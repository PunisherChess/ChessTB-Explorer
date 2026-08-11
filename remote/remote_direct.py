"""Byte-range ChessTB tablebase access: probe remote tables *in place*,
fetching only the bytes each probe touches.

How this differs from remote_fallback.py
----------------------------------------
remote_fallback.py downloads a whole table file on first touch and hands
the standard ``WDLFile``/``DTCFile``/``DTM50File`` a local path, because
at the time it was written those classes could only ``open()`` a
filesystem path. They can now read through any buffer-shaped object:
``chess.chesstb._TableFile._open_source`` is the documented seam for it,
and ``chess.chesstb.Tablebase.WDL_FILE`` / ``.DTC_FILE`` / ``.DTM50_FILE``
name the classes carrying the override, so a transport no longer has to
reimplement the look-once-then-cache logic in ``_open_wdl`` and friends.

This module connects that seam to :class:`remote_source.RemoteFileView`,
which was written against exactly this contract and had no caller. The
result is what remote_source.py's docstring already described as the goal:
``_find`` resolves a material to a :class:`remote_source.RemoteFile` rather
than downloading it, ``_open_source`` wraps that in a lazy view, and the
table's header parse plus each probe's block reads pull only their own
byte ranges through the shared page cache.

Trade-off against remote_fallback.py
------------------------------------
Cold cost drops from "one full table download" to "a handful of 256 KiB
pages", and ``REMOTE_PAGE_CACHE_BYTES`` goes back to bounding memory
rather than doubling as an on-disk budget -- nothing is written to disk
here at all.

The cost is per-read CPU. Against a mapping, the hot 8-byte bit-window
read (:func:`chess.chesstb._read_u64le`) is a C-level ``unpack_from``;
here every one of them is a Python call into
:meth:`remote_source.RemoteFile.read` -> a dict lookup and a slice, even
on a page-cache hit. So this backend wins decisively while a session
ranges over many materials (the common case for an explorer: most tables
are touched a few times each) and loses to remote_fallback.py once a
single material is probed hard enough that the download amortizes. Both
are kept; config.py's ``REMOTE_MODE`` chooses.

Where this stops
----------------
Like remote_fallback.py, this adds no lock around a first open beyond the
per-kind lock ``chess.chesstb.Tablebase`` already holds across ``_find``,
so the size probe (one HEAD) for a never-before-seen material happens
under that lock, and two threads wanting two *different* materials of the
same kind serialize behind it. Same as upstream behaves for local tables,
where the equivalent work is an ``os.path.exists``; it is a
latency-under-contention question, not a correctness one.
"""
from __future__ import annotations

import importlib.util
import os
import threading
from typing import Any, Dict, Optional

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
        and hasattr(chesstb.Tablebase, "DTC_FILE")
        and hasattr(chesstb.Tablebase, "DTM50_FILE")
        and hasattr(chesstb._TableFile, "_open_source")
    )


class _RemoteSourced:
    """The ``_open_source`` override, shared by the three table kinds.

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


class _RemoteDTCFile(_RemoteSourced, chesstb.DTCFile):
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
    DTC_FILE = _RemoteDTCFile
    DTM50_FILE = _RemoteDTM50File

    def __init__(self, base_url: str, *, block_cache_bytes: int,
                 remote_page_cache_bytes: int, remote_page_size: int,
                 remote_timeout: float, remote_max_retries: int) -> None:
        self._client = remote_source.RemoteHTTPClient(
            base_url, timeout=remote_timeout, max_retries=remote_max_retries,
        )
        # One page cache for every table opened against this base URL, so a
        # material's index region stays resident once touched and the budget
        # is enforced across materials rather than per table.
        self._page_cache = remote_source._PageCache(remote_page_cache_bytes)
        self._page_size = remote_page_size
        # A cached None means "asked, no such table" -- same contract as the
        # open caches upstream keeps, so a missing material costs one HEAD
        # for the session rather than one per probe.
        self._sizes: Dict[str, Optional[int]] = {}
        self._size_lock = threading.Lock()
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
        size = self._client.head_size(rel_path)  # may raise RemoteSourceError
        with self._size_lock:
            self._sizes[rel_path] = size
        return size

    # --- lifecycle / admin surfaces (app.py reaches these via getattr) ---

    def close(self) -> None:
        try:
            super().close()
        finally:
            # Only safe here because super().close() has already drained
            # in-flight probes and released every table's view.
            self._page_cache.clear()

    def clear_caches(self) -> None:
        """Drop decoded blocks and fetched pages, keeping open tables open
        -- reopening would only re-fetch the same headers immediately."""
        self._block_cache.clear()
        self._page_cache.clear()

    def cache_stats(self) -> Dict[str, Any]:
        return {
            "block_cache_blocks": len(self._block_cache._lru),
            "block_cache_bytes":  self._block_cache.cur_bytes,
            "remote_page_cache": {
                "pages":     len(self._page_cache._lru),
                "cur_bytes": self._page_cache.cur_bytes,
                "max_bytes": self._page_cache.max_bytes,
                "page_size": self._page_size,
            },
            "materials_resolved": sum(1 for v in self._sizes.values() if v is not None),
        }


def open_tablebase(directory: str, *,
                   block_cache_bytes: int = chesstb.DEFAULT_BLOCK_CACHE_BYTES,
                   remote_page_cache_bytes: int = remote_source.DEFAULT_PAGE_CACHE_BYTES,
                   remote_page_size: int = remote_source.DEFAULT_PAGE_SIZE,
                   remote_timeout: float = remote_source.DEFAULT_TIMEOUT,
                   remote_max_retries: int = remote_source.DEFAULT_MAX_RETRIES,
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
    )
