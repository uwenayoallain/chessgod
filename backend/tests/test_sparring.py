"""Games against the engine: history, and their mistakes as drills."""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.position import Position
from app.models.sparring import SparringMistake
from app.routers import sparring
from app.schemas.improvement import DrillAttemptIn
from app.schemas.sparring import SparringGameIn, SparringMistakeIn, SparringMistakesIn
from app.services.improvement import build_improvement_plan, record_drill_attempt

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
# After 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4?: White to move, Nxe5 wins a pawn.
AFTER_ND4 = "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq -"


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        yield db
    await engine.dispose()


def game(**overrides) -> SparringGameIn:
    return SparringGameIn(**{
        "username": "saint", "user_color": "white", "engine_rating": 1669, "rated": True,
        "result": "loss", "reason": "resignation", "start_fen": START,
        "moves_uci": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "c6d4"], **overrides,
    })


def mistake(**overrides) -> SparringMistakeIn:
    return SparringMistakeIn(**{
        "fen": AFTER_ND4, "ply": 7, "user_move_uci": "e1g1", "user_move_san": "O-O",
        "best_move_uci": "f3e5", "best_pv_uci": "f3e5 d8g5", "reply_pv_uci": "d4f3",
        "previous_move_uci": "c6d4", "parent_eval_cp": 150, "eval_drop_cp": 180, "depth": 18,
        **overrides,
    })


@pytest.mark.asyncio
async def test_a_game_with_an_illegal_move_is_refused(session):
    with pytest.raises(HTTPException) as refused:
        await sparring.save_game(game(moves_uci=["e2e5"]), session=session)
    assert refused.value.status_code == 422


@pytest.mark.asyncio
async def test_history_counts_results_and_the_rated_walk(session):
    await sparring.save_game(game(result="loss", engine_rating=1669), session=session)
    await sparring.save_game(game(result="win", engine_rating=1629), session=session)
    await sparring.save_game(game(result="draw", engine_rating=1669, rated=False), session=session)
    history = await sparring.history(username="Saint", limit=20, session=session)
    assert (history.summary.played, history.summary.wins, history.summary.draws, history.summary.losses) == (3, 1, 1, 1)
    assert (history.summary.rated_played, history.summary.first_rating, history.summary.latest_rating) == (2, 1669, 1629)
    assert history.games[0].moves == 6


@pytest.mark.asyncio
async def test_posting_a_review_twice_replaces_its_mistakes(session):
    created = await sparring.save_game(game(), session=session)
    for _ in range(2):
        await sparring.save_mistakes(
            created.id, SparringMistakesIn(mistakes=[mistake()]), session=session
        )
    assert await session.scalar(select(func.count()).select_from(SparringMistake)) == 1
    # The position is created for drilling if the library never had it.
    assert await session.scalar(select(Position.id).where(Position.fen == AFTER_ND4)) is not None


@pytest.mark.asyncio
async def test_a_mistake_needs_legal_moves(session):
    created = await sparring.save_game(game(), session=session)
    with pytest.raises(HTTPException):
        await sparring.save_mistakes(
            created.id, SparringMistakesIn(mistakes=[mistake(best_move_uci="a1a8")]), session=session
        )


@pytest.mark.asyncio
async def test_a_reviewed_mistake_becomes_a_drill_that_can_be_answered(session):
    created = await sparring.save_game(game(), session=session)
    await sparring.save_mistakes(created.id, SparringMistakesIn(mistakes=[mistake()]), session=session)
    # The review searched a position nobody imported, so the mistake carries
    # its own line: the drill is answerable straight away, graded against it.
    rows = (await session.execute(select(AnalysisResult))).scalars().all()
    assert [(row.depth, row.best_move_uci, row.best_move_san, row.eval_cp) for row in rows] == [
        (18, "f3e5", "Nxe5", 150)
    ]
    plan = await build_improvement_plan(session, username="saint")
    cards = [card for card in plan.drills if card.time_class == "engine"]
    assert len(cards) == 1
    card = cards[0]
    assert (card.best_move_uci, card.user_move_san, card.previous_move_uci) == ("f3e5", "O-O", "c6d4")

    result = await record_drill_attempt(session, DrillAttemptIn(
        username="saint", position_id=card.position_id, expected_move_uci=card.best_move_uci,
        played_move_uci="f3e5", pattern_key=card.pattern_key,
    ))
    assert result.correct


@pytest.mark.asyncio
async def test_a_mistake_whose_line_does_not_play_is_refused(session):
    created = await sparring.save_game(game(), session=session)
    with pytest.raises(HTTPException) as refused:
        await sparring.save_mistakes(
            created.id,
            SparringMistakesIn(mistakes=[mistake(best_pv_uci="f3e5 e1e8")]),
            session=session,
        )
    assert refused.value.status_code == 422
    assert await session.scalar(select(func.count()).select_from(AnalysisResult)) == 0


@pytest.mark.asyncio
async def test_a_boss_fight_pays_on_top_of_the_game(session):
    plain = await sparring.save_game(game(result="win"), session=session)
    boss_won = await sparring.save_game(game(result="win", origin="boss:scotch"), session=session)
    boss_held = await sparring.save_game(game(result="draw", origin="boss:scotch"), session=session)
    boss_lost = await sparring.save_game(game(result="loss", origin="boss:scotch"), session=session)
    assert plain.xp_gained == 15
    assert boss_won.xp_gained == 15 + 30
    assert boss_held.xp_gained == 15 + 30
    assert boss_lost.xp_gained == 15 + 5


def test_an_origin_must_look_like_one():
    with pytest.raises(ValueError):
        game(origin="boss scotch; drop table")
