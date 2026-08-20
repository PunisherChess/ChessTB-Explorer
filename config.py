"""
config.py — ChessTB Explorer configuration

Edit the values below directly, then run `python app.py`. There's no
separate .env file or environment-variable step — this file *is* the
configuration. Nothing in it is a secret (there's no API key, password,
or credential anywhere in this app; see README.md's "Security notes"),
so there's no reason to keep it out of version control or load it
indirectly through the environment.

Invalid values (wrong type, out of range) make the app log an error and
exit at startup rather than run with a silently-wrong configuration —
see AppConfig.from_config() in app.py.
"""

# ── Tablebase location ──────────────────────────────────────────────────────

# Path to the directory containing your chesstb tablebase files, or an
# http(s):// base URL serving the same layout remotely (see README.md's
# "Getting the tablebase files" section).
#   Windows example:  TABLEBASE_PATH = r"C:\chesstb\full"
#   macOS / Linux:    TABLEBASE_PATH = "/data/chesstb/full"
#   Remote example:   TABLEBASE_PATH = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve"
#                     (the trailing /resolve is required — see README.md)
# Left empty, the app still starts, but every /probe request will fail and
# /health will report "degraded" until this is set.
TABLEBASE_PATH = ""

# ── Server ───────────────────────────────────────────────────────────────────

# Set to True to run the app via Flask's own dev server (auto-reload,
# detailed error pages, interactive debugger) instead of waitress. Leave
# False for any deployment reachable from other machines — False is what
# makes `python app.py` serve via waitress, the production WSGI server
# this app ships with.
DEBUG = False

# Interface the server (waitress, or the Flask dev server if DEBUG is
# True) binds to. This app is designed for single-user, local use — it
# has no built-in authentication, including for /admin/* (see README.md's
# "Security notes") — so keep this at "127.0.0.1" unless you're putting
# your own access control (e.g. a reverse proxy, VPN, or firewall) in
# front of it.
HOST = "127.0.0.1"

# Port the server listens on — applies whether app.py ends up serving via
# waitress (DEBUG=False) or the Flask dev server (DEBUG=True).
PORT = 5000

# Number of worker threads waitress uses to handle concurrent requests
# (only relevant when DEBUG=False). Needs to be more than 1 so that a
# long-lived /probe/stream SSE connection can't block every other request
# — see README.md's "Running in production" section. This is separate
# from PROBE_THREADS below, which sizes the pool used internally to
# parallelise tablebase probing, not to serve HTTP requests.
WAITRESS_THREADS = 8

# ── Probing ──────────────────────────────────────────────────────────────────

# Worker threads in the probe thread pool used to evaluate a position's
# legal moves in parallel. Left as None so it scales with the host
# machine automatically (min(16, cpu_count() * 2)) — set an explicit
# integer to override.
PROBE_THREADS = None

# Minimum number of not-yet-cached child positions before a probe batch
# switches from sequential to the PROBE_THREADS thread pool. Lower this
# (or set to 1, to always parallelize) if you're probing positions with
# unusually many legal moves, or if profiling shows sequential probing is
# your bottleneck on your hardware; raise it if thread hand-off overhead
# outweighs the benefit for the kinds of positions you probe most.
PROBE_PARALLEL_THRESHOLD = 4

# Wall-clock timeout, in seconds, for a batch of parallel child probes
# (both in evaluate_all_moves()'s Phase 2 and /probe/stream's pre-warm
# loop) before the remaining probes are logged as timed-out and treated
# as unknown rather than blocking the request indefinitely.
PROBE_TIMEOUT_SECS = 30

# ── Caching ──────────────────────────────────────────────────────────────────

# Max entries in the root-FEN result cache (full JSON responses served by
# evaluate_fen()). Raising this keeps more distinct root positions warm
# across a session at the cost of memory.
EVALUATE_CACHE_SIZE = 4096

# Max entries in the child-position probe cache (raw WDL/DTZ/DTM/DTM50
# tuples served by _probe_fen()), shared between root probes and every
# child position probed while ranking moves.
PROBE_CACHE_SIZE = 16384

# Size (in bytes) of chess.chesstb's own internal cache of decoded/
# decompressed tablebase blocks, shared across the WDL/DTZ/DTM50 tables.
# 64 MiB is chess.chesstb's own default. Raising this reduces repeated
# disk reads + decompression across a session at the cost of RAM — worth
# raising on a machine with RAM to spare, especially when running probes
# serially (PROBE_PARALLEL_THRESHOLD set high) with no thread pool to
# amortize that cost across.
BLOCK_CACHE_BYTES = 64 * 1024 * 1024

# ── Remote (URL) TABLEBASE_PATH only ────────────────────────────────────────
# Everything below is ignored when TABLEBASE_PATH is a local directory; it
# only applies once TABLEBASE_PATH is an http(s):// URL (see above). See
# remote/remote_fallback.py's module docstring for the full design.

# How a remote table's bytes reach the prober:
#
#   "direct"   -- probe the remote tables in place, fetching only the
#                 page-sized byte ranges each probe reads, nothing written
#                 to disk (remote/remote_direct.py). Needs a chess.chesstb
#                 new enough to have the table-source seam; if yours
#                 doesn't, the app logs that and uses "download" instead.
#   "download" -- fetch each table file in full on first touch and cache it
#                 on local disk (remote/remote_fallback.py). Slower first
#                 touch of a material and real disk usage, but every read
#                 after it is a local mmap read.
#
# "direct" is the better default for browsing across many materials, which
# is what this app does. Prefer "download" if you hammer a handful of
# materials for a long session, or if your network's per-request latency is
# high enough that many small requests hurt (one cold probe can issue
# several, since a probe of a dropped-frame table walks its children).
REMOTE_MODE = "direct"

# Soft budget, in bytes, shared across every remote table opened this
# session: bounds the in-memory page cache in "direct" mode, and the
# on-disk cache of whole downloaded table files in "download" mode.
REMOTE_PAGE_CACHE_BYTES = 128 * 1024 * 1024

# Size, in bytes, of one page. In "direct" mode this is the granularity of
# every fetch, so it sets the trade between over-fetching (too large) and
# many round trips per probe (too small) -- 256 KiB keeps a table's whole
# header + index region within a page or two, which is what makes later
# probes of the same table cheap. In "download" mode it is only the chunk
# size used while streaming a full file down, and has no effect on which
# bytes end up fetched.
REMOTE_PAGE_SIZE_BYTES = 256 * 1024

# Per-HTTP-request timeout, in seconds, for both existence/size checks and
# the download itself against a remote tablebase.
REMOTE_TIMEOUT_SECS = 20.0

# Number of attempts for a single remote request before giving up (the
# request that triggered it then fails, surfacing as a probe error).
REMOTE_MAX_RETRIES = 3

# Max size of the HTTP connection pool each remote backend's session
# keeps open against TABLEBASE_PATH's host. Left as None so it scales
# with PROBE_THREADS automatically (max(PROBE_THREADS * 2, 20)) — set an
# explicit integer to override. Too small a pool under-serves concurrent
# probing (connections stop being reused once PROBE_THREADS exceeds it);
# too large rarely hurts beyond a handful of idle sockets, so there's
# little reason to set this below the auto-computed value.
REMOTE_POOL_MAXSIZE = None
