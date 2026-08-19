# ChessTB Explorer

A local, single-page web application for exploring **ChessTB** chess endgame
tablebases. Paste or build any position on an interactive board and
instantly see every legal move ranked by **Distance to Conversion (DTC)**,
**Distance to Mate (DTM)**, and **DTM under the 50-move rule (DTM50)** —
straight from the tablebase, with no chess engine involved.

The backend is a small Flask application that probes the tablebase through
a modified fork of [`python-chess`](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases)
(the `chess.chesstb` module — see [Installation](#installation)). The frontend is
dependency-light vanilla JavaScript built around
[Chessground](https://github.com/lichess-org/chessground) (lichess.org's
board component) and [chess.js](https://github.com/jhlywa/chess.js).
Chessground is **GPL-3.0-or-later** — a stricter license than a typical
permissively-licensed frontend library — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) before distributing
this project to anyone else.

> This tool only *displays* tablebase results — it does not generate,
> verify, or ship any tablebase data itself. See
> [Getting the tablebase files](#getting-the-tablebase-files) below.

> This app is designed for **single-user, local use** — it has no
> built-in authentication anywhere, including `/admin/*` (see
> [Security notes](#security-notes)). Don't expose it to a shared or
> untrusted network without putting your own access control in front of
> it.

---

## Features

- **Interactive board** — drag-and-drop moves, click-to-place pieces from
  the spare-piece trays, pawn promotion dialog, board flip (orientation
  persisted locally across visits), undo/redo.
- **Lock** — a padlock button beside the FEN box that restricts board
  interaction to legal moves only: dragging, click-to-move, and the
  spare-piece trays are limited to the side to move's legal destinations,
  and off-board drops are disabled. Unlocked by default; a manual toggle
  is remembered locally across visits. Auto-play also engages Lock for
  the duration of a run (unless already locked by hand), and disables the
  padlock button until the run stops.
- **Three ranked move tables side by side** — DTC, DTM, and DTM50 columns,
  each independently sorted best-move-first, with:
  - score text colour-coded by outcome (win / cursed win / draw /
    blessed loss / loss)
  - a **warning dot** on any move flagged cursed win or blessed loss,
    with a hover tooltip explaining the 50-move-rule nuance
  - an **info dot** on a draw by insufficient material, keeping the score
    text itself reading as a plain "Draw"
  - an outcome summary (wins / draws / losses / unknown) for the position
  - an optional pinned **Root Row** above rank 1, showing the current
    position's own score for each metric as a reference point — toggled
    from the settings panel (**Show Root Row**, off by default) and
    persisted locally
- **Best-move arrows** — the top DTC, DTM, and DTM50 moves are drawn as
  colour-coded arrows directly on the board.
- **Auto-play** — automatically plays the best move for any of the three
  metrics on a timer, so you can watch a line play out. The per-move delay
  is set from the settings panel (**Autoplay Delay**, 0s–2.5s in 50ms
  steps, 1.25s by default) and acts as a floor — a move that's still
  waiting on its tablebase probe takes as long as the probe does,
  regardless of the delay setting. A metric's button is disabled when its
  table isn't present for the current material, or when the position is
  already a draw.
- **PGN import/export** — paste a PGN to load a game and click through its
  moves, or copy the current line as PGN.
- **CSV export** of the current move table, including the Root Row line
  ahead of rank 1 when that setting is on.
- **Move-list / PGN panel** with full undo/redo and click-to-jump — jumping
  to an earlier point in the line re-uses the cached probe instead of
  re-querying the tablebase.
- **Shareable positions** — the FEN is written to the URL hash on every
  move, so a link to the page reproduces the exact position.
- **Session persistence** — the in-progress game (not just the position)
  survives a trip to the admin dashboard and back.
- **Board and piece-set theming** — two colour boards, three photographic
  boards, and three piece sets, picked from a settings panel and
  persisted locally.
- **Streaming probes** — `/probe/stream` reports progress via
  Server-Sent Events while child positions are being probed, so the UI
  shows a live progress bar instead of a blank pause on slower lookups.
- **Hover pre-fetch** — hovering a move in the table warms the cache for
  the resulting position before you click it.
- **Admin cache dashboard** (`/admin`) — live hit-rate stats for both LRU
  caches, thread-pool configuration, and a one-click cache-clear button.
- **Machine-readable API** — the full HTTP API is described by an OpenAPI
  3.0 document served at `/openapi.yaml`.
- **Keyboard shortcuts** — `Enter` Apply, `F` Flip, `C` Clear, `←`/`→`
  Back/Forward.

---

## Architecture at a glance

```
Browser (vanilla JS, ES modules)
  ├─ board.js      — chessground wrapper: drag/drop, history, arrows
  ├─ tablebase.js   — talks to /probe/stream, renders the move tables
  ├─ theme.js       — board/piece-set theming
  ├─ ui.js          — wires everything together: FEN box, PGN, auto-play,
  │                    settings panel, keyboard shortcuts
  └─ app.js         — bootstrap
        │  HTTP (JSON) / SSE (text/event-stream)
        ▼
Flask app (app.py)
  ├─ /probe, /probe/stream   — evaluate a FEN, rank every legal move
  ├─ /admin, /admin/cache/*  — cache dashboard + stats API
  └─ /openapi.yaml           — API specification
        │
        ▼
chesstb.open_tablebase(TABLEBASE_PATH)   (noobpwnftw's modified python-chess fork)
        │
        ▼
ChessTB tablebase files — local disk, or a remote http(s) URL (probed
in place over byte ranges by default, or downloaded and cached to local
disk per material — see remote/remote_direct.py, remote/remote_fallback.py,
and "Getting the tablebase files" below)
```

This covers the main explorer page's (`index.html`) module graph — see
[Project structure](#project-structure) below for the complete file set,
including `admin.js` (the `/admin` dashboard's client script) and
`utils.js` (a small shared helper).

Each module carries a file-level docstring/header comment describing its
own responsibilities, and the move-ranking algorithm itself — including
its treatment of the 50-move rule — is documented inline in `app.py`
above `evaluate_all_moves()` and the `_effective_move_wdl`/
`_effective_distance` helpers it calls.

---

## Prerequisites

- **Python 3.10+**
- **Git**, on your `PATH` — `pip install -r requirements.txt` fetches the
  `python-chess` fork directly from GitHub (`chess @ git+https://...`),
  which requires `git` to be installed even though the package itself is
  Python.
- **A ChessTB tablebase directory or URL** — either a local directory on
  disk, or an `http(s)://` base URL serving the same layout remotely with
  no local download (see [Getting the tablebase files](#getting-the-tablebase-files)).
  The app starts without one, but every probe will fail until
  `TABLEBASE_PATH` points at one of the two.
- A modern browser (the frontend uses native ES modules, `fetch`, and
  `ReadableStream`).

---

## Installation

1. **Create and activate a virtual environment:**

   ```bash
   python -m venv .venv
   source .venv/bin/activate      # Windows: .venv\Scripts\activate
   ```

2. **Install dependencies:**

   ```bash
   pip install -r requirements.txt
   ```

   This pulls in the **modified `python-chess` fork** (not the plain
   PyPI `chess` package; see the comments in `requirements.txt` for why
   that distinction matters).

3. **Get the tablebase files** — see the next section. If you're using the
   remote (no-download) option, there's nothing to fetch here at all —
   skip straight to step 4 and point `TABLEBASE_PATH` at the URL.

4. **Configure `config.py`** — open it and set `TABLEBASE_PATH` to the
   directory (or URL) from step 3:

   ```python
   TABLEBASE_PATH = "/data/chesstb/full"
   ```

   or, for the remote option:

   ```python
   TABLEBASE_PATH = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve"
   ```

   Every other setting in `config.py` has a sensible default and a
   comment explaining what it does — see
   [Configuration reference](#configuration-reference) for the complete
   list. Just open the file and edit the values directly.

5. **Run the app:**

   ```bash
   python app.py
   ```

   By default (`DEBUG = False` in `config.py`) this serves the app via
   **waitress**, a production-grade pure-Python WSGI server — see
   [Running in production](#running-in-production) below. Set
   `DEBUG = True` in `config.py` instead if you want Flask's own dev
   server (auto-reload, interactive debugger) for local development.

6. Open **http://127.0.0.1:5000** in your browser.

---

## Getting the tablebase files

ChessTB tablebase files are available two ways:

### Option A — Remote, downloaded on demand (recommended)

The full ChessTB set is published as a Hugging Face storage bucket,
browsable at:

```
https://huggingface.co/buckets/noobpwnftw/chesstb
```

with `wdl/`, `dtc/`, and `dtm50/` subdirectories laid out exactly like the
local directory structure below. Buckets aren't versioned the way
regular Hub repos are, so there's no branch segment — the raw file bytes
for that same folder are served from `/resolve`
mirroring how a normal repo's `/blob/<path>` pairs with its
`/resolve/<path>`. Point `TABLEBASE_PATH` straight at the `/resolve`
URL:

```python
TABLEBASE_PATH = "https://huggingface.co/buckets/noobpwnftw/chesstb/resolve"
```

and the app probes tables over HTTP. `REMOTE_MODE` picks how:

- **`"direct"` (default)** — `remote/remote_direct.py` probes the remote
  tables **in place**, fetching only the `REMOTE_PAGE_SIZE_BYTES`-sized
  byte ranges each probe actually reads and keeping them in an in-memory
  LRU bounded by `REMOTE_PAGE_CACHE_BYTES`. Nothing is written to disk.
  This uses `chess.chesstb`'s table-source seam
  (`Tablebase.WDL_FILE` / `_TableFile._open_source`); if your installed
  fork predates it, the app logs that and falls back to `"download"`.
- **`"download"`** — `remote/remote_fallback.py` fetches each table
  **in full** the first time a probe touches its material and caches it
  in a temporary local directory (bounded by
  `REMOTE_PAGE_CACHE_BYTES` as an on-disk budget, evicting
  least-recently-used files, removed entirely when the app stops). Every
  probe after the first is then a local mmap read.

`"direct"` is the better default for browsing across many materials, which
is what this app does. Prefer `"download"` when you hammer a handful of
materials in one long session, or on a high-latency link: a ChessTB probe
is not a narrow read — a dropped-frame table is reconstructed by walking
its children, and pawn positions reach promotion sub-tables — so one cold
probe can open several materials and issue several fetches against each.
That is also why `REMOTE_PAGE_SIZE_BYTES` should stay large. See each
module's docstring for the full design.

This is a good fit for a machine that doesn't have (or doesn't want to
dedicate) a couple of terabytes of local disk for the full tablebase set —
at the cost of probe latency on first touch of any given material
(depending on your connection to the CDN), some temporary local disk
usage for whichever material you've actually probed this session, and of
course requiring a connection at all. `git`/`chess.chesstb` install
requirements are unaffected; remote mode only additionally needs the
`requests` package (see `requirements.txt`).

### Option B — Local directory, over FTP

The same tables are also distributed over FTP for a fully local, offline
setup:

```
ftp://chessdb:chessdb@ftp.chessdb.cn/pub/chesstb/
```

Any FTP client works, for example:

```bash
# lftp
lftp -e "mirror --parallel=4 /pub/chesstb/ /data/chesstb/full; quit" \
     ftp://chessdb:chessdb@ftp.chessdb.cn

# curl (single file)
curl "ftp://chessdb:chessdb@ftp.chessdb.cn/pub/chesstb/<path-to-file>" -o <local-file>
```

Tablebase sets are large and grow quickly with piece count — check
available disk space before mirroring the full archive, and consider
mirroring only the subsets (piece counts) you need. Point
`TABLEBASE_PATH` at whichever directory you end up with.

---

However you set it, if `TABLEBASE_PATH` is unset, missing/unreachable, or
points at a location with no usable tables, the app still starts (with a
warning in the logs) — every `/probe` request will then return an error,
and `/health` reports `"degraded"`.

---

## Configuration reference

All configuration lives in **`config.py`**, as plain Python values. Open
it and edit the settings directly — each one has a comment above it
explaining what it does. The table below is the complete reference.

| Setting                     | Default          | Description |
|-----------------------------|-------------------|-------------|
| `TABLEBASE_PATH`            | `""`              | Directory containing your ChessTB tablebase files, **or** an `http(s)://` base URL serving the same layout remotely (e.g. a Hugging Face storage bucket — see [Getting the tablebase files](#getting-the-tablebase-files)). Required for probing to work. |
| `DEBUG`                     | `False`           | `True` runs `app.py` via Flask's own dev server (auto-reload, detailed tracebacks) instead of waitress. Leave `False` — which serves via waitress — for anything reachable from another machine. See [Running in production](#running-in-production). |
| `HOST`                      | `"127.0.0.1"`     | Interface the server (waitress, or the dev server if `DEBUG = True`) binds to. |
| `PORT`                      | `5000`            | Port the server listens on. |
| `WAITRESS_THREADS`          | `8`               | Worker threads in waitress's request-handling pool. Only relevant when `DEBUG = False`. Needs to be more than 1 so a long-lived `/probe/stream` connection can't block other requests. |
| `PROBE_THREADS`             | `None` (→ `min(16, cpu*2)`) | Worker threads in the probe thread pool used to evaluate a position's legal moves in parallel. Left as `None` to scale with the host machine automatically; set an explicit integer to override. |
| `PROBE_PARALLEL_THRESHOLD`  | `4`               | Minimum number of child positions before probing switches from sequential to the thread pool. |
| `PROBE_TIMEOUT_SECS`        | `30`              | Wall-clock timeout for a batch of parallel child probes. Also bounds how long a request waits on another thread's in-flight probe of the same FEN before giving up with a retryable `probe_timeout` error. |
| `EVALUATE_CACHE_SIZE`       | `4096`            | Max entries in the root-FEN result cache (full JSON responses). |
| `PROBE_CACHE_SIZE`          | `16384`           | Max entries in the child-position probe cache (raw WDL/DTZ/DTM tuples). |
| `BLOCK_CACHE_BYTES`         | `67108864` (64 MiB) | Size, in bytes, of `chesstb`'s own internal cache of decoded/decompressed tablebase blocks (shared across the WDL/DTC/DTM50 tables). Raising this trades RAM for fewer repeated disk reads/HTTP fetches + decompressions across a session — most worthwhile when `PROBE_PARALLEL_THRESHOLD` is set high enough that probing runs mostly serially. |
| `REMOTE_MODE`               | `"direct"`        | **Remote `TABLEBASE_PATH` only.** `"direct"` probes the remote tables in place over byte ranges (nothing written to disk); `"download"` fetches each table in full on first touch and caches it on local disk. Falls back to `"download"` if the installed `chess.chesstb` has no table-source seam. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_CACHE_BYTES`   | `134217728` (128 MiB) | **Remote `TABLEBASE_PATH` only.** Soft budget, in bytes, shared across every remote table opened this session: the in-memory page cache in `"direct"` mode, the on-disk cache of whole downloaded files in `"download"` mode. See [Getting the tablebase files](#getting-the-tablebase-files). |
| `REMOTE_PAGE_SIZE_BYTES`    | `262144` (256 KiB) | **Remote `TABLEBASE_PATH` only.** Size, in bytes, of one page. In `"direct"` mode this is the granularity of every fetch, so it trades over-fetching against round trips per probe; in `"download"` mode it is only the chunk size used while streaming a full file down. |
| `REMOTE_TIMEOUT_SECS`       | `20`              | **Remote `TABLEBASE_PATH` only.** Per-HTTP-request timeout for existence/size checks and the download itself. |
| `REMOTE_MAX_RETRIES`        | `3`               | **Remote `TABLEBASE_PATH` only.** Attempts for a single remote request before it's treated as failed. |

Invalid values (wrong type, out of range) cause the app to log an error
and exit at startup rather than run with a silently-wrong configuration.

---

## Running in production

`python app.py` serves the app via **[waitress](https://docs.pylonsproject.org/projects/waitress/)**,
a production-grade, pure-Python WSGI server, whenever `DEBUG` in
`config.py` is `False` (the default) — no separate `gunicorn`/`waitress`
command or extra process is needed on top of the app itself. Setting
`DEBUG = True` in `config.py` switches `app.py` over to Flask's own dev
server instead (auto-reload + interactive debugger), which is meant for
local development only and should not be used for anything reachable
from another machine.

```bash
# Production (default): DEBUG = False in config.py — serves via waitress
python app.py

# Local development: set DEBUG = True in config.py first, then run the
# same command — Flask dev server, auto-reload + debugger
python app.py
```

- `HOST` / `PORT` control the interface and port waitress binds to, same
  as for the dev server.
- `WAITRESS_THREADS` (default `8`) sizes waitress's own pool of
  request-handling threads. This needs to be more than 1 for the same
  reason the dev server needs `threaded=True`: `/probe/stream` holds a
  connection open via Server-Sent Events for the whole duration of a
  probe, and a single-threaded server would let that one connection block
  every other request — including the browser's own concurrent requests
  for CSS/JS/piece images on first page load. It's independent of
  `PROBE_THREADS`, which sizes the thread pool used internally to
  parallelise tablebase probing rather than to serve HTTP requests.
- Waitress handles `/probe/stream`'s streamed response natively; no
  additional configuration is needed for SSE to work correctly.
- This app has no built-in authentication (see
  [Security notes](#security-notes)) — if you need to reach it from
  another machine, put access control in front of it rather than just
  widening `HOST`.

---

## Usage guide

- **Set a position** — type or paste a FEN into the FEN box and press
  `Enter` or **Apply**. The move rankings and best-move arrows update
  automatically. The castling-availability field must be `-`: the loaded
  tablebases are generated on the assumption that neither side retains the
  right to castle, so a FEN granting castling rights to either side is
  rejected rather than evaluated.
- **Edit the board directly** — drag pieces around the board, drag a piece
  off the board to remove it, or click a spare piece in either tray and
  then click a square to place it (click again / press `Esc` to cancel).
  Board edits reset the current move line the same way **Clear** does.
- **Lock the board** — click the padlock button beside the FEN box to
  restrict drag-and-drop, click-to-move, and the spare-piece trays to
  legal moves for the side to move; the button turns gold while active.
  Click again to unlock. The choice is remembered locally across visits.
  Starting auto-play locks the board automatically for the run (unless
  already locked) and disables the padlock button until it stops.
- **Play moves** — click any move in one of the three ranked tables to
  play it, or drag a piece on the board through a legal move.
- **Navigate history** — **Back**/**Forward** buttons or `←`/`→`, or click
  any move in the PGN panel to jump straight to that point in the line.
- **Auto-play** — click the ▶ button above the DTC, DTM, or DTM50 columns
  to have the app play that metric's best move on a timer (delay set by
  **Autoplay Delay** in settings, 1.25s by default); click again (now
  showing ■) to stop. Any manual navigation stops auto-play.
- **Import/export a game** — **Import** in the PGN panel opens a dialog to
  paste PGN text and jump to any parsed move; **Copy** copies the current
  line as PGN with standard headers.
- **Export the move table** — the **CSV** button downloads the current
  DTC/DTM/DTM50 rankings as a CSV file.
- **Share a position** — the URL updates live with `#fen=...`; sending
  that link reproduces the exact position.
- **Change the look** — the ⚙ button in the header opens board and
  piece-set pickers, a **Show Root Row** switch for the results table, and
  an **Autoplay Delay** slider; your choices are remembered across visits.
- **Admin dashboard** — the ⊙ icon opens `/admin`, showing live hit-rate
  stats for both caches and the thread-pool configuration, auto-refreshing
  every 5 seconds.

---

## API

The full HTTP API — `/probe`, `/probe/stream`, `/health`,
`/admin/cache/stats`, `/admin/cache/clear` — is documented as an OpenAPI
3.0 specification served live by the running app at:

```
http://127.0.0.1:5000/openapi.yaml
```

`openapi.yaml` documents every endpoint's request/response shapes; the
ranking algorithm behind `moves_dtz` / `moves_dtm` / `moves_dtm50` is
documented inline in `app.py`'s own module docstring and its
`evaluate_all_moves()` function.

Quick example:

```bash
curl -X POST http://127.0.0.1:5000/probe \
     -H "Content-Type: application/json" \
     -d '{"fen": "4k3/8/8/8/8/8/8/4K2R w - - 0 1"}'
```

---

## Project structure

```
.
├── LICENSE                 # This project's own license (see file for scope — does not cover bundled third-party assets)
├── THIRD_PARTY_LICENSES.md # Licenses/attributions for bundled third-party code, fonts, piece sets, and board images
├── app.py                  # Flask backend: routes, probing, caching
├── config.py               # All configuration, as plain Python values — see "Configuration reference"
├── openapi.yaml            # OpenAPI 3.0 specification, served at /openapi.yaml
├── requirements.txt
├── README.md
├── remote/
│   ├── remote_source.py     # Generic HTTP byte-range client shared by both remote backends — see its own module docstring
│   ├── remote_direct.py     # REMOTE_MODE="direct": probe remote tables in place over byte ranges — see its own module docstring
│   └── remote_fallback.py   # REMOTE_MODE="download": whole-file download, cached to local disk on first touch — see its own module docstring
├── templates/
│   ├── index.html          # Main explorer UI
│   └── admin.html          # Cache dashboard
└── static/
    ├── css/main.css        # All application styling
    ├── js/
    │   ├── app.js           # Bootstrap
    │   ├── board.js         # Chessground wrapper (drag/drop, history, arrows)
    │   ├── tablebase.js      # /probe/stream client + results rendering
    │   ├── theme.js          # Board / piece-set theming
    │   ├── ui.js             # UI controller (FEN box, PGN, auto-play, settings)
    │   ├── admin.js          # Admin dashboard client
    │   └── utils.js          # Shared helpers (debounce)
    ├── pieces/{cburnett,kosal,maestro}/   # Piece-set SVGs
    ├── boards/{blue3,leather,wood4}.*     # Board images
    └── vendor/               # Third-party libraries (Chessground, chess.js, fonts)
```

---

## Security notes

- This app is designed for **single-user, local use**, and has **no
  built-in authentication anywhere**, including `/admin/cache/*`. It's
  meant to be run on your own machine, bound to `127.0.0.1` (the
  default), and not exposed to a shared or untrusted network. If you do
  need to reach it from another machine, put your own access control
  (a reverse proxy with auth, a VPN, a firewall rule) in front of it —
  the app itself won't gate any request.
- The app serves via **waitress**, a production-grade WSGI server, by
  default (`DEBUG = False` in `config.py`) — see [Running in production](#running-in-production).
  Only set `DEBUG = True` (which switches to Flask's own dev server) for
  local development, never for anything reachable from another machine.
- A `Content-Security-Policy` is set on every response: scripts and fonts
  are restricted to `'self'` (no inline scripts, no third-party sources);
  styles allow `'self'` plus `'unsafe-inline'` (needed for a handful of
  inline `style="..."` attributes in `index.html`/`admin.html`); images
  allow `'self'` plus `data:`; `connect-src`/`default-src` are `'self'`
  too, so `fetch`/SSE calls can only reach this same origin. `object-src`,
  `base-uri`, and `form-action` are locked to `'none'`/`'self'`/`'self'`,
  and `frame-ancestors 'none'` is the CSP-native counterpart to the
  `X-Frame-Options: DENY` set alongside it. `X-Content-Type-Options:
  nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` are set
  too. Request bodies are capped at 4 KB.
- `config.py` holds no secrets — there's no API key, password, or
  credential anywhere in this app — so it's safe to commit as-is and
  edit in place.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every probe returns "Position not covered by the loaded tablebase." | `TABLEBASE_PATH` is unset, wrong, or the tablebase set doesn't cover that many pieces. Check the startup log for "Tablebase opened at: ..." or a warning. |
| A FEN is rejected with "Invalid castling availability" (backend) or "Castling rights are not supported" (board UI) | The submitted castling-availability field is something other than `-`. The loaded tablebases carry no castling-rights information, so this field must always be `-`, even if the king and rook in the position happen to sit on their home squares. |
| `/health` returns `503 degraded` | The tablebase failed to open — check `TABLEBASE_PATH` and file permissions. |
| `ModuleNotFoundError: No module named 'chess.chesstb'` | Plain PyPI `chess` was installed instead of the fork. Re-run `pip install -r requirements.txt` and confirm it pulled `chess` from `noobpwnftw/python-chess` (the `add-chesstb-tablebases` branch) rather than plain PyPI `chess` — see the note at the top of `requirements.txt`. |
| `ModuleNotFoundError: No module named 'config'` | `config.py` is missing from alongside `app.py`. It ships with the repository — if it was deleted or moved, restore it from the repo (or re-clone) and re-apply any edits, such as `TABLEBASE_PATH`. |
| App logs `Configuration error: ...` and exits immediately | A value in `config.py` is the wrong type or out of range for that setting (e.g. a string where an integer is expected, or a negative cache size) — the error message names which setting and why. Fix it in `config.py` and re-run `python app.py`. |
| Admin dashboard panels stuck on "Loading…" | Check the browser console for a CSP violation, or that the app itself is actually running and reachable at the URL you're loading `/admin` from. |
| A drag, drop, or spare-piece placement on the board is silently rejected | The board is Locked — the padlock button beside the FEN box is highlighted gold. Lock restricts board interaction to legal moves and disables the spare-piece trays and off-board drops; click the padlock again to unlock and edit freely. |
| Probing feels slow on positions with many legal moves, or doesn't scale with `PROBE_THREADS` | Check the startup log for `chess.chesstb: 'lz4' package not installed` — without it, decompression runs in pure Python and holds the GIL, so `PROBE_THREADS` can't achieve real parallelism. `pip install lz4` (already in `requirements.txt`) and restart. Otherwise, tune `PROBE_THREADS`, `PROBE_PARALLEL_THRESHOLD`, and `PROBE_TIMEOUT_SECS` in `config.py`. Note that `chess.chesstb` has no locking around opening a not-yet-seen tablebase, so several threads racing to open the same never-before-seen material can each do a redundant read — this only affects the very first probe against any given material. |
| App logs `chess.chesstb: 'lz4' package not installed` at startup | Cosmetic warning, not an error — the app falls back to the pure-Python decoder and keeps working, just slower. `pip install lz4` and restart to pick it up. |
| `ModuleNotFoundError: No module named 'waitress'` | Your environment predates the waitress dependency — re-run `pip install -r requirements.txt` to pick it up. `app.py` imports waitress unconditionally at the top of the file, before `config.DEBUG` is even read, so setting `DEBUG = True` does **not** avoid this — waitress has to be installed either way. |
| Every probe on a remote `TABLEBASE_PATH` returns "Position not covered..." or `/health` is `degraded` | Confirm the URL is reachable and correct (try opening `TABLEBASE_PATH/wdl/KQK.lzw` — or any small material's `.lzw` — directly in a browser). Check the startup log's "Tablebase opened remotely at: ..." line (or a warning in its place) for the actual failure. |
| A probe occasionally returns `503` with `error_code: "probe_timeout"` | Another concurrent request was already probing the same position and didn't finish within `PROBE_TIMEOUT_SECS`. This is transient and retryable — the original probe has usually landed in the child-probe cache by the time you retry, so the retry is cheap. Frequent occurrences suggest raising `PROBE_TIMEOUT_SECS`, or that a slow remote `TABLEBASE_PATH` is the underlying bottleneck. |
| Remote probing feels slow, or repeated probes against the same material keep hitting the network | Check `REMOTE_TIMEOUT_SECS`/`REMOTE_MAX_RETRIES` aren't causing retries on a slow link, and consider raising `REMOTE_PAGE_CACHE_BYTES` — a too-small budget evicts cached pages (`"direct"`) or downloaded files (`"download"`) before later probes can reuse them. `GET /admin/cache/stats` surfaces this as `tablebase_cache.remote_page_cache` or `.remote_disk_cache` respectively, alongside `tablebase_remote_mode`. On a high-latency link also try raising `REMOTE_PAGE_SIZE_BYTES`, or `REMOTE_MODE = "download"`. See [Configuration reference](#configuration-reference). |

---

## Credits

- Tablebase data & format: [ChessTB / chessdb.cn](https://www.chessdb.cn/)
- Tablebase probing support: [noobpwnftw/python-chess (`add-chesstb-tablebases` branch)](https://github.com/noobpwnftw/python-chess/tree/add-chesstb-tablebases), a fork of [niklasf/python-chess](https://github.com/niklasf/python-chess)
- Remote (URL) `TABLEBASE_PATH` support for the fork's `chess.chesstb` module — see `remote/remote_source.py`, `remote/remote_direct.py` and `remote/remote_fallback.py`
- Board UI: [Chessground](https://github.com/lichess-org/chessground)
- Move generation/validation on the client: [chess.js](https://github.com/jhlywa/chess.js)
- Production WSGI server: [waitress](https://docs.pylonsproject.org/projects/waitress/)
- Piece sets and board images are the commonly-used community sets found
  in most web chess UIs (e.g. `cburnett`); verify their individual
  licenses before redistributing this project.

---

## License

This project's own code — `app.py`, `config.py`, `static/js/*.js`,
`static/css/main.css`, and `templates/*.html` — is released under the MIT
license; see [`LICENSE`](LICENSE) for the full text.

That license does **not** extend to the third-party assets and libraries
bundled under `static/vendor/`, `static/pieces/`, and `static/boards/`, or
to the `chess`/`chess.chesstb` dependency installed via `requirements.txt`
— those retain their own licenses. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the full list,
including several components (a GPL-3.0-or-later dependency,
AGPL-3.0-or-later board images, and a non-commercial-only piece set) that
place real restrictions on how this project as a whole may be
redistributed. Read that file before you redistribute, sell, or deploy a
public copy of this project.

