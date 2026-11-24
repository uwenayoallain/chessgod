"""Tests for spoken Playbook narration: notation to words, caching, and the route."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException

from app.routers.study import router
from app.services import study_tts
from app.services.study_tts import (
    DEFAULT_RATE,
    SpeechCache,
    SpeechClip,
    WordTiming,
    cache_key,
    chess_to_speech,
    course_line_speech,
    extract_speech_cues,
    narrate,
    playbook_speech,
    prewarm_study_tts,
    prewarm_texts,
    synthesize_speech,
    word_from_boundary,
)


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("O-O", "castles kingside"),
        ("O-O-O", "castles queenside"),
        ("O-O+", "castles kingside check"),
        ("O-O-O#", "castles queenside checkmate"),
        ("Nf3", "Knight to f3"),
        ("Bxc6+", "Bishop takes c6 check"),
        ("Qxd4", "Queen takes d4"),
        ("Rfe1", "Rook f to e1"),
        ("Nbd2", "Knight b to d2"),
        ("R1e2", "Rook 1 to e2"),
        ("Nbxd2", "Knight b takes d2"),
        ("Qh7#", "Queen to h7 checkmate"),
        ("Kb1", "King to b1"),
        ("e8=Q", "e8 promotes to Queen"),
        ("exd8=N+", "e takes d8 promotes to Knight check"),
        ("exd5", "e takes d5"),
        ("cxd4", "c takes d4"),
        ("e4", "e4"),
        ("d4-d5", "d4 to d5"),
        ("the a1-h8 diagonal", "the a1 to h8 diagonal"),
        ("b4-b5 and h4-h5", "b4 to b5 and h4 to h5"),
        ("1.e4", "e4"),
        ("1. e4 e5 2. Nf3", "e4 e5 Knight to f3"),
        ("5...Qf6!", "Queen to f6"),
        ("5... Qf6", "Queen to f6"),
        ("12.Nbd2", "Knight b to d2"),
        ("4...exd4", "e takes d4"),
        ("...c5", "c5"),
        ("Black answers ...d5.", "Black answers d5."),
        ("Nf3!? or Nc3?! or Bb5!! or Qh5??", "Knight to f3 or Knight to c3 or Bishop to b5 or Queen to h5"),
        ("After 5...Qf6!, White plays 6.Be3.", "After Queen to f6, White plays Bishop to e3."),
        ("  Nf3 \n\n  then\tO-O  ", "Knight to f3 then castles kingside"),
    ],
)
def test_chess_to_speech_reads_notation(text, spoken):
    assert chess_to_speech(text) == spoken


@pytest.mark.parametrize(
    "text",
    [
        "Book",
        "Best",
        "Queen",
        "Black",
        "King's Gambit",
        "Spend 4 hours a week on it.",
        "Read it 2026-11-25.",
        "Weigh it and/or skip 1/2 of it.",
        "Score 1-0 or 0-1.",
        "Read chapter 2.5 next.",
        "Bad Bishop, Good Knight, and a Rook on the seventh.",
        "Wait... then think.",
        "The e-file is half open.",
    ],
)
def test_chess_to_speech_leaves_ordinary_prose_alone(text):
    assert chess_to_speech(text) == text


@pytest.mark.parametrize(
    ("text", "spoken"),
    [
        ("A 50cp edge.", "A 50 centipawns edge."),
        ("It costs 30 cp.", "It costs 30 centipawns."),
        ("The cp loss.", "The centipawns loss."),
        ("The avg. rating is high.", "The average rating is high."),
        ("Your avg score.", "Your average score."),
        ("Italian vs. Scotch", "Italian versus Scotch"),
        ("Italian vs Scotch", "Italian versus Scotch"),
        ("Develop, e.g. Nf3.", "Develop, for example Knight to f3."),
        ("e.g. Nf3 first.", "For example Knight to f3 first."),
        ("In the QGD Black is solid.", "In the Queen's Gambit Declined Black is solid."),
        ("Blockade the IQP.", "Blockade the isolated queen's pawn."),
        ("Remember LPDO.", "Remember loose pieces drop off."),
        ("LPDO! Check it.", "Loose pieces drop off! Check it."),
        ("Nbd2-f1-g3", "Knight b to d2, then f1 to g3"),
        ("Reroute with 12.Nbd2-f1-g3 and f4-f5.", "Reroute with Knight b to d2, then f1 to g3 and f4 to f5."),
        ("Nf3-d2", "Knight to f3, then d2"),
        ("f4-f5", "f4 to f5"),
        ("f4-f5-f6", "f4 to f5 to f6"),
        ("Aim at c3/d3/a4.", "Aim at c3, d3, and a4."),
        ("The bishop drops to b6/a7.", "The bishop drops to b6 or a7."),
        ("Pawns on d4/e4.", "Pawns on d4 and e4."),
        ("Play Nf3/Nc3 first.", "Play Knight to f3 or Knight to c3 first."),
        ("Players rated 1600-2000 should study this.", "Players rated 1600 to 2000 should study this."),
        ("Win 3-4 games in a row.", "Win 3 to 4 games in a row."),
    ],
)
def test_chess_to_speech_reads_coaching_shorthand_naturally(text, spoken):
    assert chess_to_speech(text) == spoken


def test_cache_key_depends_on_voice_rate_and_text():
    assert cache_key("en-US-AvaNeural", "a") == cache_key("en-US-AvaNeural", "a")
    assert cache_key("en-US-AvaNeural", "a") != cache_key("en-US-JennyNeural", "a")
    assert cache_key("en-US-AvaNeural", "a", "-4%") != cache_key("en-US-AvaNeural", "a", "+0%")
    assert len(cache_key("en-US-AvaNeural", "a")) == 64


def test_word_boundary_ticks_become_milliseconds():
    word = word_from_boundary({"type": "WordBoundary", "offset": 8_975_000, "duration": 9_525_000, "text": "e4"})
    assert word == WordTiming(text="e4", start_ms=898, end_ms=1850)


def spoken(*words: str, gap: int = 400, length: int = 300) -> list[dict]:
    """Word timings for `words`, one every `gap` ms, each `length` ms long."""
    return [
        {"text": word, "start_ms": at * gap, "end_ms": at * gap + length} for at, word in enumerate(words)
    ]


def cue(start_ms, end_ms, squares, color, arrows=()):
    return {"start_ms": start_ms, "end_ms": end_ms, "squares": squares, "arrows": list(arrows), "color": color}


def test_cue_for_a_square_named_with_its_piece_holds_through_the_piece():
    # "e4" 400-700, "pawn" 800-1100: lit 120ms early and held through "pawn".
    assert extract_speech_cues(spoken("The", "e4", "pawn")) == [cue(280, 1650, ["e4"], "gold")]


def test_cue_for_a_square_after_a_lead_in_word_starts_on_that_word():
    assert extract_speech_cues(spoken("Knight", "to", "f5.")) == [cue(400, 1650, ["f5"], "gold")]


def test_cue_for_a_lone_square_is_held_long_enough_to_see():
    # A 100ms word still lights its square for at least 750ms.
    words = [{"text": "h7", "start_ms": 1000, "end_ms": 1100}]
    assert extract_speech_cues(words) == [cue(880, 1650, ["h7"], "gold")]
    short = [{"text": "h7", "start_ms": 50, "end_ms": 60}]
    assert extract_speech_cues(short) == [cue(0, 750, ["h7"], "gold")]


def test_cue_for_a_move_draws_an_arrow_and_lights_the_target():
    arrow = {"from": "d4", "to": "d5", "color": "gold"}
    assert extract_speech_cues(spoken("d4", "to", "d5")) == [cue(0, 1600, ["d5"], "gold", [arrow])]


def test_cue_for_a_diagonal_lights_every_square_on_it():
    cues = extract_speech_cues(spoken("the", "a7", "to", "g1", "diagonal"))
    assert cues == [cue(400, 2400, ["a7", "b6", "c5", "d4", "e3", "f2", "g1"], "blue")]


def test_squares_that_share_no_diagonal_are_a_move_even_before_the_word_diagonal():
    cues = extract_speech_cues(spoken("a1", "to", "a8", "diagonal"))
    assert cues[0]["arrows"] == [{"from": "a1", "to": "a8", "color": "gold"}]


@pytest.mark.parametrize("words", [("h-file",), ("the", "h", "file")])
def test_cue_for_a_file_lights_the_whole_file(words):
    (only,) = extract_speech_cues(spoken(*words))
    assert only["squares"] == [f"h{rank}" for rank in range(1, 9)]
    assert only["color"] == "blue"


def test_the_article_a_before_file_is_not_the_a_file():
    assert extract_speech_cues(spoken("open", "a", "file")) == []
    (only,) = extract_speech_cues(spoken("the", "a-file"))
    assert only["squares"][0] == "a1"


@pytest.mark.parametrize("words", [("7th", "rank"), ("seventh", "rank")])
def test_cue_for_the_seventh_rank(words):
    (only,) = extract_speech_cues(spoken(*words))
    assert only == cue(0, 1200, [f"{file}7" for file in "abcdefgh"], "blue")
    (black,) = extract_speech_cues(spoken(*words), side="black")
    assert black["squares"] == [f"{file}2" for file in "abcdefgh"]


def test_cue_for_the_back_rank_is_both_back_ranks_in_red():
    (only,) = extract_speech_cues(spoken("back-rank"))
    assert only["color"] == "red"
    assert only["squares"] == [f"{file}1" for file in "abcdefgh"] + [f"{file}8" for file in "abcdefgh"]


def test_cue_for_the_center():
    assert extract_speech_cues(spoken("the", "center.")) == [cue(400, 1200, ["d4", "e4", "d5", "e5"], "blue")]


@pytest.mark.parametrize(
    ("side", "squares"),
    [(None, ["g1", "f1"]), ("white", ["g1", "f1"]), ("black", ["g8", "f8"])],
)
def test_cue_for_castling_kingside_depends_on_the_side(side, squares):
    assert extract_speech_cues(spoken("castles", "kingside"), side) == [cue(0, 1200, squares, "gold")]


def test_cue_for_castling_queenside_depends_on_the_side():
    assert extract_speech_cues(spoken("castles", "queenside"))[0]["squares"] == ["c1", "d1"]
    assert extract_speech_cues(spoken("castles", "queenside"), "black")[0]["squares"] == ["c8", "d8"]


def test_cue_for_a_wing_without_castling():
    (king,) = extract_speech_cues(spoken("attack", "kingside"))
    assert king["squares"] == ["f4", "g4", "h4", "f5", "g5", "h5"]
    (queen,) = extract_speech_cues(spoken("expand", "queenside"))
    assert queen["squares"] == ["a4", "b4", "c4", "a5", "b5", "c5"]


def test_cues_are_sorted_and_ignore_plain_words_and_numbers():
    words = spoken("Players", "rated", "1600 to 2000", "push", "Knight", "b", "to", "d2,", "then", "f1", "to", "g3")
    cues = extract_speech_cues(words)
    assert [c["squares"] for c in cues] == [["d2"], ["g3"]]
    assert cues[1]["arrows"] == [{"from": "f1", "to": "g3", "color": "gold"}]
    assert [c["start_ms"] for c in cues] == sorted(c["start_ms"] for c in cues)


def test_a_multi_word_boundary_is_split_by_length():
    words = [{"text": "d4 to d5", "start_ms": 0, "end_ms": 800}]
    (only,) = extract_speech_cues(words)
    assert only["arrows"] == [{"from": "d4", "to": "d5", "color": "gold"}]
    assert only["end_ms"] == 1300


DEFAULT_CHUNKS = [
    {"type": "WordBoundary", "offset": 1_000_000, "duration": 2_000_000, "text": "Knight"},
    {"type": "audio", "data": b"ID3"},
    {"type": "WordBoundary", "offset": 3_000_000, "duration": 1_000_000, "text": "to"},
    {"type": "WordBoundary", "offset": 4_000_000, "duration": 3_000_000, "text": "f3"},
    {"type": "audio", "data": b"-mp3"},
]
VOICE = "en-US-AvaMultilingualNeural"


class FakeCommunicate:
    """Stands in for `edge_tts.Communicate`, recording every call it gets."""

    calls: list[tuple[str, str]] = []
    options: list[dict] = []
    gate: asyncio.Event | None = None
    chunks: list[dict] = DEFAULT_CHUNKS
    error: Exception | None = None

    def __init__(self, text: str, voice: str, **options) -> None:
        type(self).calls.append((text, voice))
        type(self).options.append(options)

    async def stream(self):
        if type(self).gate is not None:
            await type(self).gate.wait()
        if type(self).error is not None:
            raise type(self).error
        for chunk in type(self).chunks:
            yield chunk


@pytest.fixture
def fake_tts(monkeypatch, tmp_path):
    FakeCommunicate.calls = []
    FakeCommunicate.options = []
    FakeCommunicate.gate = None
    FakeCommunicate.chunks = list(DEFAULT_CHUNKS)
    FakeCommunicate.error = None
    monkeypatch.setattr(study_tts.edge_tts, "Communicate", FakeCommunicate)
    monkeypatch.setattr(study_tts, "_cache", SpeechCache(tmp_path / "tts"))
    return FakeCommunicate


@pytest.mark.asyncio
async def test_synthesis_speaks_normalized_text_with_the_default_voice(fake_tts):
    audio = await synthesize_speech("Play 5...Qf6!")
    assert audio == b"ID3-mp3"
    assert fake_tts.calls == [("Play Queen to f6", VOICE)]
    # A calm coaching pace, with a timestamp for every word.
    assert fake_tts.options == [{"rate": "-4%", "boundary": "WordBoundary"}]


@pytest.mark.asyncio
async def test_repeat_is_served_from_memory_and_disk_survives_a_restart(fake_tts, monkeypatch, tmp_path):
    first = await synthesize_speech("Nf3 develops.", "en-GB-SoniaNeural")
    second = await synthesize_speech("Nf3 develops.", "en-GB-SoniaNeural")
    assert first == second == b"ID3-mp3"
    assert len(fake_tts.calls) == 1

    key = cache_key("en-GB-SoniaNeural", "Knight to f3 develops.", DEFAULT_RATE)
    assert (tmp_path / "tts" / f"{key}.mp3").read_bytes() == b"ID3-mp3"
    stored = json.loads((tmp_path / "tts" / f"{key}.json").read_text())
    assert stored["spoken_text"] == "Knight to f3 develops."
    assert stored["voice"] == "en-GB-SoniaNeural"
    assert stored["words"][2] == {"text": "f3", "start_ms": 400, "end_ms": 700}

    # A fresh process: empty memory, same directory. The clip comes off disk.
    monkeypatch.setattr(study_tts, "_cache", SpeechCache(tmp_path / "tts"))
    assert await synthesize_speech("Nf3 develops.", "en-GB-SoniaNeural") == b"ID3-mp3"
    assert len(fake_tts.calls) == 1
    assert study_tts._cache.get_memory(key).audio == b"ID3-mp3"


@pytest.mark.asyncio
async def test_a_clip_without_its_timings_or_from_an_old_format_is_made_again(fake_tts, tmp_path):
    key = cache_key(VOICE, "Knight to f3")
    directory = tmp_path / "tts"
    directory.mkdir()
    (directory / f"{key}.mp3").write_bytes(b"old")
    assert await synthesize_speech("Nf3") == b"ID3-mp3"
    assert len(fake_tts.calls) == 1

    study_tts._cache._memory.clear()
    (directory / f"{key}.json").write_text(json.dumps({"format": "clip-v1", "words": []}))
    assert await synthesize_speech("Nf3") == b"ID3-mp3"
    assert len(fake_tts.calls) == 2


@pytest.mark.asyncio
async def test_narration_and_plain_audio_share_one_clip_across_sides(fake_tts):
    white = await narrate("Nf3", side="white")
    black = await narrate("Nf3", side="black")
    audio = await synthesize_speech("Nf3")
    assert len(fake_tts.calls) == 1
    assert white["audio"] == black["audio"] == audio == b"ID3-mp3"
    assert white["spoken_text"] == "Knight to f3"
    assert white["cues"] == [cue(300, 1250, ["f3"], "gold")]


@pytest.mark.asyncio
async def test_another_voice_is_another_clip(fake_tts):
    await synthesize_speech("Nf3", "en-US-AvaNeural")
    await synthesize_speech("Nf3", "en-US-EmmaMultilingualNeural")
    assert [voice for _, voice in fake_tts.calls] == ["en-US-AvaNeural", "en-US-EmmaMultilingualNeural"]


@pytest.mark.asyncio
async def test_simultaneous_requests_share_one_upstream_call(fake_tts):
    fake_tts.gate = asyncio.Event()
    waiting = [asyncio.create_task(synthesize_speech("Bxc6+ wins.")) for _ in range(5)]
    await asyncio.sleep(0.01)
    fake_tts.gate.set()
    results = await asyncio.gather(*waiting)
    assert results == [b"ID3-mp3"] * 5
    assert len(fake_tts.calls) == 1
    assert study_tts._cache._inflight == {}


@pytest.mark.asyncio
async def test_one_caller_leaving_does_not_cancel_the_clip_for_the_rest(fake_tts):
    fake_tts.gate = asyncio.Event()
    leaving = asyncio.create_task(synthesize_speech("Qh7#"))
    staying = asyncio.create_task(synthesize_speech("Qh7#"))
    await asyncio.sleep(0.01)
    leaving.cancel()
    fake_tts.gate.set()
    assert await staying == b"ID3-mp3"
    assert len(fake_tts.calls) == 1


def test_memory_lru_is_bounded_by_count_and_bytes(tmp_path):
    def clip(data: bytes) -> SpeechClip:
        return SpeechClip(audio=data)

    cache = SpeechCache(tmp_path, max_clips=2, max_bytes=10)
    cache.put_memory("a", clip(b"1111"))
    cache.put_memory("b", clip(b"2222"))
    assert cache.get_memory("a").audio == b"1111"  # "a" is now most recent
    cache.put_memory("c", clip(b"3333"))
    assert cache.get_memory("b") is None
    assert cache.get_memory("a").audio == b"1111"
    assert cache.get_memory("a").audio == b"1111"  # order now: c, a
    cache.put_memory("d", clip(b"444444"))  # three clips: the oldest, "c", goes; a + d = 10 bytes
    assert cache.get_memory("c") is None
    assert cache.get_memory("a").audio == b"1111"
    cache.put_memory("e", clip(b"55"))  # 4 + 6 + 2 = 12 bytes and three clips: "d" is oldest
    assert cache.get_memory("d") is None
    assert cache._memory_bytes <= 10
    cache.put_memory("huge", clip(b"x" * 11))  # larger than the whole budget: not kept
    assert cache.get_memory("huge") is None


@pytest.mark.asyncio
async def test_an_unwritable_disk_still_returns_audio(fake_tts, monkeypatch, tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("file")
    monkeypatch.setattr(study_tts, "_cache", SpeechCache(blocker / "tts"))
    assert await synthesize_speech("Nf3") == b"ID3-mp3"
    assert await synthesize_speech("Nf3") == b"ID3-mp3"
    assert len(fake_tts.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("text", "voice", "status"),
    [
        ("", "en-US-AvaNeural", 400),
        ("   ", "en-US-AvaNeural", 400),
        ("a" * 1201, "en-US-AvaNeural", 400),
        ("Nf3", "en-US-GuyNeural", 400),
    ],
)
async def test_service_rejects_bad_input(fake_tts, text, voice, status):
    with pytest.raises(HTTPException) as caught:
        await synthesize_speech(text, voice)
    assert caught.value.status_code == status
    assert fake_tts.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["error", "empty", "timeout"])
async def test_upstream_failure_is_503_and_not_cached(fake_tts, monkeypatch, failure):
    if failure == "error":
        fake_tts.error = ConnectionError("network down")
    elif failure == "empty":
        fake_tts.chunks = [{"type": "WordBoundary", "offset": 0, "duration": 1, "text": "Knight"}]
    else:
        fake_tts.gate = asyncio.Event()  # never set
        monkeypatch.setattr(study_tts, "SYNTHESIS_TIMEOUT_SECONDS", 0.05)
    with pytest.raises(HTTPException) as caught:
        await synthesize_speech("Nf3")
    assert caught.value.status_code == 503
    assert caught.value.detail == "Speech synthesis is temporarily unavailable."
    assert study_tts._cache._memory == {}
    assert study_tts._cache._inflight == {}

    # Recovery: the next request tries upstream again rather than replaying the failure.
    fake_tts.error = None
    fake_tts.gate = None
    fake_tts.chunks = [{"type": "audio", "data": b"ok"}]
    monkeypatch.setattr(study_tts, "SYNTHESIS_TIMEOUT_SECONDS", 15.0)
    assert await synthesize_speech("Nf3") == b"ok"


@pytest_asyncio.fixture
async def tts_api(fake_tts):
    app = FastAPI()
    app.include_router(router, prefix="/api/study")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_route_returns_cacheable_mpeg(tts_api, fake_tts):
    response = await tts_api.post("/api/study/tts", json={"text": "  1.e4 e5 2.Nf3  "})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "public, max-age=86400"
    assert response.content == b"ID3-mp3"
    assert fake_tts.calls == [("e4 e5 Knight to f3", VOICE)]


@pytest.mark.asyncio
async def test_route_accepts_a_whitelisted_voice(tts_api, fake_tts):
    response = await tts_api.post("/api/study/tts", json={"text": "O-O", "voice": "en-US-JennyNeural"})
    assert response.status_code == 200
    assert fake_tts.calls == [("castles kingside", "en-US-JennyNeural")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"text": ""},
        {"text": "    "},
        {"text": "a" * 1201},
        {"text": "Nf3", "voice": "en-US-GuyNeural"},
        {"text": "Nf3", "voice": "../../etc/passwd"},
        {"text": "Nf3", "side": "red"},
        {},
    ],
)
@pytest.mark.parametrize("path", ["/api/study/tts", "/api/study/tts/narrate"])
async def test_route_rejects_bad_requests(tts_api, fake_tts, body, path):
    response = await tts_api.post(path, json=body)
    assert response.status_code == 422
    assert fake_tts.calls == []


@pytest.mark.asyncio
async def test_route_reports_upstream_failure_as_503(tts_api, fake_tts):
    fake_tts.error = RuntimeError("upstream refused")
    response = await tts_api.post("/api/study/tts", json={"text": "Nf3"})
    assert response.status_code == 503
    assert response.json() == {"detail": "Speech synthesis is temporarily unavailable."}


@pytest.mark.asyncio
async def test_narrate_route_returns_audio_and_timed_cues(tts_api, fake_tts, tmp_path):
    response = await tts_api.post("/api/study/tts/narrate", json={"text": " 2.Nf3 ", "side": "white"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=86400"
    body = response.json()
    assert base64.b64decode(body["audio_base64"]) == b"ID3-mp3"
    assert body["mime_type"] == "audio/mpeg"
    assert body["voice"] == VOICE
    assert body["spoken_text"] == "Knight to f3"
    assert body["cues"] == [cue(300, 1250, ["f3"], "gold")]

    # Both halves are cached: in memory, and as an .mp3 plus .json pair on disk.
    key = cache_key(VOICE, "Knight to f3")
    assert study_tts._cache.get_memory(key).words[2].text == "f3"
    assert (tmp_path / "tts" / f"{key}.mp3").read_bytes() == b"ID3-mp3"
    assert json.loads((tmp_path / "tts" / f"{key}.json").read_text())["words"][0]["text"] == "Knight"

    again = await tts_api.post("/api/study/tts/narrate", json={"text": "2.Nf3", "side": "white"})
    plain = await tts_api.post("/api/study/tts", json={"text": "2.Nf3"})
    assert again.json() == body
    assert plain.content == b"ID3-mp3"
    assert len(fake_tts.calls) == 1


@pytest.mark.asyncio
async def test_narrate_route_reports_upstream_failure_as_503(tts_api, fake_tts):
    fake_tts.error = RuntimeError("upstream refused")
    response = await tts_api.post("/api/study/tts/narrate", json={"text": "Nf3"})
    assert response.status_code == 503


def test_playbook_speech_matches_the_frontend_listen_text():
    class Playbook:
        title = "Rook Endings"
        summary = "Activity first."
        core_ideas = ("Cut the king off", "Rook behind the passer!")

    assert playbook_speech(Playbook) == (
        "Rook Endings. Activity first. Core ideas. Cut the king off. Rook behind the passer!"
    )


def test_course_line_speech_matches_what_the_trainer_reads():
    line = {
        "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
        "moves": [
            {"fen": "x w", "san": "e4", "side": "opponent", "comment": "Center."},
            {"fen": "x b", "san": "e5", "side": "you", "comment": "Match it."},
            {"fen": "x w", "san": "Nf3", "side": "opponent", "comment": None},
            {"fen": "x b", "san": "Nc6", "side": "you", "comment": None},
        ],
    }
    assert course_line_speech(line) == [
        "1. e4. Center.",
        "1... e5. Match it.",
        "1... e5. Match it.",
        "1. e4. Center. 1... e5. Match it.",
        "2... Nc6.",
    ]


def test_prewarm_texts_cover_playbooks_and_course_moves_once_each():
    texts = prewarm_texts()
    assert len(texts) == len(set(texts))
    assert all(0 < len(text) <= 1200 for text in texts)
    assert any(text.startswith("4... Nxd4. Know the escape route") for text in texts)


@pytest.mark.asyncio
async def test_prewarm_skips_clips_on_disk_and_writes_the_rest_to_disk_only(fake_tts, tmp_path):
    await synthesize_speech("Nf3")
    study_tts._cache._memory.clear()

    stats = await prewarm_study_tts(texts=["Nf3", "Bc4", "O-O", "a" * 1300], pause_seconds=0)
    assert stats == {"total": 4, "cached": 1, "synthesized": 2, "failed": 1, "stopped": False}
    assert [text for text, _ in fake_tts.calls] == ["Knight to f3", "Bishop to c4", "castles kingside"]
    assert study_tts._cache._memory == {}  # listeners' memory is left alone
    assert study_tts._cache.on_disk(cache_key(VOICE, "castles kingside"))

    again = await prewarm_study_tts(texts=["Nf3", "Bc4", "O-O"], pause_seconds=0)
    assert again["cached"] == 3
    assert len(fake_tts.calls) == 3


@pytest.mark.asyncio
async def test_prewarm_swallows_failures_and_gives_up_on_an_outage(fake_tts):
    fake_tts.error = ConnectionError("network down")
    texts = [f"Move {square}" for square in ("a3", "b3", "c3", "d3", "e3", "f3", "g3", "h3")]
    stats = await prewarm_study_tts(texts=texts, concurrency=1, pause_seconds=0)
    assert stats["failed"] == 5
    assert stats["synthesized"] == 0
    assert stats["stopped"] is True
    assert len(fake_tts.calls) == 5


@pytest.mark.asyncio
async def test_prewarm_stops_when_asked(fake_tts):
    stop = asyncio.Event()
    stop.set()
    stats = await prewarm_study_tts(stop, texts=["Nf3", "Bc4"], pause_seconds=0)
    assert stats["synthesized"] == 0
    assert stats["stopped"] is True
    assert fake_tts.calls == []
