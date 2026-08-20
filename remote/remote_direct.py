"""Byte-range ChessTB tablebase access: probe remote tables *in place*,
fetching only the bytes each probe touches.

How this differs from remote_fallback.py
----------------------------------------
remote_fallback.py downloads a whole table file on first touch and hands
the standard ``WDLFile``/``DTZFile``/``DTMFile``/``DTM50File`` a local
path. This module instead uses those same classes' ability to read
through any buffer-shaped object: ``chess.chesstb._TableFile._open_source``
is the documented seam for it, and ``chess.chesstb.Tablebase.WDL_FILE`` /
``.DTZ_FILE`` / ``.DTM_FILE`` / ``.DTM50_FILE`` name the classes carrying
the override, so this module never has to reimplement the
look-once-then-cache logic in ``_open_wdl`` and friends.

This module connects that seam to :class:`remote_source.RemoteFileView`:
``_find`` resolves a material to a :class:`remote_source.RemoteFile`
rather than downloading it, ``_open_source`` wraps that in a lazy view,
and the table's header parse plus each probe's block reads pull only
their own byte ranges through the shared page cache. A material's first
touch fetches its existence, size, and first page together in one round
trip (see ``_remote_size`` / :meth:`remote_source.RemoteHTTPClient.get_first_page`)
and seeds the page cache with it, since the header parse that runs
immediately afterward needs exactly that page next anyway.

Trade-off against remote_fallback.py
------------------------------------
Cold cost is "a handful of 256 KiB pages" rather than "one full table
download", and ``REMOTE_PAGE_CACHE_BYTES`` bounds memory only -- nothing
is written to disk here at all.

The cost is per-read CPU. Against a mapping, the hot 8-byte bit-window
read (:func:`chess.chesstb._read_u64le`) is a C-level ``unpack_from``;
here every one of them is a Python call into
:meth:`remote_source.RemoteFile.read` -> a dict lookup and a slice, even
on a page-cache hit. So this backend wins decisively while a session
ranges over many materials (the common case for an explorer: most tables
are touched a few times each) and loses to remote_fallback.py once a
single material is probed hard enough that the download amortizes. Both
are kept; config.py's ``REMOTE_MODE`` chooses.

Per-material opening
---------------------
``chess.chesstb.Tablebase`` normally guards each *kind*'s first-open dance
(``_open_wdl``/``_open_dtz``/``_open_dtm``/``_open_dtm50``) with one lock
per kind, shared by every material of that kind -- cheap to hold for a
local ``os.path.exists()``, but this class's ``_find`` does a real network
round trip underneath it. So ``_RemoteTablebase`` overrides all four
``_open_*`` methods to lock per ``(kind, material)`` instead of per kind,
using the same double-checked-locking shape :class:`remote_source._PageCache`
already uses for per-page fetch locks: two threads racing to open the
*same* material still collapse onto one fetch, but two threads opening
*different* materials of the same kind no longer serialize behind each
other's round trip.
"""
from __future__ import annotations

import importlib.util
import os
import threading
from typing import Any, Dict, Optional, Tuple

import chess.chesstb as chesstb

__all__ = ["remote_source", "open_tablebase", "seam_available"]


def _load_remote_source_module() -> Any:
    """Load remote_source.py by path -- see remote_fallback.py's copy of
    this for why (this file is loaded by path too, not as a package)."""
    this_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(this_dir, "remote_source.py")
    spec = importlib.util.spec_from_file_location("_chesstb_remote_source_direct", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


#: Re-exported so app.py can reach looks_like_remote / RemoteSourceError
#: through either remote backend interchangeably.
remote_source = _load_remote_source_module()


def seam_available() -> bool:
    """True if the installed ``chess.chesstb`` has the source seam this
    module needs.

    requirements.txt tracks a *branch*, not a pinned commit, so an
    already-provisioned virtualenv can easily predate the seam. Checked
    here rather than left to explode at first probe so app.py can say so
    at startup and fall back to remote_fallback.py, which needs only
    ``_find``.
    """
    return (
        hasattr(chesstb.Tablebase, "WDL_FILE")
        and hasattr(chesstb.Tablebase, "DTZ_FILE")
        and hasattr(chesstb.Tablebase, "DTM_FILE")
        and hasattr(chesstb.Tablebase, "DTM50_FILE")
        and hasattr(chesstb._TableFile, "_open_source")
    )


class _RemoteSourced:
    """The ``_open_source`` override, shared by all four table kinds.

    ``path`` is whatever :meth:`_RemoteTablebase._find` returned -- here a
    :class:`remote_source.RemoteFile`. It becomes ``self._data`` (what
    ``_TableFile.close`` releases) and the view over it is what the table
    reads through. ``RemoteFile.close()`` is a no-op by design: the fetched
    pages belong to the page cache shared across every table, so closing
    one table must not drop them.
    """

    def _open_source(self, path: Any) -> Any:
        self._data = path  # type: ignore[attr-defined]
        return remote_source.RemoteFileView(path)


class _RemoteWDLFile(_RemoteSourced, chesstb.WDLFile):
    pass


class _RemoteDTZFile(_RemoteSourced, chesstb.DTZFile):
    pass


class _RemoteDTMFile(_RemoteSourced, chesstb.DTMFile):
    pass


class _RemoteDTM50File(_RemoteSourced, chesstb.DTM50File):
    pass


class _RemoteTablebase(chesstb.Tablebase):
    """A standard ``chess.chesstb.Tablebase`` reading its tables over HTTP
    byte ranges. Everything about probing -- index maths, block decoding,
    the rank tables, ``MissingTableError``, ``ProbeResult`` -- is the
    standard module's own code, unmodified; this class changes only where
    a table's bytes come from.
    """

    WDL_FILE = _RemoteWDLFile
    DTZ_FILE = _RemoteDTZFile
    DTM_FILE = _RemoteDTMFile
    DTM50_FILE = _RemoteDTM50File

    def __init__(self, base_url: str, *, block_cache_bytes: int,
                 remote_page_cache_bytes: int, remote_page_size: int,
                 remote_timeout: float, remote_max_retries: int,
                 remote_pool_maxsize: int) -> None:
        self._client = remote_source.RemoteHTTPClient(
            base_url, timeout=remote_timeout, max_retries=remote_max_retries,
            pool_maxsize=remote_pool_maxsize,
        )
        # One page cache for every table opened against this base URL, so a
        # material's index region stays resident once touched and the budget
        # is enforced across materials rather than per table, split evenly
        # across the cache's shards.
        self._page_cache = remote_source._PageCache(remote_page_cache_bytes)
        self._page_size = remote_page_size
        # A cached None means "asked, no such table" -- same contract as the
        # open caches upstream keeps, so a missing material costs one HEAD
        # for the session rather than one per probe.
        self._sizes: Dict[str, Optional[int]] = {}
        self._size_lock = threading.Lock()
        # One lock per (kind, material) rather than the base class's one
        # lock per kind -- see the module docstring's "Per-material
        # opening" section. Meta-locked the same way _PageCache guards
        # creating a page's fetch lock: the meta-lock is only ever held
        # long enough to create-or-fetch one Lock object.
        self._material_locks: Dict[Tuple[str, Any], threading.Lock] = {}
        self._material_locks_meta_lock = threading.Lock()
        # Base __init__ calls add_directory(base_url), which os.path.joins
        # the kind subdirectories onto it and stashes the result in
        # self.dirs. Unused here -- _find below builds "<kind>/<name><ext>"
        # relative to the base URL and never consults self.dirs -- and left
        # alone rather than overridden, exactly as remote_fallback.py does.
        super().__init__(base_url, block_cache_bytes=block_cache_bytes)

    # --- table resolution: a handle, not a download ---

    def _find(self, kind: str, name: str, ext: str) -> Optional[Any]:
        rel_path = f"{kind}/{name}{ext}"
        size = self._remote_size(rel_path)
        if size is None:
            return None
        return remote_source.RemoteFile(
            self._client, rel_path, size, self._page_cache, self._page_size,
        )

    def _remote_size(self, rel_path: str) -> Optional[int]:
        with self._size_lock:
            if rel_path in self._sizes:
                return self._sizes[rel_path]
        # First touch of this material (always under the per-(kind,
        # material) lock below -- see _open_any): one ranged GET for page
        # 0 answers "does it exist", "how big is it", and "here's its
        # header" together, since the header parse about to run needs
        # exactly this page next anyway. Replaces what would otherwise be
        # a HEAD immediately followed by an identical page-0 fetch.
        size, data = self._client.get_first_page(rel_path, self._page_size)
        with self._size_lock:
            self._sizes[rel_path] = size
        if size is not None and data:
            self._page_cache.put((rel_path, 0), data)
        return size

    # --- per-(kind, material) opening, replacing the base class's
    #     per-kind lock (see the module docstring) ---

    def _material_lock(self, kind: str, cache_key: Any) -> threading.Lock:
        key = (kind, cache_key)
        lk = self._material_locks.get(key)
        if lk is not None:
            return lk
        with self._material_locks_meta_lock:
            lk = self._material_locks.get(key)
            if lk is None:
                lk = threading.Lock()
                self._material_locks[key] = lk
            return lk

    def _open_any(self, kind: str, cache: Dict[Any, Any], file_cls: Any, cfg: Any) -> Any:
        k = cfg.cache_key
        try:
            return cache[k]
        except KeyError:
            pass
        with self._material_lock(kind, k):
            try:
                return cache[k]
            except KeyError:
                pass
            p = self._find(kind, cfg.name(), file_cls.EXT)
            table = file_cls(cfg, p, self._block_cache) if p is not None else None
            cache[k] = table
            return table

    def _open_wdl(self, cfg: Any) -> Any:
        return self._open_any("wdl", self._wdl_cache, self.WDL_FILE, cfg)

    def _open_dtz(self, cfg: Any) -> Any:
        return self._open_any("dtz", self._dtz_cache, self.DTZ_FILE, cfg)

    def _open_dtm(self, cfg: Any) -> Any:
        return self._open_any("dtm", self._dtm_cache, self.DTM_FILE, cfg)

    def _open_dtm50(self, cfg: Any) -> Any:
        return self._open_any("dtm50", self._dtm50_cache, self.DTM50_FILE, cfg)

    # --- lifecycle / admin surfaces (app.py reaches these via getattr) ---

    def close(self) -> None:
        try:
            super().close()
        finally:
            # Only safe here because super().close() has already drained
            # in-flight probes and released every table's view -- probe()
            # registers as a reader around the whole walk, including
            # _open_any above, so no thread can be inside it once this
            # runs.
            self._page_cache.clear()
            self._material_locks.clear()

    def clear_caches(self) -> None:
        """Drop decoded blocks and fetched pages, keeping open tables open
        -- reopening would only re-fetch the same headers immediately."""
        self._block_cache.clear()
        self._page_cache.clear()

    def cache_stats(self) -> Dict[str, Any]:
        page_hits, page_misses = self._page_cache.hits, self._page_cache.misses
        page_total = page_hits + page_misses
        return {
            "block_cache_blocks": len(self._block_cache._lru),
            "block_cache_bytes":  self._block_cache.cur_bytes,
            "remote_page_cache": {
                "pages":     self._page_cache.page_count,
                "cur_bytes": self._page_cache.cur_bytes,
                "max_bytes": self._page_cache.max_bytes,
                "page_size": self._page_size,
                "hits":      page_hits,
                "misses":    page_misses,
                "hit_rate":  round(page_hits / page_total, 4) if page_total else 0.0,
            },
            "remote_http": self._client.stats(),
            "materials_resolved": sum(1 for v in self._sizes.values() if v is not None),
        }


def open_tablebase(directory: str, *,
                   block_cache_bytes: int = chesstb.DEFAULT_BLOCK_CACHE_BYTES,
                   remote_page_cache_bytes: int = remote_source.DEFAULT_PAGE_CACHE_BYTES,
                   remote_page_size: int = remote_source.DEFAULT_PAGE_SIZE,
                   remote_timeout: float = remote_source.DEFAULT_TIMEOUT,
                   remote_max_retries: int = remote_source.DEFAULT_MAX_RETRIES,
                   remote_pool_maxsize: int = remote_source.DEFAULT_POOL_MAXSIZE,
                   ) -> _RemoteTablebase:
    """Open a remote ChessTB base URL, reading tables in place over byte
    ranges. Signature-compatible with ``remote_fallback.open_tablebase``
    and ``chess.chesstb.open_tablebase``, so app.py picks between the three
    without special-casing any of them.
    """
    return _RemoteTablebase(
        directory,
        block_cache_bytes=block_cache_bytes,
        remote_page_cache_bytes=remote_page_cache_bytes,
        remote_page_size=remote_page_size,
        remote_timeout=remote_timeout,
        remote_max_retries=remote_max_retries,
        remote_pool_maxsize=remote_pool_maxsize,
    )
