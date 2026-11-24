from datetime import UTC, datetime

import chess
import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.models.repertoire_mark import RepertoireMark
from app.models.training import LineMoveProgress
from app.services.repertoire_builder import build_repertoire
from app.utils.fen import normalize_fen

SCOTCH = ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Nxd4", "Qxd4"]


def fen_after(sans: list[str]) -> str:
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return normalize_fen(board.fen())


class Library:
    def __init__(self) -> None:
        self.ids: dict[str, int] = {}
        self.rows: list = []
        self.games = 0
        self.evals: list[AnalysisResult] = []
        self.marks: list[RepertoireMark] = []
        self.taught: list[LineMoveProgress] = []

    def pid(self, fen: str) -> int:
        if fen not in self.ids:
            self.ids[fen] = len(self.ids) + 1
        return self.ids[fen]

    def game(self, sans: list[str], *, color: str = "black", result: str = "loss", times: int = 6) -> None:
        for _ in range(times):
            self.games += 1
            game_id = self.games
            self.rows.append(Game(
                id=game_id, chesscom_game_url=f"u{game_id}", chesscom_game_id=str(game_id),
                username="tester", white_username="a", black_username="b", user_color=color,
                result="0-1", user_result=result, time_class="rapid", time_control="600",
                white_rating=1500, black_rating=1500, pgn="-", opening_name="Test Opening",
                played_at=datetime(2025, 1, 1, tzinfo=UTC), num_moves=len(sans),
            ))
            board = chess.Board()
            self.rows.append(GamePosition(game_id=game_id, position_id=self.pid(normalize_fen(board.fen())), ply=0))
            for ply, san in enumerate(sans, start=1):
                move = board.push_san(san)
                self.rows.append(GamePosition(
                    game_id=game_id, position_id=self.pid(normalize_fen(board.fen())), ply=ply,
                    move_uci=move.uci(), move_san=san,
                ))

    def lines(self, sans: list[str], *lines: tuple[str, int]) -> None:
        """A MultiPV search of the position after `sans`: (move SAN, White's-view score)."""
        fen = fen_after(sans)
        board = chess.Board(f"{fen} 0 1")
        for rank, (san, cp) in enumerate(lines, start=1):
            uci = board.parse_san(san).uci()
            self.evals.append(AnalysisResult(
                position_id=self.pid(fen), depth=20, eval_cp=cp, best_move_uci=uci,
                best_move_san=san, pv_uci=uci, multipv_rank=rank,
            ))

    def score(self, sans: list[str], cp: int, *, depth: int = 20) -> None:
        fen = fen_after(sans)
        board = chess.Board(f"{fen} 0 1")
        move = next(iter(board.legal_moves))
        self.evals.append(AnalysisResult(
            position_id=self.pid(fen), depth=depth, eval_cp=cp, best_move_uci=move.uci(),
            best_move_san=board.san(move), pv_uci=move.uci(), multipv_rank=1,
        ))

    def teach(self, sans: list[str], san: str, *, level: int = 1) -> None:
        """The course has taught `san` in the position after `sans`."""
        fen = fen_after(sans)
        self.taught.append(LineMoveProgress(
            username="tester", color="black", fen=fen,
            move_uci=chess.Board(f"{fen} 0 1").parse_san(san).uci(), level=level,
            reviews=1, recalls=0, lapses=0, due_at=datetime(2026, 1, 1, tzinfo=UTC),
            last_reviewed_at=datetime(2025, 12, 31, tzinfo=UTC),
        ))

    def master(self, sans: list[str], san: str, games: int) -> None:
        board = chess.Board(f"{fen_after(sans)} 0 1")
        move = board.parse_san(san)
        self.rows.append(PositionMove(
            from_position_id=self.pid(fen_after(sans)), to_position_id=self.pid(fen_after([*sans, san])),
            move_san=san, move_uci=move.uci(), move_number=board.fullmove_number,
            is_white_move=board.turn == chess.WHITE, master_game_count=games,
        ))

    async def build(self, color: str = "black", *, queries: list | None = None) -> dict:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(Position(id=position_id, fen=fen) for fen, position_id in self.ids.items())
            await session.flush()
            session.add_all([row for row in self.rows if isinstance(row, Game)])
            await session.flush()
            session.add_all([row for row in self.rows if not isinstance(row, Game)])
            session.add_all(self.evals)
            session.add_all(self.marks)
            session.add_all(self.taught)
            await session.commit()
            if queries is not None:
                @event.listens_for(engine.sync_engine, "before_cursor_execute")
                def record_query(_conn, _cursor, statement, params, _context, _executemany):
                    queries.append((statement, params))
            result = await build_repertoire(
                session, username="tester", color=color, time_class="rapid_blitz", min_user_rating=1000,
            )
        await engine.dispose()
        return result


def scotch_library() -> Library:
    library = Library()
    library.game(SCOTCH)
    library.lines(["e4"], ("e5", 30), ("c5", 35))
    library.lines(["e4", "e5", "Nf3"], ("Nc6", 35), ("Nf6", 40))
    library.lines(SCOTCH[:5], ("exd4", 30))
    # 4...Nxd4 is not among the lines and leaves White +1.20: a pawn given away.
    library.lines(SCOTCH[:7], ("Nf6", 20), ("Bc5", 30), ("Qh4", 60))
    library.score(SCOTCH[:8], 120)
    library.master(SCOTCH[:7], "Bc5", 500)
    library.master(SCOTCH[:7], "Nf6", 300)
    library.master([*SCOTCH[:7], "Bc5"], "Nb3", 400)
    return library


def _yours(line: dict) -> list[dict]:
    return [step for step in line["moves"] if step["side"] == "you"]


@pytest.mark.asyncio
async def test_a_sound_move_the_player_already_plays_is_kept() -> None:
    result = await scotch_library().build()
    first = _yours(result["lines"][0])[0]
    assert (first["san"], first["status"], first["reason"]) == ("e5", "keep", "usual")
    assert first["checked"] is True


@pytest.mark.asyncio
async def test_an_unsound_move_is_changed_for_the_sound_move_masters_play_most() -> None:
    result = await scotch_library().build()
    change = next(step for step in _yours(result["lines"][0]) if step["status"] == "change")
    # Nf6 is the engine's first choice, but Bc5 is sound and the masters' move.
    assert change["san"] == "Bc5"
    assert change["reason"] == "masters"
    assert change["usual_san"] == "Nxd4"
    assert change["usual_games"] == 6
    assert change["usual_score"] == 0.0
    assert change["usual_loss_cp"] == 100
    assert change["master_share"] == pytest.approx(0.625)


@pytest.mark.asyncio
async def test_past_a_change_the_line_follows_the_masters_and_asks_for_the_engine() -> None:
    result = await scotch_library().build()
    line = result["lines"][0]
    assert [step["san"] for step in line["moves"]][-2:] == ["Bc5", "Nb3"]
    assert line["moves"][-1]["source"] == "masters"
    assert fen_after([*SCOTCH[:7], "Bc5", "Nb3"]) in result["needs_engine"]
    assert line["changes"] == 1


@pytest.mark.asyncio
async def test_a_marked_move_wins_when_it_is_sound() -> None:
    library = scotch_library()
    library.marks.append(RepertoireMark(
        username="tester", color="black", fen=fen_after(SCOTCH[:7]),
        intended_move_uci="g8f6", intended_move_san="Nf6",
    ))
    result = await library.build()
    step = next(step for step in _yours(result["lines"][0]) if step["fen"] == fen_after(SCOTCH[:7]))
    assert (step["san"], step["reason"]) == ("Nf6", "marked")
    # Marked but not what they play yet: still a move to learn.
    assert step["status"] == "change"


@pytest.mark.asyncio
async def test_a_common_opponent_blunder_is_marked_as_a_trap() -> None:
    library = Library()
    library.game(["e4", "e5", "Qh5", "Nc6", "Bc4", "g6", "Qf3", "Nf6"])
    library.lines(["e4"], ("e5", 30))
    library.score(["e4", "e5"], 30)
    library.score(["e4", "e5", "Qh5"], -200)
    result = await library.build()
    queen = next(step for step in result["lines"][0]["moves"] if step["san"] == "Qh5")
    assert queen["trap_cp"] == 230
    assert result["lines"][0]["traps"] == 1


@pytest.mark.asyncio
async def test_positions_without_a_multipv_search_are_engine_work() -> None:
    library = Library()
    library.game(["d4", "d5", "Bf4", "Nc6"])
    library.score(["d4", "d5", "Bf4"], 40)
    result = await library.build()
    assert fen_after(["d4"]) in result["needs_engine"]
    assert fen_after(["d4", "d5", "Bf4"]) in result["needs_engine"]


@pytest.mark.asyncio
async def test_transposed_move_orders_make_one_lesson() -> None:
    library = Library()
    library.game(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], times=8)
    library.game(["e4", "e5", "Bc4", "Nc6", "Nf3", "Bc5"], times=6)
    result = await library.build()
    assert len(result["lines"]) == 1
    assert [step["san"] for step in result["lines"][0]["moves"]][2] == "Nf3"
    assert result["lines"][0]["games"] == 8


@pytest.mark.asyncio
async def test_a_small_loss_is_not_worth_learning_a_new_move() -> None:
    # 4...Nxd4 giving away half a pawn stays: a change is something to learn.
    library = scotch_library()
    library.evals = [row for row in library.evals if row.position_id != library.pid(fen_after(SCOTCH[:8]))]
    library.score(SCOTCH[:8], 70)
    result = await library.build()
    step = next(step for step in _yours(result["lines"][0]) if step["fen"] == fen_after(SCOTCH[:7]))
    assert (step["san"], step["status"]) == ("Nxd4", "keep")


@pytest.mark.asyncio
async def test_a_move_the_engine_has_not_judged_is_kept_and_queued() -> None:
    library = scotch_library()
    library.evals = [row for row in library.evals if row.position_id != library.pid(fen_after(SCOTCH[:8]))]
    result = await library.build()
    step = next(step for step in _yours(result["lines"][0]) if step["fen"] == fen_after(SCOTCH[:7]))
    assert (step["san"], step["reason"]) == ("Nxd4", "unchecked")
    assert fen_after(SCOTCH[:8]) in result["needs_engine"]


@pytest.mark.asyncio
async def test_a_move_the_course_taught_is_not_swapped_for_another_sound_one() -> None:
    # Masters prefer 4...Bc5, so an untaught player is given it. A player the
    # course already taught 4...Nf6 keeps Nf6: it is sound, and swapping it
    # turned a line they had practised into a new one to learn.
    untaught = await scotch_library().build()
    step = next(s for s in _yours(untaught["lines"][0]) if s["fen"] == fen_after(SCOTCH[:7]))
    assert step["san"] == "Bc5"

    library = scotch_library()
    library.teach(SCOTCH[:7], "Nf6")
    taught = await library.build()
    step = next(s for s in _yours(taught["lines"][0]) if s["fen"] == fen_after(SCOTCH[:7]))
    assert (step["san"], step["status"], step["reason"]) == ("Nf6", "change", "learned")


@pytest.mark.asyncio
async def test_a_taught_move_outlasts_a_sound_move_the_player_usually_plays() -> None:
    # 4...Nxd4 is the usual move and sound enough to keep, which is what an
    # untaught player gets. Once 4...Nf6 has been taught, it stays.
    library = scotch_library()
    library.evals = [row for row in library.evals if row.position_id != library.pid(fen_after(SCOTCH[:8]))]
    library.score(SCOTCH[:8], 70)
    library.teach(SCOTCH[:7], "Nf6")
    result = await library.build()
    step = next(s for s in _yours(result["lines"][0]) if s["fen"] == fen_after(SCOTCH[:7]))
    assert (step["san"], step["status"]) == ("Nf6", "change")


@pytest.mark.asyncio
async def test_a_taught_move_the_engine_now_refutes_is_replaced() -> None:
    library = scotch_library()
    library.evals = [row for row in library.evals if row.position_id != library.pid(fen_after(SCOTCH[:7]))]
    library.lines(SCOTCH[:7], ("Nf6", 20), ("Bc5", 30), ("Qh4", 60), ("d6", 130))
    library.teach(SCOTCH[:7], "d6")
    result = await library.build()
    step = next(s for s in _yours(result["lines"][0]) if s["fen"] == fen_after(SCOTCH[:7]))
    assert step["san"] == "Bc5"


@pytest.mark.asyncio
async def test_a_move_only_introduced_is_not_pinned() -> None:
    # Level 0 is a move shown and got wrong in learn mode: nothing was taught.
    library = scotch_library()
    library.teach(SCOTCH[:7], "Nf6", level=0)
    result = await library.build()
    step = next(s for s in _yours(result["lines"][0]) if s["fen"] == fen_after(SCOTCH[:7]))
    assert step["san"] == "Bc5"


@pytest.mark.asyncio
async def test_a_tie_in_games_is_broken_the_same_way_on_every_build() -> None:
    # Two moves played equally often: which is "usual" must not depend on the
    # order rows come back in, or the line changes between builds.
    def tied(first: str, second: str) -> Library:
        library = Library()
        library.game(["e4", first], times=5)
        library.game(["e4", second], times=5)
        library.lines(["e4"], ("e5", 30), ("c5", 35))
        return library

    one = await tied("e5", "c5").build()
    other = await tied("c5", "e5").build()
    pick = lambda result: {line["moves"][1]["san"] for line in result["lines"]}  # noqa: E731
    assert pick(one) == pick(other) and len(pick(one)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("compatible_score_exists", [False, True])
async def test_child_fallback_uses_compatible_depths(compatible_score_exists) -> None:
    library = Library()
    library.game(["e4", "e5"])
    library.lines(["e4"], ("c5", 0), ("e6", 20))
    library.score(["e4", "e5"], 180, depth=24)
    if compatible_score_exists:
        library.score(["e4", "e5"], 180)

    result = await library.build()
    first = _yours(result["lines"][0])[0]
    if compatible_score_exists:
        assert (first["san"], first["status"], first["usual_loss_cp"]) == ("c5", "change", 180)
    else:
        assert (first["san"], first["reason"], first["usual_loss_cp"]) == ("e5", "unchecked", None)
        assert fen_after(["e4", "e5"]) in result["needs_engine"]


@pytest.mark.asyncio
async def test_fens_are_loaded_once_per_frontier_and_only_when_visited() -> None:
    library = Library()
    replies = ["e4", "d4", "Nf3", "c4", "g3", "b3"]
    for san in replies:
        library.game([san])
        library.lines([san], ("e5", 0))
    library.master(["e4"], "c5", 10)

    queries = []
    result = await library.build(queries=queries)
    assert len(result["lines"]) == len(replies)
    fen_queries = [
        params for sql, params in queries
        if "WHERE positions.fen" in sql
    ]
    assert [set(params) for params in fen_queries] == [
        {fen_after([])},
        {fen_after([san]) for san in replies},
        {fen_after([san, "e5"]) for san in replies},
    ]
    assert not any("WHERE positions.id IN" in sql for sql, _ in queries)
