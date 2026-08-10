/**
 * app.js — Bootstrap
 *
 * The entry point, loaded as a module. Determines the initial position,
 * wires up board/piece theming in the correct order, initialises the UI,
 * and listens for URL hash changes so the position stays in sync with
 * `#fen=...` links (read on load; written on every position change by
 * ui.js).
 *
 * Theme.init(Board.reconstruct) is registered BEFORE Board.init() runs,
 * because Board.init() reads Theme.pieceThemeFn() while constructing the
 * Chessboard() instance. Theme.apply() runs AFTER Board.init(), because it
 * injects a <style> tag that targets DOM nodes the board just created.
 */

import { UI }    from './ui.js';
import { Board } from './board.js';
import { Theme } from './theme.js';

(function () {

    // Default starting position for the explorer. The castling-availability
    // field is always '-': the loaded tablebases are generated on the
    // assumption that neither side retains the right to castle.
    const DEFAULT_FEN = '4k3/8/8/8/8/8/8/4K2R w - - 0 1';

    // Read position from URL hash first (e.g. a shared link). If there's no
    // hash (e.g. we just navigated back from /admin, which has no #fen= of
    // its own and so drops it entirely), fall back to the last full game
    // (start position + move list) persisted to localStorage — this is what
    // lets both the board position *and* the PGN panel survive that
    // round-trip. Falls back to the hard-coded default starting position if
    // neither is available.
    const hashFen   = UI.readHashFen();
    const lastGame  = UI.readLastGame();

    let initialFen, restoreGame;
    if (hashFen) {
        initialFen  = UI.normalizeFen(hashFen);
        restoreGame = null;
    } else if (lastGame) {
        initialFen  = UI.normalizeFen(lastGame.startFen);
        restoreGame = lastGame;
    } else {
        initialFen  = DEFAULT_FEN;
        restoreGame = null;
    }

    // Register the piece-set reconstruction callback before Board.init()
    // creates the first Chessboard() instance.
    Theme.init(Board.reconstruct);

    document.addEventListener('DOMContentLoaded', () => {
        UI.init(initialFen, restoreGame);

        // Restore persisted board + piece set and inject the theme <style>
        // tag. Runs after UI.init() (which calls Board.init()) because the
        // injected CSS targets board DOM nodes that must already exist.
        Theme.apply();
    });

    // Also support hash changes (browser back/forward, shared links opened while tab is open).
    // Goes through Board.setPosition() — not UI.onPositionChange() directly — so the visible
    // board, the internal chess.js game object, and the move tree all move with the hash instead
    // of only the FEN box/results panel updating. setPosition() invokes onPositionChange() itself.
    window.addEventListener('hashchange', () => {
        const newFen = UI.readHashFen();
        if (!newFen) return;
        const result = Board.setPosition(UI.normalizeFen(newFen));
        if (!result.ok) UI.toast(result.reason || 'Invalid position in URL.');
    });

}());
