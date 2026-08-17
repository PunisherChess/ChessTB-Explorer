/**
 * theme.js — Board and piece theming module
 *
 * Owns all visual choices for the chess board: square colours (or board
 * image), rank/file label colours, last-move highlight colour, spare-piece
 * tray colours, and the piece-set image path. Exposes a small public API
 * consumed by board.js, ui.js, and app.js.
 *
 * The two private CSS-generation functions below target chessground's
 * DOM/class model (`cg-board`, `coords.ranks`/`coords.files`) — see the
 * comment above _cssForColourBoard() for how coordinate-label positioning
 * and colouring are derived against that model.
 *
 * Board and piece set are tracked independently so changing one never
 * forces a change to the other. Internally, board configs are split into
 * two source arrays merged into one exported list:
 *
 *   COLOUR_BOARDS  — CSS-colour board configs (no image file required)
 *   IMAGE_BOARDS   — board image configs (rendered from the actual board
 *                    image file — there is no separate thumbnail asset;
 *                    the settings picker in ui.js renders `boardImage`
 *                    itself, scaled down by CSS)
 *   ALL_BOARDS     — COLOUR_BOARDS + IMAGE_BOARDS (this is what's exported;
 *                    ui.js doesn't need the colour/image split)
 *   PIECE_SETS     — piece set descriptors ({ id, label })
 *
 * Tray colours are board-specific and are written only by _applyCSS().
 * changePieceSet() calls _reconstructBoard() but NOT _applyCSS(), so the
 * tray colour never changes when the user switches piece sets.
 *
 * Public API:
 *   Theme.init(reconstructBoard)   — register board reconstruction callback
 *   Theme.apply()                  — restore persisted / default settings
 *   Theme.changeBoard(boardId)     — switch board (colour or image)
 *   Theme.changePieceSet(setId)    — switch piece set (rebuilds board; CSS unchanged)
 *   Theme.currentBoard()           — return active board config object
 *   Theme.currentPieceSet()        — return active piece set id string
 *   Theme.pieceThemeFn()           — return piece-code → image-path function
 *                                     (used by board.js's spare trays and
 *                                     promotion dialog)
 *
 * Also exported: ALL_BOARDS, PIECE_SETS (consumed by ui.js's settings panel).
 *
 * localStorage keys:
 *   chesstb_board    — board id
 *   chesstb_pieceset — piece set id
 */

// ── Colour board configs ──────────────────────────────────────────────────────
// Values match main.css's own square-colour defaults, so the default board
// (libre-brown) renders identically whether or not this module has run yet.

const COLOUR_BOARDS = [
    {
        id:          'libre-brown',
        label:       'Libre Brown',
        mode:        'colour',
        lightSquare: '#f0d9b5',
        darkSquare:  '#b58863',
        labelLight:  '#b58863',   // label colour on light-square corners
        labelDark:   '#f0d9b5',   // label colour on dark-square corners
        highlight:   'rgba(155, 199, 0, 0.41)',
        trayBg:      '#b0a998',
        trayBgDark:  '#726a5a',
        trayBorder:  '#8a8070',
    },
    {
        id:          'corporate-green',
        label:       'Corporate Green',
        mode:        'colour',
        lightSquare: '#eeeed2',
        darkSquare:  '#769656',
        labelLight:  '#769656',
        labelDark:   '#eeeed2',
        highlight:   'rgba(186, 202, 68, 0.5)',
        trayBg:      '#b4c396',
        trayBgDark:  '#78875a',
        trayBorder:  '#8c9b6e',
    },
];

// ── Image board configs ───────────────────────────────────────────────────────
// `boardImage` is the only image reference — it is used both as the board
// background *and* as the source for its own settings-panel option (scaled
// down by CSS). There is no separate thumbnail asset or thumbnail field.

const IMAGE_BOARDS = [
    {
        id:          'blue3',
        label:       'Blue Marble',
        mode:        'image',
        boardImage:  '/static/boards/blue3.jpg',
        labelLight:  '#4470a2',
        labelDark:   '#e6e3de',
        highlight:   'rgba(155, 199, 0, 0.41)',
        trayBg:      '#6a8aaa',
        trayBgDark:  '#3a5a7a',
        trayBorder:  '#4a6a8a',
    },
    {
        id:          'leather',
        label:       'Leather',
        mode:        'image',
        boardImage:  '/static/boards/leather.jpg',
        labelLight:  '#b58509',
        labelDark:   '#e7e3dd',
        highlight:   'rgba(155, 199, 0, 0.41)',
        trayBg:      '#c4aa6b',
        trayBgDark:  '#886e2f',
        trayBorder:  '#9c8243',
    },
    {
        id:          'wood4',
        label:       'Wood',
        mode:        'image',
        boardImage:  '/static/boards/wood4.jpg',
        labelLight:  '#85532d',
        labelDark:   '#cfb68f',
        highlight:   'rgba(155, 199, 0, 0.41)',
        trayBg:      '#b4a888',
        trayBgDark:  '#7a6a50',
        trayBorder:  '#8a7860',
    },
];

// ── Piece set descriptors ─────────────────────────────────────────────────────

export const PIECE_SETS = [
    { id: 'cburnett', label: 'CBurnett' },
    { id: 'kosal',    label: 'Kosal'    },
    { id: 'maestro',  label: 'Maestro'  },
];

export const ALL_BOARDS = [...COLOUR_BOARDS, ...IMAGE_BOARDS];

const DEFAULT_BOARD_ID    = 'libre-brown';
const DEFAULT_PIECESET_ID = 'cburnett';

const _LS_BOARD    = 'chesstb_board';
const _LS_PIECESET = 'chesstb_pieceset';

// ── Module state ──────────────────────────────────────────────────────────────

let _activeBoard      = COLOUR_BOARDS[0];  // default: Libre Brown
let _activePieceSet   = DEFAULT_PIECESET_ID;
let _reconstructBoard = null;              // callback registered via init()

// ── Private: CSS generation ───────────────────────────────────────────────────
//
// Chessground has no per-square light/dark CSS classes — the checkerboard
// pattern is a single background-image on `cg-board`. Colour boards render
// their two flat colours as a tiny tiled SVG data URI (_checkerboardDataUri)
// rather than replicating chessground's own base64/opacity-overlay
// technique — same visual result, easier to template and to review in a
// diff. Rank/file labels are chessground's own `coords.ranks`/`coords.files`
// elements, positioned by static CSS in main.css to sit inset at the
// board's corners rather than chessground's default outside-the-board
// placement. Colour is done with :nth-child
// selectors scoped by orientation, NOT the `.coord-light`/`.coord-dark`
// classes renderCoords() (wrap.ts) puts on each label — verified against a
// live render that those classes don't correspond to the actual square
// each label overlays once repositioned this way (chessground's own
// official theme CSS doesn't use them for coords.ranks/coords.files
// either, for the same reason: they're only meaningful for chessground's
// default outside-the-board placement, not an overlaid one). See the
// matching comment in main.css for the full derivation.
//
// Both board kinds use the same two-colour, alternating-by-square scheme
// for the labels themselves — _coordLabelCss() below: 
// a light square's label is coloured with something drawn
// from the board's dark tone, a dark square's label with something drawn
// from its light tone, so the label always reads against its own square.

function _checkerboardDataUri(light, dark) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'>
<rect width='1' height='1' fill='${light}'/>
<rect x='1' width='1' height='1' fill='${dark}'/>
<rect y='1' width='1' height='1' fill='${dark}'/>
<rect x='1' y='1' width='1' height='1' fill='${light}'/>
</svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Coordinate-label CSS shared by both board kinds: a light-square label
// gets c.labelLight, a dark-square label gets c.labelDark. Same nth-child+
// orientation structure as main.css's own default coord-label rule (see
// the comment there for why .coord-light/.coord-dark aren't used) — class
// + type + type + :nth-child, matched on all four orientation/parity
// combinations, so this carries the same CSS specificity and correctly
// overrides that default rather than losing to it regardless of source
// order. For white orientation the odd nth-child positions land on the
// a-file's dark squares (a1/a3/a5/a7, per main.css's comment) and so take
// c.labelDark; the even positions (a2/a4/a6/a8, light squares) take
// c.labelLight. No text-shadow: the label colour itself carries enough
// contrast against its own square.
function _coordLabelCss(c) {
    return `.orientation-white coords.ranks coord:nth-child(odd),
.orientation-white coords.files coord:nth-child(odd) { color: ${c.labelDark} !important; }
.orientation-white coords.ranks coord:nth-child(even),
.orientation-white coords.files coord:nth-child(even) { color: ${c.labelLight} !important; }
.orientation-black coords.ranks coord:nth-child(odd),
.orientation-black coords.files coord:nth-child(odd) { color: ${c.labelLight} !important; }
.orientation-black coords.ranks coord:nth-child(even),
.orientation-black coords.files coord:nth-child(even) { color: ${c.labelDark} !important; }`;
}

function _cssForColourBoard(c) {
    return `/* chesstb-theme: ${c.id} */
:root { --tray-bg: ${c.trayBg}; --tray-bg-dark: ${c.trayBgDark}; --tray-border: ${c.trayBorder}; }
cg-board {
    background-image: url("${_checkerboardDataUri(c.lightSquare, c.darkSquare)}");
    /* _checkerboardDataUri() returns a 2x2 tile (2 squares per axis).
       25% 25% sizes it to 2/8 of the board per axis, so the tile repeats
       4x4 (background-repeat's default) to fill all 64 squares; matches
       the base checkerboard sizing in main.css. */
    background-size: 25% 25%;
}
${_coordLabelCss(c)}
cg-board square.last-move { background-color: ${c.highlight} !important; }`;
}

function _cssForImageBoard(c) {
    return `/* chesstb-theme: ${c.id} */
:root { --tray-bg: ${c.trayBg}; --tray-bg-dark: ${c.trayBgDark}; --tray-border: ${c.trayBorder}; }
cg-board {
    background-image: url('${c.boardImage}') !important;
    background-size: 100% 100% !important;
    background-repeat: no-repeat !important;
}
${_coordLabelCss(c)}
cg-board square.last-move { background-color: ${c.highlight} !important; }`;
}

function _applyCSS() {
    let tag = document.getElementById('chesstb-theme');
    if (!tag) {
        tag = document.createElement('style');
        tag.id = 'chesstb-theme';
        document.head.appendChild(tag);
    }
    tag.textContent = _activeBoard.mode === 'image'
        ? _cssForImageBoard(_activeBoard)
        : _cssForColourBoard(_activeBoard);
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

function _findBoard(id) {
    return ALL_BOARDS.find(b => b.id === id) || null;
}

function _findPieceSet(id) {
    return PIECE_SETS.find(p => p.id === id) || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register the board reconstruction callback from board.js.
 * Must be called before Board.init().
 */
function init(reconstructBoard) {
    _reconstructBoard = reconstructBoard;
}

/**
 * Restore persisted board + piece set, or fall back to defaults.
 */
function apply() {
    let boardId, pieceSetId;
    try {
        boardId    = localStorage.getItem(_LS_BOARD);
        pieceSetId = localStorage.getItem(_LS_PIECESET);
    } catch (_) {}

    _activeBoard    = _findBoard(boardId)       || _findBoard(DEFAULT_BOARD_ID) || COLOUR_BOARDS[0];
    _activePieceSet = _findPieceSet(pieceSetId) ? pieceSetId : DEFAULT_PIECESET_ID;

    _applyCSS();

    // board.js's init() populates the spare trays/promotion dialog using
    // whichever piece set is active in theme.js at that point, which is
    // still the DEFAULT_PIECESET_ID module default, since Theme.apply()
    // runs after Board.init() in app.js's bootstrap order. This call
    // re-applies the piece set that was just read from persisted storage
    // above, so the trays and promotion dialog reflect it immediately on
    // load rather than only after the user next opens the piece-set picker
    // (the only other place this is called, via changePieceSet()). It runs
    // unconditionally, even when the piece set turns out to already be the
    // default — reconstruct() is a cheap, idempotent CSS-link-href +
    // tray-image update (see board.js), so this is simpler than detecting
    // whether it actually changed.
    if (_reconstructBoard) {
        _reconstructBoard(pieceThemeFn());
    }
}

/**
 * Switch to a different board by id (colour or image board).
 * Writes the new board CSS — does NOT touch the piece set.
 * Tray colours update because _applyCSS() is called.
 */
function changeBoard(boardId) {
    const next = _findBoard(boardId);
    if (!next) return false;
    _activeBoard = next;
    _applyCSS();
    try { localStorage.setItem(_LS_BOARD, _activeBoard.id); } catch (_) {}
    return true;
}

/**
 * Switch to a different piece set by id.
 * Does NOT call _applyCSS() — the board CSS (including tray colours) is
 * intentionally left unchanged so the tray colour tracks the board, not
 * the piece set.
 * Calls _reconstructBoard(pieceThemeFn()) so board.js can update the piece
 * CSS <link> and repopulate the spare-tray/promotion-dialog images. This is
 * a lightweight operation — piece images are plain CSS, not baked into the
 * board instance, so reconstruct() only needs to swap the CSS and refresh
 * the tray/dialog images rather than destroy/rebuild the board (see
 * board.js's reconstruct()).
 */
function changePieceSet(setId) {
    if (!_findPieceSet(setId)) return false;
    const prev = _activePieceSet;
    _activePieceSet = setId;
    try { localStorage.setItem(_LS_PIECESET, _activePieceSet); } catch (_) {}
    if (_activePieceSet !== prev && _reconstructBoard) {
        _reconstructBoard(pieceThemeFn());
    }
    return true;
}

/** Return the active board config object. */
function currentBoard() { return _activeBoard; }

/** Return the active piece set id string. */
function currentPieceSet() { return _activePieceSet; }

/**
 * Return the piece-code → image-path function for the active piece set
 * (e.g. 'wQ' -> '/static/pieces/cburnett/wQ.svg'). Called by board.js to
 * populate the spare-tray and promotion-dialog images.
 */
function pieceThemeFn() {
    const set = _activePieceSet;
    return function (piece) {
        return `/static/pieces/${set}/${piece}.svg`;
    };
}

export const Theme = {
    init, apply,
    changeBoard, changePieceSet,
    currentBoard, currentPieceSet,
    pieceThemeFn,
};