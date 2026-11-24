"""Spoken narration for Playbooks and lessons, through Microsoft's neural voices.

Three jobs live here. `chess_to_speech` rewrites chess notation and coaching
shorthand inside prose into words a voice reads naturally ("5...Qf6!" becomes
"Queen to f6", "Nbd2-f1-g3" becomes "Knight b to d2, then f1 to g3", "50cp"
becomes "50 centipawns") while leaving ordinary English and ordinary numbers
alone. `synthesize_clip` turns the result into MP3 bytes with `edge-tts` and
keeps the word timings the voice reports alongside them. `extract_speech_cues`
turns those timings into board cues (squares to light, arrows to draw) that
start and stop with the words that name them.

Playbook and lesson lines are fixed text, so the same sentence is asked for over
and over. Each clip is synthesized once: a bounded in-memory LRU serves repeats
in well under a millisecond, a disk directory keeps them across restarts, and a
single-flight table makes two simultaneous requests for one line share a single
upstream call. Cues are not cached per side: the clip stores the word timings,
and cues for White, Black or neither are derived from them in microseconds, so
one upstream call serves every side and both endpoints.

Upstream is slow (measured on this host: 3-4s before the first audio, then about
0.75x real time, so a 588-character line took 33.5s), which is why
`prewarm_study_tts` exists: run it once and every built-in line is on disk.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
import hashlib
import json
import logging
import os
from pathlib import Path
import re
from typing import Final, Literal

from fastapi import HTTPException

import edge_tts

logger = logging.getLogger(__name__)

Side = Literal["white", "black"]

DEFAULT_VOICE: Final = "en-US-AvaMultilingualNeural"
# Female English neural voices only; callers pick from this list, never a free string.
VOICE_CHOICES: Final = (
    "en-US-AvaMultilingualNeural",
    "en-US-EmmaMultilingualNeural",
    "en-GB-SoniaNeural",
    "en-US-AvaNeural",
    "en-US-JennyNeural",
)
ALLOWED_VOICES: Final = frozenset(VOICE_CHOICES)
# A touch slower than the voice's default: a coach explaining, not a newsreader.
DEFAULT_RATE: Final = "-4%"
MAX_TEXT_CHARS: Final = 1200
# Upstream needs a few seconds before the first audio and then streams at about
# 0.75x real time, so the allowance grows with the text: 588 characters took 33.5s.
SYNTHESIS_TIMEOUT_SECONDS: Final = 20.0
SYNTHESIS_SECONDS_PER_CHAR: Final = 0.06
MEMORY_MAX_CLIPS: Final = 256
MEMORY_MAX_BYTES: Final = 15 * 1024 * 1024
UNAVAILABLE_DETAIL: Final = "Speech synthesis is temporarily unavailable."
# Bumped whenever the stored clip format changes, so old files are never misread.
CACHE_FORMAT: Final = "clip-v2"
TICKS_PER_MS: Final = 10_000  # edge-tts offsets and durations are 100ns ticks

_PIECE_NAMES: Final = {"K": "King", "Q": "Queen", "R": "Rook", "B": "Bishop", "N": "Knight"}

# --------------------------------------------------------------------------
# Notation and shorthand as spoken English
# --------------------------------------------------------------------------

# Coaching shorthand, applied first. Each pattern is word-bounded so it never
# fires inside another word.
_ABBREVIATIONS: Final = (
    (re.compile(r"\be\.g\.(?!\w)"), "for example"),
    (re.compile(r"\bi\.e\.(?!\w)"), "that is"),
    # "vs." mid-sentence loses its dot: a pause there would sound choppy.
    (re.compile(r"\b[Vv]s\.?(?=\s)"), "versus"),
    (re.compile(r"\b[Vv]s\b"), "versus"),
    (re.compile(r"\bavg\.(?=\s+[a-z0-9])"), "average"),
    (re.compile(r"\bavg\b"), "average"),
    (re.compile(r"(?<=\d)\s?cp\b"), " centipawns"),
    (re.compile(r"\bcp\b"), "centipawns"),
    (re.compile(r"\bQGD\b"), "Queen's Gambit Declined"),
    (re.compile(r"\bQGA\b"), "Queen's Gambit Accepted"),
    (re.compile(r"\bIQPs\b"), "isolated queen's pawns"),
    (re.compile(r"\bIQP\b"), "isolated queen's pawn"),
    (re.compile(r"\bLPDO\b"), "loose pieces drop off"),
)

# "Nbd2-f1-g3": a piece tour, the first step written as SAN and the rest as squares.
_PIECE_TOUR = re.compile(
    r"(?<![\w.\-])(?:\d{1,3}\.(?:\.\.)?\s?)?"
    r"(?P<piece>[KQRBN])(?P<disamb>[a-h]?[1-8]?)(?P<first>[a-h][1-8])(?P<rest>(?:-[a-h][1-8])+)"
    r"(?![\w\-])"
)

# "d4-d5", "f4-f5-f6", "the a1-h8 diagonal": squares written from-to.
_SQUARE_CHAIN = re.compile(r"(?<![\w\-/])(?P<chain>[a-h][1-8](?:-[a-h][1-8])+)(?![\w\-/])")

# "c3/d3/a4" or "Nf3/Nc3": alternatives (or a group) written with slashes.
_MOVE_CHUNK = r"(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8])[+#]?"
_SLASH_LIST = re.compile(rf"(?<![\w/\-.])(?P<items>{_MOVE_CHUNK}(?:/{_MOVE_CHUNK})+)(?![\w/\-])")

# "1600-2000", "3-4": a range. Game results ("1-0", "0-1") and dates are not.
_NUMBER_RANGE = re.compile(r"(?<![\w\-/.])(?P<low>\d{1,4})-(?P<high>\d{1,4})(?![\w\-/]|\.\d)")

# One SAN move, optionally led by a move number ("12.", "5...", "1. ") or a bare
# "..." for a Black move, and trailed by a check mark and an annotation. Every
# alternative needs a board square (or the castling shape), so words like "Book",
# "Best" or "Queen" and numbers like "1600-2000" can never match.
_SAN = re.compile(
    r"""
    (?<![\w.\-])
    (?:(?P<num>\d{1,3})\.(?:\.\.)?\s?|\.\.\.\s?)?
    (?:
        (?P<castle>O-O-O|O-O)
      | (?P<piece>[KQRBN])(?P<disamb>[a-h]?[1-8]?)(?P<pcap>x)?(?P<pto>[a-h][1-8])
      | (?P<pfile>[a-h])(?:x(?P<pawnto>[a-h][1-8])|(?P<prank>[1-8]))(?:=?(?P<promo>[QRBN]))?
    )
    (?P<check>[+#])?
    (?:!!|\?\?|!\?|\?!|!|\?)?
    (?![\w\-])
    """,
    re.VERBOSE,
)
_BARE_SQUARE = re.compile(r"[a-h][1-8]")


def _speak_san(match: re.Match[str]) -> str:
    parts: list[str]
    if castle := match.group("castle"):
        parts = ["castles queenside" if castle == "O-O-O" else "castles kingside"]
    elif piece := match.group("piece"):
        parts = [_PIECE_NAMES[piece]]
        if disamb := match.group("disamb"):
            parts.append(disamb)
        parts.append("takes" if match.group("pcap") else "to")
        parts.append(match.group("pto"))
    else:
        pfile = match.group("pfile")
        if pawn_to := match.group("pawnto"):
            parts = [pfile, "takes", pawn_to]
        else:
            parts = [f"{pfile}{match.group('prank')}"]
        if promo := match.group("promo"):
            parts.extend(["promotes to", _PIECE_NAMES[promo]])
    check = match.group("check")
    if check == "+":
        parts.append("check")
    elif check == "#":
        parts.append("checkmate")
    return " ".join(parts)


def _speak_piece_tour(match: re.Match[str]) -> str:
    head = [_PIECE_NAMES[match.group("piece")]]
    if disamb := match.group("disamb"):
        head.append(disamb)
    head.extend(["to", match.group("first")])
    rest = match.group("rest").lstrip("-").split("-")
    return f"{' '.join(head)}, then {' to '.join(rest)}"


def _speak_slash_list(match: re.Match[str]) -> str:
    items = match.group("items").split("/")
    spoken = [_SAN.sub(_speak_san, item) for item in items]
    if len(spoken) > 2:
        return f"{', '.join(spoken[:-1])}, and {spoken[-1]}"
    first, second = items
    # Two squares side by side on one rank are a group (the d4/e4 pawn duo);
    # anything else written with a slash is a choice (b6/a7, Nf3/Nc3).
    duo = (
        _BARE_SQUARE.fullmatch(first)
        and _BARE_SQUARE.fullmatch(second)
        and first[1] == second[1]
        and abs(ord(first[0]) - ord(second[0])) == 1
    )
    return f"{spoken[0]} {'and' if duo else 'or'} {spoken[1]}"


def _speak_range(match: re.Match[str]) -> str:
    low, high = int(match.group("low")), int(match.group("high"))
    if low >= high or (low, high) == (0, 1):
        return match.group(0)
    return f"{match.group('low')} to {match.group('high')}"


def _expand(match: re.Match[str], words: str) -> str:
    """The expansion, capitalised when the shorthand opened a sentence."""
    before = match.string[: match.start()].rstrip()
    if not before or before[-1] in ".!?":
        stripped = words.lstrip()
        return words[: len(words) - len(stripped)] + stripped[:1].upper() + stripped[1:]
    return words


def chess_to_speech(text: str) -> str:
    """Rewrite chess notation and coaching shorthand as spoken English; leave everything else alone."""
    spoken = text
    for pattern, replacement in _ABBREVIATIONS:
        spoken = pattern.sub(lambda match, words=replacement: _expand(match, words), spoken)
    spoken = _PIECE_TOUR.sub(_speak_piece_tour, spoken)
    spoken = _SQUARE_CHAIN.sub(lambda match: " to ".join(match.group("chain").split("-")), spoken)
    spoken = _SLASH_LIST.sub(_speak_slash_list, spoken)
    spoken = _NUMBER_RANGE.sub(_speak_range, spoken)
    spoken = _SAN.sub(_speak_san, spoken)
    return re.sub(r"\s+", " ", spoken).strip()


# --------------------------------------------------------------------------
# Word timings to board cues
# --------------------------------------------------------------------------

CueColor = Literal["gold", "blue", "red", "green"]

MIN_CUE_MS: Final = 750
ARROW_HOLD_MS: Final = 500
SQUARE_HOLD_MS: Final = 550
SQUARE_LEAD_MS: Final = 120

_FILES: Final = "abcdefgh"
_SQUARE_WORD = re.compile(r"[a-h][1-8]")
_FILE_WORD = re.compile(r"([a-h])-files?")
_EDGE_PUNCTUATION = ".,;:!?\"'()[]{}‘’“”"
# Words that point at the square named next: the light comes up as she says them.
_LEAD_IN_WORDS: Final = frozenset({
    "knight", "bishop", "queen", "rook", "king", "pawn",
    "takes", "captures", "on", "to", "square", "outpost", "weak", "target",
})
_PIECE_WORDS: Final = frozenset({
    "knight", "knights", "bishop", "bishops", "queen", "rook", "rooks", "king", "pawn", "pawns",
})
_ORDINALS: Final = {
    "1st": 1, "first": 1, "2nd": 2, "second": 2, "3rd": 3, "third": 3, "4th": 4, "fourth": 4,
    "5th": 5, "fifth": 5, "6th": 6, "sixth": 6, "7th": 7, "seventh": 7, "8th": 8, "eighth": 8,
}
_CASTLING_WORDS: Final = frozenset({"castles", "castle", "castling", "castled"})
_CENTER_WORDS: Final = frozenset({"center", "centre", "central"})
_CENTER: Final = ("d4", "e4", "d5", "e5")
_KINGSIDE_ZONE: Final = ("f4", "g4", "h4", "f5", "g5", "h5")
_QUEENSIDE_ZONE: Final = ("a4", "b4", "c4", "a5", "b5", "c5")


@dataclass(frozen=True, slots=True)
class WordTiming:
    """One word the voice spoke, and when, in milliseconds from the clip's start."""

    text: str
    start_ms: int
    end_ms: int

    def as_dict(self) -> dict:
        return {"text": self.text, "start_ms": self.start_ms, "end_ms": self.end_ms}


def word_from_boundary(event: dict) -> WordTiming:
    """An edge-tts `WordBoundary` event (100ns ticks) as a millisecond word timing."""
    offset = int(event.get("offset", 0))
    duration = int(event.get("duration", 0))
    return WordTiming(
        text=str(event.get("text", "")),
        start_ms=round(offset / TICKS_PER_MS),
        end_ms=round((offset + duration) / TICKS_PER_MS),
    )


def _as_timing(word: WordTiming | dict) -> WordTiming:
    if isinstance(word, WordTiming):
        return word
    return WordTiming(text=str(word["text"]), start_ms=int(word["start_ms"]), end_ms=int(word["end_ms"]))


def _split_words(words: Iterable[WordTiming | dict]) -> list[tuple[str, int, int]]:
    """Normalized (word, start, end) triples, one per spoken word.

    The service sometimes reports a phrase as one boundary ("1600 to 2000"), so
    a multi-word boundary is split and its time shared out by length.
    """
    out: list[tuple[str, int, int]] = []
    for raw in words:
        word = _as_timing(raw)
        parts = [part.strip(_EDGE_PUNCTUATION).lower() for part in word.text.split()]
        parts = [part for part in parts if part]
        if not parts:
            continue
        if len(parts) == 1:
            out.append((parts[0], word.start_ms, word.end_ms))
            continue
        total = sum(len(part) for part in parts) or 1
        span = max(0, word.end_ms - word.start_ms)
        cursor = float(word.start_ms)
        for part in parts:
            share = span * len(part) / total
            out.append((part, round(cursor), round(cursor + share)))
            cursor += share
    return out


def _file_squares(file: str) -> list[str]:
    return [f"{file}{rank}" for rank in range(1, 9)]


def _rank_squares(rank: int) -> list[str]:
    return [f"{file}{rank}" for file in _FILES]


def _diagonal(start: str, end: str) -> list[str] | None:
    """Every square from `start` to `end` inclusive, or None when they share no diagonal."""
    file_step = ord(end[0]) - ord(start[0])
    rank_step = int(end[1]) - int(start[1])
    if file_step == 0 or abs(file_step) != abs(rank_step):
        return None
    df = 1 if file_step > 0 else -1
    dr = 1 if rank_step > 0 else -1
    return [
        f"{chr(ord(start[0]) + df * step)}{int(start[1]) + dr * step}"
        for step in range(abs(file_step) + 1)
    ]


def _cue(start_ms: int, end_ms: int, squares: Sequence[str], color: CueColor, arrows=()) -> dict:
    start_ms = max(0, start_ms)
    return {
        "start_ms": start_ms,
        "end_ms": max(end_ms, start_ms + MIN_CUE_MS),
        "squares": list(dict.fromkeys(squares)),
        "arrows": [dict(arrow) for arrow in arrows],
        "color": color,
    }


def extract_speech_cues(words: Iterable[WordTiming | dict], side: Side | None = None) -> list[dict]:
    """Board cues timed to the words that name them, sorted by start.

    Each cue is `{start_ms, end_ms, squares, arrows, color}`: a move ("d4 to d5")
    draws a gold arrow and lights its target, a diagonal ("a1 to h8 diagonal")
    lights every square on it, a lone square lights itself, and files, ranks,
    the center, the wings and castling light the squares they mean. `side` is
    whose point of view the narration takes: it decides where "castles" lands
    and which rank "the seventh rank" is.
    """
    items = _split_words(words)
    count = len(items)
    cues: list[dict] = []

    def norm(at: int) -> str:
        return items[at][0] if 0 <= at < count else ""

    i = 0
    while i < count:
        word, start, end = items[i]

        if _SQUARE_WORD.fullmatch(word):
            target = norm(i + 2)
            if norm(i + 1) in {"to", "-"} and _SQUARE_WORD.fullmatch(target):
                diagonal_at = next((at for at in (i + 3, i + 4) if norm(at) == "diagonal"), None)
                squares = _diagonal(word, target) if diagonal_at is not None else None
                if squares is not None and diagonal_at is not None:
                    cues.append(_cue(start, items[diagonal_at][2] + ARROW_HOLD_MS, squares, "blue"))
                    i = diagonal_at + 1
                    continue
                arrow = {"from": word, "to": target, "color": "gold"}
                cues.append(_cue(start, items[i + 2][2] + ARROW_HOLD_MS, [target], "gold", [arrow]))
                i += 3
                continue
            lead = items[i - 1][1] if norm(i - 1) in _LEAD_IN_WORDS else start - SQUARE_LEAD_MS
            # "the e4 pawn": hold the square through the piece standing on it.
            hold_until = items[i + 1][2] if norm(i + 1) in _PIECE_WORDS else end
            cues.append(_cue(lead, hold_until + SQUARE_HOLD_MS, [word], "gold"))
            i += 1
            continue

        if match := _FILE_WORD.fullmatch(word):
            cues.append(_cue(start, end + ARROW_HOLD_MS, _file_squares(match.group(1)), "blue"))
            i += 1
            continue
        # "the h file" spoken as two words; a bare "a" is the article, so "a file" is not one.
        if len(word) == 1 and word in _FILES[1:] and norm(i + 1) in {"file", "files"}:
            cues.append(_cue(start, items[i + 1][2] + ARROW_HOLD_MS, _file_squares(word), "blue"))
            i += 2
            continue

        rank_word, _, rank_tail = word.partition("-")
        if rank_word in _ORDINALS and (rank_tail in {"rank", "ranks"} or norm(i + 1) in {"rank", "ranks"}):
            rank = _ORDINALS[rank_word]
            if side == "black":
                rank = 9 - rank  # Black's seventh rank is the second rank on the board.
            last = i if rank_tail else i + 1
            cues.append(_cue(start, items[last][2] + ARROW_HOLD_MS, _rank_squares(rank), "blue"))
            i = last + 1
            continue
        if rank_word == "back" and (rank_tail in {"rank", "ranks"} or norm(i + 1) in {"rank", "ranks"}):
            last = i if rank_tail else i + 1
            cues.append(_cue(start, items[last][2] + ARROW_HOLD_MS, _rank_squares(1) + _rank_squares(8), "red"))
            i = last + 1
            continue

        if word in _CASTLING_WORDS and norm(i + 1) in {"kingside", "queenside"}:
            kingside = norm(i + 1) == "kingside"
            back = "8" if side == "black" else "1"
            files = ("g", "f") if kingside else ("c", "d")
            squares = [f"{file}{back}" for file in files]
            cues.append(_cue(start, items[i + 1][2] + ARROW_HOLD_MS, squares, "gold"))
            i += 2
            continue

        if word in _CENTER_WORDS:
            cues.append(_cue(start, end + ARROW_HOLD_MS, _CENTER, "blue"))
        elif word == "kingside":
            cues.append(_cue(start, end + ARROW_HOLD_MS, _KINGSIDE_ZONE, "blue"))
        elif word == "queenside":
            cues.append(_cue(start, end + ARROW_HOLD_MS, _QUEENSIDE_ZONE, "blue"))
        i += 1

    cues.sort(key=lambda cue: (cue["start_ms"], cue["end_ms"]))
    return cues


# --------------------------------------------------------------------------
# Clips: audio plus word timings, cached in memory and on disk
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SpeechClip:
    audio: bytes
    words: tuple[WordTiming, ...] = ()

    @property
    def size(self) -> int:
        # Roughly what the timings cost in memory beside the audio.
        return len(self.audio) + 64 * len(self.words)


def cache_key(voice: str, spoken_text: str, rate: str = DEFAULT_RATE) -> str:
    return hashlib.sha256(f"{CACHE_FORMAT}:{voice}:{rate}:{spoken_text}".encode()).hexdigest()


Producer = Callable[[], Awaitable[SpeechClip]]


class SpeechCache:
    """Bounded memory LRU over a disk directory, with single-flight synthesis.

    On disk a clip is two files: `<key>.mp3` (the audio) and `<key>.json` (the
    word timings). The JSON is written last, so its presence means the pair is
    complete.
    """

    def __init__(
        self,
        directory: Path | None,
        *,
        max_clips: int = MEMORY_MAX_CLIPS,
        max_bytes: int = MEMORY_MAX_BYTES,
    ) -> None:
        self.directory = directory
        self.max_clips = max_clips
        self.max_bytes = max_bytes
        self._memory: OrderedDict[str, SpeechClip] = OrderedDict()
        self._memory_bytes = 0
        self._inflight: dict[str, asyncio.Task[SpeechClip]] = {}

    def get_memory(self, key: str) -> SpeechClip | None:
        clip = self._memory.get(key)
        if clip is not None:
            self._memory.move_to_end(key)
        return clip

    def put_memory(self, key: str, clip: SpeechClip) -> None:
        if clip.size > self.max_bytes:
            return
        previous = self._memory.pop(key, None)
        if previous is not None:
            self._memory_bytes -= previous.size
        self._memory[key] = clip
        self._memory_bytes += clip.size
        while self._memory and (len(self._memory) > self.max_clips or self._memory_bytes > self.max_bytes):
            _, evicted = self._memory.popitem(last=False)
            self._memory_bytes -= evicted.size

    def _paths(self, key: str) -> tuple[Path, Path] | None:
        if self.directory is None:
            return None
        return self.directory / f"{key}.mp3", self.directory / f"{key}.json"

    def on_disk(self, key: str) -> bool:
        """Whether a complete clip is stored, without reading it (two stat calls)."""
        paths = self._paths(key)
        return paths is not None and paths[0].is_file() and paths[1].is_file()

    def _read_disk(self, key: str) -> SpeechClip | None:
        paths = self._paths(key)
        if paths is None:
            return None
        audio_path, words_path = paths
        try:
            meta = json.loads(words_path.read_text(encoding="utf-8"))
            audio = audio_path.read_bytes()
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            logger.warning("Could not read cached speech clip %s", audio_path, exc_info=True)
            return None
        if not audio or meta.get("format") != CACHE_FORMAT:
            return None
        try:
            words = tuple(_as_timing(word) for word in meta.get("words", []))
        except (KeyError, TypeError, ValueError):
            return None
        return SpeechClip(audio=audio, words=words)

    def _write_disk(self, key: str, clip: SpeechClip, meta: dict) -> None:
        paths = self._paths(key)
        if paths is None:
            return
        audio_path, words_path = paths
        payload = json.dumps(
            {**meta, "format": CACHE_FORMAT, "words": [word.as_dict() for word in clip.words]},
            ensure_ascii=False,
        )
        try:
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            for path, data in ((audio_path, clip.audio), (words_path, payload.encode("utf-8"))):
                partial = path.with_suffix(f"{path.suffix}.{os.getpid()}.part")
                partial.write_bytes(data)
                os.replace(partial, path)
        except OSError:
            # A read-only or full disk costs only the restart cache, never the clip.
            logger.warning("Could not store speech clip %s", audio_path, exc_info=True)

    async def get_or_create(
        self,
        key: str,
        produce: Producer,
        *,
        meta: dict | None = None,
        remember: bool = True,
    ) -> SpeechClip:
        clip = self.get_memory(key)
        if clip is not None:
            return clip
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._load_or_produce(key, produce, meta or {}, remember))
            self._inflight[key] = task
            task.add_done_callback(lambda done: self._finish(key, done))
        # Shielded so one caller disconnecting does not cancel the clip for the others.
        return await asyncio.shield(task)

    def _finish(self, key: str, task: asyncio.Task[SpeechClip]) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]
        if not task.cancelled():
            task.exception()  # Mark retrieved even when every waiter has gone.

    async def _load_or_produce(self, key: str, produce: Producer, meta: dict, remember: bool) -> SpeechClip:
        clip = await asyncio.to_thread(self._read_disk, key)
        if clip is None:
            clip = await produce()
            await asyncio.to_thread(self._write_disk, key, clip, meta)
        if remember:
            self.put_memory(key, clip)
        return clip


_cache = SpeechCache(Path(os.getenv("TTS_CACHE_DIR", "/tmp/chessgod-tts-cache")))


def synthesis_timeout(spoken_text: str) -> float:
    return SYNTHESIS_TIMEOUT_SECONDS + SYNTHESIS_SECONDS_PER_CHAR * len(spoken_text)


async def _stream_edge_tts(spoken_text: str, voice: str, rate: str = DEFAULT_RATE) -> SpeechClip:
    chunks: list[bytes] = []
    words: list[WordTiming] = []
    try:
        async with asyncio.timeout(synthesis_timeout(spoken_text)):
            communicate = edge_tts.Communicate(spoken_text, voice, rate=rate, boundary="WordBoundary")
            async for chunk in communicate.stream():
                kind = chunk.get("type")
                if kind == "audio" and chunk.get("data"):
                    chunks.append(chunk["data"])
                elif kind == "WordBoundary" and chunk.get("text"):
                    words.append(word_from_boundary(chunk))
    except Exception as exc:  # noqa: BLE001 - network, protocol and timeout errors all mean "unavailable"
        logger.warning("edge-tts synthesis failed (%s: %s)", type(exc).__name__, exc)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL) from exc
    audio = b"".join(chunks)
    if not audio:
        logger.warning("edge-tts returned no audio for voice %s", voice)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)
    return SpeechClip(audio=audio, words=tuple(words))


def _prepare(text: str, voice: str) -> str:
    if voice not in ALLOWED_VOICES:
        raise HTTPException(status_code=400, detail="Unknown voice.")
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"Text is longer than {MAX_TEXT_CHARS} characters.")
    spoken_text = chess_to_speech(text)
    if not spoken_text:
        raise HTTPException(status_code=400, detail="Nothing to read aloud.")
    return spoken_text


async def _clip_for(spoken_text: str, voice: str, *, remember: bool = True) -> SpeechClip:
    rate = DEFAULT_RATE
    key = cache_key(voice, spoken_text, rate)
    meta = {"voice": voice, "rate": rate, "spoken_text": spoken_text}
    return await _cache.get_or_create(
        key, lambda: _stream_edge_tts(spoken_text, voice, rate), meta=meta, remember=remember
    )


async def synthesize_clip(text: str, voice: str = DEFAULT_VOICE) -> tuple[str, SpeechClip]:
    """The spoken form of `text` and its clip (audio and word timings), synthesizing each line once."""
    spoken_text = _prepare(text, voice)
    return spoken_text, await _clip_for(spoken_text, voice)


async def synthesize_speech(text: str, voice: str = DEFAULT_VOICE) -> bytes:
    """Return MP3 bytes for `text` read in `voice`, synthesizing each line once."""
    _, clip = await synthesize_clip(text, voice)
    return clip.audio


async def narrate(text: str, voice: str = DEFAULT_VOICE, side: Side | None = None) -> dict:
    """Audio for `text` with the board cues timed to it, from the same cached clip as `synthesize_speech`."""
    spoken_text, clip = await synthesize_clip(text, voice)
    return {
        "audio": clip.audio,
        "voice": voice,
        "spoken_text": spoken_text,
        "cues": extract_speech_cues(clip.words, side),
    }


# --------------------------------------------------------------------------
# Prewarming the built-in lines
# --------------------------------------------------------------------------

# What the frontend sends: `SPEECH_TEXT_LIMIT` in `lib/speech.ts`.
SPEECH_TEXT_LIMIT: Final = 1150
PREWARM_CONCURRENCY: Final = 2
PREWARM_PAUSE_SECONDS: Final = 1.0
PREWARM_MAX_CONSECUTIVE_FAILURES: Final = 5


def cap_speech_text(text: str, limit: int = SPEECH_TEXT_LIMIT) -> str:
    """Python twin of the frontend's `capSpeechText`: cut at a sentence end when one is near."""
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    cut = clean[:limit]
    sentence = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if sentence > limit / 2:
        return cut[: sentence + 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > 0 else cut).strip()


def playbook_speech(playbook) -> str:
    """What a Playbook's Listen button reads: `playbookSpeech` in `study-guide.tsx`."""
    ideas = ""
    if playbook.core_ideas:
        sentences = [re.sub(r"([^.!?])$", r"\1.", idea.strip()) for idea in playbook.core_ideas]
        ideas = " Core ideas. " + " ".join(sentences)
    return cap_speech_text(f"{playbook.title}. {playbook.summary}{ideas}")


def _move_labels(line: dict) -> list[str]:
    """`moveLabels` in `study-course-trainer.tsx`: "4." for White, "4..." for Black."""
    fields = line["start_fen"].split(" ")
    number = int(fields[5]) if len(fields) > 5 and fields[5].isdigit() else 1
    labels = []
    for move in line["moves"]:
        black = move["fen"].split(" ")[1] == "b"
        labels.append(f"{number}{'...' if black else '.'}")
        if black:
            number += 1
    return labels


def course_line_speech(line: dict) -> list[str]:
    """Every text the line trainer reads for one line in learn mode, in order.

    A commented move is read as "4... Nxd4. <comment>" (the note and review
    buttons), each of the player's moves as "5. Qxd4. <comment>" (the prompt),
    and auto-read joins an opponent's note to the prompt that follows it.
    """
    labels = _move_labels(line)
    moves = line["moves"]
    texts: list[str] = []
    for index, move in enumerate(moves):
        label = f"{labels[index]} {move['san']}"
        comment = move.get("comment") or ""
        note = f"{label}. {comment}" if comment else ""
        if note:
            texts.append(note)
        if move["side"] != "you":
            continue
        prompt = f"{label}. {comment}".strip()
        texts.append(prompt)
        previous = moves[index - 1] if index > 0 else None
        if previous is not None and previous["side"] == "opponent" and previous.get("comment"):
            texts.append(f"{labels[index - 1]} {previous['san']}. {previous['comment']} {prompt}")
    return texts


def prewarm_texts() -> list[str]:
    """Every built-in line worth having on disk: Playbook overviews, then course moves."""
    # Imported here: these modules are large, and only the prewarm needs them.
    from app.services.study_courses import BUILTIN_COURSE_PRESETS, parse_pgn_chapters
    from app.services.study_curriculum import PLAYBOOKS

    texts = [playbook_speech(playbook) for playbook in PLAYBOOKS]
    for preset in BUILTIN_COURSE_PRESETS.values():
        try:
            chapters = parse_pgn_chapters(preset["pgn"], preset.get("color", "auto"))
        except Exception:  # noqa: BLE001 - one bad preset must not stop the rest
            logger.warning("Skipping course preset %s in the speech prewarm", preset.get("id"), exc_info=True)
            continue
        for chapter in chapters:
            for line in chapter["lines"]:
                texts.extend(course_line_speech(line))
    return [text for text in dict.fromkeys(texts) if text and len(text) <= MAX_TEXT_CHARS]


async def _rest(stop_event: asyncio.Event | None, seconds: float) -> None:
    if seconds <= 0:
        return
    if stop_event is None:
        await asyncio.sleep(seconds)
        return
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except TimeoutError:
        pass


async def prewarm_study_tts(
    stop_event: asyncio.Event | None = None,
    *,
    texts: Sequence[str] | None = None,
    voice: str = DEFAULT_VOICE,
    concurrency: int = PREWARM_CONCURRENCY,
    pause_seconds: float = PREWARM_PAUSE_SECONDS,
) -> dict:
    """Synthesize every built-in line that is not on disk yet, gently, and never raise.

    A clip already stored is skipped with two stat calls. Missing ones are made
    `concurrency` at a time with a pause after each upstream call, written to
    disk only (the memory LRU is left to real listeners), and a failure is
    counted and passed over. Five failures in a row end the run, since that is
    an outage rather than a bad line; setting `stop_event` ends it between clips.
    Run it from a script or a background task, never from a request.
    """
    stats = {"total": 0, "cached": 0, "synthesized": 0, "failed": 0, "stopped": False}
    try:
        pending = list(texts) if texts is not None else await asyncio.to_thread(prewarm_texts)
    except Exception:  # noqa: BLE001
        logger.warning("Could not list the lines to prewarm", exc_info=True)
        return stats
    queue: asyncio.Queue[str] = asyncio.Queue()
    for text in pending:
        queue.put_nowait(text)
    stats["total"] = len(pending)
    failures_in_a_row = 0

    def halted() -> bool:
        return (stop_event is not None and stop_event.is_set()) or failures_in_a_row >= PREWARM_MAX_CONSECUTIVE_FAILURES

    async def worker() -> None:
        nonlocal failures_in_a_row
        while not halted():
            try:
                text = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                spoken_text = _prepare(text, voice)
            except HTTPException:
                stats["failed"] += 1
                continue
            if _cache.on_disk(cache_key(voice, spoken_text)):
                stats["cached"] += 1
                continue
            try:
                await _clip_for(spoken_text, voice, remember=False)
            except Exception as exc:  # noqa: BLE001 - a prewarm never takes the process down
                stats["failed"] += 1
                failures_in_a_row += 1
                logger.info("Speech prewarm skipped a line (%s)", getattr(exc, "detail", exc))
            else:
                stats["synthesized"] += 1
                failures_in_a_row = 0
            await _rest(stop_event, pause_seconds)

    await asyncio.gather(*(worker() for _ in range(max(1, concurrency))))
    stats["stopped"] = halted() and not queue.empty()
    logger.info("Speech prewarm finished: %s", stats)
    return stats


if __name__ == "__main__":  # pragma: no cover - run by hand: python -m app.services.study_tts
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(json.dumps(asyncio.run(prewarm_study_tts())))
