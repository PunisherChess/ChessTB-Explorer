/**
 * board.js — Chessground wrapper
 *
 * Wraps the vendor Chessground() instance and a chess.js game-state object,
 * and owns:
 *   - A branching move tree (_nodes/_rootChildren) used by the PGN panel:
 *     playing a move after navigating back adds a variation instead of
 *     overwriting whatever previously continued from that point. A plain
 *     undo/redo FEN stack (_history/_future) sits alongside it as a
 *     fallback for Back/Forward once navigation walks off the tree (e.g.
 *     past a board edit that started a fresh one).
 *   - Best-move arrows for DTC/DTM/DTM50, drawn via chessground's native
 *     drawable.autoShapes.
 *   - Click-to-place editing: click a spare piece, then click a square to
 *     place it. Drag-from-tray is also supported (chessground's
 *     dragNewPiece()).
 *   - goToNode() — jump to any node in the *current* move tree (used by
 *     the PGN panel, including variation moves) without resetting the tree
 *     or re-triggering a probe for a position that's already been evaluated.
 *   - Board/piece theming: the piece image path is owned by theme.js
 *     (Theme.pieceThemeFn()). reconstruct(pieceThemeFn) updates the piece
 *     CSS <link> and repopulates the spare-tray/promotion-dialog images;
 *     chessground never needs to be destroyed and rebuilt for a piece-set
 *     change, since piece images are plain CSS.
 *
 * Every position-changing action — setPosition(), clear(), playMove(),
 * goBack()/goForward(), board edits (off-board drop, board-setup drag,
 * click-to-place) — records itself (in the tree or the undo/redo stack,
 * whichever applies) and invokes the onPositionChange callback itself, so
 * callers never need to remember to do either one manually.
 *
 * chess.js (via _game) remains the single source of truth for
 * position/legality — chessground is a dumb, controlled rendering surface.
 * Every position-changing function ends with a call to _syncChessground(),
 * which pushes _game's current FEN (plus turn colour, check state, and
 * last-move squares) into chessground in one shot. The core mutation
 * handler (_handleBoardMutation) is written to be idempotent rather than
 * tracking which of chessground's several event hooks handled a given user
 * action, because chessground fires multiple, differently-scoped events for
 * what is logically one move — see the comment above events.move's wiring
 * in init() for the actual firing order this relies on: for an ordinary
 * relocation, chessground's own events.move fires first, then
 * events.change, then movable.events.after (confirmed directly from
 * chessground's source, not a timing flake — see board.ts's
 * baseMove()/userMove()). events.change carries no orig/dest, so if it won
 * the idempotency race it would take the generic "board edit" branch and
 * leave movable.events.after's orig/dest with nothing left to act on.
 * Wiring events.move as the primary handler avoids that: it fires before
 * events.change and, unlike movable.events.after, carries orig/dest (plus
 * capture info), so it reliably wins the idempotency race with enough
 * information to classify the move correctly. events.change and
 * movable.events.after stay wired as idempotent fallbacks, since neither
 * can fire before events.move for a relocation, and events.change remains
 * the only hook that fires at all for an off-board deletion (drag.ts's
 * deleteOnDropOff branch calls it directly, with no accompanying
 * events.move/movable.events.after).
 */

import { Chess }       from '../vendor/chess-1.4.0.esm.js';
import { Chessground } from '../vendor/chessground.min.js';
import { Theme }       from './theme.js';

const Board = (() => {

    let cg     = null;   // Chessground instance
    let _game  = null;
    let _onPositionChange    = null;
    let _onMoveHistoryChange = null;

    let _pendingPromotion = null;

    // ── Lock mode ────────────────────────────────────────────────────────────
    // When true, the board only accepts legal moves for the side to move;
    // spare-piece placement and off-board deletion are disabled. Toggled via
    // setLocked(). Moves played through the ranked-moves table, auto-play, or
    // the PGN panel are unaffected, since those are already always legal.
    let _locked = false;

    // [orig, dest] of the most recently played/navigated-to move, or
    // undefined. Fed into chessground's `lastMove` config on every sync.
    // Tracked separately from the move tree because Back/Forward/goToNode
    // land on a node that already has its own from/to squares recorded —
    // this variable is what lets _syncChessground() highlight the right
    // squares for those navigations too, not just for a freshly played move.
    let _lastMoveKeys = undefined;

    // ── Undo / redo stacks ────────────────────────────────────────────────────
    // Plain chronological FEN log, used only as a Back/Forward fallback once
    // navigation walks off the current move tree entirely (e.g. past a board
    // edit — edits aren't part of the tree, see _resetMoveLine below). While
    // the current position is inside the tree, goBack()/goForward() use the
    // tree's parent/activeChild pointers instead (see below).
    let _history = [];
    let _future  = [];
    const _MAX_HISTORY = 100;

    function _pushHistory(fen) {
        _history.push(fen);
        if (_history.length > _MAX_HISTORY) _history.shift();
        _future = [];   // any new position discards the redo stack
    }

    // ── Move tree ──────────────────────────────────────────────────────────────
    // Only legal moves via playMove() (and the promotion/drag-move
    // equivalents) are recorded here. setPosition() / clear() / board edits
    // reset the tree.
    //
    // Each node is {id, san, fen, from, to, parentId, children, activeChild}.
    // `id` is also the node's index in _nodes. parentId === ROOT (-1) means
    // the node replies to the tree's start position (_startFen). `children`
    // lists every move tried from that node — children[0] renders as the
    // "main" continuation, children[1+] as parenthesised variations.
    // `activeChild` is whichever child Forward should follow from that node
    // (whichever branch was most recently played/clicked into) — not
    // necessarily children[0]. `from`/`to` are the move's origin/destination
    // squares, recorded alongside san/fen so lastMove highlighting works
    // when navigating the tree, not just on a freshly-played move.
    //
    // The PGN panel and PGN export walk this tree recursively so alternate
    // moves are preserved as variations instead of overwriting history.
    const ROOT = -1;

    let _nodes           = [];   // [{id, san, fen, from, to, parentId, children:[], activeChild}]
    let _rootChildren    = [];   // ids of moves played directly from _startFen
    let _rootActiveChild = null;
    let _currentId        = ROOT; // id of the node currently shown, or ROOT for _startFen itself
    let _startFen         = null; // FEN the current tree began from (for PGN formatting)

    function _childrenOf(id) { return id === ROOT ? _rootChildren : _nodes[id].children; }
    function _activeChildOf(id) { return id === ROOT ? _rootActiveChild : _nodes[id].activeChild; }
    function _setActiveChild(id, childId) {
        if (id === ROOT) _rootActiveChild = childId;
        else _nodes[id].activeChild = childId;
    }

    function _resetMoveLine() {
        _nodes            = [];
        _rootChildren     = [];
        _rootActiveChild  = null;
        _currentId        = ROOT;
        _future           = [];
        _startFen         = _game ? _game.fen() : null;
        if (_onMoveHistoryChange) _emitHistory();
    }

    function _emitHistory() {
        if (_onMoveHistoryChange) {
            _onMoveHistoryChange({
                nodes: _nodes, rootChildren: _rootChildren,
                rootActiveChild: _rootActiveChild, currentId: _currentId,
            }, _startFen);
        }
    }

    // Records a played move as a child of the current node. If the current
    // node already has a child with this exact SAN (the user replayed a move
    // already tried from this point), that existing node is reused instead
    // of creating a duplicate. Otherwise a new node is created and placed at
    // the FRONT of the children list — it becomes the new "main" line going
    // forward, and whatever previously continued from this point (if
    // anything) is demoted to a parenthesised variation.
    function _addMove(san, fen, from, to) {
        _future = [];   // starting a fresh line invalidates any pre-tree redo
        const kids = _childrenOf(_currentId);
        let childId = kids.find(id => _nodes[id].san === san);
        if (childId === undefined) {
            childId = _nodes.length;
            _nodes.push({ id: childId, san, fen, from, to, parentId: _currentId, children: [], activeChild: null });
            kids.unshift(childId);
        }
        // (else: reused an existing child — same SAN replayed from this node)
        _setActiveChild(_currentId, childId);
        _currentId = childId;
        return childId;
    }

    // ── Piece theme ───────────────────────────────────────────────────────────
    // Delegates to theme.js, which owns the active piece set. Kept as a local
    // wrapper (rather than calling Theme.pieceThemeFn() inline everywhere)
    // so callers below don't need to know theme.js exists.
    function _pieceTheme(piece) {
        return Theme.pieceThemeFn()(piece);
    }

    // Builds chessground's `movable.dests` shape (Map<Key, Key[]>) from
    // chess.js's legal-move list, grouped by origin square. Only consulted
    // while locked — see _syncChessground() below.
    function _legalDestsMap() {
        const dests = new Map();
        if (!_game) return dests;
        _game.moves({ verbose: true }).forEach(m => {
            const list = dests.get(m.from);
            if (list) list.push(m.to);
            else dests.set(m.from, [m.to]);
        });
        return dests;
    }

    // ── Chessground sync ──────────────────────────────────────────────────────
    // The single point where _game's state is pushed into chessground.
    // Called unconditionally after every position-changing action — even a
    // "legal move" one, since chessground's own baseMove() has no concept of
    // en passant or promotion and can leave its internal state briefly
    // chess-wise-incorrect (e.g. not removing the captured pawn on an en
    // passant capture, or leaving a pawn on the back rank instead of the
    // promoted piece, until this call corrects it). We never treat
    // chessground's internal state as authoritative; this call always
    // overwrites it from _game.
    function _syncChessground() {
        if (!cg || !_game) return;
        cg.set({
            fen:       _game.fen(),
            turnColor: _game.turn() === 'w' ? 'white' : 'black',
            check:     _game.isCheck() ? (_game.turn() === 'w' ? 'white' : 'black') : false,
            lastMove:  _lastMoveKeys,
            // Locked: restrict dragging/click-move to the side to move's
            // legal destinations. Unlocked: free editing.
            movable: {
                free:  !_locked,
                color: _locked ? (_game.turn() === 'w' ? 'white' : 'black') : 'both',
                dests: _locked ? _legalDestsMap() : undefined,
            },
            // Off-board drop-to-delete is disabled while locked, same as the
            // spare trays below.
            draggable: { deleteOnDropOff: !_locked },
        });
    }

    // ── Promotion ─────────────────────────────────────────────────────────────
    // pieceCode is a two-letter code like 'wP' (colour + uppercase type),
    // matching the shape the rest of this file (and theme.js) already uses.
    function _isPromotionMove(target, pieceCode) {
        if (!pieceCode || pieceCode[1] !== 'P') return false;
        const color = pieceCode[0], rank = target[1];
        return (color === 'w' && rank === '8') || (color === 'b' && rank === '1');
    }
    function _showPromotionDialog(source, target, color) {
        _pendingPromotion = { source, target };
        const dialog = document.getElementById('promotion-dialog');
        ['q','r','b','n'].forEach(p => {
            const btn = dialog.querySelector(`.promotion-piece-btn[data-piece="${p}"]`);
            const img = btn && btn.querySelector('img');
            if (img) img.src = _pieceTheme(color + p.toUpperCase());
        });
        dialog.classList.add('is-visible');
        dialog.querySelector('.promotion-piece-btn')?.focus();
    }
    function _hidePromotionDialog() {
        document.getElementById('promotion-dialog').classList.remove('is-visible');
    }
    // Cancelling (Escape / backdrop click) needs to resync now, since
    // chessground has already visually relocated the pawn to the target
    // square by the time the dialog is showing (its own drag/drop already
    // moved the piece before this handler ever runs). This call reverts
    // that visual relocation by pushing _game's still-unchanged state back
    // into chessground.
    function _cancelPromotion() {
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
    }
    function _onPromotionSelect(piece) {
        _hidePromotionDialog();
        if (!_pendingPromotion) return;
        const { source, target } = _pendingPromotion;
        _pendingPromotion = null;
        let legalMove = null;
        try { legalMove = _game.move({ from: source, to: target, promotion: piece }); }
        catch (_) { legalMove = null; }
        if (!legalMove) { _syncChessground(); return; }   // revert the visual pawn-on-back-rank relocation
        _lastMoveKeys = [source, target];
        _addMove(legalMove.san, _game.fen(), legalMove.from, legalMove.to);
        _emitHistory();
        _syncChessground();
        // immediate=true: a completed promotion is a single, definite move
        // (see playMove()'s own comment on this parameter), not part of a
        // rapid-fire stream of changes the debounce below it is meant to
        // guard against.
        if (_onPositionChange) _onPositionChange(_game.fen(), true, true);
    }

    // ── Core sync algorithm ──────────────────────────────────────────────────
    // Chessground fires multiple, differently-scoped callbacks for what a
    // user experiences as a single action (events.move, events.change,
    // movable.events.after, events.dropNewPiece), so rather than track
    // which-callback-handled-what with suppression flags, this handler is
    // idempotent: it compares chessground's current placement against
    // _game's, and no-ops if they already match.
    //
    // events.move is wired as the informative hook (the one that passes
    // origHint/destHint below) rather than movable.events.after, based on
    // chessground's actual event-firing order for an ordinary relocation:
    // events.move fires first (scheduled from within board.ts's baseMove()),
    // then events.change (also scheduled by baseMove(), immediately after),
    // then movable.events.after (scheduled later by userMove()) — all via
    // setTimeout(fn,1), so same-delay-timer FIFO ordering makes this
    // deterministic, not a race (confirmed directly from chessground's
    // source). events.change carries no orig/dest, so if it were the
    // informative hook it would always take the generic "board edit" branch
    // below first, leaving movable.events.after's real orig/dest with
    // nothing left to act on once it fires — the idempotency guard would
    // already see the position as synced. events.move avoids that: it
    // fires before events.change and, unlike movable.events.after, carries
    // orig/dest (plus capture info), so it reliably wins the idempotency
    // race with enough information to classify the move correctly.
    // events.change and movable.events.after stay wired below as idempotent
    // fallbacks/no-ops for a relocation; events.change remains load-bearing
    // for the one case with no orig/dest-carrying hook at all — an
    // off-board deletion (drag.ts's deleteOnDropOff branch).
    function _handleBoardMutation(origHint, destHint) {
        if (!cg || !_game) return;
        const cgPlacement  = cg.getFen();                 // chessground's own current placement-only FEN
        const ourPlacement = _game.fen().split(' ')[0];
        if (cgPlacement === ourPlacement) return;          // already synced by another callback this tick

        if (origHint && destHint) {
            // _game hasn't moved yet at this point — only chessground has —
            // so the piece that was at origHint is still readable from _game.
            const pieceAtOrig = _game.get(origHint);
            const pieceCode   = pieceAtOrig ? (pieceAtOrig.color + pieceAtOrig.type.toUpperCase()) : null;
            if (pieceCode && _isPromotionMove(destHint, pieceCode)) {
                _showPromotionDialog(origHint, destHint, pieceCode[0]);
                return;   // resolved later by _onPromotionSelect()/_cancelPromotion()
            }
            let legalMove = null;
            try { legalMove = _game.move({ from: origHint, to: destHint, promotion: 'q' }); }
            catch (_) { legalMove = null; }
            if (legalMove) {
                _lastMoveKeys = [origHint, destHint];
                _addMove(legalMove.san, _game.fen(), legalMove.from, legalMove.to);
                _emitHistory();
                _syncChessground();
                // immediate=true: see the comment on the equivalent call in
                // _onPromotionSelect() above — a completed drag-and-drop
                // move is a single, definite move too.
                if (_onPositionChange) _onPositionChange(_game.fen(), true, true);
                return;
            }
            // Not legal — fall through to the generic edit path below, which
            // reads the placement chessground already committed rather than
            // origHint/destHint.
        }

        // Board-edit path: spare-piece drop, off-board delete, or an
        // illegal relocation.
        const prevFen = _game.fen();
        const nextFen = `${cgPlacement} ${_game.turn()} - - 0 1`;
        try { _game.load(nextFen); }
        catch (_) { _syncChessground(); return; }   // invalid resulting position — snap back
        _pushHistory(prevFen);
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        if (_onPositionChange) _onPositionChange(_game.fen(), false);
    }

    function _onCgSelect(key) {
        if (!_clickPlacePiece) return;         // not in placement mode — let chessground handle the click normally
        cg.selectSquare(null);                  // clear any selection chessground itself may have started,
                                                 // so a piece "armed" for placement never gets relocated
                                                 // by chessground's own click-to-move instead
        const prevFen = _game.fen();
        const placed = _game.put(
            { type: _clickPlacePiece[1].toLowerCase(), color: _clickPlacePiece[0] === 'w' ? 'w' : 'b' },
            key
        );
        if (!placed) return;    // rejected — placing a king of a colour that already has one elsewhere
        _pushHistory(prevFen);
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        if (_onPositionChange) _onPositionChange(_game.fen(), false);
    }

    // ── Best-move arrows (DTC / DTM / DTM50) ─────────────────────────────────
    // Native chessground feature (drawable.autoShapes) — square keys, not
    // pixel coordinates, so chessground handles orientation/resizing itself.
    // bestMoves: { dtc: entry|null, dtm: entry|null, dtm50: entry|null } —
    // the top-ranked move for each metric (any of which may be missing, e.g.
    // for a terminal or not-yet-probed position).
    function drawArrows(bestMoves) {
        if (!cg) return;
        if (!bestMoves) { cg.setAutoShapes([]); return; }
        const legalVerbose = _game.moves({ verbose: true });
        const sanMap = {};
        legalVerbose.forEach(m => { sanMap[m.san] = m; });

        const shapes = [];
        ['dtc', 'dtm', 'dtm50'].forEach(metric => {
            const entry = bestMoves[metric];
            if (!entry) return;
            const moveObj = sanMap[entry.san];
            if (!moveObj) return;
            shapes.push({ orig: moveObj.from, dest: moveObj.to, brush: metric });
        });
        cg.setAutoShapes(shapes);
    }
    function clearArrows() {
        if (!cg) return;
        cg.setAutoShapes([]);
    }

    // ── Click-to-place + spare-piece trays ───────────────────────────────────
    let _clickPlacePiece = null;   // e.g. 'wQ', 'bK', or null

    const ROLE_OF = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
    function _toCgPiece(code /* e.g. 'wQ' */) {
        return { color: code[0] === 'w' ? 'white' : 'black', role: ROLE_OF[code[1]] };
    }

    function _populateTrayImages() {
        document.querySelectorAll('.spare-piece').forEach(btn => {
            const code = btn.dataset.piece;
            const img  = btn.querySelector('img');
            if (img && code) img.src = _pieceTheme(code);
        });
    }

    // Two interaction paths, both needed: click-to-place (click a tray
    // piece, then click a destination square) and drag-from-tray (native
    // HTML5 drag onto the board, handled via chessground's dragNewPiece()).
    // The spare-piece trays are expected to support both at once, so
    // neither wiring below can assume the other is absent.
    function _initSpareTrays() {
        document.querySelectorAll('.spare-piece').forEach(btn => {
            const code = btn.dataset.piece;

            // Path 1: click tray piece, then click a square — handled by
            // this click listener (arms _clickPlacePiece) plus _onCgSelect()
            // (does the actual placement), wired in init()'s Config.events.select.
            // Disabled while locked (tray is also dimmed — see setLocked()).
            btn.addEventListener('click', () => {
                if (_locked) return;
                setClickPlacePiece(_clickPlacePiece === code ? null : code);
            });

            // Path 2: drag a tray piece directly onto the board. `force:
            // true` is required — cg.dragNewPiece() without it refuses to
            // overwrite an occupied square, and dropping a spare piece onto
            // an occupied square is expected to replace it. Disabled while locked.
            btn.addEventListener('pointerdown', e => {
                if (_locked) return;
                if (e.button !== undefined && e.button !== 0) return;   // primary pointer only
                cg.dragNewPiece(_toCgPiece(code), e, /* force */ true);
            });
        });

        // Escape clears click-to-place selection
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _clickPlacePiece) setClickPlacePiece(null);
        });
    }

    function setClickPlacePiece(piece) {
        _clickPlacePiece = piece;
        // Visual feedback
        document.querySelectorAll('.spare-piece.cp-selected').forEach(el => el.classList.remove('cp-selected'));
        if (piece) {
            document.querySelectorAll(`.spare-piece[data-piece="${piece}"]`).forEach(el => el.classList.add('cp-selected'));
        }
        // Update cursor on board
        const boardEl = document.getElementById('board');
        if (boardEl) {
            boardEl.classList.toggle('cp-active', !!piece);
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    // Shared king-count sanity check, used by both init() and setPosition() —
    // chess.js's own load() validates check legality etc. but doesn't reject
    // a placement with zero or more than one king per side.
    function _kingCountError(fen) {
        const placement = (fen || '').split(' ')[0] || '';
        const wKings = (placement.match(/K/g) || []).length;
        const bKings = (placement.match(/k/g) || []).length;
        if (wKings === 0) return 'Position has no white king.';
        if (bKings === 0) return 'Position has no black king.';
        if (wKings > 1)   return 'Position has more than one white king.';
        if (bKings > 1)   return 'Position has more than one black king.';
        return null;
    }

    // Shared castling-rights check, used by both init() and setPosition() —
    // the loaded tablebases are generated on the assumption that neither
    // side retains the right to castle, so a FEN granting castling rights
    // to either side is rejected here for the same reason a bad king count
    // is: chess.js itself would happily load it (and, with the king and
    // rook still on their home squares, treat castling as a legal move),
    // but that isn't a position this tool's tablebase data can speak to.
    function _castlingRightsError(fen) {
        const castling = (fen || '').split(' ')[2];
        if (castling !== undefined && castling !== '-') {
            return "Castling rights are not supported: the castling-availability field must be '-'.";
        }
        return null;
    }

    function _restoredOrientation() {
        try { return localStorage.getItem('chesstb_orientation') === 'black' ? 'black' : 'white'; }
        catch (_) { return 'white'; }
    }

    function _restoredLocked() {
        try { return localStorage.getItem('chesstb_locked') === 'true'; }
        catch (_) { return false; }
    }

    function init(onPositionChange, initialFen) {
        _onPositionChange = onPositionChange;
        _game = new Chess();
        // Same validation setPosition() applies to every later position
        // change — an invalid initialFen (bad king count, castling rights
        // present, or one chess.js itself rejects) falls back to the
        // default reset position, and the reason is returned below so the
        // caller can tell the user, instead of silently substituting a
        // different position with no feedback.
        const startupError = _kingCountError(initialFen) || _castlingRightsError(initialFen);
        let loadError = null;
        if (startupError) {
            loadError = startupError;
            _game.reset();
        } else {
            try { _game.load(initialFen); }
            catch (_) { loadError = 'Invalid FEN: position violates chess rules.'; _game.reset(); }
        }
        _startFen = _game.fen();

        // Built from _startFen (the validated/fallback position), not the
        // raw initialFen — otherwise an invalid initialFen leaves the
        // visible board showing the rejected placement while _game already
        // holds the fallback, a desync baked in right at startup.
        cg = Chessground(document.getElementById('board'), {
            fen:                  _startFen,
            orientation:          _restoredOrientation(),
            turnColor:            _game.turn() === 'w' ? 'white' : 'black',
            check:                _game.isCheck() ? (_game.turn() === 'w' ? 'white' : 'black') : false,
            lastMove:             undefined,
            coordinates:          true,
            // coordinatesOnSquares stays false: that mode prints a combined
            // "a8"-style label on all 64 squares, whereas this app wants the
            // classic look — a rank number down the left column and a file
            // letter along the bottom row only, both sitting inset at the
            // board's edges. Chessground's native coords.ranks/coords.files
            // strips (one rank-only label per row, one file-only label per
            // column) already produce that layout once repositioned via CSS
            // (see main.css) to sit inside the board edge instead of outside
            // it, so the combined per-square mode isn't needed here.
            coordinatesOnSquares: false,
            // Castling is driven by chess.js (_game), not chessground's own
            // king-two-squares heuristic, so chessground should never
            // second-guess or auto-correct a king move into a castle itself.
            autoCastle:           false,
            viewOnly:             false,
            disableContextMenu:   true,
            highlight:            { lastMove: true, check: true },
            animation:            { enabled: true, duration: 200 },
            movable: {
                // Any drag is provisionally accepted here and classified
                // afterward by _handleBoardMutation, rather than gating
                // drags up front with a separate edit-mode toggle.
                free:  true,
                color: 'both',
                showDests: true,
                events: { after: (orig, dest) => _handleBoardMutation(orig, dest) },
            },
            premovable:  { enabled: false },
            draggable: {
                enabled:         true,
                showGhost:       true,
                deleteOnDropOff: true,
            },
            selectable: { enabled: true },
            events: {
                move:         (orig, dest) => _handleBoardMutation(orig, dest),
                change:       () => _handleBoardMutation(),
                dropNewPiece: () => _handleBoardMutation(),
                select:       (key) => _onCgSelect(key),
            },
            drawable: {
                enabled: true,
                visible: true,
                brushes: {
                    dtc:   { key: 'dtc',   color: '#2451c4', opacity: 0.40, lineWidth: 10 },
                    dtm:   { key: 'dtm',   color: '#8b93a1', opacity: 0.40, lineWidth: 10 },
                    dtm50: { key: 'dtm50', color: '#e1453a', opacity: 0.40, lineWidth: 10 },
                },
            },
        });

        const dialog = document.getElementById('promotion-dialog');
        dialog.querySelectorAll('.promotion-piece-btn').forEach(btn => {
            btn.addEventListener('click', () => _onPromotionSelect(btn.dataset.piece));
        });
        dialog.addEventListener('click', e => {
            if (e.target === dialog) _cancelPromotion();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && dialog.classList.contains('is-visible')) _cancelPromotion();
        });

        _populateTrayImages();
        _initSpareTrays();
        _syncTrayOrientation();

        // Restored the same way orientation is above — persist:false since
        // this is a stored preference being applied on load, not a new one
        // being set, so it's not written straight back to the same key.
        setLocked(_restoredLocked(), false);

        return loadError ? { ok: false, reason: loadError } : { ok: true };
    }

    /**
     * Update the active piece-set CSS <link> and repopulate the spare-tray
     * and promotion-dialog images, preserving position/orientation/history
     * (none of which live inside the Chessground instance to begin with).
     * Registered with theme.js via Theme.init(reconstruct) and invoked when
     * the user picks a different piece set.
     *
     * This never touches the Chessground instance itself — piece images are
     * plain CSS (`.cg-wrap piece.<role>.<color>`), not baked into a
     * constructor closure, so there's no board to destroy and rebuild for a
     * piece-set change; swapping the stylesheet is enough.
     */
    function reconstruct(pieceThemeFn) {
        if (!cg || !_game) return;
        const link = document.getElementById('chesstb-piece-css');
        // theme.js has already updated its active piece set by the time this
        // runs (see Theme.changePieceSet()), so Theme.currentPieceSet() and
        // the pieceThemeFn passed in here always agree — using it directly
        // is simpler than re-deriving the set id from a sample image path.
        if (link) link.href = `/static/css/pieces-${Theme.currentPieceSet()}.css`;
        _populateTrayImages();
    }

    function setPosition(fen) {
        const positionError = _kingCountError(fen) || _castlingRightsError(fen);
        if (positionError) return { ok: false, reason: positionError };
        const prevFen = _game.fen();
        try { _game.load(fen); }
        catch (_) {
            return { ok: false, reason: 'Invalid FEN: position violates chess rules.' };
        }
        _pushHistory(prevFen);
        _hidePromotionDialog();
        _pendingPromotion = null;
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        // Invoke the position-change callback here, the same way
        // playMove()/goBack()/goForward()/goToNode() already do, instead of
        // leaving every caller to remember to call it (and to probe the
        // tablebase) manually. See clear() below for the same behaviour.
        const nextFen = _game.fen();
        if (_onPositionChange) _onPositionChange(nextFen, false);
        return { ok: true };
    }

    function clear() {
        const prevFen  = _game.fen();
        const resetFen = '4k3/8/8/8/8/8/8/4K3 w - - 0 1';
        _pushHistory(prevFen);
        try { _game.load(resetFen); }
        catch (_) { _syncChessground(); return resetFen; }
        _hidePromotionDialog();
        _pendingPromotion = null;
        _lastMoveKeys = undefined;
        _resetMoveLine();
        _syncChessground();
        // See setPosition() above.
        if (_onPositionChange) _onPositionChange(resetFen, false);
        return resetFen;
    }

    // Mirrors chessground's own orientation as a class on #board-wrap-inner;
    // main.css uses it to flip flex-direction so the spare-piece trays swap
    // sides visually without moving them in the DOM.
    function _syncTrayOrientation() {
        const wrapEl = document.getElementById('board-wrap-inner');
        if (wrapEl) wrapEl.classList.toggle('orientation-black', cg.state.orientation === 'black');
    }

    function flip() {
        cg.toggleOrientation();
        _syncTrayOrientation();
        try { localStorage.setItem('chesstb_orientation', cg.state.orientation); } catch (_) {}
        clearArrows();   // arrows are orientation-dependent; caller (ui.js) redraws right after flip
    }

    function currentFen()   { return _game.fen(); }

    // ── Lock mode (public) ───────────────────────────────────────────────────
    // Toggles legal-moves-only board interaction. Persisted to localStorage
    // the same way orientation is (see flip()) when persist defaults to
    // true; callers applying an already-known value (init() restoring on
    // load, or ui.js's auto-play engaging/releasing Lock) pass persist:false.
    function setLocked(locked, persist = true) {
        _locked = !!locked;
        if (_locked) setClickPlacePiece(null);   // drop any armed spare piece
        document.querySelectorAll('.spare-tray').forEach(el => {
            el.classList.toggle('is-locked', _locked);
            if (_locked) el.setAttribute('title', 'Board is locked');
            else el.removeAttribute('title');
        });
        if (persist) {
            try { localStorage.setItem('chesstb_locked', String(_locked)); } catch (_) {}
        }
        _syncChessground();
    }
    function isLocked() { return _locked; }

    function playMove(san) {
        let move = null;
        try { move = _game.move(san); } catch (_) { move = null; }
        if (!move) return false;

        const nextFen = _game.fen();
        _lastMoveKeys = [move.from, move.to];

        // Track in the move tree (branches instead of overwriting if the
        // user had navigated back before playing this move).
        _addMove(move.san, nextFen, move.from, move.to);
        _emitHistory();
        _syncChessground();

        // immediate=true: this is a single, definite move (played by
        // auto-play or by clicking a move in the ranked-moves table, the
        // two callers of playMove() — see ui.js), not a rapid-fire stream
        // of changes the 300ms debounce is meant to guard against. Without
        // this, onPositionChange()'s `immediate` parameter is left
        // undefined and every played move's probe sits behind the 300ms
        // debounce for no reason — most visible as a flat ~300ms of extra
        // latency between auto-play moves even with Autoplay Delay set to
        // 0s, on top of (and indistinguishable from) actual probe latency.
        if (_onPositionChange) _onPositionChange(nextFen, true, true);
        return true;
    }

    // Back/Forward walk the move tree directly (parent / activeChild) so
    // stepping through a line that includes variations works the same as
    // stepping through the main line. The plain _history/_future FEN stack
    // is only consulted once navigation reaches the tree's root (id ROOT)
    // and goes further back than the tree itself — i.e. undoing past
    // whatever move/edit started the current tree (see _resetMoveLine).
    function goBack() {
        if (_currentId !== ROOT) {
            const parentId = _nodes[_currentId].parentId;
            const fen = parentId === ROOT ? _startFen : _nodes[parentId].fen;
            try { _game.load(fen); }
            catch (_) { _syncChessground(); return false; }
            _lastMoveKeys = parentId === ROOT ? undefined : [_nodes[parentId].from, _nodes[parentId].to];
            _currentId = parentId;
        } else {
            if (_history.length === 0) return false;
            const prevFen = _history.pop();
            _future.push(_game.fen());
            try { _game.load(prevFen); }
            catch (_) {
                _future.pop();
                _syncChessground();
                return false;
            }
            // The plain _history/_future stack holds FENs only, with no
            // accompanying from/to squares (unlike tree nodes), so there's
            // nothing to highlight as the last move here.
            _lastMoveKeys = undefined;
        }
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(_game.fen(), false);
        return true;
    }

    function goForward() {
        const activeChildId = _activeChildOf(_currentId);
        if (activeChildId !== null && activeChildId !== undefined) {
            const node = _nodes[activeChildId];
            try { _game.load(node.fen); }
            catch (_) { _syncChessground(); return false; }
            _lastMoveKeys = [node.from, node.to];
            _currentId = activeChildId;
        } else if (_currentId === ROOT && _future.length > 0) {
            const nextFen = _future.pop();
            _history.push(_game.fen());
            try { _game.load(nextFen); }
            catch (_) {
                _history.pop();
                _syncChessground();
                return false;
            }
            _lastMoveKeys = undefined;
        } else {
            return false;
        }
        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(_game.fen(), false);
        return true;
    }

    // goToNode() jumps to an arbitrary node in the *current* move tree (used
    // by the PGN panel — including variation moves, not just the main line).
    // Unlike setPosition(), this never calls _resetMoveLine(). targetId ===
    // ROOT (-1) means "start of the tree" (the position before any move was
    // played). Clicking any node marks it — and every ancestor on the path
    // to it — as its parent's activeChild, so Forward continues along
    // whichever branch was just brought into view.
    function goToNode(targetId) {
        if (targetId !== ROOT && !_nodes[targetId]) return false;
        if (targetId === _currentId) return true;

        const fen = targetId === ROOT ? _startFen : _nodes[targetId].fen;
        try { _game.load(fen); }
        catch (_) { return false; }

        const chain = [];
        let walk = targetId;
        while (walk !== ROOT) { chain.unshift(walk); walk = _nodes[walk].parentId; }
        let parent = ROOT;
        chain.forEach(id => { _setActiveChild(parent, id); parent = id; });
        _currentId = targetId;
        _lastMoveKeys = targetId === ROOT ? undefined : [_nodes[targetId].from, _nodes[targetId].to];

        _hidePromotionDialog();
        _pendingPromotion = null;
        _syncChessground();
        _emitHistory();
        if (_onPositionChange) _onPositionChange(_game.fen(), false);
        return true;
    }

    // restoreTree() rehydrates a full move tree (start position + every
    // node + which node was current) captured on a previous page, e.g.
    // before navigating to /admin and back. Does it as a single board
    // update instead of replaying each move (and its probe) individually.
    function restoreTree(startFen, nodes, rootChildren, rootActiveChild, currentId) {
        if (!_game || !startFen) return false;
        const safeNodes        = Array.isArray(nodes) ? nodes : [];
        const safeRootChildren = Array.isArray(rootChildren) ? rootChildren : [];
        const safeCurrentId    = (currentId === ROOT || (typeof currentId === 'number' && safeNodes[currentId]))
            ? currentId : ROOT;

        const loadFen = safeCurrentId === ROOT ? startFen : safeNodes[safeCurrentId].fen;
        try { _game.load(loadFen); }
        catch (_) {
            // Saved state doesn't parse (e.g. corrupted storage) — fall back
            // to just the start position with an empty tree.
            try { _game.load(startFen); } catch (_) { _game.reset(); }
            _startFen         = _game.fen();
            _nodes            = [];
            _rootChildren     = [];
            _rootActiveChild  = null;
            _currentId        = ROOT;
            _history          = [];
            _future           = [];
            _lastMoveKeys     = undefined;
            if (cg) {
                _hidePromotionDialog();
                _syncChessground();
            }
            _emitHistory();
            return false;
        }

        _startFen        = startFen;
        _nodes            = safeNodes;
        _rootChildren     = safeRootChildren;
        _rootActiveChild  = (typeof rootActiveChild === 'number') ? rootActiveChild : null;
        _currentId        = safeCurrentId;
        _history          = [];
        _future           = [];
        _lastMoveKeys     = (safeCurrentId === ROOT || !safeNodes[safeCurrentId])
            ? undefined
            : [safeNodes[safeCurrentId].from, safeNodes[safeCurrentId].to];

        _hidePromotionDialog();
        _pendingPromotion = null;
        if (cg) _syncChessground();
        _emitHistory();
        return true;
    }

    function canGoBack()    { return _currentId !== ROOT || _history.length > 0; }
    function canGoForward() {
        const activeChildId = _activeChildOf(_currentId);
        return (activeChildId !== null && activeChildId !== undefined) || (_currentId === ROOT && _future.length > 0);
    }

    function getMoveHistory() {
        return { nodes: _nodes, rootChildren: _rootChildren, rootActiveChild: _rootActiveChild, currentId: _currentId };
    }
    function getStartFen() { return _startFen; }       // PGN formatting
    function setOnMoveHistoryChange(fn) {
        _onMoveHistoryChange = fn;
    }

    return {
        init, reconstruct, setPosition, clear, flip, currentFen,
        playMove, goBack, goForward, goToNode, restoreTree, canGoBack, canGoForward,
        getMoveHistory, getStartFen, setOnMoveHistoryChange,
        drawArrows, clearArrows,
        setClickPlacePiece,
        setLocked, isLocked,
    };

})();

export { Board };
