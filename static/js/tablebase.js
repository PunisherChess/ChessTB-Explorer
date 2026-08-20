/**
 * tablebase.js — /probe/stream SSE client and results renderer
 *
 * Owns the SSE client for /probe/stream and all rendering of the three
 * ranked move tables (DTZ / DTM / DTM50), including:
 *   - setResultHandler(fn) — callback after each successful probe, used by
 *     ui.js as its auto-play hook.
 *   - Prefetch on hover: warms the cache for the child position of a
 *     hovered move.
 *   - The frozen Root row: the current position's own score for each
 *     metric, pinned above the ranked child moves (see _renderRootRow),
 *     shown/hidden per the persisted "Show Root Row" setting (see
 *     setShowRootRow/getShowRootRow in the Public API).
 *   - A coverage indicator: distinct UI when error_code === "missing_table".
 *   - An info dot on draws by insufficient material: keeps the score cell
 *     reading "Draw" and moves the reason into a hover tooltip.
 *   - A warning dot beside a move's score when that outcome is a cursed
 *     win or blessed loss, with a hover tooltip explaining the
 *     50-move-rule nuance.
 *   - CSV export of the current move table.
 *   - A result cache keyed by FEN, so revisiting an already-probed position
 *     (e.g. clicking back into the move line, or the PGN panel) reuses the
 *     cached result instead of issuing a new /probe/stream call.
 *   - New probes blank the table immediately (the same look as first
 *     launch) instead of leaving the previous position's rows on screen to
 *     pulse via the is-loading shimmer until the new probe resolves.
 */

// ── Bounded LRU cache ────────────────────────────────────────────────────
// A plain Map with no eviction and no size cap grows for the lifetime of
// the tab if someone leaves it open and browses a lot of positions. This
// wraps a Map (insertion order = recency order) with evict-oldest-on-
// overflow and refresh-on-read, capped at a sane size — same get/has/set/
// delete surface as Map, so it's a drop-in replacement.
const _MAX_CACHE_ENTRIES = 500;

class _BoundedCache {
    constructor(maxSize) {
        this._maxSize = maxSize;
        this._map = new Map();
    }
    has(key) { return this._map.has(key); }
    get(key) {
        if (!this._map.has(key)) return undefined;
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);   // refresh recency
        return value;
    }
    set(key, value) {
        this._map.delete(key);
        this._map.set(key, value);
        if (this._map.size > this._maxSize) {
            this._map.delete(this._map.keys().next().value);   // evict oldest
        }
    }
    delete(key) { this._map.delete(key); }
}

const Tablebase = (() => {

    let _currentController = null;
    let _probeSeq    = 0;
    let _onMoveSelect = null;
    let _onResult     = null;
    let _lastData     = null;
    let _lastFen      = null;     // FEN of the currently-applied results — used for CSV
                                   // export and to let callers confirm getLastData() actually
                                   // matches a given position rather than one probed earlier
    let _prefetchCache = new _BoundedCache(_MAX_CACHE_ENTRIES);   // child_fen → probe result data
    let _resultCache   = new _BoundedCache(_MAX_CACHE_ENTRIES);   // fen → last probe result

    // ── Show Root Row setting ────────────────────────────────────────────────
    // Persisted client-side preference (default OFF), following the same
    // per-module localStorage convention theme.js uses for board/piece-set.
    // Purely a rendering toggle — never affects probing/caching.
    const _LS_SHOW_ROOT_ROW = 'chesstb_show_root_row';

    function _readShowRootRowPref() {
        try {
            const raw = localStorage.getItem(_LS_SHOW_ROOT_ROW);
            return raw === null ? false : raw === 'true';
        } catch (_) {
            return false;   // storage unavailable — default OFF
        }
    }

    let _showRootRow = _readShowRootRowPref();

    const _ROOT_LABEL = 'Position';   // shown in the move column for the frozen Root row

    // ── Info / warning dot icon ────────────────────────────────────────────────
    // Built as a tiny vector graphic instead of a text glyph ('i') set in an
    // 8px font inside a 13px circle: at that size a font glyph is at the
    // mercy of the browser's hinting/baseline metrics and comes out visibly
    // off-centre. A hand-built SVG (circle background + "i" drawn from a
    // dot + rounded rect) is centred exactly by construction.
    //
    // Used for both the insufficient-material info dot and the
    // cursed-win/blessed-loss warning flag (see _createMoveCells below),
    // which read identically at a glance — only the hover title and the
    // `prefix`-selected CSS classes ('info-dot__*' vs 'warning-dot__*')
    // tell the two apart.
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function _dotIconSvg(prefix) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add(`${prefix}__icon`);

        const bg = document.createElementNS(SVG_NS, 'circle');
        bg.setAttribute('cx', '8');
        bg.setAttribute('cy', '8');
        bg.setAttribute('r', '8');
        bg.classList.add(`${prefix}__bg`);

        const pip = document.createElementNS(SVG_NS, 'circle');
        pip.setAttribute('cx', '8');
        pip.setAttribute('cy', '4.3');
        pip.setAttribute('r', '1.05');
        pip.classList.add(`${prefix}__mark`);

        const stem = document.createElementNS(SVG_NS, 'rect');
        stem.setAttribute('x', '7.1');
        stem.setAttribute('y', '6.5');
        stem.setAttribute('width', '1.8');
        stem.setAttribute('height', '6.2');
        stem.setAttribute('rx', '0.9');
        stem.classList.add(`${prefix}__mark`);

        svg.append(bg, pip, stem);
        return svg;
    }

    // ── WDL helpers ───────────────────────────────────────────────────────────
    // Maps a raw wdl integer (2/1/0/-1/-2) to the same outcome strings used
    // throughout moves_dtz/moves_dtm/moves_dtm50 entries ("win"/"cursed_win"/
    // "draw"/"blessed_loss"/"loss"), so the Root row and CSV export can share
    // all the same outcome-based formatting/coloring as a real move entry.
    function _wdlToOutcome(wdl) {
        return { 2:'win', 1:'cursed_win', 0:'draw', '-1':'blessed_loss', '-2':'loss' }[wdl] ?? 'unknown';
    }
    function _pliesText(n) {
        const a = Math.abs(n);
        return a === 1 ? `${a} ply` : `${a} plies`;
    }
    function _isWin(o)  { return o === 'win'  || o === 'cursed_win'; }
    function _isLoss(o) { return o === 'loss' || o === 'blessed_loss'; }
    // CSV plies for a move/root entry: 'N/A' rather than a bare 0 when
    // available is false, so an unavailable metric doesn't read in the
    // exported file as if it were real 0-ply data.
    function _csvPlies(entry) { return entry.available === false ? 'N/A' : entry.plies; }

    // ── Progress bar ──────────────────────────────────────────────────────────
    function _showProgress(completed, total) {
        const bar = document.getElementById('probe-progress');
        if (!bar) return;
        bar.style.display = 'block';
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        bar.querySelector('.probe-progress__fill').style.width = pct + '%';
        const lbl = document.getElementById('probe-progress-label');
        if (lbl) lbl.textContent = total > 0 ? `Probing ${completed}/${total}…` : 'Probing…';
    }
    function _hideProgress() {
        const bar = document.getElementById('probe-progress');
        if (bar) bar.style.display = 'none';
        const lbl = document.getElementById('probe-progress-label');
        if (lbl) lbl.textContent = '';
    }

    // ── Cell rendering ────────────────────────────────────────────────────────
    // interactive=false is used for the Root row (see _renderRootRow below):
    // same move+score cell shape/formatting as a real move, but no data-san/
    // child-fen (it isn't a move a person can click or hover to prefetch) —
    // .is-root in main.css only drops the pointer cursor, the text itself
    // stays styled like a real move. Warning/info dots are unaffected by
    // this flag and keep their current placement on the score cell.
    function _createMoveCells(entry, groupClass, withLabel, interactive = true) {
        if (!entry) {
            const em = document.createElement('td');
            em.className = `${groupClass} col-move is-empty-cell`;
            em.textContent = '—';
            const es = document.createElement('td');
            es.className = 'col-score is-empty-cell';
            es.textContent = '—';
            return [em, es];
        }
        const moveCell = document.createElement('td');
        moveCell.className = `${groupClass} col-move${interactive ? '' : ' is-root'}`;
        if (interactive) {
            moveCell.dataset.san      = entry.san;
            moveCell.dataset.childFen = entry.child_fen || '';
        }
        moveCell.textContent = entry.san;

        let scoreText;
        if (entry.is_mate)                                    scoreText = 'Checkmate';
        else if (entry.draw_reason === 'stalemate')           scoreText = 'Stalemate';
        else if (entry.outcome === 'draw')                    scoreText = 'Draw';
        else if (entry.outcome === 'unknown')                 scoreText = 'Unknown';
        else if (entry.outcome === 'not_available')           scoreText = 'Not Available';
        else if (!entry.available)                            scoreText = withLabel
            ? (_isWin(entry.outcome) ? 'Win (Not Available)' : 'Loss (Not Available)')
            : 'N/A';
        else if (withLabel && _isWin(entry.outcome))          scoreText = `Win in ${_pliesText(entry.plies)}`;
        else if (withLabel && _isLoss(entry.outcome))         scoreText = `Loss in ${_pliesText(entry.plies)}`;
        else                                                   scoreText = _pliesText(entry.plies);

        const scoreCell = document.createElement('td');
        scoreCell.className         = `col-score${entry.is_mate ? ' is-mate' : ''}`;
        scoreCell.dataset.outcome   = entry.outcome;
        if (interactive) {
            scoreCell.dataset.san       = entry.san;
            scoreCell.dataset.childFen  = entry.child_fen || '';
        }
        scoreCell.textContent       = scoreText;

        // Cursed win / blessed loss flag — sits beside the score, same
        // spot as the insufficient-material info dot below, and looks
        // identical to it (see _dotIconSvg); this dot's hover title
        // is what explains *why* the result is flagged rather than a
        // plain win/loss. Shown on both ranked child rows and the Root
        // row — `interactive` only gates the data-san/child-fen
        // attributes above, not this indicator.
        if (entry.outcome === 'cursed_win' || entry.outcome === 'blessed_loss') {
            const warn = document.createElement('span');
            warn.className = 'warning-dot';
            warn.title      = entry.outcome === 'cursed_win'
                ? 'Cursed Win — a win in principle, but a draw under the 50-move rule.'
                : 'Blessed Loss — a loss in principle, but a draw under the 50-move rule.';
            warn.appendChild(_dotIconSvg('warning-dot'));
            scoreCell.appendChild(warn);
        }

        // Insufficient material still reads as plain "Draw" text (unlike
        // Stalemate, which is short enough to spell out inline) — the
        // reason shows up as a hover tooltip on this dot instead, so the
        // column never has to fit the long form.
        if (entry.draw_reason === 'insufficient_material') {
            const dot = document.createElement('span');
            dot.className = 'info-dot';
            dot.title      = 'Draw by Insufficient Material';
            dot.appendChild(_dotIconSvg('info-dot'));
            scoreCell.appendChild(dot);
        }
        return [moveCell, scoreCell];
    }

    // ── Table rendering ───────────────────────────────────────────────────────
    function _renderTable(movesDtz, movesDtm, movesDtm50) {
        const tbody      = document.getElementById('moves-tbody');
        const emptyState = document.getElementById('moves-empty-state');
        const countEl    = document.getElementById('move-count');
        const maxRows = Math.max(movesDtz.length, movesDtm.length, movesDtm50.length);

        if (maxRows === 0) {
            tbody.innerHTML = '';
            emptyState.style.display = 'flex';
            countEl.textContent = '';
            return;
        }

        emptyState.style.display = 'none';
        countEl.textContent = `${maxRows} legal move${maxRows === 1 ? '' : 's'}`;

        const fragment = document.createDocumentFragment();
        for (let i = 0; i < maxRows; i++) {
            const tr = document.createElement('tr');
            const rankCell = document.createElement('td');
            rankCell.className   = 'col-rank';
            rankCell.textContent = i + 1;
            tr.appendChild(rankCell);

            const dtzCells   = _createMoveCells(movesDtz[i]   || null, 'group-dtz',   false);
            const dtmCells   = _createMoveCells(movesDtm[i]   || null, 'group-dtm',   true);
            const dtm50Cells = _createMoveCells(movesDtm50[i] || null, 'group-dtm50', true);

            for (const cell of [...dtzCells, ...dtmCells, ...dtm50Cells]) tr.appendChild(cell);
            fragment.appendChild(tr);
        }
        tbody.innerHTML = '';
        tbody.appendChild(fragment);
    }

    // ── Root row ───────────────────────────────────────────────────────────────
    // Rebuilds the frozen Root row (see <thead> in index.html) from the
    // *position's own* wdl/dtz/dtm/dtm50 fields — not a moves_* array entry,
    // since it isn't a move. Always called from _applyResults() in the same
    // synchronous pass as _renderTable(), so the Root row and the ranked
    // child rows below it populate together rather than one appearing ahead
    // of the other. No-ops (and hides the row) when the "Show Root Row"
    // setting is off — see setShowRootRow().
    function _renderRootRow(data, maxRows) {
        const row = document.getElementById('root-row');
        if (!row) return;
        if (!_showRootRow) {
            row.classList.add('is-hidden');
            row.innerHTML = '';
            return;
        }
        row.classList.remove('is-hidden');

        // No legal moves and the position isn't a draw ⇒ the root itself is
        // checkmate. (wdl 0 with no moves is stalemate, which already reads
        // correctly as "Draw" through the normal outcome formatting below.)
        const rootIsMate = maxRows === 0 && data.wdl !== 0;

        // dtz/dtm fall back to _wdlToOutcome(data.wdl) even when
        // *_available is false — WDL alone already distinguishes win/
        // cursed_win/draw/blessed_loss/loss, so it's the exact fallback
        // bucket for the root's own metric too, same as for a move (see
        // evaluate_all_moves/_capped_wdl on the backend); only the plies
        // shown are gated on availability. dtm50 has no such fallback:
        // it carries its own rule50-aware WDL, unknowable from data.wdl,
        // so it's flatly "not_available" instead.
        const dtzEntry = {
            san: _ROOT_LABEL, plies: data.dtz_available ? data.dtz : 0,
            outcome: _wdlToOutcome(data.wdl), available: data.dtz_available,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        const dtmEntry = {
            san: _ROOT_LABEL, plies: data.dtm_available ? data.dtm : 0,
            outcome: _wdlToOutcome(data.wdl), available: data.dtm_available,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };
        const dtm50Entry = {
            san: _ROOT_LABEL, plies: data.dtm50_available ? data.dtm50[1] : 0,
            outcome: data.dtm50_available ? _wdlToOutcome(data.dtm50[0]) : 'not_available',
            available: data.dtm50_available,
            is_mate: rootIsMate, draw_reason: data.draw_reason, child_fen: null,
        };

        const cells = [
            ..._createMoveCells(dtzEntry,   'group-dtz',   false, false),
            ..._createMoveCells(dtmEntry,   'group-dtm',   true,  false),
            ..._createMoveCells(dtm50Entry, 'group-dtm50', true,  false),
        ];

        row.innerHTML = '';
        const rankCell = document.createElement('td');
        rankCell.className = 'col-rank';   // no index# on the Root row
        row.appendChild(rankCell);
        for (const cell of cells) row.appendChild(cell);
    }

    // Same pre-probe/blank shape as an unmatched _createMoveCells(null, …)
    // child cell — em-dash placeholders, not a hidden row (unless the
    // setting is off, in which case it's `.is-hidden` instead).
    function _blankRootRow() {
        const row = document.getElementById('root-row');
        if (!row) return;
        if (!_showRootRow) {
            row.classList.add('is-hidden');
            row.innerHTML = '';
            return;
        }
        row.classList.remove('is-hidden');
        row.innerHTML = '';
        const rankCell = document.createElement('td');
        rankCell.className = 'col-rank';
        row.appendChild(rankCell);
        for (const groupClass of ['group-dtz', 'group-dtm', 'group-dtm50']) {
            for (const cell of _createMoveCells(null, groupClass, false)) row.appendChild(cell);
        }
    }

    // ── Loading / reset ───────────────────────────────────────────────────────
    function _setLoading()   { document.querySelector('.results-panel')?.classList.add('is-loading'); }
    function _clearLoading() { document.querySelector('.results-panel')?.classList.remove('is-loading'); }

    function _reset() {
        _clearLoading();
        _blankRootRow();
        _hideProgress();
        if (document.getElementById('moves-tbody'))
            document.getElementById('moves-tbody').innerHTML = '';
        const es = document.getElementById('moves-empty-state');
        if (es) es.style.display = 'none';
        // Deliberately does not clear #move-count, for the same reason
        // _blankResults() below doesn't: the legal-move count is set
        // synchronously and client-side by ui.js's onPositionChange(),
        // straight from the FEN, so it never came from probe data and a
        // probe error doesn't make it wrong. Clearing it here would drop
        // a correct, already-visible number for no reason.
        const el = document.getElementById('error-line');
        if (el) { el.textContent = ''; el.classList.remove('is-coverage-error'); }
        _lastData = null;
        _lastFen  = null;
    }

    // Clears the move table back to the same blank state shown on first
    // launch (before any probe has ever completed), rather than leaving
    // the previous position's rows on screen to pulse via the is-loading
    // shimmer while the new probe is in flight. Used whenever a *new*
    // network probe is kicked off — not for cache/prefetch hits, which
    // resolve near-instantly and don't need a blank interstitial.
    //
    // Deliberately does not clear #move-count: the legal-move count that
    // ui.js's onPositionChange() sets synchronously the moment the position
    // changes (so it's visible without waiting for the probe) doesn't come
    // from probe data — it's computed client-side from the FEN — so there's
    // no reason to blank it here; it stays correct and visible until
    // _renderTable() confirms it from the real result.
    function _blankResults() {
        _blankRootRow();
        const tbody = document.getElementById('moves-tbody');
        if (tbody) tbody.innerHTML = '';
        const es = document.getElementById('moves-empty-state');
        if (es) es.style.display = 'none';
    }

    // A result carrying "unknown" moves is one the server couldn't fully
    // resolve (probe timeout / transient fetch error). Caching it here would
    // pin those unknowns to the position for the rest of the page's life,
    // since a revisit is served from cache and never re-probes.
    function _isComplete(data) {
        return !(data && data.summary && data.summary.unknown > 0);
    }

    function _applyResults(data, fen) {
        _clearLoading();
        _hideProgress();
        _lastData = data;
        _lastFen  = fen;
        if (_isComplete(data)) _resultCache.set(fen, data);

        const movesDtz   = data.moves_dtz   || [];
        const movesDtm   = data.moves_dtm   || [];
        const movesDtm50 = data.moves_dtm50 || [];

        // Root row and ranked child rows are built from the same probe
        // result in this one synchronous pass, so they land on screen
        // together instead of one appearing ahead of the other.
        _renderRootRow(data, Math.max(movesDtz.length, movesDtm.length, movesDtm50.length));
        _renderTable(movesDtz, movesDtm, movesDtm50);
        if (_onResult) _onResult(data);
    }

    // Apply a result we already have in hand (prefetch cache or result
    // cache) without going through the network at all. Shows the loading
    // state for one microtask so the UI doesn't flash, then applies.
    function _applyCachedResult(data, fen) {
        _setLoading();
        Promise.resolve().then(() => {
            _clearLoading();
            _applyResults(data, fen);
            const errorEl = document.getElementById('error-line');
            if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('is-coverage-error'); }
        });
    }

    // ── Coverage error ────────────────────────────────────────────────────────
    function _showCoverageError(errData) {
        const el = document.getElementById('error-line');
        if (!el) return;
        const pc   = errData.piece_count;
        const note = pc ? ` (position has ${pc} pieces)` : '';
        el.textContent = `Not in tablebase${note} — load a tablebase with more piece coverage.`;
        el.classList.add('is-coverage-error');
    }

    function _handleError(errData, errorEl, onError) {
        const msg = errData.error || 'Unknown error.';
        if (errData.error_code === 'missing_table') {
            _showCoverageError(errData);
        } else {
            if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('is-coverage-error'); }
        }
        if (onError) onError(msg);
    }

    // ── SSE streaming client ──────────────────────────────────────────────────
    async function _probeStream(fen, signal) {
        const response = await fetch('/probe/stream', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ fen }),
            signal,
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Network error.' }));
            throw err;
        }

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            for (const rawEvent of events) {
                const line = rawEvent.trim();
                if (!line.startsWith('data: ')) continue;
                let evtData;
                try { evtData = JSON.parse(line.slice(6)); } catch { continue; }

                if (evtData.status === 'probing') {
                    _showProgress(evtData.completed, evtData.total);
                } else if (evtData.status === 'done') {
                    return evtData;
                } else if (evtData.status === 'error') {
                    throw evtData;
                }
            }
        }
        throw { error: 'Stream ended unexpectedly.' };
    }

    // ── Main probe function ───────────────────────────────────────────────────
    function probe(fen, onError) {
        if (_currentController) _currentController.abort();

        // Check prefetch cache
        if (_prefetchCache.has(fen)) {
            const cached = _prefetchCache.get(fen);
            _prefetchCache.delete(fen);
            _applyCachedResult(cached, fen);
            return;
        }

        // Already-evaluated position (e.g. revisited via the PGN move list,
        // or stepping back/forward through the move line).
        if (_resultCache.has(fen)) {
            _applyCachedResult(_resultCache.get(fen), fen);
            return;
        }

        _currentController = new AbortController();
        const myController = _currentController;
        const signal       = myController.signal;
        const mySeq        = ++_probeSeq;

        // Blank the table/WDL immediately so stale rows from the previous
        // position aren't left sitting on screen — only the is-loading
        // shimmer shows while this probe is in flight.
        _blankResults();
        _setLoading();
        _showProgress(0, 0);
        const errorEl = document.getElementById('error-line');

        _probeStream(fen, signal)
            .then(data => {
                if (_currentController === myController) _currentController = null;
                _hideProgress();
                if (data.error) {
                    _reset();
                    _handleError(data, errorEl, onError);
                } else {
                    _applyResults(data, fen);
                    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('is-coverage-error'); }
                }
            })
            .catch(err => {
                _hideProgress();
                if (err && err.name === 'AbortError') {
                    if (mySeq === _probeSeq) { _currentController = null; _clearLoading(); }
                    return;
                }
                if (_currentController === myController) _currentController = null;
                _reset();
                _handleError(err && err.error ? err : { error: 'Cannot reach backend.' }, errorEl, onError);
                console.error('[Tablebase]', err);
            });
    }

    // ── CSV export ────────────────────────────────────────────────────────────
    function exportCsv() {
        if (!_lastData) return;
        const dtz   = _lastData.moves_dtz   || [];
        const dtm   = _lastData.moves_dtm   || [];
        const dtm50 = _lastData.moves_dtm50 || [];
        const rows  = Math.max(dtz.length, dtm.length, dtm50.length);
        const lines = [];
        if (_lastFen) lines.push(`[FEN "${_lastFen}"]`);
        lines.push('Rank,DTZ Move,DTZ Plies,DTZ Outcome,DTM Move,DTM Plies,DTM Outcome,DTM50 Move,DTM50 Plies,DTM50 Outcome');
        // Root row — the position's own score, ahead of rank 1 and with no
        // rank number, mirroring the frozen row shown in the UI table.
        // Omitted when the "Show Root Row" setting is off, so the export
        // matches what's on screen.
        if (_showRootRow) {
            lines.push([
                '',
                _ROOT_LABEL, _lastData.dtz_available   ? _lastData.dtz      : 'N/A', _wdlToOutcome(_lastData.wdl),
                _ROOT_LABEL, _lastData.dtm_available   ? _lastData.dtm      : 'N/A', _wdlToOutcome(_lastData.wdl),
                _ROOT_LABEL, _lastData.dtm50_available ? _lastData.dtm50[1] : 'N/A',
                             _lastData.dtm50_available ? _wdlToOutcome(_lastData.dtm50[0]) : 'not_available',
            ].join(','));
        }
        for (let i = 0; i < rows; i++) {
            const d0 = dtz[i],   d1 = dtm[i],   d2 = dtm50[i];
            lines.push([
                i + 1,
                d0 ? d0.san : '', d0 ? _csvPlies(d0) : '', d0 ? d0.outcome : '',
                d1 ? d1.san : '', d1 ? _csvPlies(d1) : '', d1 ? d1.outcome : '',
                d2 ? d2.san : '', d2 ? _csvPlies(d2) : '', d2 ? d2.outcome : '',
            ].join(','));
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'chesstb_moves.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    function setMoveSelectHandler(fn)  { _onMoveSelect = fn; }
    function setResultHandler(fn)      { _onResult = fn; }
    function getLastData()             { return _lastData; }
    function getLastFen()              { return _lastFen; }

    // Toggled by the "Show Root Row" switch in the settings panel (see
    // ui.js _initSettings). Persists the preference and re-renders
    // immediately from whatever result is already in memory — deliberately
    // does NOT trigger a new /probe/stream call, since the root wdl/dtz/
    // dtm/dtm50 fields this needs are already part of every probe result.
    function setShowRootRow(show) {
        _showRootRow = !!show;
        try { localStorage.setItem(_LS_SHOW_ROOT_ROW, String(_showRootRow)); } catch (_) { /* storage unavailable */ }
        if (_lastData) {
            const movesDtz   = _lastData.moves_dtz   || [];
            const movesDtm   = _lastData.moves_dtm   || [];
            const movesDtm50 = _lastData.moves_dtm50 || [];
            _renderRootRow(_lastData, Math.max(movesDtz.length, movesDtm.length, movesDtm50.length));
        } else {
            _blankRootRow();
        }
    }
    function getShowRootRow() { return _showRootRow; }

    // ── DOM event wiring ──────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        const tbody = document.getElementById('moves-tbody');
        if (!tbody) return;

        // Sync the static placeholder Root row (baked into index.html) with
        // the persisted "Show Root Row" preference before the first probe
        // ever runs — otherwise a disabled preference would still show the
        // placeholder dashes for a moment on load.
        _blankRootRow();

        // Click to play
        tbody.addEventListener('click', e => {
            const cell = e.target.closest('td[data-san]');
            if (cell && _onMoveSelect) _onMoveSelect(cell.dataset.san);
        });
        tbody.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const cell = e.target.closest('td[data-san]');
            if (cell && _onMoveSelect) { e.preventDefault(); _onMoveSelect(cell.dataset.san); }
        });

        // Pair-hover
        let _hoveredPair = [];
        function _pairCells(cell) {
            if (cell.classList.contains('col-move')) {
                const next = cell.nextElementSibling;
                return next && next.dataset.san ? [cell, next] : [cell];
            }
            if (cell.classList.contains('col-score')) {
                const prev = cell.previousElementSibling;
                return prev && prev.dataset.san ? [prev, cell] : [cell];
            }
            return [cell];
        }
        tbody.addEventListener('mouseover', e => {
            const cell = e.target.closest('td[data-san]');
            _hoveredPair.forEach(c => c.classList.remove('is-pair-hover'));
            _hoveredPair = [];
            if (cell) {
                _hoveredPair = _pairCells(cell);
                _hoveredPair.forEach(c => c.classList.add('is-pair-hover'));
            }
        });
        tbody.addEventListener('mouseleave', () => {
            _hoveredPair.forEach(c => c.classList.remove('is-pair-hover'));
            _hoveredPair = [];
        });

        // Prefetch on hover
        let _prefetchTimer      = null;
        let _prefetchController = null;   // in-flight prefetch fetch, if any
        let _prefetchFen        = null;   // childFen the timer/fetch above is (or will be) for

        function _cancelPrefetch() {
            clearTimeout(_prefetchTimer);
            _prefetchTimer = null;
            if (_prefetchController) { _prefetchController.abort(); _prefetchController = null; }
            _prefetchFen = null;
        }

        tbody.addEventListener('mouseover', e => {
            const cell = e.target.closest('td[data-child-fen]');
            if (!cell || !cell.dataset.childFen) { _cancelPrefetch(); return; }
            const childFen = cell.dataset.childFen;
            if (childFen === _prefetchFen) return;   // already pending/in-flight for this move
            _cancelPrefetch();                       // hover moved elsewhere — drop the old one
            if (_prefetchCache.has(childFen) || _resultCache.has(childFen)) return;
            _prefetchFen = childFen;
            _prefetchTimer = setTimeout(() => {
                const controller = new AbortController();
                _prefetchController = controller;
                fetch('/probe/stream', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ fen: childFen }),
                    signal:  controller.signal,
                })
                .then(r => r.ok ? r : Promise.reject())
                .then(async r => {
                    const reader  = r.body.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });
                        const events = buf.split('\n\n'); buf = events.pop() || '';
                        for (const raw of events) {
                            const l = raw.trim();
                            if (!l.startsWith('data: ')) continue;
                            try {
                                const d = JSON.parse(l.slice(6));
                                if (d.status === 'done') {
                                    if (_isComplete(d)) _prefetchCache.set(childFen, d);
                                    return;
                                }
                                if (d.status === 'error') return;
                            } catch { /**/ }
                        }
                    }
                })
                .catch(() => {/* prefetch failure or cancellation is silent */})
                .finally(() => {
                    if (_prefetchController === controller) _prefetchController = null;
                    if (_prefetchFen === childFen)          _prefetchFen = null;
                });
            }, 150);
        });
        tbody.addEventListener('mouseleave', _cancelPrefetch);

        // Export button
        document.getElementById('export-btn')?.addEventListener('click', exportCsv);

    }, { once: true });

    return { probe, setMoveSelectHandler, setResultHandler, getLastData, getLastFen, setShowRootRow, getShowRootRow };

})();

export { Tablebase };