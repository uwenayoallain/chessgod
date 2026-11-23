"""The report services' raw SQL: username binds, the streamed habits read, coverage counts.

`games.username` is CITEXT on Postgres. A raw `text()` query whose username
bind was typed `Text()` rendered `$1::VARCHAR`, which turns the comparison
into a case-sensitive `text = text` that cannot use the CITEXT index: up to
220x slower, and a name typed in another case matched nothing. SQLite cannot
show either (its column collation is NOCASE whatever the bind), so the
Postgres rendering is checked by compiling every statement the services ran.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import chess
import pytest
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import asyncpg
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.sql.elements import TextClause

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.identity import Username
from app.models.position import Position
from app.models.position_outcome import PositionOutcome
from app.services import clock, habits, progress, threats
from app.utils.fen import normalize_fen

# 28 plies of the Ruy Lopez, every position distinct.
RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "d6",
       "c3", "O-O", "h3", "Nb8", "d4", "Nbd7", "Nbd2", "Bb7", "Bc2", "Re8", "Nf1", "Bf8", "Ng3", "g6"]
NOW = datetime(2026, 10, 1, 12, tzinfo=UTC)


class Library:
    def __init__(self) -> None:
        self.ids: dict[str, int] = {}
        self.games: list[Game] = []
        self.rows: list[GamePosition] = []
        self.evals: list[AnalysisResult] = []
        self.outcomes: list[PositionOutcome] = []

    def pid(self, fen: str) -> int:
        return self.ids.setdefault(fen, len(self.ids) + 1)

    def game(self, sans: list[str], *, played_at: datetime, color: str = "white",
             clocks: bool = True) -> list[str]:
        game_id = len(self.games) + 1
        self.games.append(Game(
            id=game_id, chesscom_game_url=f"https://chess.com/game/{game_id}", chesscom_game_id=str(game_id),
            username="tester", white_username="tester", black_username="b", user_color=color, result="0-1",
            user_result="loss", time_class="rapid", time_control="600", white_rating=1500, black_rating=1500,
            pgn="-", played_at=played_at, num_moves=len(sans),
        ))
        board = chess.Board()
        fens = [normalize_fen(board.fen())]
        self.rows.append(GamePosition(game_id=game_id, position_id=self.pid(fens[0]), ply=0))
        for ply, san in enumerate(sans, start=1):
            move = board.push_san(san)
            fens.append(normalize_fen(board.fen()))
            self.rows.append(GamePosition(
                game_id=game_id, position_id=self.pid(fens[-1]), ply=ply, move_uci=move.uci(), move_san=san,
                think_seconds=3.0 if clocks else None, clock_seconds_after=600.0 - 5 * ply if clocks else None,
            ))
        return fens

    def score(self, fen: str, cp: int, *, depth: int = 20, rank: int = 1, best: str | None = None) -> None:
        board = chess.Board(f"{fen} 0 1")
        move = board.parse_san(best) if best else min(board.legal_moves, key=lambda m: m.uci())
        self.evals.append(AnalysisResult(
            position_id=self.pid(fen), depth=depth, eval_cp=cp, best_move_uci=move.uci(),
            best_move_san=board.san(move), pv_uci=move.uci(), multipv_rank=rank,
        ))

    async def run(self, work):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        statements: list[TextClause] = []

        @event.listens_for(engine.sync_engine, "before_execute")
        def capture(conn, clauseelement, multiparams, params, execution_options):  # noqa: ARG001
            if isinstance(clauseelement, TextClause):
                statements.append(clauseelement)

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(Position(id=position_id, fen=fen) for fen, position_id in self.ids.items())
            await session.flush()
            session.add_all(self.games)
            await session.flush()
            session.add_all([*self.rows, *self.evals, *self.outcomes])
            await session.commit()
            statements.clear()
            result = await work(session)
        await engine.dispose()
        return result, statements


def _username_casts(statements: list[TextClause]) -> list[str]:
    """Each statement comparing `username` to a bind, as asyncpg would send it."""
    rendered = []
    for statement in statements:
        compiled = statement.compile(dialect=asyncpg.dialect())
        sql = str(compiled)
        if ".username = $" in sql:
            assert compiled.binds["username"].type is Username
            rendered.append(sql)
    return rendered


def _ruy_library() -> tuple[Library, list[str]]:
    """White blunders at ply 21 and again at ply 23: a second mistake, past move 10."""
    library = Library()
    fens = library.game(RUY, played_at=NOW - timedelta(days=3))
    for ply, fen in enumerate(fens):
        cp = 0 if ply <= 20 else -300 if ply <= 22 else -700
        # After 11.Nbd2?? the punishment is a capture, so Blunder Check asks it.
        library.score(fen, cp, best="exd4" if ply == 21 else None)
    return library, fens


@pytest.mark.asyncio
async def test_every_report_matches_the_player_in_any_case_and_binds_username_as_citext() -> None:
    library, _ = _ruy_library()

    async def work(session):
        kwargs = {"username": "TeStEr", "min_user_rating": 1000}
        return {
            "clock": await clock.build_clock(session, **kwargs),
            "progress": await progress.build_progress(session, **kwargs),
            "habits": await habits.build_habits(session, **kwargs),
            "pool": await threats.build_pool(session, **kwargs),
            "punish": await threats.build_punish_pool(session, **kwargs),
            "recent": await threats.recent_unanalysed_games(session, username="TESTER", now=NOW),
            "sitting": await habits.current_sitting(session, username="TESTER", now=NOW),
        }

    reports, statements = await library.run(work)
    assert reports["clock"]["games"] == 1
    assert reports["progress"]["checked_games"] == 1
    assert reports["habits"]["games"] == 1
    assert [item["reply_san"] for item in reports["pool"]] == ["exd4"]
    assert reports["recent"] == 0
    rendered = _username_casts(statements)
    # Clock (3), progress (1), habits (games + sitting), both pools, recent coverage.
    assert len(rendered) == 9
    for sql in rendered:
        assert "::VARCHAR" not in sql, sql
        assert "::TEXT" not in sql, sql


@pytest.mark.asyncio
async def test_habits_streams_plies_and_keeps_only_the_newest_covered_games_moves() -> None:
    library, fens = _ruy_library()
    # A newer game with nothing judged: counted as pending, never read for moments.
    library.game(["d4", "d5", "c4", "e6"], played_at=NOW - timedelta(days=1))

    async def work(session):
        return await habits.build_habits(session, username="tester", min_user_rating=1000)

    report, _ = await library.run(work)
    assert report["games"] == 2
    assert report["pending_games"] == 1
    last = report["last_game"]
    assert last["game_id"] == 1
    assert last["big_mistakes"] == 2
    [moment] = last["moments"]
    assert (moment["kind"], moment["ply"], moment["san"]) == ("second_mistake", 23, "Bc2")
    assert moment["fen"] == fens[22]
    second = next(habit for habit in report["habits"] if habit["key"] == "second_mistake")
    # Plies 23 and 25 each follow a big mistake; only 23 is another one.
    assert (second["events"], second["rate"]) == (2, 0.5)


def test_a_folded_reading_counts_exactly_what_its_moves_did() -> None:
    plies = {20: ("Nc6", 2.0, 20), 21: ("Qh5", 3.0, 21), 22: ("Nf6", 1.0, 22), 23: ("Qxf7+", 2.0, 23)}
    evals = {20: [(22, 50, "Nf3")], 21: [(22, -200, None)], 22: [(22, -200, "Qe2")], 23: [(22, -700, None)]}
    reading = habits.read_game({"id": 1, "user_color": "white"}, plies, evals)
    folded = {**reading, "moves": []}
    for measure in (habits.second_mistake, habits.missed_punishment):
        assert measure([folded]) == measure([reading])
        assert measure([{"moves": reading["moves"]}]) == measure([reading])


async def _recent_unanalysed(*, evaluated: int, mate_recorded: bool = False) -> int:
    library = Library()
    # Fool's mate: 4 plies, 5 positions, the last one a finished position.
    fens = library.game(["f3", "e5", "g4", "Qh4#"], played_at=NOW - timedelta(days=2))
    # Each evaluated position at three depths and two MultiPV lines: six rows.
    for fen in fens[:evaluated]:
        for depth in (18, 22, 26):
            for rank in (1, 2):
                library.score(fen, 0, depth=depth, rank=rank)
    # Only a rank-2 line on the fourth: not a trusted evaluation of the position.
    library.score(fens[3], 0, depth=22, rank=2)
    if mate_recorded:
        library.outcomes.append(PositionOutcome(position_id=library.pid(fens[4]), white_result=-1,
                                                reason="checkmate"))

    async def work(session):
        return await threats.recent_unanalysed_games(session, username="tester", now=NOW)

    return (await library.run(work))[0]


@pytest.mark.asyncio
async def test_recent_coverage_counts_each_ply_once_however_many_rows_its_position_has() -> None:
    # 3 of 5 plies judged: exactly 60%, so the game is not under it. Joined
    # directly, the 19 evaluation rows made it 4 positions over 20 joined rows.
    assert await _recent_unanalysed(evaluated=3) == 0
    assert await _recent_unanalysed(evaluated=2) == 1
    # Mate needs no search, so the finished position counts as judged.
    assert await _recent_unanalysed(evaluated=2, mate_recorded=True) == 0


@pytest.mark.asyncio
async def test_a_recapture_is_filtered_in_sql_before_the_pool_is_read() -> None:
    library = Library()
    # 1.e4 d5 2.exd5?? Qxd5: a trade gone wrong, not a scan.
    trade = library.game(["e4", "d5", "exd5", "Qxd5"], played_at=NOW - timedelta(days=2))
    library.score(trade[2], 0)
    board = chess.Board(f"{trade[3]} 0 1")
    library.evals.append(AnalysisResult(
        position_id=library.pid(trade[3]), depth=20, eval_cp=-400, best_move_uci="d8d5",
        best_move_san="Qxd5", pv_uci="d8d5", multipv_rank=1,
    ))
    assert board.is_legal(chess.Move.from_uci("d8d5"))

    async def work(session):
        return await threats.build_pool(session, username="tester", min_user_rating=1000)

    assert (await library.run(work))[0] == []


@pytest.mark.asyncio
async def test_clock_takes_each_games_own_last_clock_in_one_pass() -> None:
    library = Library()
    library.game(RUY[:24], played_at=NOW - timedelta(days=3), color="white")
    library.game(RUY[:26], played_at=NOW - timedelta(days=2), color="black")
    library.game(RUY[:10], played_at=NOW - timedelta(days=1), color="white", clocks=False)

    async def work(session):
        return await clock.build_clock(session, username="tester", min_user_rating=1000)

    report, _ = await library.run(work)
    assert report["games"] == 3
    # White's last move is ply 23, Black's ply 26; the clockless game has none.
    assert report["losses"] == 2
    assert report["left_in_losses"] == ((600.0 - 5 * 23) + (600.0 - 5 * 26)) / 2


@pytest.mark.asyncio
@pytest.mark.parametrize("add_deeper_scores", [False, True])
async def test_pool_thresholds_follow_depth_selection(add_deeper_scores: bool) -> None:
    library = Library()
    fens = library.game(["Nf3", "Nf6", "Ng1", "Ng8"] * 5 + ["e4", "d5", "Qg4"], played_at=NOW)
    scores = [(20, (0, 300, -700))]
    if add_deeper_scores:
        scores.append((22, (0, 10, 0)))
    for depth, (before, gift, after) in scores:
        library.score(fens[21], before, depth=depth, best="d5")
        library.score(fens[22], gift, depth=depth, best="exd5")
        library.score(fens[23], after, depth=depth, best="Bxg4")

    async def work(session):
        return [
            await build(session, username="TeStEr", min_user_rating=1000)
            for build in (threats.build_pool, threats.build_punish_pool)
        ]

    pools, _ = await library.run(work)
    assert [len(pool) for pool in pools] == ([0, 0] if add_deeper_scores else [1, 1])
