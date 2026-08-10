# Third-Party Licenses & Attributions

ChessTB Explorer's own code (see `LICENSE`) bundles or depends on the
third-party components listed below. This file documents each one so you
know what you're redistributing if you ship, sell, or publicly deploy this
project. **This is not legal advice** — if you plan to distribute this
software commercially or publicly, have the flagged items below reviewed
by a lawyer.

## Read this first — four components with real restrictions

1. **Backend: `python-chess` fork (`chess` / `chess.chesstb`)** —
   **GPL-3.0-or-later**. `app.py` imports the base `chess` package
   directly (`import chess`, for `chess.Board` and move generation) and
   also imports `chess.chesstb` directly for tablebase probing — see
   `requirements.txt`. Under the FSF's interpretation of the GPL,
   directly importing a GPL-licensed library like this generally makes
   the combined program a "derivative work" that must be distributed
   under GPL-3.0 terms if you distribute it at all. Running the app
   privately/internally isn't "distribution" and doesn't trigger this. If
   you plan to give copies of this app to others, plan around GPL-3.0
   compliance for the whole thing.

2. **Board textures (`static/boards/blue3.jpg`, `wood4.jpg`, `leather.jpg`)** —
   **AGPL-3.0-or-later**, as part of lichess.org's `lila` codebase
   (`public/images/board`, credited to the lila authors and pirouetti). AGPL
   extends copyleft to network use — offering the app as a network service
   can itself count as distribution under AGPL. If you deploy this
   publicly, treat these three images the same way you'd treat any other
   AGPL-licensed asset.

3. **"Maestro" piece set (`static/pieces/maestro/`)** — **CC BY-NC-SA 4.0**,
   by sadsnake1, **non-commercial use only**. If this project is used
   commercially, either remove this piece set or get separate permission
   from the author.

4. **Frontend: Chessground (`static/vendor/chessground.min.js`,
   `chessground.base.css`)** — **GPL-3.0-or-later**. The chess board UI is
   [Chessground](https://github.com/lichess-org/chessground) (10.1.1), the
   board component developed for lichess.org. Per the maintainers: when
   Chessground is used in a website, "your combined work may be
   distributed only under the GPL. You must release your source code to
   the users of your website." Unlike the backend `python-chess` concern
   above, which only bites if you hand out copies of the *server* code,
   this one applies **the moment the app is served to any user who isn't
   you** — including a locally-hosted deployment accessed by anyone else
   over a network. Running it purely for yourself, never distributed, is
   fine under any license. This is a materially stricter condition than a
   permissively-licensed frontend library would carry, because it reaches
   the browser and every user of the app, not just the backend. If you
   plan to distribute this project (give it away, sell it, or deploy it
   somewhere other users can reach it) with Chessground bundled, the
   combined client-served frontend needs to be made available under
   GPL-3.0 terms — review `LICENSE` for compatibility, and treat this as a
   legal/business decision, not just an engineering one, before shipping.

The other components below (chess.js, the fonts, the `cburnett` and
`kosal` piece sets, and the other Python dependencies) are permissively
licensed and don't carry these restrictions.

---

## Frontend libraries — `static/vendor/`

| File | Library | Version | License | Author / Source |
|---|---|---|---|---|
| `chessground.min.js`, `chessground.base.css` | Chessground | 10.1.1 | **GPL-3.0-or-later** ([full text](https://github.com/lichess-org/chessground/blob/v10.1.1/LICENSE)) | [lichess.org / Chessground](https://github.com/lichess-org/chessground) — see "Read this first" item 4 above |
| `chess-1.4.0.esm.js` | chess.js | 1.4.0 | BSD-2-Clause | [Jeff Hlywa](https://github.com/jhlywa/chess.js) |

## Fonts — `static/vendor/fonts/`

| File(s) | Typeface | License | Author / Source |
|---|---|---|---|
| `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2` | Inter | SIL Open Font License 1.1 | [Rasmus Andersson](https://rsms.me/inter/) |
| `JetBrainsMono-Regular.woff2`, `JetBrainsMono-Medium.woff2` | JetBrains Mono | SIL Open Font License 1.1 | [JetBrains](https://www.jetbrains.com/lp/mono/) |

## Chess piece sets — `static/pieces/` (via lichess.org)

| Directory | License | Author | Source |
|---|---|---|---|
| `cburnett/` | GPL-2.0-or-later | Colin M.L. Burnett | [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) |
| `kosal/` | CC BY 4.0 | Philatype | [philatype/kosal](https://github.com/philatype/kosal), via lila |
| `maestro/` | **CC BY-NC-SA 4.0 — non-commercial only** | sadsnake1 | [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) |

## Board textures — `static/boards/` (via lichess.org)

| File | License | Author | Source |
|---|---|---|---|
| `blue3.jpg`, `wood4.jpg`, `leather.jpg` | AGPL-3.0-or-later | the lila authors and pirouetti | [lila COPYING.md](https://github.com/lichess-org/lila/blob/master/COPYING.md) |

## Backend (Python) dependencies — `requirements.txt`

| Package | License | Notes |
|---|---|---|
| `chess` (installed from `noobpwnftw/python-chess`, `add-chesstb-tablebases` branch) | GPL-3.0-or-later | Fork of [niklasf/python-chess](https://github.com/niklasf/python-chess); both the base `chess` package and `chess.chesstb` are imported directly by `app.py`. See callout above. |
| Flask | BSD-3-Clause | [pallets/flask](https://github.com/pallets/flask) |
| waitress | ZPL 2.1 (permissive) | [Pylons/waitress](https://github.com/Pylons/waitress) |
| lz4 | BSD-3-Clause | [python-lz4/python-lz4](https://github.com/python-lz4/python-lz4) |
| requests | Apache-2.0 | [psf/requests](https://github.com/psf/requests); used by `remote/remote_source.py` (and, through it, `remote/remote_fallback.py`) only when `TABLEBASE_PATH` is a remote `http(s)://` URL. |

## Not third-party

The favicon in `templates/index.html` is an inline, self-authored SVG data
URI — no external asset. Everything under `README.md` and the
application code itself (`app.py`, `config.py`, `static/js/*.js`,
`static/css/main.css`, `templates/*.html`, `remote/`) is original,
written by Claude (Anthropic) for this project and covered by `LICENSE`.

## Tablebase data

Not covered here: this project only *displays* results from ChessTB
tablebase files you supply yourself (see README.md → "Getting the
tablebase files"). No tablebase data is bundled with the app, so its
licensing is outside the scope of this document.
