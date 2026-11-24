"""Tests for annotated course imports and shared spaced-repetition progress."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
import importlib.util
import json
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
import chess
import chess.pgn
import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from sqlalchemy import create_engine, func, inspect, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import get_db
from app.models.base import Base
from app.models.study_course import StudyChapter, StudyCourse
from app.models.training import LineMoveProgress, TrainingEvent
from app.routers.study import router
from app.services import study_courses, training
from app.services.study_courses import (
    BUILTIN_COURSE_PRESETS,
    MAX_CHAPTERS,
    MAX_LINES,
    MAX_PLIES,
    fetch_lichess_study_pgn,
    lichess_study_id,
    parse_pgn_chapters,
)
from app.services.training import LEVEL_INTERVALS
from app.utils.fen import normalize_fen

START = normalize_fen(chess.STARTING_FEN)
REVIEW_PGN = """
[Event "Open games"]

1. e4 e5 2. Nf3 Nc6 (2... Nf6 3. Nxe5) *
"""
ANNOTATED_PGN = """
[Event "Empty game"]

*

[Event "Sicilian example"]
[SetUp "1"]
[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]
[Orientation "Black"]

{Opening lesson.} 1... c5 {Fight for d4. [%cal Gc7c5,Rc5d4,Bg8f6,Yb8c6,Xa1a8] [%csl Gd4,Rf5,Be4,Ye5] [%clk 0:05:00] [%eval 0.2]}
(1... e5 2. Nf3 Nc6 (2... Nf6 {Counterattack e4. [%cal Gf6e4]}))
2. Nf3 d6 {[%clk 0:04:55]} *

[Event "Second chapter"]
[Orientation "White"]

1. d4 d5 *
"""


@pytest.mark.parametrize("preset_id", BUILTIN_COURSE_PRESETS)
def test_builtin_presets_have_legal_annotated_main_lines_and_variations(preset_id):
    preset = BUILTIN_COURSE_PRESETS[preset_id]
    chapters = parse_pgn_chapters(preset["pgn"])
    assert len(chapters) == preset["chapter_count"]
    assert all(chapter["color"] == preset["color"] for chapter in chapters)
    for chapter in chapters:
        assert len(chapter["lines"]) >= 2
        assert chapter["lines"][0]["title"] == "Main line"
        assert any(
            move["comment"] and move["arrows"]
            for line in chapter["lines"] for move in line["moves"]
        )
        for line in chapter["lines"]:
            board = chess.Board(f'{line["start_fen"]} 0 1')
            assert board.is_valid()
            for ply, move in enumerate(line["moves"], 1):
                assert move["ply"] == ply
                assert move["fen"] == normalize_fen(board.fen())
                assert move["side"] == ("you" if board.turn == (preset["color"] == "white") else "opponent")
                legal_move = board.parse_uci(move["uci"])
                assert move["san"] == board.san(legal_move)
                board.push(legal_move)


def test_annotated_pgn_has_custom_start_and_nested_variations():
    chapters = parse_pgn_chapters(ANNOTATED_PGN)
    assert [chapter["title"] for chapter in chapters] == ["Sicilian example", "Second chapter"]
    assert chapters[0]["start_fen"] == "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
    main, alternative, nested = chapters[0]["lines"]
    assert [main["id"], alternative["id"], nested["id"]] == ["ch1-l1", "ch1-l2", "ch1-l3"]
    assert [line["title"] for line in (main, alternative, nested)] == [
        "Main line", "Variation: 1...e5", "Variation: 2...Nf6",
    ]
    assert [move["san"] for move in main["moves"]] == ["c5", "Nf3", "d6"]
    assert [move["san"] for move in alternative["moves"]] == ["e5", "Nf3", "Nc6"]
    assert [move["san"] for move in nested["moves"]] == ["e5", "Nf3", "Nf6"]
    assert main["moves"][0] == {
        "ply": 1,
        "fen": chapters[0]["start_fen"],
        "san": "c5",
        "uci": "c7c5",
        "side": "you",
        "comment": "Opening lesson. Fight for d4.",
        "arrows": [
            {"from": "c7", "to": "c5", "color": "green"},
            {"from": "c5", "to": "d4", "color": "red"},
            {"from": "g8", "to": "f6", "color": "blue"},
            {"from": "b8", "to": "c6", "color": "yellow"},
        ],
        "highlights": [
            {"square": "d4", "color": "green"},
            {"square": "f5", "color": "red"},
            {"square": "e4", "color": "blue"},
            {"square": "e5", "color": "yellow"},
        ],
    }
    assert main["moves"][1]["side"] == "opponent"
    assert main["moves"][2]["comment"] is None
    assert "[%cal" in chapters[0]["pgn"]
    # Course orientation was decided by the first playable chapter.
    assert chapters[1]["lines"][0]["moves"][0]["side"] == "opponent"
    assert parse_pgn_chapters(ANNOTATED_PGN, "white")[0]["lines"][0]["moves"][0]["side"] == "opponent"
    assert parse_pgn_chapters(REVIEW_PGN)[0]["color"] == "white"


def test_pgn_caps_chapters_lines_and_plies():
    game = chess.pgn.Game()
    board = game.board()
    for move in board.legal_moves:
        node = game.add_variation(move)
        for reply in list(node.board().legal_moves)[:3]:
            node.add_variation(reply)
    games = "\n\n".join([str(game)] + ["1. e4 e5 *"] * MAX_CHAPTERS)
    chapters = parse_pgn_chapters(games)
    assert len(chapters) == MAX_CHAPTERS
    assert len(chapters[0]["lines"]) == MAX_LINES
    assert len({line["id"] for line in chapters[0]["lines"]}) == MAX_LINES

    long_game = " ".join(f"{n}. Nf3 Nf6 {n + 1}. Ng1 Ng8" for n in range(1, 40, 2))
    chapter = parse_pgn_chapters(f"{long_game} *")[0]
    assert len(chapter["lines"][0]["moves"]) == MAX_PLIES
    assert chapter["lines"][0]["moves"][-1]["ply"] == MAX_PLIES


@pytest.mark.parametrize("source", [
    "1. e4 e5 2. Bh6 *",
    '1. e4 -- *',
    '[SetUp "1"]\n[FEN "bad"]\n\n1. e4 *',
    '[SetUp "1"]\n[FEN "8/8/8/8/8/8/P7/7k w - - 0 1"]\n\n1. a3 *',
])
def test_invalid_pgn_is_rejected(source):
    with pytest.raises(HTTPException) as error:
        parse_pgn_chapters(source)
    assert error.value.status_code == 400


@pytest.mark.parametrize("value", [
    "a1b2C3D4",
    "https://lichess.org/study/a1b2C3D4",
    "https://lichess.org/study/a1b2C3D4/01234567",
])
def test_lichess_study_id(value):
    assert lichess_study_id(value) == "a1b2C3D4"


@pytest.mark.parametrize("value", [
    "http://lichess.org/study/a1b2C3D4",
    "https://localhost/study/a1b2C3D4",
    "https://127.0.0.1/study/a1b2C3D4",
    "https://lichess.org@127.0.0.1/study/a1b2C3D4",
    "https://lichess.org.example/study/a1b2C3D4",
    "https://lichess.org:8443/study/a1b2C3D4",
    "https://lichess.org/study/a1b2C3D4/../../about",
    "https://lichess.org/study/a1b2C3D4?next=https://localhost/",
    "https://lichess.org/study/a1b2C3D4#2",
    "https://lichess.org/study/%61%31b2C3D4",
    "abcdefghX",
    "àbcdefgh",
    "",
])
def test_invalid_lichess_study_url(value):
    with pytest.raises(HTTPException) as error:
        lichess_study_id(value)
    assert error.value.status_code == 400


def mock_lichess(monkeypatch, handler):
    client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(study_courses.httpx, "AsyncClient", lambda **kwargs: client(transport=transport, **kwargs))


@pytest.mark.asyncio
async def test_fetch_lichess_study_pgn(monkeypatch):
    def handle(request):
        assert request.method == "GET"
        assert str(request.url) == (
            "https://lichess.org/api/study/a1b2C3D4.pgn"
            "?comments=true&variations=true&clocks=false&orientation=true"
        )
        assert request.headers["User-Agent"] == "ChessGod/1.0"
        return httpx.Response(200, text=ANNOTATED_PGN)

    mock_lichess(monkeypatch, handle)
    assert await fetch_lichess_study_pgn("https://lichess.org/study/a1b2C3D4/01234567") == ANNOTATED_PGN


@pytest.mark.asyncio
@pytest.mark.parametrize(("upstream", "status", "detail"), [
    (403, 404, "private"),
    (404, 404, "private"),
    (429, 502, "rate limiting"),
    (301, 502, "Could not download"),
    (500, 502, "Could not download"),
    (None, 502, "Could not download"),
])
async def test_lichess_fetch_errors(monkeypatch, upstream, status, detail):
    requests = []

    def handle(request):
        requests.append(request)
        if upstream is None:
            raise httpx.ConnectError("unreachable", request=request)
        return httpx.Response(upstream, headers={"Location": "http://127.0.0.1/"})

    mock_lichess(monkeypatch, handle)
    with pytest.raises(HTTPException, match=detail) as error:
        await fetch_lichess_study_pgn("a1b2C3D4")
    assert error.value.status_code == status
    assert len(requests) == 1


def test_study_migration_runs_on_sqlite(monkeypatch):
    path = Path(__file__).resolve().parents[1] / "alembic/versions/027_study_courses.py"
    spec = importlib.util.spec_from_file_location("study_courses_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.down_revision == "026_drop_unused_indexes"

    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys=ON"))
            monkeypatch.setattr(migration, "op", Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            course_id = connection.execute(StudyCourse.__table__.insert().values(
                username="ChessFan", title="Test course", color="white", source_type="pgn",
            )).inserted_primary_key[0]
            assert course_id == 1
            chapter_id = connection.execute(StudyChapter.__table__.insert().values(
                course_id=course_id, position=1, title="Test chapter", start_fen=START,
                pgn=REVIEW_PGN, lines_json=[{"id": "ch1-l1"}],
            )).inserted_primary_key[0]
            assert chapter_id == 1
            assert connection.scalar(
                select(StudyCourse.id).where(StudyCourse.username == "CHESSFAN")
            ) == course_id
            assert connection.scalar(select(StudyChapter.lines_json)) == [{"id": "ch1-l1"}]
            connection.execute(StudyCourse.__table__.delete())
            assert connection.scalar(select(func.count()).select_from(StudyChapter)) == 0
            migration.downgrade()
            assert inspect(connection).get_table_names() == []
    finally:
        engine.dispose()


@pytest_asyncio.fixture
async def course_api():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        app = FastAPI()
        app.include_router(router, prefix="/api/study")

        async def override_db():
            async with sessions() as session:
                yield session

        app.dependency_overrides[get_db] = override_db
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            yield client, sessions
    finally:
        await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize(("playbook_id", "preset_id", "line_counts"), [
    ("quiet_moves_planning", "middlegame_mastery_white", (3, 3, 3, 4)),
    ("endgame_technique", "defense_endgame_mastery_white", (2, 2, 3)),
])
async def test_mastery_presets_launch_from_playbook_links(course_api, playbook_id, preset_id, line_counts):
    client, _ = course_api
    playbooks = (await client.get("/api/study/playbooks")).json()["playbooks"]
    playbook = next(item for item in playbooks if item["id"] == playbook_id)
    assert playbook["course_preset_id"] == preset_id

    result = await client.post("/api/study/courses/import", json={
        "username": "ChessFan", "preset_id": playbook["course_preset_id"],
    })
    assert result.status_code == 201
    course = result.json()
    assert (course["color"], course["source_type"], course["source_ref"]) == ("white", "builtin", preset_id)
    assert tuple(len(chapter["lines"]) for chapter in course["chapters"]) == line_counts
    for chapter in course["chapters"]:
        assert chapter["start_fen"] != START
        for line in chapter["lines"]:
            for move in line["moves"]:
                assert move["comment"] and move["arrows"] and move["highlights"]


@pytest.mark.asyncio
async def test_course_import_list_detail_and_delete(course_api, monkeypatch):
    client, sessions = course_api
    base = "/api/study/courses"
    response = await client.get(base, params={"username": "ChessFan"})
    assert response.status_code == 200
    assert response.json()["courses"] == []
    presets = response.json()["presets"]
    assert {preset["id"] for preset in presets} == set(BUILTIN_COURSE_PRESETS)
    assert all("pgn" not in preset and preset["tags"] for preset in presets)

    result = await client.post(f"{base}/import", json={
        "username": "ChessFan", "pgn": REVIEW_PGN, "title": "White openings",
    })
    assert result.status_code == 201
    pgn = result.json()
    assert (pgn["title"], pgn["color"], pgn["source_type"], pgn["source_ref"]) == (
        "White openings", "white", "pgn", None,
    )
    assert (pgn["chapter_count"], pgn["line_count"], pgn["your_moves"]) == (1, 2, 5)

    result = await client.post(f"{base}/import", json={
        "username": "ChessFan", "preset_id": "qgd_vs_d4_black",
    })
    assert result.status_code == 201
    builtin = result.json()
    assert (builtin["title"], builtin["color"], builtin["source_type"], builtin["source_ref"]) == (
        "Classical QGD & Anti-London System", "black", "builtin", "qgd_vs_d4_black",
    )
    assert builtin["chapter_count"] == 3
    assert builtin["description"]

    async def fetch(study_id):
        assert study_id == "a1b2C3D4"
        return ANNOTATED_PGN.replace(
            '[Event "Sicilian example"]',
            '[Event "My Study: Sicilian example"]\n[Site "https://lichess.org/study/a1b2C3D4/01234567"]',
        )

    monkeypatch.setattr(study_courses, "fetch_lichess_study_pgn", fetch)
    result = await client.post(f"{base}/import", json={
        "username": "ChessFan", "lichess_url": "https://lichess.org/study/a1b2C3D4/01234567",
    })
    assert result.status_code == 201
    lichess = result.json()
    assert (lichess["title"], lichess["color"], lichess["source_type"], lichess["source_ref"]) == (
        "My Study", "black", "lichess", "https://lichess.org/study/a1b2C3D4",
    )
    assert lichess["chapters"][0]["title"] == "Sicilian example"

    library = (await client.get(base, params={"username": "CHESSFAN"})).json()["courses"]
    assert [course["id"] for course in library] == [lichess["id"], builtin["id"], pgn["id"]]
    assert all("chapters" not in summary for summary in library)
    assert all(summary["known_moves"] == summary["due_moves"] == 0 for summary in library)
    item = f"{base}/{pgn['id']}"
    assert (await client.get(item, params={"username": "CHESSFAN"})).json() == pgn
    assert (await client.get(item, params={"username": "other"})).status_code == 404
    assert (await client.delete(item, params={"username": "other"})).status_code == 404
    deleted = await client.delete(item, params={"username": "CHESSFAN"})
    assert deleted.json() == {"deleted": True, "id": pgn["id"]}
    assert (await client.get(item, params={"username": "ChessFan"})).status_code == 404
    async with sessions() as session:
        assert await session.scalar(select(StudyChapter.id).where(StudyChapter.course_id == pgn["id"])) is None
    assert (await client.get("/api/study/playbooks")).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(("sources", "status"), [
    ({}, 422),
    ({"lichess_url": "a1b2C3D4", "pgn": REVIEW_PGN}, 422),
    ({"lichess_url": "https://localhost/study/a1b2C3D4"}, 400),
    ({"pgn": '[Event "Empty"]\n\n*'}, 400),
    ({"preset_id": "missing"}, 404),
])
async def test_course_import_validation(course_api, sources, status):
    client, _ = course_api
    response = await client.post("/api/study/courses/import", json={"username": "ChessFan", **sources})
    assert response.status_code == status
    assert (await client.get("/api/study/courses", params={"username": "ChessFan"})).json()["courses"] == []


@pytest.mark.asyncio
async def test_review_progression_idempotency_validation_and_shared_memory(course_api):
    client, sessions = course_api
    base = "/api/study/courses"
    params = {"username": "CHESSFAN"}
    source = {"username": "ChessFan", "pgn": REVIEW_PGN}
    course = (await client.post(f"{base}/import", json=source)).json()
    other_course = (await client.post(f"{base}/import", json={**source, "pgn": "1. e4 e5 2. Bc4 *"})).json()
    item = f"{base}/{course['id']}"
    review = f"{item}/review"
    line = course["chapters"][0]["lines"][0]
    assert line["status"] == "new"
    assert not line["moves"][0]["seen"]
    assert line["moves"][0]["next_review_at"] is None
    answers = [
        {"fen": step["fen"], "expected_uci": step["uci"], "played_uci": step["uci"], "hinted": False}
        for step in line["moves"] if step["side"] == "you"
    ]
    payload = {"username": "ChessFan", "line_id": line["id"], "mode": "practice", "moves": answers}

    assert (await client.post(review, json={**payload, "username": "other"})).status_code == 404
    assert (await client.post(review, json={**payload, "line_id": "ch2-l1"})).status_code == 404
    assert (await client.post(review, json={
        **payload, "moves": [answers[0], {**answers[1], "expected_uci": "f1c4"}],
    })).status_code == 400
    assert (await client.post(review, json={**payload, "moves": [answers[0], answers[0]]})).status_code == 400
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(LineMoveProgress)) == 0

    first = await client.post(review, json={**payload, "request_id": "first"})
    assert first.status_code == 200
    first_body = first.json()
    reward = first_body.pop("reward")
    assert first_body == {
        "line_id": line["id"], "recalled": 2, "missed": 0, "total": 2,
        "known_moves": 2, "due_moves": 0, "status": "learning", "xp_gained": 16,
    }
    assert reward["xp_gained"] == 16 and reward["profile"]["xp"] == 16
    retry = await client.post(review, json={**payload, "username": "CHESSFAN", "request_id": "first"})
    assert retry.json() == first.json()
    mismatch = await client.post(review, json={**payload, "mode": "learn", "request_id": "first"})
    assert mismatch.status_code == 409

    async def state(url=item):
        response = await client.get(url, params=params)
        assert response.status_code == 200
        return response.json()["chapters"][0]["lines"][0]

    initial = await state()
    assert initial["moves"][0]["level"] == 1
    assert initial["moves"][0]["seen"]
    assert not initial["moves"][0]["due"]
    shared = await state(f"{base}/{other_course['id']}")
    assert shared["known_moves"] == 1
    assert shared["status"] == "new"
    assert shared["moves"][0]["next_review_at"] == initial["moves"][0]["next_review_at"]
    async with sessions() as session:
        rows = (await session.scalars(select(LineMoveProgress))).all()
        assert len(rows) == 2 and all(row.reviews == row.recalls == 1 for row in rows)
        assert all(row.due_at - row.last_reviewed_at == LEVEL_INTERVALS[1] for row in rows)
        # The receipt, two recalled moves and the perfect-line bonus.
        assert await session.scalar(select(func.count()).select_from(TrainingEvent)) == 4

    early = await client.post(review, json=payload)
    assert early.status_code == 200
    assert (await state())["moves"][0]["next_review_at"] == initial["moves"][0]["next_review_at"]

    for level in (2, 3, 4):
        async with sessions() as session:
            await session.execute(update(LineMoveProgress).values(due_at=datetime.now(UTC) - timedelta(seconds=1)))
            await session.commit()
        assert (await state())["status"] == "due"
        library = (await client.get(base, params=params)).json()["courses"]
        assert next(summary for summary in library if summary["id"] == course["id"])["due_moves"] == 4
        response = await client.post(review, json=payload)
        assert response.status_code == 200
        assert response.json()["due_moves"] == 0
        current = await state()
        assert current["moves"][0]["level"] == level
        async with sessions() as session:
            rows = (await session.scalars(select(LineMoveProgress))).all()
            assert all(row.due_at - row.last_reviewed_at == LEVEL_INTERVALS[level] for row in rows)

    assert (await state())["status"] == "mastered"

    result = await client.post(review, json={
        **payload, "mode": "learn",
        "moves": [{**answers[0], "hinted": True}, {**answers[1], "played_uci": "f1c4"}],
    })
    assert result.status_code == 200
    assert result.json()["recalled"] == 0
    assert result.json()["missed"] == 2
    assert result.json()["status"] == "learning"
    async with sessions() as session:
        rows = (await session.scalars(select(LineMoveProgress))).all()
        assert all(row.level == 1 and row.lapses == 1 and row.reviews == 6 for row in rows)
        assert all(row.due_at - row.last_reviewed_at == LEVEL_INTERVALS[1] for row in rows)

    assert (await client.delete(item, params=params)).status_code == 200
    assert (await state(f"{base}/{other_course['id']}"))["known_moves"] == 1


async def _review_setup(client):
    course = (await client.post("/api/study/courses/import", json={
        "username": "ChessFan", "pgn": REVIEW_PGN,
    })).json()
    line = course["chapters"][0]["lines"][0]
    answers = [
        {"fen": step["fen"], "expected_uci": step["uci"], "played_uci": step["uci"], "hinted": False}
        for step in line["moves"] if step["side"] == "you"
    ]
    assert len(answers) == 2
    review = f"/api/study/courses/{course['id']}/review"
    payload = {"username": "ChessFan", "line_id": line["id"], "moves": answers}
    return course, review, payload, answers


async def _events(sessions) -> list[tuple[str, int]]:
    async with sessions() as session:
        rows = (await session.execute(
            select(TrainingEvent.kind, TrainingEvent.xp).order_by(TrainingEvent.id)
        )).all()
    return [(kind, xp) for kind, xp in rows]


@pytest.mark.asyncio
async def test_learning_a_lesson_pays_xp_once_with_a_training_reward(course_api):
    client, sessions = course_api
    _, review, payload, _ = await _review_setup(client)
    body = {**payload, "mode": "learn", "request_id": "learn-1", "tz": "Europe/Berlin", "daily_goal": 20}

    first = await client.post(review, json=body)
    assert first.status_code == 200
    result = first.json()
    assert result["xp_gained"] == 15
    reward = result["reward"]
    assert set(reward) == {"xp_gained", "leveled_up", "goal_just_met", "unlocked", "profile"}
    assert reward["xp_gained"] == 15
    assert reward["leveled_up"] is False and reward["goal_just_met"] is False
    assert [badge["key"] for badge in reward["unlocked"]] == ["first_line"]
    async with sessions() as session:
        # The same profile the training endpoints return, so `useApplyReward` reads it as is.
        assert reward["profile"] == json.loads(json.dumps(
            await training.profile(session, "ChessFan", tz="Europe/Berlin", goal=20)
        ))
    assert reward["profile"]["xp"] == reward["profile"]["today_xp"] == 15
    events = await _events(sessions)
    assert events == [("line_review_receipt", 0), ("line_learned", 15)]

    # A retry returns the stored outcome, reward included, and records nothing.
    retry = await client.post(review, json=body)
    assert retry.status_code == 200
    assert retry.json() == result
    assert await _events(sessions) == events

    # Learning the same line again is not a second lesson.
    again = await client.post(review, json={**body, "request_id": "learn-2"})
    assert again.json()["xp_gained"] == 0
    assert again.json()["reward"]["profile"]["xp"] == 15
    assert [kind for kind, _ in await _events(sessions)].count("line_learned") == 1


@pytest.mark.asyncio
async def test_practice_pays_recalls_misses_and_early_reviews_like_the_repertoire(course_api):
    client, sessions = course_api
    _, review, payload, answers = await _review_setup(client)
    practice = {**payload, "mode": "practice"}

    # One clean recall of a new move, one move played with the hint.
    mixed = await client.post(review, json={
        **practice, "moves": [answers[0], {**answers[1], "hinted": True}], "request_id": "mixed",
    })
    assert mixed.json()["xp_gained"] == 3 + 1
    assert (mixed.json()["recalled"], mixed.json()["missed"]) == (1, 1)
    assert sorted(await _events(sessions)) == sorted([
        ("line_review_receipt", 0), ("move_recalled", 3), ("move_missed", 1),
    ])
    async with sessions() as session:
        rows = {row.move_uci: row for row in (await session.scalars(select(LineMoveProgress))).all()}
    clean, hinted = rows[answers[0]["expected_uci"]], rows[answers[1]["expected_uci"]]
    assert (clean.level, clean.recalls, clean.lapses) == (1, 1, 0)
    assert (hinted.level, hinted.recalls, hinted.lapses) == (1, 0, 1)

    # Both due: two recalls climb a rung, and the clean pass earns the bonus.
    async with sessions() as session:
        await session.execute(update(LineMoveProgress).values(due_at=datetime.now(UTC) - timedelta(seconds=1)))
        await session.commit()
    due = await client.post(review, json={**practice, "request_id": "due"})
    assert due.json()["xp_gained"] == 3 + 3 + 10
    async with sessions() as session:
        levels = {row.move_uci: row.level for row in (await session.scalars(select(LineMoveProgress))).all()}
    assert set(levels.values()) == {2}

    # Played again at once: nothing is due, so each move pays the early rate and no bonus.
    early = await client.post(review, json={**practice, "request_id": "early"})
    assert early.json()["xp_gained"] == 1 + 1
    async with sessions() as session:
        rows = (await session.scalars(select(LineMoveProgress))).all()
    assert all(row.level == 2 for row in rows)

    # A miss in practice drops the move to the first rung and pays the miss rate.
    missed = await client.post(review, json={
        **practice, "moves": [answers[0], {**answers[1], "played_uci": "f1c4"}], "request_id": "miss",
    })
    assert missed.json()["xp_gained"] == 1 + 1
    async with sessions() as session:
        rows = {row.move_uci: row for row in (await session.scalars(select(LineMoveProgress))).all()}
    assert rows[answers[1]["expected_uci"]].level == 1
    assert rows[answers[0]["expected_uci"]].level == 2

    total = sum(xp for _, xp in await _events(sessions))
    assert total == 4 + 16 + 2 + 2
    assert missed.json()["reward"]["profile"]["xp"] == total


@pytest.mark.asyncio
async def test_lesson_xp_meets_the_daily_goal_and_starts_the_streak(course_api):
    client, _ = course_api
    _, review, payload, _ = await _review_setup(client)
    learned = await client.post(review, json={
        **payload, "mode": "learn", "request_id": "learn", "daily_goal": 20,
    })
    assert learned.json()["reward"]["goal_just_met"] is False
    assert learned.json()["reward"]["profile"]["streak"] == 0

    practised = await client.post(review, json={
        **payload, "mode": "practice", "request_id": "practise", "daily_goal": 20,
    })
    reward = practised.json()["reward"]
    assert reward["xp_gained"] == 2  # both moves were learned moments ago: early reviews
    assert reward["goal_just_met"] is False
    assert reward["profile"]["today_xp"] == 17

    # Without a request id a pass still pays: two more early passes cross the goal.
    again = await client.post(review, json={**payload, "mode": "practice", "daily_goal": 20})
    assert again.json()["reward"]["goal_just_met"] is False
    again = await client.post(review, json={**payload, "mode": "practice", "daily_goal": 20})
    reward = again.json()["reward"]
    assert reward["profile"]["today_xp"] == 21
    assert reward["goal_just_met"] is True
    assert reward["profile"]["goal_met_today"] is True
    assert reward["profile"]["streak"] == 1
    assert reward["profile"]["daily_goal"] == 20


@pytest.mark.asyncio
async def test_review_payload_rejects_an_out_of_range_daily_goal(course_api):
    client, _ = course_api
    _, review, payload, _ = await _review_setup(client)
    response = await client.post(review, json={**payload, "mode": "learn", "daily_goal": 5})
    assert response.status_code == 422
