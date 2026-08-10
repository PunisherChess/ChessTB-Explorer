/**
 * ui.js — UI controller
 *
 * Wires every other module together and owns everything that isn't board
 * rendering or tablebase communication:
 *   - The move-list panel: renders the branching move tree (main line plus
 *     any variations, in standard parenthesised PGN notation), back/forward
 *     buttons.
 *   - URL-hash position sharing: writes the FEN to location.hash on every
 *     position change and reads it back on load / hashchange.
 *   - Auto-play: plays a metric's best move automatically on a timer.
 *   - PGN import: a modal that parses a PGN and lets the user click any
 *     move to jump to it.
 *   - Clicking a move in the PGN panel — main line or a variation — jumps
 *     within the existing move tree via Board.goToNode() (rather than
 *     clearing the tree and re-probing), which reuses the already-cached
 *     result. Playing a new move after navigating back adds a variation
 *     instead of discarding whatever used to continue from that point.
 *   - The settings panel: the cog button in the header opens a dropdown
 *     with two accordion sections — Board and Piece Set — plus two
 *     standalone rows after them: a "Show Root Row" toggle switch (state
 *     owned by tablebase.js; see Tablebase.setShowRootRow/getShowRootRow)
 *     and an "Autoplay Delay" slider (state owned by this module; see
 *     _AUTO_PLAY_DELAY_DEFAULT_MS/_autoPlayDelayMs below).
 *     Board options render the real board image file (theme.js's
 *     `boardImage`), scaled down by CSS; there is no separate thumbnail
 *     asset. Colour-mode boards (no image file) are rendered as a small
 *     colour swatch instead. Piece-set options render each set's white
 *     knight (wN.svg).
 *   - Keyboard shortcuts (←/→/F/C), which bail out while an `<input>` has
 *     focus or the promotion dialog is open.
 *
 * onPositionChange() stops auto-play whenever the position changes for a
 * reason other than auto-play's own scheduled move (manual Back/Forward, a
 * PGN move-list click, Apply/Clear, a board edit, etc.), so a pending
 * auto-play timer never fires later and plays a move on top of wherever
 * the user has since navigated.
 */

import { Board }     from './board.js';
import { Tablebase } from './tablebase.js';
import { debounce }  from './utils.js';
import { Chess }     from '../vendor/chess-1.4.0.esm.js';
import { Theme, ALL_BOARDS, PIECE_SETS } from './theme.js';

const UI = (() => {

    const _debouncedProbe = debounce(Tablebase.probe, 300);

    // ── URL sharing ───────────────────────────────────────────────────────────
    function _writeHash(fen) {
        try {
            const hash = '#fen=' + encodeURIComponent(fen);
            history.replaceState(null, '', hash);
        } catch (_) { /* sandboxed context */ }
    }
    function readHashFen() {
        try {
            const m = location.hash.match(/[#&]fen=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        } catch (_) { return null; }
    }

    // ── Game-state persistence ────────────────────────────────────────────────
    // The URL hash alone isn't enough to survive a round-trip through a
    // different page (e.g. the /admin cache dashboard, which is a distinct
    // route with no #fen= of its own): navigating there and clicking "Back
    // to explorer" lands back on "/" with an empty hash. Persisting the
    // *entire* move tree (not just the current FEN) to localStorage lets
    // app.js restore both the board position and the PGN panel — including
    // any variations — on that round-trip, instead of just the position.
    // Saved on every move-history change (see Board.setOnMoveHistoryChange
    // below), which already fires on every position change — played moves,
    // undo/redo, new positions, and board edits alike.
    const _LS_GAME = 'chesstb_last_game';

    function _saveGameState(history, startFen) {
        try {
            localStorage.setItem(_LS_GAME, JSON.stringify({
                startFen,
                nodes:           history.nodes,
                rootChildren:    history.rootChildren,
                rootActiveChild: history.rootActiveChild,
                currentId:       history.currentId,
            }));
        } catch (_) { /* storage unavailable or quota exceeded */ }
    }
    function readLastGame() {
        try {
            const raw = localStorage.getItem(_LS_GAME);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.startFen !== 'string' || !Array.isArray(parsed.nodes)) {
                return null;
            }
            return parsed;
        } catch (_) { return null; }
    }

    // ── FEN normalisation (client-side mirror of _normalize_fen) ─────────────
    function normalizeFen(s) {
        const parts = s.trim().split(/\s+/);
        const defaults = ['8/8/8/8/8/8/8/8', 'w', '-', '-', '0', '1'];
        while (parts.length < 6) parts.push(defaults[parts.length]);
        return parts.slice(0, 6).join(' ');
    }

    // ── Startup readiness gate ────────────────────────────────────────────────
    // The FEN box / Apply button are disabled from page load until the board
    // has been constructed *and* the very first probe for the initial
    // position has resolved (success or error) — so a FEN can't be submitted
    // while the app is still finishing its first render/probe. Once ready,
    // inputs stay enabled for the rest of the session; calling this again
    // later (e.g. on every subsequent probe result) is harmless.
    function _setInputsReady(ready) {
        const fenInput = document.getElementById('fen-input');
        const applyBtn = document.getElementById('apply-btn');
        if (fenInput) fenInput.disabled = !ready;
        if (applyBtn) applyBtn.disabled = !ready;
    }

    // ── Turn badge ────────────────────────────────────────────────────────────
    function _updateTurnBadge(fen) {
        const turn = fen.split(' ')[1] || 'w';
        const wBtn = document.getElementById('turn-white');
        const bBtn = document.getElementById('turn-black');
        if (wBtn) wBtn.setAttribute('aria-pressed', turn === 'w' ? 'true' : 'false');
        if (bBtn) bBtn.setAttribute('aria-pressed', turn === 'b' ? 'true' : 'false');
    }

    // ── Back / forward buttons ────────────────────────────────────────────────
    function _updateNavBtns() {
        const back = document.getElementById('back-btn');
        const fwd  = document.getElementById('forward-btn');
        if (back) back.disabled = !Board.canGoBack();
        if (fwd)  fwd.disabled  = !Board.canGoForward();
    }

    // ── PGN-format helpers ─────────────────────────────────────────────────────
    // Derive {turn, fullmove} from a FEN's 2nd/6th fields, used to number the
    // move line correctly when the starting position isn't a fresh game.
    function _parseFenMeta(fen) {
        const parts = String(fen || '').trim().split(/\s+/);
        const turn     = parts[1] === 'b' ? 'b' : 'w';
        const fullmove = parseInt(parts[5], 10);
        return { turn, fullmove: Number.isFinite(fullmove) && fullmove > 0 ? fullmove : 1 };
    }

    // ── Move-list panel ───────────────────────────────────────────────────────
    // Renders the branching move tree returned by Board.getMoveHistory():
    // the main line (each node's children[0], recursively) inline, and any
    // other children of a node as a parenthesised variation right after it —
    // standard PGN notation, e.g. "6.Re1 Bb7 (6...b5 7.Bb3 d6 8.c3 ...)".
    // `_treeNodes` is stashed for the duration of a render pass so the
    // recursive helpers below don't need to thread the array through every
    // call.
    let _treeNodes = [];
    const ROOT_ID  = -1;

    function _childrenOfForRender(id, rootChildren) {
        return id === ROOT_ID ? rootChildren : _treeNodes[id].children;
    }

    // Follows children[0] repeatedly from startId to build one line's worth
    // of node ids (its own "main" continuation) — used both for the top-level
    // main line and for each variation's own body.
    function _collectMainPath(startId) {
        const ids = [];
        let cur = startId;
        while (cur !== null && cur !== undefined) {
            ids.push(cur);
            const kids = _treeNodes[cur].children;
            cur = kids.length ? kids[0] : null;
        }
        return ids;
    }

    function _appendMoveButton(container, node, currentId, depth) {
        const btn = document.createElement('button');
        btn.className = 'move-line__move'
            + (node.id === currentId ? ' is-current' : '')
            + (depth > 0 ? ' move-line__move--var' : '');
        btn.textContent = node.san;
        btn.dataset.nodeId = node.id;
        // Jump within the existing move tree instead of treating this as a
        // brand-new position. goToNode() keeps the whole tree intact (so
        // other variations don't clear) and reuses Tablebase's cached result
        // for this FEN instead of kicking off a fresh /probe/stream request.
        btn.addEventListener('click', () => Board.goToNode(node.id));
        container.appendChild(btn);
    }

    function _appendNumber(container, moveNum, whiteToMove) {
        const num = document.createElement('span');
        num.className   = 'move-line__num';
        num.textContent = moveNum + (whiteToMove ? '.' : '...');
        container.appendChild(num);
    }

    // Renders one line (the main line, or one variation's body) starting at
    // whiteToMove/moveNum, and — after each node — any *other* children of
    // that node's parent as nested parenthesised variations. `skipFirstFork`
    // is true when this call is itself rendering a variation body: the
    // caller's own loop already enumerated every sibling at nodeIds[0]
    // (including this one) as separate "(...)" blocks, so re-deriving
    // "siblings of the first node" here would duplicate/recurse forever.
    function _renderLine(container, nodeIds, parentId, whiteToMove, moveNum, currentId, depth, skipFirstFork, rootChildren) {
        nodeIds.forEach((id, i) => {
            const node = _treeNodes[id];
            if (whiteToMove || i === 0) _appendNumber(container, moveNum, whiteToMove);
            _appendMoveButton(container, node, currentId, depth);

            if (!(i === 0 && skipFirstFork)) {
                const parentForThis = i === 0 ? parentId : nodeIds[i - 1];
                const kids = _childrenOfForRender(parentForThis, rootChildren);
                for (let v = 1; v < kids.length; v++) {
                    const open = document.createElement('span');
                    open.className = 'move-line__paren';
                    open.textContent = '(';
                    container.appendChild(open);

                    const varPath = _collectMainPath(kids[v]);
                    _renderLine(container, varPath, parentForThis, whiteToMove, moveNum, currentId, depth + 1, true, rootChildren);

                    const close = document.createElement('span');
                    close.className = 'move-line__paren';
                    close.textContent = ')';
                    container.appendChild(close);
                }
            }

            if (!whiteToMove) moveNum++;
            whiteToMove = !whiteToMove;
        });
    }

    function _renderMoveList(history, startFen) {
        const container = document.getElementById('move-line');
        if (!container) return;
        const { nodes, rootChildren, currentId } = history;
        if (!rootChildren || rootChildren.length === 0) {
            container.innerHTML = '<span class="move-line__empty">No moves yet</span>';
            return;
        }
        _treeNodes = nodes;

        const { turn, fullmove } = _parseFenMeta(startFen);
        const frag     = document.createDocumentFragment();
        const mainPath = _collectMainPath(rootChildren[0]);
        _renderLine(frag, mainPath, ROOT_ID, turn === 'w', fullmove, currentId, 0, false, rootChildren);

        container.innerHTML = '';
        container.appendChild(frag);
        // Scroll current move into view
        container.querySelector('.is-current')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }

    // Determines the PGN result token ("1-0" / "0-1" / "1/2-1/2" / "*") by
    // inspecting the final position of the move line.
    function _pgnResultFromFen(fen) {
        try {
            const g = new Chess();
            g.load(fen);
            if (g.isCheckmate()) {
                // Side to move is the side that got mated.
                return g.turn() === 'w' ? '0-1' : '1-0';
            }
            const drawn =
                (typeof g.isDraw === 'function' && g.isDraw()) ||
                (typeof g.isStalemate === 'function' && g.isStalemate()) ||
                (typeof g.isInsufficientMaterial === 'function' && g.isInsufficientMaterial()) ||
                (typeof g.isThreefoldRepetition === 'function' && g.isThreefoldRepetition());
            if (drawn) return '1/2-1/2';
        } catch (_) { /* fall through to unknown result */ }
        return '*';
    }

    // Same recursive shape as _renderLine() above (see there for why
    // skipFirstFork exists), but building PGN movetext tokens instead of DOM
    // nodes — so a copied/exported PGN preserves variations exactly as
    // they're shown in the panel, using the standard "(...)" notation.
    function _buildMoveTokens(nodes, rootChildren, nodeIds, parentId, whiteToMove, moveNum, skipFirstFork) {
        const tokens = [];
        nodeIds.forEach((id, i) => {
            const node = nodes[id];
            if (whiteToMove) {
                tokens.push(`${moveNum}.`, node.san);
            } else if (i === 0) {
                tokens.push(`${moveNum}...`, node.san);
            } else {
                tokens.push(node.san);
            }

            if (!(i === 0 && skipFirstFork)) {
                const parentForThis = i === 0 ? parentId : nodeIds[i - 1];
                const kids = parentForThis === -1 ? rootChildren : nodes[parentForThis].children;
                for (let v = 1; v < kids.length; v++) {
                    const varPath = _pgnCollectMainPath(nodes, kids[v]);
                    const varTokens = _buildMoveTokens(nodes, rootChildren, varPath, parentForThis, whiteToMove, moveNum, true);
                    tokens.push(`(${varTokens.join(' ')})`);
                }
            }

            if (!whiteToMove) moveNum++;
            whiteToMove = !whiteToMove;
        });
        return tokens;
    }

    function _pgnCollectMainPath(nodes, startId) {
        const ids = [];
        let cur = startId;
        while (cur !== null && cur !== undefined) {
            ids.push(cur);
            const kids = nodes[cur].children;
            cur = kids.length ? kids[0] : null;
        }
        return ids;
    }

    // Builds a lichess-style PGN export: the standard seven-tag-roster header
    // block (plus FEN/SetUp for non-standard starting positions, which the
    // tablebase explorer always has) followed by movetext (including any
    // variations, in standard parenthesised notation) ending in a result
    // token — not just the bare main-line move list.
    function _buildPgnText() {
        const { nodes, rootChildren } = Board.getMoveHistory();
        if (!rootChildren || rootChildren.length === 0) return '';

        const startFen = Board.getStartFen();

        // The Result tag and final position reflect the main line (the line
        // actually being played out), not wherever the cursor happens to be
        // parked.
        const mainPath = _pgnCollectMainPath(nodes, rootChildren[0]);
        const finalFen = nodes[mainPath[mainPath.length - 1]].fen;
        const result   = _pgnResultFromFen(finalFen);

        const today   = new Date();
        const pad     = n => String(n).padStart(2, '0');
        const dateStr = `${today.getFullYear()}.${pad(today.getMonth() + 1)}.${pad(today.getDate())}`;

        const headers = [
            ['Event',  'ChessTB Explorer'],
            ['Site',   '?'],
            ['Date',   dateStr],
            ['Round',  '?'],
            ['White',  '?'],
            ['Black',  '?'],
            ['Result', result],
            ['FEN',    startFen],
            ['SetUp',  '1'],
        ];
        const headerBlock = headers.map(([k, v]) => `[${k} "${v}"]`).join('\n');

        const { turn, fullmove } = _parseFenMeta(startFen);
        const tokens = _buildMoveTokens(nodes, rootChildren, mainPath, -1, turn === 'w', fullmove, false);
        tokens.push(result);

        return `${headerBlock}\n\n${tokens.join(' ')}`;
    }

    Board.setOnMoveHistoryChange((history, startFen) => {
        _renderMoveList(history, startFen);
        _updateNavBtns();
        _saveGameState(history, startFen);
    });

    // ── Position-change callback ──────────────────────────────────────────────
    function onPositionChange(fen, _isLegalMove, immediate) {
        // Any position change that didn't come from auto-play's own
        // scheduled move (manual Back/Forward, a PGN move-list click,
        // Apply/Clear, a board edit, etc.) means the user has taken over —
        // stop auto-play instead of letting its pending timer fire later
        // and play a move on top of wherever the user has since navigated.
        // _autoPlayMoveInFlight is set true only for the instant spanned by
        // auto-play's own Board.playMove() call below, so it stays false
        // for every other caller of onPositionChange().
        if (_autoPlayMetric && !_autoPlayMoveInFlight) {
            _stopAutoPlay();
        }

        const input = document.getElementById('fen-input');
        if (input) { input.value = fen; input.classList.remove('is-invalid'); }
        const errorEl = document.getElementById('error-line');
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('is-coverage-error'); }
        _updateTurnBadge(fen);
        _updateNavBtns();
        _writeHash(fen);

        // Arrows reflect the *previous* position's best moves — clear them
        // right away rather than leaving them on screen until the new
        // probe finishes (which can take a moment on slower tablebase
        // lookups). They're redrawn once Tablebase.setResultHandler fires
        // for the new position.
        Board.clearArrows();

        // Instantly populate the legal-move count without waiting for the probe
        try {
            const _tempGame = new Chess();
            _tempGame.load(fen);
            const _count = _tempGame.moves().length;
            const _countEl = document.getElementById('move-count');
            if (_countEl) _countEl.textContent = _count > 0 ? `${_count} legal move${_count === 1 ? '' : 's'}` : '';
        } catch (_) { /* silent — probe will handle it */ }

        const onProbeError = msg => {
            if (errorEl) errorEl.textContent = msg;
            _setInputsReady(true);   // don't leave inputs stuck disabled on error
        };
        if (immediate) {
            Tablebase.probe(fen, onProbeError);
        } else {
            _debouncedProbe(fen, onProbeError);
        }
    }

    // ── Auto-play ─────────────────────────────────────────────────────────────
    // One button per metric (DTC / DTM / DTM50, rendered below each column
    // group in the moves table); each plays that metric's top-ranked move on
    // a timer. Only one metric can be running at a time — starting one stops
    // any other that was active.
    //
    // Each move waits on two conditions that both have to clear before the
    // next move plays: a pacing window (user-configurable via the Autoplay
    // Delay slider in the settings panel — see _AUTO_PLAY_DELAY_DEFAULT_MS
    // below), so moves land one at a time instead of flashing past, and the
    // tablebase result for the position just reached, so the move played is
    // actually the best one available. The two run concurrently rather than
    // one after the other — the pacing timer and the probe both start the
    // moment a move is played — so the wait between moves is whichever of
    // the two takes longer (i.e. max(pacing window, probe latency)), not
    // their sum.
    const _METRIC_CONFIG = {
        dtc:   { dataKey: 'moves_dtz',   label: 'DTC'   },
        dtm:   { dataKey: 'moves_dtm',   label: 'DTM'   },
        dtm50: { dataKey: 'moves_dtm50', label: 'DTM50' },
    };
    const _AUTO_PLAY_METRICS = Object.keys(_METRIC_CONFIG);

    // ── Autoplay Delay setting ────────────────────────────────────────────
    // The range offered by the settings-panel slider, and the pacing
    // window's floor value while a given point on it is selected.
    // Persisted client-side, following the same per-module localStorage
    // convention theme.js and tablebase.js use for their own settings.
    const _AUTO_PLAY_DELAY_MIN_MS     = 0;
    const _AUTO_PLAY_DELAY_MAX_MS     = 2500;
    const _AUTO_PLAY_DELAY_STEP_MS    = 50;
    const _AUTO_PLAY_DELAY_DEFAULT_MS = 1250;
    const _LS_AUTOPLAY_DELAY_MS = 'chesstb_autoplay_delay_ms';

    function _clampAutoPlayDelayMs(ms) {
        if (!Number.isFinite(ms)) return _AUTO_PLAY_DELAY_DEFAULT_MS;
        const snapped = Math.round(ms / _AUTO_PLAY_DELAY_STEP_MS) * _AUTO_PLAY_DELAY_STEP_MS;
        return Math.min(_AUTO_PLAY_DELAY_MAX_MS, Math.max(_AUTO_PLAY_DELAY_MIN_MS, snapped));
    }

    function _readAutoPlayDelayMs() {
        try {
            const raw = localStorage.getItem(_LS_AUTOPLAY_DELAY_MS);
            const ms = raw === null ? NaN : parseInt(raw, 10);
            return Number.isFinite(ms) ? _clampAutoPlayDelayMs(ms) : _AUTO_PLAY_DELAY_DEFAULT_MS;
        } catch (_) {
            return _AUTO_PLAY_DELAY_DEFAULT_MS;   // storage unavailable
        }
    }

    let _autoPlayDelayValueMs = _readAutoPlayDelayMs();

    function _autoPlayDelayMs() { return _autoPlayDelayValueMs; }

    function _formatAutoPlayDelay(ms) {
        return ms === 0 ? '0s' : `${parseFloat((ms / 1000).toFixed(2))}s`;
    }

    function _setAutoPlayDelayMs(ms) {
        _autoPlayDelayValueMs = _clampAutoPlayDelayMs(ms);
        try { localStorage.setItem(_LS_AUTOPLAY_DELAY_MS, String(_autoPlayDelayValueMs)); } catch (_) { /* storage unavailable */ }
    }

    let _autoPlayMetric = null;   // 'dtc' | 'dtm' | 'dtm50' | null
    let _autoPlayTimer  = null;
    // Guards onPositionChange()'s manual-navigation detection — true only
    // for the duration of auto-play's own Board.playMove() call.
    let _autoPlayMoveInFlight = false;
    // Identifies the pacing/probe wait currently in progress. Incremented
    // whenever a wait starts, and whenever auto-play stops, so a timer or
    // probe-result callback left over from a wait that's since been
    // superseded or cancelled can recognise itself as stale and no-op
    // instead of acting on a position auto-play has already moved past.
    let _autoPlayCycleId     = 0;
    let _autoPlayPacingReady = false;   // this wait's pacing window has elapsed
    let _autoPlayDataReady   = false;   // this wait's position data is available

    function _autoplayBtn(metric) { return document.getElementById(`autoplay-btn-${metric}`); }

    function _stopAutoPlay() {
        const prevMetric = _autoPlayMetric;
        _autoPlayMetric = null;
        _autoPlayCycleId++;
        clearTimeout(_autoPlayTimer);
        _autoPlayTimer = null;
        _autoPlayPacingReady = false;
        _autoPlayDataReady   = false;
        if (!prevMetric) return;
        const btn = _autoplayBtn(prevMetric);
        if (btn) {
            // The play/stop icon swap is handled entirely by CSS off the
            // is-playing class (see .autoplay-icon rules in main.css) —
            // no textContent glyph to update here any more.
            btn.classList.remove('is-playing');
            btn.title = `Auto-play best ${_METRIC_CONFIG[prevMetric].label} move`;
        }
    }

    function _startAutoPlay(metric) {
        if (!_METRIC_CONFIG[metric]) return;
        _stopAutoPlay();   // only one metric autoplays at a time
        _autoPlayMetric = metric;
        const btn = _autoplayBtn(metric);
        if (btn) {
            btn.classList.add('is-playing');
            btn.title = `Stop ${_METRIC_CONFIG[metric].label} auto-play`;
        }
        // Usually the position on screen already has a result sitting in
        // hand, so only the pacing window gates the first move. But if a
        // probe for this position is still in flight — the button was
        // clicked right after a move/Apply/etc., before that probe landed
        // — Tablebase.getLastData() still holds the previous position's
        // result. Treating that as ready would let the first move play
        // off the wrong data, so the first move waits on the probe too,
        // same as every move after it.
        const dataAlreadyReady = Tablebase.getLastFen() === Board.currentFen();
        _armAutoPlayWait(dataAlreadyReady);
    }

    // Starts one pacing/probe wait: arms the pacing timer and records
    // whether the upcoming position's data is already available or still
    // has to arrive via a probe result. _tryPlayAutoPlayMove() runs
    // whenever either condition clears, and only plays a move once both
    // have.
    function _armAutoPlayWait(dataAlreadyReady) {
        const cycleId = ++_autoPlayCycleId;
        _autoPlayPacingReady = false;
        _autoPlayDataReady   = dataAlreadyReady;
        clearTimeout(_autoPlayTimer);
        _autoPlayTimer = setTimeout(() => {
            if (cycleId !== _autoPlayCycleId) return;   // superseded wait
            _autoPlayPacingReady = true;
            _tryPlayAutoPlayMove(cycleId);
        }, _autoPlayDelayMs());
    }

    // Plays the next move once both the pacing window and the position
    // data are ready. Reached from the pacing timer and from the probe
    // result handler below — whichever fires second is the one that
    // actually moves. cycleId ties the call back to the wait it belongs
    // to, so a callback left over from a wait that's since been replaced
    // (another move already played, auto-play stopped, a different metric
    // started) is ignored rather than acting on the wrong position.
    function _tryPlayAutoPlayMove(cycleId) {
        if (cycleId !== _autoPlayCycleId) return;
        if (!_autoPlayMetric) return;
        if (!_autoPlayPacingReady || !_autoPlayDataReady) return;

        const metric = _autoPlayMetric;
        const data = Tablebase.getLastData();
        if (!data) return;
        const moves = data[_METRIC_CONFIG[metric].dataKey] || [];
        // Find the first non-unknown move
        const best = moves.find(m => m.outcome !== 'unknown');
        // Stop autoplay if there's no usable move
        if (!best) { _stopAutoPlay(); return; }
        // Mark this specific position change as auto-play-initiated so
        // onPositionChange() doesn't mistake it for manual navigation
        // and stop auto-play on its own move.
        _autoPlayMoveInFlight = true;
        const played = Board.playMove(best.san);
        _autoPlayMoveInFlight = false;
        if (!played) { _stopAutoPlay(); return; }
        // Stop auto-play *after* playing — if it was mate or a draw,
        // the game is effectively over and there is nothing further to play.
        if (best.is_mate || best.outcome === 'draw') { _stopAutoPlay(); return; }
        // Board.playMove() synchronously triggered onPositionChange(),
        // which kicked off a probe for the position just reached — start
        // the next wait with its data pending until that probe resolves.
        _armAutoPlayWait(/* dataAlreadyReady */ false);
    }

    function _onAutoPlayResult(_data) {
        if (!_autoPlayMetric) return;
        _autoPlayDataReady = true;
        _tryPlayAutoPlayMove(_autoPlayCycleId);
    }

    // Disable a metric's auto-play button when its root outcome is already a
    // draw — there's no "best move" worth auto-playing towards. DTC/DTM
    // share the root WDL (they ignore the 50-move rule); DTM50 uses its own
    // 50-move-rule-aware root WDL.
    function _updateAutoplayAvailability(data) {
        const rootWdlByMetric = {
            dtc:   data?.wdl,
            dtm:   data?.wdl,
            dtm50: Array.isArray(data?.dtm50) ? data.dtm50[0] : null,
        };
        _AUTO_PLAY_METRICS.forEach(metric => {
            const btn = _autoplayBtn(metric);
            if (!btn) return;
            const isDraw = rootWdlByMetric[metric] === 0;
            if (isDraw) {
                if (_autoPlayMetric === metric) _stopAutoPlay();
                btn.disabled = true;
                btn.title = `${_METRIC_CONFIG[metric].label} auto-play unavailable — position is a draw`;
            } else {
                btn.disabled = false;
                if (_autoPlayMetric !== metric) btn.title = `Auto-play best ${_METRIC_CONFIG[metric].label} move`;
            }
        });
    }

    // Best move per metric, for the 3-colour arrow overlay. Lists are
    // empty only for terminal/no-data positions; drawArrows() handles a
    // missing metric gracefully by simply not drawing that arrow.
    function _bestMovesForArrows(data) {
        return {
            dtc:   (data?.moves_dtz   || [])[0] || null,
            dtm:   (data?.moves_dtm   || [])[0] || null,
            dtm50: (data?.moves_dtm50 || [])[0] || null,
        };
    }

    Tablebase.setResultHandler(data => {
        // Draw DTC / DTM / DTM50 best-move arrows
        Board.drawArrows(_bestMovesForArrows(data));
        _updateAutoplayAvailability(data);
        _setInputsReady(true);   // first (or any) successful probe → ready
        // Runs last: this may synchronously play auto-play's next move
        // (when its pacing window already elapsed while this probe was in
        // flight), which advances the board past the position the calls
        // above just rendered.
        _onAutoPlayResult(data);
    });

    // ── PGN import ────────────────────────────────────────────────────────────
    let _pgnSnapshots = [];   // [{label, fen}]

    function _openPgnDialog() {
        const dlg = document.getElementById('pgn-dialog');
        if (dlg) { dlg.classList.add('is-open'); document.getElementById('pgn-input')?.focus(); }
    }
    function _closePgnDialog() {
        const dlg = document.getElementById('pgn-dialog');
        if (dlg) dlg.classList.remove('is-open');
    }
    // loadPgn() (chess-1.4.0.esm.js) has no success return value — it mutates
    // the instance in place and throws on invalid input. Success/failure must
    // be read from the try/catch, not from the call's return value.
    function _parsePgn() {
        const text = (document.getElementById('pgn-input')?.value || '').trim();
        if (!text) return;
        const errEl = document.getElementById('pgn-error');
        if (errEl) errEl.textContent = '';
        const tempGame = new Chess();
        try {
            tempGame.loadPgn(text);
        } catch (_) {
            if (errEl) errEl.textContent = 'Could not parse PGN. Check the format and try again.';
            return;
        }
        const history  = tempGame.history({ verbose: true });
        // Replay from the PGN's own starting position, not the default
        // starting position — a [FEN "..."] header (as chesstb writes on
        // export) means the game did not begin from the default array,
        // and moves in the history are only legal relative to that FEN.
        const startFen = _fenHeaderValue(tempGame.getHeaders());
        const replay   = new Chess();
        if (startFen) {
            try { replay.load(startFen); } catch (_) { replay.reset(); }
        }
        _pgnSnapshots = [{ label: 'Start', fen: replay.fen() }];
        history.forEach((move, idx) => {
            replay.move(move.san);
            const moveNum  = Math.floor(idx / 2) + 1;
            const isWhite  = idx % 2 === 0;
            const label    = isWhite ? `${moveNum}. ${move.san}` : `${moveNum}… ${move.san}`;
            _pgnSnapshots.push({ label, fen: replay.fen() });
        });
        _renderPgnMoveList();
    }

    // Case-insensitive lookup, mirroring loadPgn()'s own tolerant header
    // scan — a PGN's FEN tag is conventionally "FEN" but the parser accepts
    // any case, so the header key can't be assumed here either.
    function _fenHeaderValue(headers) {
        for (const key in headers) {
            if (key.toLowerCase() === 'fen') return headers[key];
        }
        return null;
    }

    function _renderPgnMoveList() {
        const container = document.getElementById('pgn-moves');
        if (!container) return;
        container.innerHTML = '';
        if (_pgnSnapshots.length === 0) return;
        const frag = document.createDocumentFragment();
        _pgnSnapshots.forEach((snap, i) => {
            const btn = document.createElement('button');
            btn.className   = 'pgn-move-btn';
            btn.textContent = snap.label;
            btn.addEventListener('click', () => {
                // Note: this is importing a *new* game from the dialog, not
                // navigating the current move line, so setPosition() (which
                // resets the move line) is correct here — unlike the
                // in-panel move-list click handler above. setPosition() now
                // invokes onPositionChange() itself, so there's
                // no manual call needed here any more.
                const norm   = normalizeFen(snap.fen);
                const result = Board.setPosition(norm);
                if (!result.ok) return;
                _closePgnDialog();
            });
            frag.appendChild(btn);
        });
        container.appendChild(frag);
    }

    function _initPgnDialog() {
        document.getElementById('pgn-btn')?.addEventListener('click', _openPgnDialog);
        document.getElementById('pgn-close-btn')?.addEventListener('click', _closePgnDialog);
        document.getElementById('pgn-parse-btn')?.addEventListener('click', _parsePgn);
        document.getElementById('pgn-dialog')?.addEventListener('click', e => {
            if (e.target.id === 'pgn-dialog') _closePgnDialog();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') _closePgnDialog();
        });
    }

    // ── FEN input helpers ─────────────────────────────────────────────────────
    // Board.setPosition() invokes onPositionChange itself (which clears
    // arrows, updates the turn badge/URL hash, and schedules the debounced
    // Tablebase.probe()), so this doesn't probe or call onPositionChange()
    // a second time on top of it.
    function _applyFen(rawFen) {
        const norm   = normalizeFen(rawFen);
        const result = Board.setPosition(norm);
        const errorEl = document.getElementById('error-line');
        const input   = document.getElementById('fen-input');
        if (!result.ok) {
            if (input)   input.classList.add('is-invalid');
            if (errorEl) errorEl.textContent = result.reason || 'Invalid position.';
            return;
        }
        if (input)   input.classList.remove('is-invalid');
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('is-coverage-error'); }
    }

    // Clicking the turn already in effect is a no-op, so it doesn't push a
    // duplicate entry onto the undo stack or wipe the current move
    // line/PGN when nothing about the position actually changed.
    function _setTurn(turn) {
        const input = document.getElementById('fen-input');
        if (!input) return;
        const parts = normalizeFen(input.value).split(' ');
        if (parts[1] === turn) return;   // already this turn — nothing to do
        parts[1] = turn;
        _applyFen(parts.join(' '));
    }

    // ── toast ─────────────────────────────────────────────────────────────────
    function toast(message, durationMs = 1800) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className   = 'toast';
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.classList.add('is-out');
            el.addEventListener('animationend', () => el.remove(), { once: true });
            setTimeout(() => el.remove(), 400);
        }, durationMs);
    }

    // ── Settings panel ────────────────────────────────────────────────────────
    //
    // Dropdown anchored under the header cog button, with two accordion
    // sections built once at init:
    //   • Board     — colour boards render as a small two-tone swatch;
    //                 image boards render the actual board image file
    //                 (theme.js's `boardImage`), scaled down by CSS. There
    //                 is no separate thumbnail asset anywhere in this flow.
    //   • Piece Set — each set is shown as its own wN.svg white knight.
    //
    // Board and piece-set selection are independent: changeBoard() re-injects
    // the theme <style> tag (tray colours included); changePieceSet() only
    // rebuilds the Chessboard() instance via Board.reconstruct(), so the
    // tray colour never shifts just because the piece set changed.
    //
    // Below the two accordion sections sit two standalone rows: the Show
    // Root Row toggle (state owned by tablebase.js) and the Autoplay Delay
    // slider (state owned by this module — see _AUTO_PLAY_DELAY_DEFAULT_MS
    // and _autoPlayDelayMs in the Auto-play section above).

    let _settingsPanel = null;

    function _closeSettings() {
        if (_settingsPanel) _settingsPanel.classList.remove('is-open');
    }

    function _buildBoardOption(board) {
        const btn = document.createElement('button');
        btn.className  = 'theme-option';
        btn.dataset.id = board.id;
        btn.title      = board.label;

        const swatch = document.createElement('span');
        swatch.className = 'theme-option__swatch';
        if (board.mode === 'image') {
            const img = document.createElement('img');
            img.src       = board.boardImage;
            img.alt       = board.label;
            img.draggable = false;
            swatch.appendChild(img);
        } else {
            swatch.classList.add('theme-option__swatch--colour');
            swatch.style.background =
                `linear-gradient(135deg, ${board.lightSquare} 50%, ${board.darkSquare} 50%)`;
        }

        const lbl = document.createElement('span');
        lbl.className   = 'theme-option__label';
        lbl.textContent = board.label;

        btn.append(swatch, lbl);
        btn.addEventListener('click', () => {
            Theme.changeBoard(board.id);
            _markActiveBoard();
        });
        return btn;
    }

    function _buildPieceSetOption(set) {
        const btn = document.createElement('button');
        btn.className  = 'theme-option';
        btn.dataset.id = set.id;
        btn.title      = set.label;

        const swatch = document.createElement('span');
        swatch.className = 'theme-option__swatch theme-option__swatch--piece';
        const img = document.createElement('img');
        img.src       = `/static/pieces/${set.id}/wN.svg`;
        img.alt       = set.label;
        img.draggable = false;
        swatch.appendChild(img);

        const lbl = document.createElement('span');
        lbl.className   = 'theme-option__label';
        lbl.textContent = set.label;

        btn.append(swatch, lbl);
        btn.addEventListener('click', () => {
            Theme.changePieceSet(set.id);
            Board.drawArrows(_bestMovesForArrows(Tablebase.getLastData()));
            _markActivePieceSet();
        });
        return btn;
    }

    function _markActiveBoard() {
        const activeId = Theme.currentBoard().id;
        document.querySelectorAll('#board-grid .theme-option').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.id === activeId);
        });
    }

    function _markActivePieceSet() {
        const activeId = Theme.currentPieceSet();
        document.querySelectorAll('#pieceset-grid .theme-option').forEach(btn => {
            btn.classList.toggle('is-active', btn.dataset.id === activeId);
        });
    }

    function _initSettings() {
        const cogBtn = document.getElementById('settings-btn');
        _settingsPanel = document.getElementById('settings-panel');
        const closeBtn = document.getElementById('settings-close-btn');
        if (!cogBtn || !_settingsPanel) return;

        cogBtn.addEventListener('click', e => {
            e.stopPropagation();
            const opening = !_settingsPanel.classList.contains('is-open');
            if (opening) {
                _settingsPanel.classList.add('is-open');
                _markActiveBoard();
                _markActivePieceSet();
                const rootRowToggle = document.getElementById('show-root-row-toggle');
                if (rootRowToggle) rootRowToggle.checked = Tablebase.getShowRootRow();
                _syncAutoPlayDelaySlider();
            } else {
                _closeSettings();
            }
        });
        closeBtn?.addEventListener('click', _closeSettings);

        document.addEventListener('click', e => {
            if (_settingsPanel.classList.contains('is-open') &&
                !_settingsPanel.contains(e.target) &&
                e.target !== cogBtn && !cogBtn.contains(e.target)) {
                _closeSettings();
            }
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') _closeSettings();
        });

        // Accordion rows
        _settingsPanel.querySelectorAll('.settings-row__header').forEach(header => {
            header.addEventListener('click', () => {
                const row  = header.closest('.settings-row');
                const open = row.classList.toggle('is-open');
                header.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        });

        // Board grid — colour boards + image boards, in declared order
        const boardGrid = document.getElementById('board-grid');
        if (boardGrid) {
            ALL_BOARDS.forEach(b => boardGrid.appendChild(_buildBoardOption(b)));
        }

        // Piece-set grid
        const pieceGrid = document.getElementById('pieceset-grid');
        if (pieceGrid) {
            PIECE_SETS.forEach(p => pieceGrid.appendChild(_buildPieceSetOption(p)));
        }

        // Show Root Row toggle
        const rootRowToggle = document.getElementById('show-root-row-toggle');
        if (rootRowToggle) {
            rootRowToggle.checked = Tablebase.getShowRootRow();
            rootRowToggle.addEventListener('change', () => {
                Tablebase.setShowRootRow(rootRowToggle.checked);
            });
        }

        // Autoplay Delay slider
        const delaySlider = document.getElementById('autoplay-delay-slider');
        if (delaySlider) {
            _syncAutoPlayDelaySlider();
            delaySlider.addEventListener('input', () => {
                _setAutoPlayDelayMs(parseInt(delaySlider.value, 10));
                _syncAutoPlayDelaySlider();
            });
        }
    }

    // Reflects _autoPlayDelayMs onto the slider's position, its fill
    // percentage, its aria-valuetext, and its value label. Called once at
    // init and again on every settings-panel open — same refresh-on-open
    // treatment as the Show Root Row toggle above, even though this
    // setting is only ever changed via this same slider.
    function _syncAutoPlayDelaySlider() {
        const slider = document.getElementById('autoplay-delay-slider');
        if (slider) {
            slider.value = String(_autoPlayDelayMs());
            const pct = (_autoPlayDelayMs() - _AUTO_PLAY_DELAY_MIN_MS) /
                        (_AUTO_PLAY_DELAY_MAX_MS - _AUTO_PLAY_DELAY_MIN_MS) * 100;
            slider.style.setProperty('--range-fill', pct + '%');
            slider.setAttribute('aria-valuetext', _formatAutoPlayDelay(_autoPlayDelayMs()));
        }
        const valueEl = document.getElementById('autoplay-delay-value');
        if (valueEl) valueEl.textContent = _formatAutoPlayDelay(_autoPlayDelayMs());
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    function _bindKeys() {
        document.addEventListener('keydown', e => {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            // Don't let shortcuts act on the board underneath the promotion
            // dialog — ←/→/F/C must not navigate/mutate the position while
            // the modal is open, or picking a piece afterward would apply
            // _pendingPromotion's {from,to} against a position that has
            // since changed.
            const promoDialog = document.getElementById('promotion-dialog');
            if (promoDialog && promoDialog.classList.contains('is-visible')) return;

            if (e.key === 'ArrowLeft'  && !e.shiftKey && !e.ctrlKey && !e.metaKey)
                { e.preventDefault(); Board.goBack(); }
            if (e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.metaKey)
                { e.preventDefault(); Board.goForward(); }
            // e.key is 'F' (not 'f') when Shift is held, so this is checked
            // case-insensitively — Shift+F flips the board too.
            if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey)
                { e.preventDefault(); Board.flip(); }
            // 'C' clears the board, matching the kbd-hints badge.
            if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey)
                { e.preventDefault(); document.getElementById('clear-btn')?.click(); }
        });
    }

    // ── init ──────────────────────────────────────────────────────────────────
    // `restoreGame`, if provided, is a persisted move-tree snapshot (see
    // readLastGame()): {startFen, nodes, rootChildren, rootActiveChild,
    // currentId}. `initialFen` in that case is expected to already equal
    // restoreGame.startFen — Board.init() below loads it as the tree's
    // starting position, then restoreTree() fast-forwards straight to the
    // saved node (rebuilding the PGN panel, variations included) without
    // re-probing every intermediate move.
    function init(initialFen, restoreGame) {
        _setInputsReady(false);   // re-enabled once the first probe resolves
        const boardInit = Board.init(onPositionChange, initialFen);
        if (!boardInit.ok) {
            toast(boardInit.reason || 'Invalid starting position — loaded the default position instead.');
        }

        if (restoreGame) {
            Board.restoreTree(
                restoreGame.startFen, restoreGame.nodes, restoreGame.rootChildren,
                restoreGame.rootActiveChild, restoreGame.currentId
            );
        }

        // FEN input — reflects the actual current position, which after a
        // restoreTree() may be further along than `initialFen` (the tree's
        // *start* position).
        const fenInput = document.getElementById('fen-input');
        if (fenInput) {
            fenInput.value = Board.currentFen();
            fenInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); _applyFen(fenInput.value.trim()); }
            });
        }

        // Action buttons
        document.getElementById('apply-btn')?.addEventListener('click', () => {
            const v = document.getElementById('fen-input')?.value.trim();
            if (v) _applyFen(v);
        });
        document.getElementById('copy-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(Board.currentFen())
                .then(() => toast('FEN copied!'))
                .catch(() => {
                    const input = document.getElementById('fen-input');
                    input?.select(); document.execCommand('copy'); toast('FEN copied!');
                });
        });
        document.getElementById('pgn-copy-btn')?.addEventListener('click', () => {
            const pgnText = _buildPgnText();
            if (!pgnText) { toast('No moves to copy.'); return; }
            navigator.clipboard.writeText(pgnText)
                .then(() => toast('PGN copied!'))
                .catch(() => toast('Could not copy PGN.'));
        });
        document.getElementById('flip-btn')?.addEventListener('click', () => {
            Board.flip();
            Board.drawArrows(_bestMovesForArrows(Tablebase.getLastData()));
        });
        document.getElementById('clear-btn')?.addEventListener('click', () => {
            // Board.clear() invokes onPositionChange itself (clears arrows,
            // updates the turn badge/URL hash, schedules the debounced
            // probe), so there's no need to call it again here.
            Board.clear();
        });
        document.getElementById('back-btn')?.addEventListener('click', () => Board.goBack());
        document.getElementById('forward-btn')?.addEventListener('click', () => Board.goForward());

        // Turn toggle
        document.getElementById('turn-white')?.addEventListener('click', () => _setTurn('w'));
        document.getElementById('turn-black')?.addEventListener('click', () => _setTurn('b'));

        // Auto-play — one button per metric, below each column group
        _AUTO_PLAY_METRICS.forEach(metric => {
            _autoplayBtn(metric)?.addEventListener('click', () => {
                if (_autoPlayMetric === metric) _stopAutoPlay();
                else _startAutoPlay(metric);
            });
        });

        Tablebase.setMoveSelectHandler(san => {
            const played = Board.playMove(san);
            if (!played) { toast('Illegal move — this position may have changed.'); }
        });

        _initPgnDialog();
        _initSettings();
        _updateNavBtns();
        _updateTurnBadge(Board.currentFen());
        _bindKeys();

        // Run the same pipeline Apply/moves/etc. use, so a FEN loaded from
        // the URL hash (or the default starting FEN) is probed immediately
        // instead of sitting unprobed until the user manually hits Apply.
        // Uses Board.currentFen() rather than `initialFen` so a restored
        // game probes the position the user was actually looking at,
        // not the start of that game's move line.
        // immediate=true: this is the very first probe of the session, so
        // there's no prior in-flight probe for the 300ms debounce to guard
        // against — going through it here just added a flat 300ms of dead
        // time before the page's first result ever appeared.
        onPositionChange(Board.currentFen(), false, true);
    }

    return { init, onPositionChange, normalizeFen, readHashFen, readLastGame, toast };

})();

export { UI };