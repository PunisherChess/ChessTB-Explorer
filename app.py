"""
app.py — ChessTB Explorer back-end

A single-file Flask application that probes a ChessTB endgame tablebase
for a submitted FEN position and returns every legal move ranked by
Distance to Conversion (DTC), Distance to Mate (DTM), and DTM under the
50-move rule (DTM50).

Routes
------
  POST /probe              — evaluate a FEN position (JSON)
  POST /probe/stream       — evaluate with SSE streaming progress
  GET  /                   — main UI
  GET  /health             — readiness check
  GET  /admin              — cache dashboard HTML page
  POST /admin/cache/clear  — purge both LRU caches
  GET  /admin/cache/stats  — cache hit-rate statistics
  GET  /openapi.yaml       — OpenAPI 3.0 specification

Each move entry includes a child_fen so the client can pre-fetch the next
probe, and each response includes a summary of wins/draws/losses/unknown
across all legal moves. A position not covered by the loaded tablebase
raises MissingTableError, which is returned as structured JSON
({error_code, piece_count}). Root-JSON and child-probe cache sizes are
configurable via the EVALUATE_CACHE_SIZE / PROBE_CACHE_SIZE env vars.

The loaded tablebases are generated on the assumption that neither side
retains the right to castle, so a submitted FEN's castling-availability
field must be "-"; any other value is rejected as invalid input before
the board is ever built or probed.

Running this file directly (`python app.py`) serves the app via waitress
(a production-grade WSGI server) by default. Set DEBUG = True in
config.py to use Flask's own dev server instead (auto-reload +
interactive debugger) for local development. See README.md
"Installation" / "Running in production" for details.
"""

from __future__ import annotations

from concurrent.futures import (
    ThreadPoolExecutor,
    wait as futures_wait,
    ALL_COMPLETED,
    FIRST_COMPLETED,
)
from dataclasses import dataclass, field
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, send_file
from functools import lru_cache
from typing import TypedDict
from waitress import serve as waitress_serve
import atexit
import chess
import config
import importlib.util
import json
import os
import re
import logging
import sys
import threading
import time

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)


# ── ChessTB backend ───────────────────────────────────────────────────────────

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REMOTE_FALLBACK_PATH = os.path.join(_THIS_DIR, "remote", "remote_fallback.py")
_REMOTE_DIRECT_PATH = os.path.join(_THIS_DIR, "remote", "remote_direct.py")


def _load_module_by_path(module_name: str, path: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# chess.chesstb comes from noobpwnftw's add-chesstb-tablebases fork of
# python-chess (see requirements.txt) — open_tablebase, ProbeResult's raw
# wdl/dtc/dtm/dtm50 fields, MissingTableError, and the WIN/CURSED_WIN/DRAW/
# BLESSED_LOSS/LOSE constants all come from that module.
import chess.chesstb as chesstb

log.info("chess.chesstb backend: noobpwnftw/python-chess (add-chesstb-tablebases)")

# Remote (HTTP) tablebase support, in two flavours -- config.REMOTE_MODE
# picks one, and both are signature-compatible with
# chesstb.open_tablebase so the choice is one call below:
#   remote/remote_direct.py   ("direct")   probe in place over byte ranges
#   remote/remote_fallback.py ("download") whole-file download, disk-cached
# See each file's module docstring for the design and the trade-off.
# looks_like_remote()/RemoteSourceError come from remote/remote_source.py,
# re-exported identically through both.
_remote_download = _load_module_by_path("_chesstb_remote_fallback", _REMOTE_FALLBACK_PATH)
_remote_direct = _load_module_by_path("_chesstb_remote_direct", _REMOTE_DIRECT_PATH)
remote_source = _remote_download.remote_source


# ── Type aliases ──────────────────────────────────────────────────────────────

class MoveEntry(TypedDict):
    san:         str
    plies:       int
    is_mate:     bool
    outcome:     str         # "win"|"cursed_win"|"draw"|"blessed_loss"|"loss"|"unknown"
    child_fen:   str | None  # FEN after this move; None for terminal / unknown
    draw_reason: str | None  # "stalemate"|"insufficient_material"|None


MoveList = list[MoveEntry]


# ── Config validation helpers ─────────────────────────────────────────────────
# Centralise the "read a config.py value, check its type, validate range"
# pattern that AppConfig.from_config() below needs once per setting.

def _validated_int(name: str, value, *, min_val: int | None = 1, max_val: int | None = None) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"config.{name} must be an integer, got {value!r}")
    if min_val is not None and max_val is not None and not (min_val <= value <= max_val):
        raise ValueError(f"config.{name} must be {min_val}-{max_val}, got {value}")
    if max_val is None and min_val is not None and value < min_val:
        raise ValueError(f"config.{name} must be >= {min_val}, got {value}")
    return value


def _validated_float(name: str, value, *, min_val: float = 0) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"config.{name} must be a number, got {value!r}")
    value = float(value)
    if value <= min_val:
        raise ValueError(f"config.{name} must be > {min_val}, got {value}")
    return value


def _validated_str(name: str, value) -> str:
    if not isinstance(value, str):
        raise ValueError(f"config.{name} must be a string, got {value!r}")
    return value


def _validated_choice(name: str, value, allowed: tuple) -> str:
    if value not in allowed:
        raise ValueError(
            f"config.{name} must be one of {', '.join(map(repr, allowed))}, got {value!r}")
    return value


def _validated_bool(name: str, value) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"config.{name} must be True or False, got {value!r}")
    return value


# ── Validated configuration ───────────────────────────────────────────────────

@dataclass(frozen=True)
class AppConfig:
    tablebase_path:      str
    probe_threads:       int
    parallel_threshold:  int
    probe_timeout:       float
    max_fen_length:      int   = field(default=100)
    host:                str   = field(default="127.0.0.1")
    port:                int   = field(default=5000)
    evaluate_cache_size: int   = field(default=4096)
    probe_cache_size:    int   = field(default=16384)
    block_cache_bytes:   int   = field(default=64 * 1024 * 1024)
    debug:               bool  = field(default=False)
    waitress_threads:    int   = field(default=8)
    # Only used when TABLEBASE_PATH is an http(s):// URL (see
    # "ChessTB backend" above and remote/remote_source.py) -- ignored
    # entirely for a local TABLEBASE_PATH directory. Bounds an on-disk LRU
    # of whole downloaded table files cached by remote/remote_fallback.py
    # (see that file's module docstring for the full design).
    remote_mode:             str   = field(default="direct")
    remote_page_cache_bytes: int   = field(default=128 * 1024 * 1024)
    remote_page_size_bytes:  int   = field(default=256 * 1024)
    remote_timeout_secs:     float = field(default=20.0)
    remote_max_retries:      int   = field(default=3)

    @classmethod
    def from_config(cls) -> "AppConfig":
        # PROBE_THREADS is the one setting with a computed (not literal)
        # default, so a None left in config.py falls back to a
        # CPU-count-based figure instead of going through _validated_int.
        threads = (
            _validated_int("PROBE_THREADS", config.PROBE_THREADS)
            if config.PROBE_THREADS is not None
            else min(16, (os.cpu_count() or 4) * 2)
        )

        return cls(
            tablebase_path=_validated_str("TABLEBASE_PATH", config.TABLEBASE_PATH),
            probe_threads=threads,
            parallel_threshold=_validated_int("PROBE_PARALLEL_THRESHOLD", config.PROBE_PARALLEL_THRESHOLD),
            probe_timeout=_validated_float("PROBE_TIMEOUT_SECS", config.PROBE_TIMEOUT_SECS),
            host=_validated_str("HOST", config.HOST),
            port=_validated_int("PORT", config.PORT, max_val=65535),
            evaluate_cache_size=_validated_int("EVALUATE_CACHE_SIZE", config.EVALUATE_CACHE_SIZE),
            probe_cache_size=_validated_int("PROBE_CACHE_SIZE", config.PROBE_CACHE_SIZE),
            block_cache_bytes=_validated_int("BLOCK_CACHE_BYTES", config.BLOCK_CACHE_BYTES),
            # DEBUG also selects the server used by
            # `if __name__ == "__main__"` below: the Flask dev server when
            # True, waitress otherwise (see README.md "Running in production").
            debug=_validated_bool("DEBUG", config.DEBUG),
            waitress_threads=_validated_int("WAITRESS_THREADS", config.WAITRESS_THREADS),
            remote_mode=_validated_choice(
                "REMOTE_MODE", getattr(config, "REMOTE_MODE", "direct"),
                ("direct", "download")),
            remote_page_cache_bytes=_validated_int(
                "REMOTE_PAGE_CACHE_BYTES", config.REMOTE_PAGE_CACHE_BYTES),
            remote_page_size_bytes=_validated_int(
                "REMOTE_PAGE_SIZE_BYTES", config.REMOTE_PAGE_SIZE_BYTES),
            remote_timeout_secs=_validated_float("REMOTE_TIMEOUT_SECS", config.REMOTE_TIMEOUT_SECS),
            remote_max_retries=_validated_int("REMOTE_MAX_RETRIES", config.REMOTE_MAX_RETRIES),
        )


try:
    cfg = AppConfig.from_config()
except (ValueError, AttributeError) as e:
    log.error("Configuration error: %s — fix config.py and restart.", e)
    raise SystemExit(1) from e

_tablebase_is_remote = remote_source.looks_like_remote(cfg.tablebase_path)
# Which remote backend actually gets used: config.REMOTE_MODE, downgraded to
# "download" if the installed chess.chesstb predates the source seam
# "direct" needs. Resolved here so the open below and the logging and
# /admin/cache/stats reporting all name the same thing.
_remote_backend_name = (
    "direct" if cfg.remote_mode == "direct" and _remote_direct.seam_available()
    else "download")
# Exception type(s) to treat as "couldn't reach the remote tablebase" in
# the /probe and /probe/stream handlers below — a plain tuple (rather than
# an `if` at each call site) so `except _REMOTE_SOURCE_ERRORS:` is valid
# at every call site.
_REMOTE_SOURCE_ERRORS = (remote_source.RemoteSourceError,)

if not cfg.tablebase_path:
    log.warning("TABLEBASE_PATH is not set — tablebase lookups will fail.")


# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024   # 4 KB


@app.errorhandler(413)
def request_too_large(e: Exception) -> tuple:
    return jsonify({"error": "Request body too large (max 4 KB)."}), 413


# ── Tablebase + thread pool ───────────────────────────────────────────────────

try:
    if cfg.tablebase_path and _tablebase_is_remote:
        # Remote (http/https) TABLEBASE_PATH -- see the "ChessTB backend"
        # section above. "direct" needs a chess.chesstb carrying the table
        # source seam; without it the module can't work at all, so fall
        # back rather than fail the whole app at startup.
        if _remote_backend_name == "download":
            if cfg.remote_mode == "direct":
                log.warning(
                    "REMOTE_MODE is \"direct\", but the installed chess.chesstb has no "
                    "table-source seam (Tablebase.WDL_FILE / _TableFile._open_source) -- "
                    "using \"download\" instead. Update the fork (see requirements.txt) "
                    "to get byte-range probing.")
            TB = _remote_download.open_tablebase(
                cfg.tablebase_path,
                block_cache_bytes=cfg.block_cache_bytes,
                remote_page_cache_bytes=cfg.remote_page_cache_bytes,
                remote_page_size=cfg.remote_page_size_bytes,
                remote_timeout=cfg.remote_timeout_secs,
                remote_max_retries=cfg.remote_max_retries,
            )
        else:
            TB = _remote_direct.open_tablebase(
                cfg.tablebase_path,
                block_cache_bytes=cfg.block_cache_bytes,
                remote_page_cache_bytes=cfg.remote_page_cache_bytes,
                remote_page_size=cfg.remote_page_size_bytes,
                remote_timeout=cfg.remote_timeout_secs,
                remote_max_retries=cfg.remote_max_retries,
            )
    elif cfg.tablebase_path:
        TB = chesstb.open_tablebase(cfg.tablebase_path, block_cache_bytes=cfg.block_cache_bytes)
    else:
        TB = None
    if TB:
        if _tablebase_is_remote:
            log.info(
                "Tablebase opened remotely at: %s (mode=%s, %s, "
                "block_cache_bytes=%d, remote_page_cache_bytes=%d, "
                "remote_page_size=%d)",
                cfg.tablebase_path, _remote_backend_name,
                "byte-range, nothing written to disk" if _remote_backend_name == "direct"
                else "whole-file download, disk-cached",
                cfg.block_cache_bytes, cfg.remote_page_cache_bytes,
                cfg.remote_page_size_bytes,
            )
        else:
            log.info(
                "Tablebase opened at: %s (block_cache_bytes=%d)",
                cfg.tablebase_path, cfg.block_cache_bytes,
            )
except Exception as e:
    log.warning("Failed to open tablebase: %s", e)
    TB = None

_executor = ThreadPoolExecutor(max_workers=cfg.probe_threads, thread_name_prefix="tb_probe")
log.info(
    "Thread pool: %d workers, parallel_threshold=%d, timeout=%.0fs, "
    "eval_cache=%d, probe_cache=%d, block_cache_bytes=%d",
    cfg.probe_threads, cfg.parallel_threshold, cfg.probe_timeout,
    cfg.evaluate_cache_size, cfg.probe_cache_size, cfg.block_cache_bytes,
)


@atexit.register
def _close_tb() -> None:
    try:
        if TB is not None:
            TB.close()
    except Exception as e:
        log.warning("Error closing tablebase: %s", e)


@atexit.register
def _shutdown_executor() -> None:
    try:
        _executor.shutdown(wait=True, cancel_futures=True)
    except Exception as e:
        log.warning("Error shutting down thread pool: %s", e)


# ── Security headers ──────────────────────────────────────────────────────────

@app.after_request
def set_security_headers(response: Response) -> Response:
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; img-src 'self' data:; connect-src 'self'; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; "
        "frame-ancestors 'none';"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# ── FEN normalisation ─────────────────────────────────────────────────────────

_FEN_FIELD_DEFAULTS = ("8/8/8/8/8/8/8/8", "w", "-", "-", "0", "1")


def _normalize_fen(fen: str) -> str:
    parts = fen.split()
    while len(parts) < 6:
        parts.append(_FEN_FIELD_DEFAULTS[len(parts)])
    return " ".join(parts[:6])


# ── Sort helpers ──────────────────────────────────────────────────────────────

def _outcome_rank(wdl_val: int) -> int:
    if wdl_val == 2:  return 0   # win
    if wdl_val == 1:  return 1   # cursed win
    if wdl_val == 0:  return 2   # draw
    if wdl_val == -1: return 3   # blessed loss
    if wdl_val == -2: return 4   # loss
    return 2                     # unrecognised value: treat as draw-ish


def _ply_rank(wdl_val: int, eff_val: int) -> int:
    if wdl_val > 0:  return eff_val
    if wdl_val < 0:  return -abs(eff_val)
    return 0


_WDL_TO_OUTCOME_LABEL: dict[int, str] = {
    2: "win", 1: "cursed_win", 0: "draw", -1: "blessed_loss", -2: "loss",
}


def _outcome_label(wdl_val: int) -> str:
    return _WDL_TO_OUTCOME_LABEL.get(wdl_val, "unknown")


def _effective_move_wdl(move_wdl: int, root_wdl: int, eff_distance: int) -> int:
    """The win/cursed-win (or loss/blessed-loss) bucket a move belongs in,
    used for both its outcome label and its sort-key rank. A raw win/loss
    (move_wdl 2/-2) downgrades to cursed_win/blessed_loss (1/-1) when its
    own eff_distance exceeds the 100-ply cutoff. The result is then capped
    at root_wdl, since a move can never be better than the root position's
    own optimal value — this cap is one-directional, as a move CAN be
    worse than root_wdl (e.g. a blunder turning a blessed_loss root into a
    pure -2 loss). Draws pass through unchanged."""
    if move_wdl == 2 and abs(eff_distance) > 100:
        move_wdl = 1
    elif move_wdl == -2 and abs(eff_distance) > 100:
        move_wdl = -1
    if move_wdl > root_wdl:
        move_wdl = root_wdl
    return move_wdl


def _effective_distance(wdl: int, raw_distance: int) -> int:
    if wdl != 0 and raw_distance == 0:
        return 1 if wdl > 0 else -1
    if raw_distance > 0:
        return raw_distance + 1
    if raw_distance < 0:
        return raw_distance - 1
    return 0


# ── FEN pre-validation ────────────────────────────────────────────────────────

_EP_PATTERN = re.compile(r"^(-|[a-h][36])$")


def _validate_fen_format(fen: str) -> str | None:
    parts = fen.split()
    if len(parts) < 2:
        return "FEN must have at least a piece-placement field and a side-to-move field."
    if parts[1] not in ("w", "b"):
        return f"Invalid side to move: '{parts[1]}' (expected 'w' or 'b')."
    # The loaded tablebases are generated on the assumption that neither
    # side retains castling rights, so the only castling-availability
    # field this tool can meaningfully evaluate is "-". Rejecting any
    # other value here — before a board is ever built — keeps a castling
    # move from being able to reach board.legal_moves() in the first
    # place, rather than relying on each downstream consumer to
    # special-case it away.
    if len(parts) >= 3 and parts[2] != "-":
        return (
            f"Invalid castling availability: '{parts[2]}' (expected '-' — "
            "the loaded tablebases are generated without castling rights, "
            "so positions with castling rights are not supported)."
        )
    if len(parts) >= 4 and not _EP_PATTERN.match(parts[3]):
        return (
            f"Invalid en-passant square: '{parts[3]}' "
            "(expected '-' or a valid target square such as 'e3' or 'd6')."
        )
    if len(parts) >= 5:
        try:
            hmc = int(parts[4])
            if hmc < 0:
                return "Halfmove clock must be a non-negative integer."
        except ValueError:
            return f"Invalid halfmove clock: '{parts[4]}' (expected a non-negative integer)."
    if len(parts) >= 6:
        try:
            fmc = int(parts[5])
            if fmc < 1:
                return "Fullmove number must be a positive integer."
        except ValueError:
            return f"Invalid fullmove number: '{parts[5]}' (expected a positive integer)."
    return None


# ── Signed-value helpers ──────────────────────────────────────────────────────
#
# The standard chess.chesstb backend's ProbeResult only carries the raw,
# unsigned wdl/dtc/dtm/dtm50_wdl/dtm50 fields — no convenience signed_wdl/
# signed_dtc/signed_dtm/signed_dtm50 properties. Reproducing the same signed
# WDL convention ourselves (matching chess.syzygy: +2 win, +1 cursed win,
# 0 draw, -1 blessed loss, -2 loss) directly off the raw fields and the
# public WIN/CURSED_WIN/DRAW/BLESSED_LOSS/LOSE constants is what
# _probe_board below builds on.
_WDL_SIGNED = {
    chesstb.WIN: 2,
    chesstb.CURSED_WIN: 1,
    chesstb.DRAW: 0,
    chesstb.BLESSED_LOSS: -1,
    chesstb.LOSE: -2,
}


def _signed_wdl(wdl: int) -> int | None:
    """Signed WDL for a raw wdl/dtm50_wdl class value."""
    return _WDL_SIGNED.get(wdl)


def _signed_ply(magnitude: int, wdl: int) -> int:
    """Signed ply count for a raw (magnitude, wdl) pair, as returned by
    ProbeResult's dtc/dtm/dtm50 fields alongside their wdl/dtm50_wdl."""
    if wdl in (chesstb.WIN, chesstb.CURSED_WIN):
        return magnitude
    if wdl in (chesstb.LOSE, chesstb.BLESSED_LOSS):
        return -magnitude
    return 0


# ── Raw probe ─────────────────────────────────────────────────────────────────

def _probe_board(board: chess.Board) -> tuple[int, int, int, int, int] | None:
    # A single combined probe() call computes WDL + DTC + DTM + DTM50 together
    # internally no matter what you ask for, so building all four signed
    # values off one ProbeResult's raw fields (via _signed_wdl/_signed_ply
    # above) avoids calling get_wdl()/get_dtz()/get_dtm()/probe_dtm50()
    # separately, which would each trigger their own full probe, redoing
    # that same work 4 times over. This matters a lot here since
    # _probe_board runs per-position on every worker thread in the pool below.
    r = TB.probe(board, rule50=board.halfmove_clock)
    if r.status != "ok":
        return None
    if not (r.has_dtc and r.has_dtm and r.has_dtm50):
        return None
    dtm50_wdl, dtm50_plies = _signed_wdl(r.dtm50_wdl), r.dtm50
    return (
        _signed_wdl(r.wdl),
        dtm50_wdl,
        abs(_signed_ply(r.dtc, r.wdl)),
        abs(_signed_ply(r.dtm, r.wdl)),
        dtm50_plies,
    )


# ── Child-position probe cache ────────────────────────────────────────────────

class ProbeInFlightTimeout(Exception):
    """A probe of this FEN was already running and didn't finish in time.
    Retryable, exactly like the probe having timed out directly."""


class _InFlightProbe:
    """Slot for one probe in progress. The thread that creates it does the
    probing; every other thread asking for the same FEN waits on it."""

    __slots__ = ("done", "result", "error")

    def __init__(self) -> None:
        self.done   = threading.Event()
        self.result: tuple[int, int, int, int, int] | None = None
        self.error:  BaseException | None = None


_inflight_lock = threading.Lock()
_inflight: dict[str, _InFlightProbe] = {}


def _probe_fen_deduped(fen: str) -> tuple[int, int, int, int, int] | None:
    """Runs at most one probe per FEN at a time, however many callers ask.

    _probe_fen's lru_cache only dedupes probes that have already *finished* —
    concurrent callers all miss it and all probe the same position. That
    happens routinely: /probe/stream pre-warms a child FEN that
    evaluate_all_moves then asks for again, and a retry after a timeout
    re-asks for a FEN whose first probe is still running. Each duplicate costs
    a full remote probe and occupies a pool worker.

    The wait is bounded by cfg.probe_timeout so one hung probe can't pin every
    waiter indefinitely; the wait expiring raises, which reads downstream as a
    retryable failure just like the probe itself timing out.
    """
    with _inflight_lock:
        slot = _inflight.get(fen)
        if slot is None:
            slot = _inflight[fen] = _InFlightProbe()
            owner = True
        else:
            owner = False

    if not owner:
        if not slot.done.wait(cfg.probe_timeout):
            raise ProbeInFlightTimeout(f"Timed out waiting on an in-flight probe of {fen}")
        if slot.error is not None:
            raise slot.error
        return slot.result

    try:
        slot.result = _probe_board(chess.Board(fen))
        return slot.result
    except BaseException as exc:
        slot.error = exc
        raise
    finally:
        # Drop the slot before waking the waiters, so a caller arriving in
        # between starts a fresh probe rather than joining a finished one.
        with _inflight_lock:
            _inflight.pop(fen, None)
        slot.done.set()


@lru_cache(maxsize=cfg.probe_cache_size)
def _probe_fen(fen: str) -> tuple[int, int, int, int, int] | None:
    return _probe_fen_deduped(fen)


# ── Move evaluation ───────────────────────────────────────────────────────────

def _apply_sign(magnitude: int, sign_wdl: int) -> int:
    """Gives an unsigned ply magnitude the sign implied by a signed WDL
    value: positive for a winning sign_wdl, negative for a losing one,
    zero for a draw. Shared by every DTC/DTM/DTM50 assembly step in
    evaluate_all_moves below, so the three metrics can't drift apart on
    how a magnitude gets its sign."""
    if sign_wdl > 0:
        return magnitude
    if sign_wdl < 0:
        return -magnitude
    return 0


def _collect_move_info(board: chess.Board) -> list[tuple[str, bool, bool, str | None, str | None]]:
    move_info: list[tuple[str, bool, bool, str | None, str | None]] = []
    for move in board.legal_moves:
        san = board.san(move)
        # Bypasses expensive Board.is_checkmate() checks by parsing the SAN string directly
        move_is_mate = san.endswith("#")
        move_is_zeroing = board.is_zeroing(move)
        draw_reason: str | None = None
        board.push(move)
        try:
            if not move_is_mate:
                # Bypasses Board.is_stalemate() by stopping at the first legal move found
                if not any(board.generate_legal_moves()):
                    draw_reason = "stalemate"
                elif board.is_insufficient_material():
                    draw_reason = "insufficient_material"
            child_fen: str | None = None if (move_is_mate or draw_reason) else board.fen()
        finally:
            board.pop()
        move_info.append((san, move_is_mate, move_is_zeroing, draw_reason, child_fen))
    return move_info


def evaluate_all_moves(
    board: chess.Board,
    root_wdl: int,
    bypass_parallel: bool = False,
    precomputed_move_info: list[tuple[str, bool, bool, str | None, str | None]] | None = None,
) -> tuple[MoveList, MoveList, MoveList, bool]:
    """Returns the three ranked move lists plus a "complete" flag: False when
    at least one move shows "unknown" for a retryable reason (probe timeout or
    error) rather than because its table is genuinely absent. Callers use it to
    decide whether the result is worth caching — see evaluate_fen()."""

    # Phase 1: collect move metadata (no TB calls) — reuses the caller's own
    # pass over board.legal_moves() when one is supplied, instead of
    # re-walking every legal move a second time for the same board.
    move_info = precomputed_move_info if precomputed_move_info is not None else _collect_move_info(board)

    # Phase 2: probe child positions
    unique_fens: set[str] = {child_fen for _, _, _, _, child_fen in move_info if child_fen is not None}
    probe_cache: dict[str, tuple | None] = {}

    # Child FENs that failed for a retryable reason. A probe that timed out is
    # still running in the pool and will populate _probe_fen's own cache, so a
    # later attempt at this position resolves it; a probe that raised may
    # succeed on a retry too. Neither is the same as _probe_fen returning None,
    # which means tb_not_found and won't change however often it's re-probed.
    transient_failures: set[str] = set()

    # Bypass thread-pool and execute sequentially if we know child FENs are cached
    if len(unique_fens) >= cfg.parallel_threshold and not bypass_parallel:
        futures = {fen: _executor.submit(_probe_fen, fen) for fen in unique_fens}
        done, _ = futures_wait(
            futures.values(), timeout=cfg.probe_timeout, return_when=ALL_COMPLETED
        )
        for fen, fut in futures.items():
            if fut in done:
                try:
                    probe_cache[fen] = fut.result()
                except Exception as exc:
                    log.warning("Probe error for %s: %s", fen, exc)
                    probe_cache[fen] = None
                    transient_failures.add(fen)
            else:
                log.warning("Probe timed out for %s", fen)
                probe_cache[fen] = None
                transient_failures.add(fen)
    else:
        for fen in unique_fens:
            try:
                probe_cache[fen] = _probe_fen(fen)
            except Exception as exc:
                log.warning("Probe error for %s: %s", fen, exc)
                probe_cache[fen] = None
                transient_failures.add(fen)

    # Phase 3: assemble and sort
    dtz_rows:   list[tuple] = []
    dtm_rows:   list[tuple] = []
    dtm50_rows: list[tuple] = []

    for san, move_is_mate, move_is_zeroing, draw_reason, child_fen in move_info:

        if move_is_mate:
            opp_wdl = opp_dtm50_wdl = -2
            opp_dtc = opp_dtm = opp_dtm50 = 0

        elif draw_reason:
            opp_wdl = opp_dtm50_wdl = 0
            opp_dtc = opp_dtm = opp_dtm50 = 0

        else:
            probe_result = probe_cache.get(child_fen)
            if probe_result is None:
                log.warning("No probe result for %s (%s); showing unknown.", child_fen, san)
                stub: MoveEntry = {
                    "san": san, "plies": 0, "is_mate": False,
                    "outcome": "unknown", "child_fen": child_fen, "draw_reason": None,
                }
                stub_key = (_outcome_rank(0) + 10, 0, san)
                dtz_rows.append((stub_key, stub))
                dtm_rows.append((stub_key, stub))
                dtm50_rows.append((stub_key, stub))
                continue
            opp_wdl, opp_dtm50_wdl, opp_dtc, opp_dtm, opp_dtm50 = probe_result

        my_wdl       = -opp_wdl
        my_dtm50_wdl = -opp_dtm50_wdl
        my_dtm50 = _apply_sign(opp_dtm50, my_dtm50_wdl)
        eff_dtm50 = _effective_distance(my_dtm50_wdl, my_dtm50)

        my_dtc = _apply_sign(opp_dtc, my_wdl)
        my_dtm = _apply_sign(opp_dtm, my_wdl)

        # If this move is itself a zeroing move (capture/pawn-push/promotion),
        # it IS the conversion, so its DTC is 1 ply — not
        # 1 + the child position's own distance to *its* next conversion,
        # which is what feeding my_dtc straight into _effective_distance
        # would compute (double-counting a second conversion event nobody
        # asked for). _effective_distance already has a branch for exactly
        # this ("no further distance needed, the move itself resolves it"),
        # so just call it with raw_distance=0 instead of reimplementing that
        # branch here.
        eff_dtc = (_effective_distance(my_wdl, 0) if move_is_zeroing
                   else _effective_distance(my_wdl, my_dtc))
        eff_dtm = _effective_distance(my_wdl, my_dtm)

        # DTC and DTM share the same win/cursed-win (loss/blessed-loss)
        # bucket, since that status is a single fact about eff_dtc and
        # root_wdl rather than a separate one per metric — see
        # _effective_move_wdl. Both the label shown for this move and the
        # bucket its sort key ranks it in come from that same value, so the
        # two always agree; only the ply used to break ties within a
        # bucket differs between the two keys.
        eff_wdl = _effective_move_wdl(my_wdl, root_wdl, eff_dtc)
        outcome = _outcome_label(eff_wdl)

        dtz_key = (_outcome_rank(eff_wdl), _ply_rank(eff_wdl, eff_dtc), san)
        dtz_rows.append((dtz_key, {
            "san": san, "plies": abs(eff_dtc), "is_mate": move_is_mate,
            "outcome": outcome, "child_fen": child_fen, "draw_reason": draw_reason,
        }))

        dtm_key = (_outcome_rank(eff_wdl), _ply_rank(eff_wdl, eff_dtm), san)
        dtm_rows.append((dtm_key, {
            "san": san, "plies": abs(eff_dtm), "is_mate": move_is_mate,
            "outcome": outcome, "child_fen": child_fen, "draw_reason": draw_reason,
        }))

        dtm50_key = (_outcome_rank(my_dtm50_wdl), _ply_rank(my_dtm50_wdl, eff_dtm50), san)
        dtm50_rows.append((dtm50_key, {
            "san": san, "plies": abs(eff_dtm50), "is_mate": move_is_mate,
            "outcome": _outcome_label(my_dtm50_wdl), "child_fen": child_fen, "draw_reason": draw_reason,
        }))

    dtz_rows.sort(key=lambda r: r[0])
    dtm_rows.sort(key=lambda r: r[0])
    dtm50_rows.sort(key=lambda r: r[0])

    return (
        [r[1] for r in dtz_rows],
        [r[1] for r in dtm_rows],
        [r[1] for r in dtm50_rows],
        not transient_failures,
    )


# ── Root Probe Calculation ────────────────────────────────────────────────────

_evaluate_tls = threading.local()


def _validate_and_build_board(fen: str) -> chess.Board:
    """
    Single authoritative implementation of root-FEN validation, shared by
    /probe (via evaluate_fen) and /probe/stream (which needs a validated
    board up front, before it can start emitting SSE progress events).
    Raises RuntimeError if the tablebase isn't loaded, or ValueError for any
    FEN/board problem — callers are expected to catch and format those.
    """
    if TB is None:
        raise RuntimeError("Tablebase not initialised. Check TABLEBASE_PATH.")

    fmt_error = _validate_fen_format(fen)
    if fmt_error:
        raise ValueError(fmt_error)

    try:
        board = chess.Board(fen)
    except ValueError as e:
        raise ValueError(f"Malformed FEN: {e}") from e

    if not board.is_valid():
        raise ValueError(
            "Invalid board position (missing kings, adjacent kings, pawn on back rank, etc.)."
        )

    return board


def _missing_table_error_payload(fen: str) -> dict:
    """
    Single authoritative shape for the "position not covered by the loaded
    tablebase" error, shared by /probe and /probe/stream so the two
    transports (plain JSON vs SSE) can't drift out of sync on wording,
    error_code, or how piece_count is computed.
    """
    try:
        piece_count = len(chess.Board(fen).piece_map())
    except Exception:
        piece_count = None
    return {
        "error":       "Position not covered by the loaded tablebase.",
        "error_code":  "missing_table",
        "piece_count": piece_count,
    }


class _IncompleteResult(Exception):
    """Carries a probe result that must not be cached — see evaluate_fen()."""

    def __init__(self, json_str: str) -> None:
        super().__init__("probe incomplete")
        self.json_str = json_str


def _evaluate_fen_impl(fen: str) -> str:
    """
    Probes the tablebase for a root FEN and returns a pre-serialized JSON string.
    Routes the root probe through the same shared _probe_fen cache used for
    child positions, so a position that was just probed as a child (e.g. the
    position the user just moved into) is served from cache instead of
    re-hitting the tablebase.

    fen is the only argument (required for @lru_cache to key on it), so a
    caller that already built a board/move_info for this exact fen — e.g.
    probe_stream()'s SSE handler, which needs both up front anyway to size
    its progress bar — hands them over via _evaluate_tls instead, letting
    this call skip redoing that work. Ignored on a cache hit, since the
    function body below never runs in that case.

    Raises _IncompleteResult (carrying the same JSON) when a move came back
    unknown for a retryable reason, so evaluate_fen() can serve it without
    caching it.
    """
    precomputed_board     = getattr(_evaluate_tls, "board", None)
    precomputed_move_info = getattr(_evaluate_tls, "move_info", None)
    board = precomputed_board if precomputed_board is not None else _validate_and_build_board(fen)

    if board.is_checkmate():
        return json.dumps({
            "wdl": -2, "dtz": 0, "dtm": 0, "dtm50": [-2, 0],
            "moves_dtz": [], "moves_dtm": [], "moves_dtm50": [],
            "summary": {"wins": 0, "draws": 0, "losses": 0, "unknown": 0},
            "draw_reason": None,
        })

    if board.is_stalemate() or board.is_insufficient_material():
        return json.dumps({
            "wdl": 0, "dtz": 0, "dtm": 0, "dtm50": [0, 0],
            "moves_dtz": [], "moves_dtm": [], "moves_dtm50": [],
            "summary": {"wins": 0, "draws": 0, "losses": 0, "unknown": 0},
            "draw_reason": "stalemate" if board.is_stalemate() else "insufficient_material",
        })

    # Route the root probe through the shared child-probe cache.
    root = _probe_fen(fen)
    if root is None:
        raise chesstb.MissingTableError(f"Position not in tablebase: {fen}")
    root_wdl, root_dtm50_wdl, root_dtc, root_dtm, root_dtm50 = root

    bypass_parallel = getattr(_evaluate_tls, "bypass_parallel", False)
    moves_dtz, moves_dtm, moves_dtm50, complete = evaluate_all_moves(
        board, root_wdl, bypass_parallel=bypass_parallel, precomputed_move_info=precomputed_move_info,
    )

    # Outcome summary across all legal moves.
    outcomes = [m["outcome"] for m in moves_dtz]
    summary = {
        "wins":    sum(1 for o in outcomes if o in ("win", "cursed_win")),
        "draws":   sum(1 for o in outcomes if o == "draw"),
        "losses":  sum(1 for o in outcomes if o in ("loss", "blessed_loss")),
        "unknown": sum(1 for o in outcomes if o == "unknown"),
    }

    json_str = json.dumps({
        "wdl":          root_wdl,
        "dtz":          root_dtc,
        "dtm":          root_dtm,
        "dtm50":        [root_dtm50_wdl, root_dtm50],
        "moves_dtz":    moves_dtz,
        "moves_dtm":    moves_dtm,
        "moves_dtm50":  moves_dtm50,
        "summary":      summary,
        "draw_reason":  None,   # root always has legal moves here, so never terminal
    })
    if not complete:
        raise _IncompleteResult(json_str)
    return json_str


# The cache lives on the inner function only: lru_cache never stores the result
# of a call that raised, so an _IncompleteResult passes straight through to the
# caller without being memoized, and the next request for that FEN re-probes.
# By then the timed-out probes have usually landed in _probe_fen's own cache,
# so the retry is both cheap and likely to resolve. Without this a single
# timeout pinned "unknown" to a position for the rest of the process, with
# /admin/cache/clear the only way out.
@lru_cache(maxsize=cfg.evaluate_cache_size)
def _evaluate_fen_cached(fen: str) -> str:
    return _evaluate_fen_impl(fen)


def evaluate_fen(fen: str) -> str:
    try:
        return _evaluate_fen_cached(fen)
    except _IncompleteResult as incomplete:
        return incomplete.json_str


evaluate_fen.cache_clear = _evaluate_fen_cached.cache_clear  # type: ignore[attr-defined]
evaluate_fen.cache_info  = _evaluate_fen_cached.cache_info   # type: ignore[attr-defined]


# ── Common FEN extraction + validation helper ─────────────────────────────────

def _extract_fen(data: dict | None) -> tuple[str, Response | None]:
    if not data or "fen" not in data:
        return "", (jsonify({"error": "Missing FEN in request body."}), 400)
    fen_raw = data["fen"]
    if not isinstance(fen_raw, str):
        return "", (jsonify({"error": "FEN must be a string."}), 400)
    fen = fen_raw.strip()
    if not fen:
        return "", (jsonify({"error": "FEN string is empty."}), 400)
    if len(fen) > cfg.max_fen_length:
        return "", (jsonify({"error": f"FEN string too long (max {cfg.max_fen_length})."}), 400)
    return _normalize_fen(fen), None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.route("/probe", methods=["POST"])
def probe() -> Response:
    body = request.get_json(silent=True)
    fen, err = _extract_fen(body)
    if err:
        return err

    try:
        json_str = evaluate_fen(fen)
        return app.response_class(json_str, status=200, mimetype="application/json")

    except chesstb.MissingTableError:
        return jsonify(_missing_table_error_payload(fen)), 400

    except RuntimeError as e:
        # Tablebase not initialised (TABLEBASE_PATH unset/failed to load)
        # -- same condition and status code as /health's own "degraded"
        # response for this, and the same message _validate_and_build_board
        # raises for /probe/stream to report over SSE.
        return jsonify({"error": str(e)}), 503

    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    except _REMOTE_SOURCE_ERRORS as e:
        log.warning("Remote tablebase fetch failed probing FEN %s: %s", fen, e)
        return jsonify({
            "error": "Could not reach the remote tablebase. Try again shortly.",
            "error_code": "remote_unavailable",
        }), 502

    except ProbeInFlightTimeout as e:
        log.warning("%s", e)
        return jsonify({
            "error": "Probe timed out. Try again shortly.",
            "error_code": "probe_timeout",
        }), 503

    except Exception:
        log.exception("Unhandled error probing FEN: %s", fen)
        return jsonify({"error": "Internal server error."}), 500


@app.route("/probe/stream", methods=["POST"])
def probe_stream() -> Response:
    body = request.get_json(silent=True)
    fen, err = _extract_fen(body)
    if err:
        return err

    def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    def generate():
        # Validated up front (rather than only inside evaluate_fen below) so
        # we can report a validation error immediately over SSE instead of
        # only finding out after pre-warming child positions. Uses the same
        # _validate_and_build_board() that evaluate_fen() itself calls, so
        # there's one authoritative implementation of "what makes a FEN
        # probeable" instead of two hand-written copies that could disagree.
        try:
            root_board = _validate_and_build_board(fen)
        except (RuntimeError, ValueError) as e:
            yield _sse({"status": "error", "error": str(e)})
            return

        move_info = _collect_move_info(root_board)
        child_fens: set[str] = {child_fen for _, _, _, _, child_fen in move_info if child_fen is not None}

        total = len(child_fens)
        yield _sse({"status": "probing", "completed": 0, "total": total})

        # Pre-warm child FENs in parallel using the native non-blocking cache.
        # Always via the thread pool (regardless of cfg.parallel_threshold, which
        # only governs evaluate_all_moves' own sequential/parallel choice below) —
        # a bare sequential loop here would have no way to bound a single hung
        # _probe_fen() call, since there'd be no worker thread to poll against;
        # only a background thread lets this deadline actually cut the wait short.
        futures = {cf: _executor.submit(_probe_fen, cf) for cf in child_fens}
        remaining = set(futures.values())
        done_count = 0
        deadline = time.monotonic() + cfg.probe_timeout
        prewarm_complete = True
        while done_count < total:
            time_left = deadline - time.monotonic()
            if time_left <= 0:
                log.warning(
                    "Probe pre-warm timed out for %s (%d/%d child positions still pending)",
                    fen, total - done_count, total,
                )
                prewarm_complete = False
                break
            newly_done, remaining = futures_wait(
                remaining, timeout=min(0.3, time_left), return_when=FIRST_COMPLETED
            )
            done_count += len(newly_done)
            yield _sse({"status": "probing", "completed": done_count, "total": total})

        # If pre-warming above finished, every child FEN is already cached, so
        # evaluate_fen() below can fetch them all as cache hits sequentially,
        # without the overhead of resubmitting each one to the thread pool. If
        # pre-warming timed out instead, skip that shortcut: evaluate_all_moves()
        # inside evaluate_fen() then takes its own parallel path, which
        # independently bounds its wait by cfg.probe_timeout and reports
        # "unknown" for whatever's still unresolved, rather than this handler
        # blocking on the same hung probe a second time.
        _evaluate_tls.bypass_parallel = prewarm_complete
        # Already built above (root_board, move_info) to size the progress
        # bar and know which child FENs to pre-warm — handing them to
        # evaluate_fen() here means a cache-miss FEN doesn't pay for a
        # second board build + legal-move walk right after this one.
        _evaluate_tls.board     = root_board
        _evaluate_tls.move_info = move_info
        try:
            result = json.loads(evaluate_fen(fen))
            yield _sse({"status": "done", **result})
        except chesstb.MissingTableError:
            yield _sse({"status": "error", **_missing_table_error_payload(fen)})
        except _REMOTE_SOURCE_ERRORS as e:
            log.warning("Remote tablebase fetch failed in probe/stream for %s: %s", fen, e)
            yield _sse({
                "status": "error",
                "error": "Could not reach the remote tablebase. Try again shortly.",
                "error_code": "remote_unavailable",
            })
        except ProbeInFlightTimeout as e:
            log.warning("%s", e)
            yield _sse({
                "status": "error",
                "error": "Probe timed out. Try again shortly.",
                "error_code": "probe_timeout",
            })
        except Exception as e:
            log.exception("Error in probe/stream for %s", fen)
            yield _sse({"status": "error", "error": str(e)})
        finally:
            _evaluate_tls.bypass_parallel = False
            _evaluate_tls.board     = None
            _evaluate_tls.move_info = None

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/health")
def health() -> Response:
    if TB is None:
        return jsonify({"status": "degraded", "reason": "Tablebase not initialised"}), 503
    return jsonify({"status": "ok"}), 200


def _cache_info_dict(info) -> dict:
    hits, misses       = info.hits, info.misses
    maxsize, currsize  = info.maxsize, info.currsize
    total = hits + misses
    return {
        "hits":     hits,
        "misses":   misses,
        "hit_rate": round(hits / total, 4) if total else 0.0,
        "maxsize":  maxsize,
        "currsize": currsize,
    }


@app.route("/admin/cache/clear", methods=["POST"])
def clear_cache() -> Response:
    evaluate_fen.cache_clear()
    _probe_fen.cache_clear()
    # The two LRUs above are app.py-level caches keyed on exact FEN strings.
    # They are not the only cache in the probing pipeline: a Tablebase can
    # keep its own internal decoded-block cache and, in remote mode, a
    # downloaded-file cache (remote/remote_fallback.py). clear_caches()/
    # cache_stats() exist only when TB is a remote/remote_fallback.py
    # Tablebase -- a plain local-directory Tablebase has no equivalent,
    # since it has no such cache to clear. Guarded with getattr rather
    # than an isinstance check, so this keeps working unmodified across
    # both cases without needing to enumerate them here.
    tb_cache_cleared = False
    tb_cache_info = None
    clear_fn = getattr(TB, "clear_caches", None) if TB is not None else None
    if clear_fn is not None:
        clear_fn()
        tb_cache_cleared = True
        stats_fn = getattr(TB, "cache_stats", None)
        if stats_fn is not None:
            tb_cache_info = stats_fn()
    log.info(
        "All probe caches cleared (tablebase-internal cache %s).",
        "cleared" if tb_cache_cleared else "not applicable for this tablebase",
    )
    response = {
        "status":             "ok",
        "message":            "All probe caches cleared (root JSON cache + child probe cache"
                               + (" + tablebase-internal caches)." if tb_cache_cleared else ")."),
        "evaluate_fen_cache": _cache_info_dict(evaluate_fen.cache_info()),
        "probe_fen_cache":    _cache_info_dict(_probe_fen.cache_info()),
        "tablebase_internal_cache_cleared": tb_cache_cleared,
    }
    if tb_cache_info is not None:
        response["tablebase_cache"] = tb_cache_info
    return jsonify(response)


@app.route("/admin/cache/stats", methods=["GET"])
def cache_stats() -> Response:
    stats = {
        "evaluate_fen_cache": _cache_info_dict(evaluate_fen.cache_info()),
        "probe_fen_cache":    _cache_info_dict(_probe_fen.cache_info()),
        "thread_pool": {
            "max_workers":        cfg.probe_threads,
            "parallel_threshold": cfg.parallel_threshold,
            "probe_timeout_secs": cfg.probe_timeout,
        },
        "config": {
            "evaluate_cache_size": cfg.evaluate_cache_size,
            "probe_cache_size":    cfg.probe_cache_size,
            "block_cache_bytes":   cfg.block_cache_bytes,
        },
        "tablebase_source": "remote" if _tablebase_is_remote else "local",
        "tablebase_remote_mode": _remote_backend_name if _tablebase_is_remote else None,
    }
    # Guarded with getattr rather than a TB-is-not-None check: TB is a
    # valid Tablebase either way, but cache_stats() only exists when TB is
    # a remote/remote_fallback.py Tablebase -- see clear_cache() above for
    # why. Reports the backend's downloaded-file cache when present.
    stats_fn = getattr(TB, "cache_stats", None) if TB is not None else None
    if stats_fn is not None:
        stats["tablebase_cache"] = stats_fn()
    return jsonify(stats)


@app.route("/admin", methods=["GET"])
def admin_dashboard() -> str:
    return render_template("admin.html")


# ── OpenAPI specification ─────────────────────────────────────────────────────
# Spec itself lives in openapi.yaml (project root) rather than as an inline
# string here -- keeps it out of app.py's line count and lets it be edited/
# linted/diffed as a normal YAML file.

_OPENAPI_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "openapi.yaml")


@app.route("/openapi.yaml")
def openapi_spec() -> Response:
    return send_file(_OPENAPI_PATH, mimetype="application/yaml")


if __name__ == "__main__":
    if cfg.debug:
        # Flask's own dev server: auto-reload + interactive debugger, for
        # local development only. `threaded=True` is what lets a long-lived
        # /probe/stream SSE connection coexist with other concurrent
        # requests on this single-process server (see README.md "Running in
        # production").
        log.info("DEBUG = True (config.py) — starting Flask development server on %s:%s", cfg.host, cfg.port)
        app.run(debug=True, host=cfg.host, port=cfg.port, threaded=True)
    else:
        # Production: serve via waitress, a pure-Python production-grade
        # WSGI server. `threads` gives waitress its own pool of
        # request-handling threads, playing the same role `threaded=True`
        # plays for the Flask dev server above — without it, a single
        # open /probe/stream connection could starve every other request
        # (see README.md "Running in production").
        log.info(
            "Starting waitress production server on %s:%s (threads=%s)",
            cfg.host, cfg.port, cfg.waitress_threads,
        )
        waitress_serve(app, host=cfg.host, port=cfg.port, threads=cfg.waitress_threads)