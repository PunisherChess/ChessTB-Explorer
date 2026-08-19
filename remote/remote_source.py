"""Random-access byte source for chesstb tables served over plain HTTP,
via ``Range`` requests, instead of a local filesystem.

This module has no chesstb-specific logic of its own -- it's a generic
HTTP byte-range client -- and lives in remote/ as shared infrastructure
for remote (URL) ``TABLEBASE_PATH`` support, used by both remote backends
app.py can select via ``config.REMOTE_MODE`` (see each file's module
docstring for its own design):

* remote/remote_direct.py ("direct", the default) probes tables in place,
  reading through :class:`RemoteFileView` below so only the byte ranges a
  probe actually touches are ever fetched.
* remote/remote_fallback.py ("download") downloads each table file in
  full on first touch and disk-caches it, using only
  :class:`RemoteHTTPClient`, :class:`RemoteFile`, and :class:`_PageCache`
  from this module.

Design
------
* :class:`RemoteHTTPClient` -- a thin ``requests.Session`` wrapper that
  knows how to ask "does `<base_url>/<path>` exist, and how big is it?"
  and "give me bytes [offset, offset+length) of `<base_url>/<path>`", and
  keeps a running count of every HTTP request it issues and every
  response byte it receives, available via :meth:`RemoteHTTPClient.stats`.
  Its session mounts an ``HTTPAdapter`` sized to the caller's expected
  concurrency (``pool_maxsize``, normally set from ``PROBE_THREADS``) so
  concurrent requests reuse warm connections instead of opening fresh
  ones once the default pool is exhausted, and its retry loop backs off
  between attempts -- honoring a ``Retry-After`` header when the server
  sends one -- rather than retrying instantly into a struggling or
  rate-limiting CDN edge.
* :class:`_PageCache` -- a sharded LRU cache, shared by every table opened
  against one remote base URL, of fixed-size raw page fetches. A page's
  key is hashed to one of a fixed number of independent shards -- each
  with its own lock, LRU ledger, per-key fetch lock, and slice of the
  overall byte budget -- so concurrent reads of pages that land in
  different shards never contend on a single mutex. This is what makes
  the hot path fast: a table's index structures (consulted on every
  single probe) do many small, scattered reads clustered in a fairly
  small region of each table file, so after the first probe touches a
  region its page is cached and every later probe against the same table
  is served with no network round trip at all. Each shard also tracks its
  own hit/miss counts, summed by :attr:`_PageCache.hits` /
  :attr:`_PageCache.misses` for the whole cache.
* :class:`RemoteFile` -- one opened remote table (fixed client + path +
  size), with a ``read(offset, length)`` that satisfies a request from
  the shared page cache, fetching only whichever pages aren't already
  resident.
* :class:`RemoteFileView` -- a lightweight ``(RemoteFile, base, length)``
  view supporting the same slicing/indexing a local
  ``memoryview(mmap(...))`` buffer would. Slicing a view is *free* -- it
  never touches the network, just narrows the (base, length) window.
  Only an explicit materialisation (``bytes(view)``, iterating it, or
  indexing a single byte) triggers a fetch, and only for the span
  actually needed. This is what remote_direct.py probes through.
"""
from __future__ import annotations

import collections
import threading
import time
from typing import Dict, List, Optional, Tuple

try:
    import requests  # type: ignore
except ImportError:  # pragma: no cover - exercised only without `requests`
    requests = None  # type: ignore

__all__ = [
    "RemoteSourceError",
    "RemoteHTTPClient",
    "RemoteFile",
    "RemoteFileView",
    "looks_like_remote",
    "DEFAULT_PAGE_SIZE",
    "DEFAULT_PAGE_CACHE_BYTES",
    "DEFAULT_PAGE_CACHE_SHARDS",
    "DEFAULT_TIMEOUT",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_POOL_MAXSIZE",
]

#: Size of one page fetched/cached at a time. Large enough that a table's
#: whole header + index-vector region (dict, MonoUintVec/Min0UintVec
#: offsets -- everything but the bulk compressed data) typically fits in
#: one or two pages, small enough that a single cold random probe doesn't
#: pull down an unreasonable amount of unrelated data.
DEFAULT_PAGE_SIZE = 256 * 1024  # 256 KiB

#: Soft budget (bytes) for the shared LRU page cache, mirroring
#: chesstb.py's DEFAULT_BLOCK_CACHE_BYTES for the decoded-block cache one
#: layer up. Configurable via Tablebase/open_tablebase kwargs.
DEFAULT_PAGE_CACHE_BYTES = 128 * 1024 * 1024  # 128 MiB

#: Number of independent shards the page cache splits its keyspace
#: across. Each shard gets its own lock and an equal slice of
#: DEFAULT_PAGE_CACHE_BYTES, so concurrent probe threads reading
#: different pages -- the common case once a session has more than a
#: handful of materials open -- don't serialize behind one mutex.
DEFAULT_PAGE_CACHE_SHARDS = 16

DEFAULT_TIMEOUT = 20.0
DEFAULT_MAX_RETRIES = 3

#: Default HTTP connection pool size for a client's underlying
#: ``requests.Session``, used when the caller (normally app.py, sizing
#: this against ``PROBE_THREADS``) doesn't pick one explicitly. One
#: RemoteHTTPClient talks to a single host, so all of this budget goes to
#: that one pool.
DEFAULT_POOL_MAXSIZE = 20

#: Cap (seconds) on the exponential backoff between retried requests --
#: see :func:`_retry_delay`.
_MAX_RETRY_DELAY = 4.0


def looks_like_remote(directory: str) -> bool:
    """True if `directory` (the value the app would otherwise treat as a
    local ``TABLEBASE_PATH``) is actually an ``http(s)://`` base URL --
    e.g. a Hugging Face bucket such as
    ``https://huggingface.co/buckets/<owner>/<name>/resolve``."""
    return bool(directory) and directory.startswith(("http://", "https://"))


def _retry_delay(attempt: int, resp: Optional["requests.Response"]) -> float:
    """Seconds to wait before retry number `attempt` (0-based).

    Honors a numeric ``Retry-After`` header on `resp` if present (a
    server explicitly asking for a pause takes priority over guessing);
    otherwise a capped exponential backoff, so a burst of concurrent
    requests hitting a struggling or rate-limiting CDN edge spread out
    instead of retrying in lockstep.
    """
    if resp is not None:
        retry_after = resp.headers.get("Retry-After")
        if retry_after is not None and retry_after.isdigit():
            return float(retry_after)
    return min(0.25 * (2 ** attempt), _MAX_RETRY_DELAY)


class RemoteSourceError(IOError):
    """Raised when a remote tablebase byte range can't be fetched."""


class _PageCacheShard:
    """One shard of :class:`_PageCache`: an independent LRU cache of raw,
    still-compressed page-sized byte ranges, with its own hit/miss counts.

    Structurally mirrors :class:`chesstb._BlockCache`: an ``OrderedDict``
    used as an LRU ledger, evicted down to a soft byte budget, plus
    per-key locks so concurrent probe threads landing on the same
    not-yet-fetched page fetch it once rather than once each.
    """

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.cur_bytes = 0
        self.hits = 0
        self.misses = 0
        self._data: Dict[Tuple[str, int], bytes] = {}
        self._lru: "collections.OrderedDict[Tuple[str, int], int]" = collections.OrderedDict()
        self._lock = threading.Lock()
        self._page_locks: Dict[Tuple[str, int], threading.Lock] = {}
        self._meta_lock = threading.Lock()

    def lock_for(self, key: Tuple[str, int]) -> threading.Lock:
        lk = self._page_locks.get(key)
        if lk is not None:
            return lk
        with self._meta_lock:
            lk = self._page_locks.get(key)
            if lk is None:
                lk = threading.Lock()
                self._page_locks[key] = lk
            return lk

    def get(self, key: Tuple[str, int]) -> Optional[bytes]:
        with self._lock:
            data = self._data.get(key)
            if data is not None:
                self._lru.move_to_end(key)
                self.hits += 1
            else:
                self.misses += 1
            return data

    def put(self, key: Tuple[str, int], data: bytes) -> None:
        with self._lock:
            old = self._lru.pop(key, None)
            if old is not None:
                self.cur_bytes -= old
            self._data[key] = data
            self._lru[key] = len(data)
            self.cur_bytes += len(data)
            while self.cur_bytes > self.max_bytes and len(self._lru) > 1:
                ev_key, ev_size = self._lru.popitem(last=False)
                self._data.pop(ev_key, None)
                self.cur_bytes -= ev_size
                self._page_locks.pop(ev_key, None)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()
            self._lru.clear()
            self.cur_bytes = 0
            self.hits = 0
            self.misses = 0
        with self._meta_lock:
            self._page_locks.clear()


class _PageCache:
    """Sharded LRU cache of raw, still-compressed page-sized byte ranges
    fetched over HTTP, shared by every table opened against one remote
    base URL. See the module docstring for why this matters.

    A page's ``(path, page_index)`` key is hashed to one of
    :data:`DEFAULT_PAGE_CACHE_SHARDS` independent :class:`_PageCacheShard`
    instances, each owning its own lock, LRU ledger, per-key fetch locks,
    and an equal slice of the overall byte budget -- so a given key always
    lands on the same shard (its cache entry and its fetch lock are always
    found together), and reads or writes to pages in different shards
    never contend on a shared mutex. ``max_bytes``, ``cur_bytes``,
    ``page_count``, ``hits``, and ``misses`` each report totals summed
    across every shard.
    """

    def __init__(self, max_bytes: int, shard_count: int = DEFAULT_PAGE_CACHE_SHARDS) -> None:
        self._shard_count = max(1, shard_count)
        per_shard = max(max_bytes // self._shard_count, 1)
        self._shards: List[_PageCacheShard] = [
            _PageCacheShard(per_shard) for _ in range(self._shard_count)
        ]

    def _shard(self, key: Tuple[str, int]) -> _PageCacheShard:
        return self._shards[hash(key) % self._shard_count]

    def lock_for(self, key: Tuple[str, int]) -> threading.Lock:
        return self._shard(key).lock_for(key)

    def get(self, key: Tuple[str, int]) -> Optional[bytes]:
        return self._shard(key).get(key)

    def put(self, key: Tuple[str, int], data: bytes) -> None:
        self._shard(key).put(key, data)

    def clear(self) -> None:
        for shard in self._shards:
            shard.clear()

    @property
    def max_bytes(self) -> int:
        return sum(shard.max_bytes for shard in self._shards)

    @property
    def cur_bytes(self) -> int:
        return sum(shard.cur_bytes for shard in self._shards)

    @property
    def page_count(self) -> int:
        return sum(len(shard._lru) for shard in self._shards)

    @property
    def hits(self) -> int:
        return sum(shard.hits for shard in self._shards)

    @property
    def misses(self) -> int:
        return sum(shard.misses for shard in self._shards)


class RemoteHTTPClient:
    """Ranged-GET / existence-check client for one remote base URL, with a
    running count of every HTTP request it issues and every response byte
    it receives -- see :meth:`stats`."""

    def __init__(self, base_url: str, *, timeout: float = DEFAULT_TIMEOUT,
                 max_retries: int = DEFAULT_MAX_RETRIES,
                 pool_maxsize: int = DEFAULT_POOL_MAXSIZE,
                 extra_headers: Optional[dict] = None) -> None:
        if requests is None:
            raise RuntimeError(
                "Remote tablebase access requires the 'requests' package. "
                "Install it with `pip install requests` (already listed in "
                "requirements.txt)."
            )
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max(1, max_retries)
        self._session = requests.Session()
        # One host per client, so one pool's worth of connections is all
        # this ever needs -- sized to the caller's expected concurrency
        # rather than left at requests' default of 10, which PROBE_THREADS
        # alone can exceed. max_retries=0 here: retrying is this class's
        # own job (see get_range/get_first_page), not urllib3's.
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=1, pool_maxsize=max(1, pool_maxsize), max_retries=0,
        )
        self._session.mount("https://", adapter)
        self._session.mount("http://", adapter)
        if extra_headers:
            self._session.headers.update(extra_headers)
        self._stats_lock = threading.Lock()
        self._requests = 0
        self._bytes_fetched = 0

    def _record(self, nbytes: int = 0) -> None:
        """Count one HTTP round trip -- successful or not -- and however
        many response body bytes it actually carried."""
        with self._stats_lock:
            self._requests += 1
            self._bytes_fetched += nbytes

    def stats(self) -> Dict[str, int]:
        """Total HTTP requests issued and response bytes received through
        this client so far."""
        with self._stats_lock:
            return {"requests": self._requests, "bytes_fetched": self._bytes_fetched}

    def url_for(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    def head_size(self, path: str) -> Optional[int]:
        """Return `path`'s size in bytes, or ``None`` if it doesn't exist.

        Tries a plain HEAD first; falls back to a 1-byte ranged GET (whose
        ``Content-Range`` header also carries the total size) for servers
        that answer HEAD inconsistently for range-servable objects.
        """
        url = self.url_for(path)
        try:
            resp = self._session.head(url, timeout=self.timeout, allow_redirects=True)
        except requests.RequestException:
            resp = None  # fall through to the ranged-GET probe below
        if resp is not None:
            self._record()  # HEAD has no body -- nothing to add to bytes_fetched
            if resp.status_code == 404:
                return None
            if resp.status_code < 400:
                cl = resp.headers.get("Content-Length")
                if cl is not None and cl.isdigit():
                    return int(cl)

        try:
            resp = self._session.get(url, headers={"Range": "bytes=0-0"}, timeout=self.timeout)
        except requests.RequestException as exc:
            self._record()
            raise RemoteSourceError(f"Failed to reach {url}: {exc}") from exc
        self._record(len(resp.content))
        if resp.status_code == 404:
            return None
        if resp.status_code == 206:
            content_range = resp.headers.get("Content-Range", "")
            total = content_range.rsplit("/", 1)[-1] if "/" in content_range else ""
            if total.isdigit():
                return int(total)
        if resp.status_code == 200:
            # Server ignored Range and returned the whole object -- only
            # sane for a tiny/placeholder file, so this is safe to keep.
            return len(resp.content)
        raise RemoteSourceError(f"Unexpected status {resp.status_code} probing {url}")

    def get_range(self, path: str, offset: int, length: int) -> bytes:
        if length <= 0:
            return b""
        url = self.url_for(path)
        end = offset + length - 1
        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries):
            try:
                resp = self._session.get(
                    url, headers={"Range": f"bytes={offset}-{end}"}, timeout=self.timeout,
                )
            except requests.RequestException as exc:
                self._record()
                last_exc = exc
                if attempt + 1 < self.max_retries:
                    time.sleep(_retry_delay(attempt, None))
                continue
            self._record(len(resp.content))
            if resp.status_code == 206:
                return resp.content
            if resp.status_code == 200:
                # Range not honoured by this server/CDN -- slice client
                # side instead of silently keeping the whole response.
                return resp.content[offset:offset + length]
            if resp.status_code == 404:
                raise RemoteSourceError(f"{url} not found")
            last_exc = RemoteSourceError(
                f"Unexpected status {resp.status_code} fetching {url} bytes={offset}-{end}"
            )
            if resp.status_code in (429, 503) and attempt + 1 < self.max_retries:
                time.sleep(_retry_delay(attempt, resp))
        raise last_exc or RemoteSourceError(f"Failed to fetch {url} bytes={offset}-{end}")

    def get_first_page(self, path: str, page_size: int) -> Tuple[Optional[int], bytes]:
        """Fetch `path`'s first `page_size` bytes, returning
        ``(total_size, data)`` -- ``total_size`` is ``None`` if `path`
        doesn't exist, in which case ``data`` is empty.

        This is "does it exist", "how big is it", and "here's its header"
        in one round trip: a freshly-touched table needs all three
        (existence + size to construct a :class:`RemoteFile`, and its
        first page immediately afterward to parse the header), so this
        replaces what would otherwise be a HEAD followed straight away by
        an identical page-0 fetch. `data` is capped to `page_size` bytes
        even if the server ignores the Range header and returns the whole
        object, so a cache entry seeded from it always matches what a
        normal page-0 fetch through :meth:`get_range` would have produced.
        """
        if page_size <= 0:
            return None, b""
        url = self.url_for(path)
        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries):
            try:
                resp = self._session.get(
                    url, headers={"Range": f"bytes=0-{page_size - 1}"}, timeout=self.timeout,
                )
            except requests.RequestException as exc:
                self._record()
                last_exc = exc
                if attempt + 1 < self.max_retries:
                    time.sleep(_retry_delay(attempt, None))
                continue
            self._record(len(resp.content))
            if resp.status_code == 404:
                return None, b""
            if resp.status_code == 206:
                content_range = resp.headers.get("Content-Range", "")
                total = content_range.rsplit("/", 1)[-1] if "/" in content_range else ""
                return (int(total) if total.isdigit() else None), resp.content[:page_size]
            if resp.status_code == 200:
                # Range not honoured -- whole object came back from byte 0.
                return len(resp.content), resp.content[:page_size]
            last_exc = RemoteSourceError(f"Unexpected status {resp.status_code} probing {url}")
            if resp.status_code in (429, 503) and attempt + 1 < self.max_retries:
                time.sleep(_retry_delay(attempt, resp))
        raise last_exc or RemoteSourceError(f"Failed to fetch {url} bytes=0-{page_size - 1}")


class RemoteFile:
    """One opened remote table file: fixed (client, path, size), backed
    by a page cache shared across every table opened against the same
    remote base URL (see :class:`chesstb.Tablebase`)."""

    def __init__(self, client: RemoteHTTPClient, path: str, size: int,
                 page_cache: _PageCache, page_size: int = DEFAULT_PAGE_SIZE) -> None:
        self.client = client
        self.path = path
        self.size = size
        self._page_cache = page_cache
        self.page_size = page_size

    def __len__(self) -> int:
        return self.size

    def __str__(self) -> str:
        return self.client.url_for(self.path)

    def _get_page(self, page_index: int) -> bytes:
        key = (self.path, page_index)
        data = self._page_cache.get(key)
        if data is not None:
            return data
        with self._page_cache.lock_for(key):
            data = self._page_cache.get(key)
            if data is not None:
                return data
            start = page_index * self.page_size
            length = min(self.page_size, self.size - start)
            data = self.client.get_range(self.path, start, length)
            self._page_cache.put(key, data)
            return data

    def read(self, offset: int, length: int) -> bytes:
        """Return up to `length` bytes starting at `offset`, clamped to
        the file's actual size (mirrors slicing past the end of a
        ``memoryview``/``mmap`` rather than raising)."""
        if length <= 0 or offset >= self.size:
            return b""
        length = min(length, self.size - offset)
        first_page = offset // self.page_size
        last_page = (offset + length - 1) // self.page_size
        if first_page == last_page:
            page = self._get_page(first_page)
            start_in_page = offset - first_page * self.page_size
            return page[start_in_page:start_in_page + length]
        parts = []
        remaining = length
        cur_offset = offset
        for page_index in range(first_page, last_page + 1):
            page = self._get_page(page_index)
            start_in_page = cur_offset - page_index * self.page_size
            take = min(len(page) - start_in_page, remaining)
            parts.append(page[start_in_page:start_in_page + take])
            cur_offset += take
            remaining -= take
        return b"".join(parts)

    def close(self) -> None:
        # Fetched pages live in the Tablebase-shared page cache, not
        # here -- nothing owned by this object needs releasing.
        pass


class RemoteFileView:
    """A lazy, ``memoryview``-slicing-compatible view over a
    :class:`RemoteFile`. See the module docstring for why slicing this is
    free and only explicit materialisation fetches bytes.
    """
    __slots__ = ("_file", "_base", "_len")

    def __init__(self, remote_file: RemoteFile, base: int = 0,
                 length: Optional[int] = None) -> None:
        self._file = remote_file
        self._base = base
        self._len = length if length is not None else (len(remote_file) - base)

    def __len__(self) -> int:
        return self._len

    def __getitem__(self, item):
        if isinstance(item, slice):
            start, stop, step = item.indices(self._len)
            if step != 1:
                raise ValueError("RemoteFileView does not support strided slicing")
            return RemoteFileView(self._file, self._base + start, max(0, stop - start))
        idx = item + self._len if item < 0 else item
        if not (0 <= idx < self._len):
            raise IndexError("RemoteFileView index out of range")
        chunk = self._file.read(self._base + idx, 1)
        if not chunk:
            raise IndexError("RemoteFileView index out of range (past end of remote file)")
        return chunk[0]

    def get_bytes(self, offset: int = 0, length: Optional[int] = None) -> bytes:
        """Materialise (fetch, via the page cache) `length` bytes starting
        `offset` bytes into this view."""
        if length is None:
            length = self._len - offset
        return self._file.read(self._base + offset, length)

    def __bytes__(self) -> bytes:
        return self.get_bytes()

    def __iter__(self):
        return iter(self.get_bytes())

    def close(self) -> None:
        pass
