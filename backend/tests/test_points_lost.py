from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.schemas.improvement import PhaseLossOut
from app.services import points_lost
from app.services.points_lost import (
    build_points_lost,
    expected_score,
    loss_kind,
    opening_verdict,
    out_of_opening,
)

START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"
AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -"
AFTER_QH5 = "rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq -"
AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -"
AFTER_BC4 = "rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq -"
# Full armies: a middlegame by material.
MIDDLE = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -"
MIDDLE_AFTER = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPPQPPP/RNB1KB1R b KQkq -"
# One rook: an endgame.
ENDING = "8/5k2/8/8/8/8/5K2/7R w - -"
ENDING_AFTER = "8/5k2/8/8/8/8/6K1/7R b - -"


class Library:
    """Games for one player, with an evaluation for every position reached."""

    def __init__(self) -> None:
        self.positions: dict[str, int] = {}
        self.evals: dict[int, tuple[int, str, str, int]] = {}
        self.games: list[Game] = []
        self.game_positions: list[GamePosition] = []

    def position(self, fen: str, cp: int, best_uci: str, best_san: str, depth: int = 22) -> int:
        position_id = self.positions.setdefault(fen, len(self.positions) + 1)
        self.evals[position_id] = (cp, best_uci, best_san, depth)
        return position_id

    def game(self, plies: list[tuple[int, str, str | None, str | None]], *,
             opening_name: str = "Test Opening") -> None:
        game_id = len(self.games) + 1
        self.games.append(Game(
            id=game_id,
            chesscom_game_url=f"https://chess.com/game/{game_id}",
            chesscom_game_id=str(game_id),
            username="tester",
            white_username="tester",
            black_username="opponent",
            user_color="white",
            result="1-0",
            user_result="win",
            time_class="rapid",
            time_control="600",
            white_rating=1200,
            black_rating=1200,
            pgn="1. e4 1-0",
            opening_name=opening_name,
            played_at=datetime(2025, 1, game_id % 28 + 1, tzinfo=UTC),
            num_moves=len(plies),
        ))
        for ply, fen, move_uci, move_san in plies:
            self.game_positions.append(GamePosition(
                game_id=game_id, position_id=self.positions[fen], ply=ply,
                move_uci=move_uci, move_san=move_san,
            ))

    async def measure(self, **kwargs):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(Position(id=position_id, fen=fen) for fen, position_id in self.positions.items())
            session.add_all(self.games)
            await session.flush()
            session.add_all(self.game_positions)
            session.add_all(
                AnalysisResult(
                    position_id=position_id, depth=depth, eval_cp=cp,
                    best_move_uci=best_uci, best_move_san=best_san, multipv_rank=1,
                )
                for position_id, (cp, best_uci, best_san, depth) in self.evals.items()
            )
            await session.commit()
            result = await build_points_lost(
                session, username="tester", color="both", time_class="rapid_blitz",
                min_user_rating=1000, **kwargs,
            )
        await engine.dispose()
        return result


def _opening_library() -> Library:
    library = Library()
    library.position(START, 30, "e2e4", "e4")
    library.position(AFTER_E4, 30, "e7e5", "e5")
    library.position(AFTER_E5, 30, "g1f3", "Nf3")
    library.position(AFTER_QH5, -150, "b8c6", "Nc6")
    library.position(AFTER_NF3, 30, "b8c6", "Nc6")
    library.position(AFTER_BC4, -170, "g8f6", "Nf6")
    opening = [(0, START, None, None), (1, AFTER_E4, "e2e4", "e4"), (2, AFTER_E5, "e7e5", "e5")]
    for _ in range(3):
        library.game(opening + [(3, AFTER_QH5, "d1h5", "Qh5")], opening_name="Wayward Queen")
    for _ in range(2):
        library.game(opening + [(3, AFTER_BC4, "f1c4", "Bc4")])
    library.game(opening + [(3, AFTER_NF3, "g1f3", "Nf3")])
    return library


@pytest.mark.asyncio
async def test_a_repeated_losing_opening_move_is_named_with_its_answer() -> None:
    result = await _opening_library().measure()

    assert [fix.played_san for fix in result.opening_fixes] == ["Qh5"]
    fix = result.opening_fixes[0]
    assert fix.best_san == "Nf3"
    assert fix.occurrences == 3
    assert fix.average_loss_cp == 180
    assert fix.fen == AFTER_E5
    assert fix.last_move_uci == "e7e5"
    assert fix.side_to_move == "white"
    assert fix.opening_name == "Wayward Queen"


@pytest.mark.asyncio
async def test_a_losing_move_played_only_twice_is_not_a_fix() -> None:
    # 2.Bc4 loses 2 pawns here, but twice is not yet a habit worth a line on the card.
    result = await _opening_library().measure()
    assert "Bc4" not in {fix.played_san for fix in result.opening_fixes}


@pytest.mark.asyncio
async def test_phases_are_split_by_ply_then_material() -> None:
    library = _opening_library()
    library.position(MIDDLE, 0, "d2d4", "d4")
    library.position(MIDDLE_AFTER, -300, "c6d4", "Nxd4")
    library.position(ENDING, 500, "h1h7", "Rh7+")
    library.position(ENDING_AFTER, 500, "f7e6", "Ke6")
    library.game([(20, MIDDLE, "b8c6", "Nc6"), (21, MIDDLE_AFTER, "d1e2", "Qe2")])
    library.game([(40, ENDING, "g8f7", "Kf7"), (41, ENDING_AFTER, "f2g2", "Kg2")])

    result = await library.measure()

    by_phase = {phase.phase: phase for phase in result.phases}
    assert by_phase["opening"].analyzed_decisions == 6 * 2
    assert by_phase["middlegame"].analyzed_decisions == 1
    assert by_phase["endgame"].analyzed_decisions == 1
    assert sum(phase.share_of_loss for phase in result.phases) == pytest.approx(1.0, abs=1e-3)
    # The middlegame move let the opponent capture: it is filed under that kind.
    kinds = {kind.key: kind for kind in result.kinds}
    assert kinds["left_capturable"].decisions == 1
    assert kinds["left_capturable"].share_of_loss == pytest.approx(1.0)
    # A move that kept a won ending won loses nothing.
    assert by_phase["endgame"].average_loss == 0


@pytest.mark.asyncio
async def test_searches_too_far_apart_are_not_measured() -> None:
    library = _opening_library()
    # The parent searched to 30 and the child to 22 measure the gap, not the move.
    library.position(AFTER_E5, 30, "g1f3", "Nf3", depth=30)
    result = await library.measure()
    assert result.opening_fixes == []
    assert result.analyzed_decisions == 6 * 1


def test_loss_kinds_follow_the_drill_classifier_order() -> None:
    assert loss_kind(50, "Qxd5", "Nf3") == "small"
    assert loss_kind(300, "Qxd5+", "Nf3") == "left_capturable"
    assert loss_kind(300, "Qh5+", "Nf3") == "allowed_check"
    assert loss_kind(300, "Nf6", "Bxf7+") == "missed_forcing"
    assert loss_kind(300, "Nf6", "Qh5#") == "missed_forcing"
    assert loss_kind(300, "Nf6", "Nf3") == "quiet"
    assert loss_kind(300, None, None) == "quiet"


def test_expected_score_counts_a_pawn_at_equality_more_than_in_a_won_game() -> None:
    assert expected_score(0) == pytest.approx(0.5)
    assert expected_score(300) + expected_score(-300) == pytest.approx(1.0)
    level = expected_score(0) - expected_score(-100)
    winning = expected_score(800) - expected_score(700)
    assert level > 4 * winning


def _phases(opening_share_of_moves: float, opening_share_of_loss: float, decisions: int = 500):
    return [
        PhaseLossOut(phase="opening", analyzed_decisions=decisions,
                     share_of_moves=opening_share_of_moves, share_of_loss=opening_share_of_loss,
                     average_loss=0.03),
        PhaseLossOut(phase="middlegame", analyzed_decisions=decisions,
                     share_of_moves=1 - opening_share_of_moves, share_of_loss=1 - opening_share_of_loss,
                     average_loss=0.05),
        PhaseLossOut(phase="endgame", analyzed_decisions=0, share_of_moves=0, share_of_loss=0,
                     average_loss=0),
    ]


def test_the_opening_verdict_compares_its_loss_with_its_share_of_moves() -> None:
    assert opening_verdict(_phases(0.24, 0.19)) == "lighter"
    assert opening_verdict(_phases(0.24, 0.25)) == "even"
    assert opening_verdict(_phases(0.24, 0.40)) == "heavier"


def test_the_opening_verdict_refuses_thin_evidence() -> None:
    few = points_lost.MIN_PHASE_DECISIONS - 1
    assert opening_verdict(_phases(0.24, 0.10, decisions=few)) == "insufficient"


def test_out_of_opening_is_read_from_each_colour_s_own_side() -> None:
    rows = [
        # White: level, level, a pawn up.
        ("white", "win", 20), ("white", "loss", -30), ("white", "win", 150),
        # Black: White's view +250 is Black two and a half pawns down.
        ("black", "loss", 250), ("black", "loss", 120), ("black", "win", 0), ("black", "draw", 10),
    ]
    white, black = out_of_opening(rows)
    assert (white.color, white.games, white.average_cp, white.worse_share) == ("white", 3, 47, 0.0)
    assert white.score_when_worse is None
    assert (black.games, black.average_cp, black.worse_share) == (4, -95, 0.5)
    assert black.score_when_worse == 0.0
    assert black.score_when_level == 0.75
