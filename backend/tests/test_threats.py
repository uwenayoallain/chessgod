from datetime import UTC, datetime, timedelta

import chess
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.analysis import AnalysisResult
from app.models.base import Base
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.services.threats import build_pool, build_punish_pool, is_recapture, kind_of, pick_set, schedule
from app.utils.fen import normalize_fen


class Library:
    def __init__(self) -> None:
        self.ids: dict[str, int] = {}
        self.games: list[Game] = []
        self.rows: list[GamePosition] = []
        self.evals: list[AnalysisResult] = []

    def pid(self, fen: str) -> int:
        return self.ids.setdefault(fen, len(self.ids) + 1)

    def game(self, sans: list[str], *, color: str = "white") -> list[str]:
        game_id = len(self.games) + 1
        self.games.append(Game(
            id=game_id, chesscom_game_url=f"https://chess.com/game/{game_id}", chesscom_game_id=str(game_id),
            username="tester", white_username="a", black_username="b", user_color=color, result="1-0",
            user_result="loss", time_class="rapid", time_control="600", white_rating=1500, black_rating=1500,
            pgn="-", played_at=datetime(2026, 9, game_id, tzinfo=UTC), num_moves=len(sans),
        ))
        board = chess.Board()
        fens = [normalize_fen(board.fen())]
        self.rows.append(GamePosition(game_id=game_id, position_id=self.pid(fens[0]), ply=0))
        for ply, san in enumerate(sans, start=1):
            move = board.push_san(san)
            fens.append(normalize_fen(board.fen()))
            self.rows.append(GamePosition(game_id=game_id, position_id=self.pid(fens[-1]), ply=ply,
                                          move_uci=move.uci(), move_san=san))
        return fens

    def score(self, fen: str, cp: int, best_san: str) -> None:
        board = chess.Board(f"{fen} 0 1")
        move = board.parse_san(best_san)
        self.evals.append(AnalysisResult(
            position_id=self.pid(fen), depth=20, eval_cp=cp, best_move_uci=move.uci(),
            best_move_san=best_san, pv_uci=move.uci(), multipv_rank=1,
        ))

    async def pool(self, build=build_pool) -> list[dict]:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            session.add_all(Position(id=position_id, fen=fen) for fen, position_id in self.ids.items())
            await session.flush()
            session.add_all(self.games)
            await session.flush()
            session.add_all(self.rows)
            session.add_all(self.evals)
            await session.commit()
            result = await build(session, username="tester", min_user_rating=1000)
        await engine.dispose()
        return result


@pytest.mark.asyncio
async def test_a_hung_piece_is_asked_from_the_opponent_s_side() -> None:
    library = Library()
    # 2.Qg4?? hangs the queen to ...Bxg4.
    fens = library.game(["e4", "d5", "Qg4"])
    library.score(fens[2], 40, "exd5")
    library.score(fens[3], -800, "Bxg4")
    [item] = await library.pool()
    assert (item["your_move_san"], item["reply_san"], item["better_san"]) == ("Qg4", "Bxg4", "exd5")
    assert item["kind"] == "capture"
    assert item["fen"] == fens[3]
    assert item["player_color"] == "white"
    assert item["loss_cp"] == 840


@pytest.mark.asyncio
async def test_small_losses_lost_positions_and_quiet_replies_are_left_out() -> None:
    library = Library()
    small = library.game(["e4", "e5", "Nf3", "Nc6", "Bc4"])
    library.score(small[4], 40, "Bb5")
    library.score(small[5], -60, "Nf6")
    lost = library.game(["d4", "d5", "c4", "e6", "Qa4+"])
    library.score(lost[4], -500, "Nc3")
    library.score(lost[5], -900, "Bd7")
    quiet = library.game(["c4", "e5", "Nc3", "Nf6", "g4"])
    library.score(quiet[4], 20, "Nf3")
    library.score(quiet[5], -300, "d5")
    assert await library.pool() == []


def test_a_recapture_is_a_trade_not_a_scan() -> None:
    assert is_recapture("c1g5", "Bxg5", "h6g5")
    assert not is_recapture("d1d4", "Qd4", "c6d4")  # the moved piece hung: kept
    assert not is_recapture("c1g5", "Bxg5", "d8d1")


def test_kinds_and_sets() -> None:
    assert kind_of("Qxf7#") == "mate"
    assert kind_of("Bxg4") == "capture"
    assert kind_of("Qh5+") == "check"
    pool = [{"position_id": n} for n in range(30)]
    picked = pick_set(pool, exclude=set(range(0, 30, 2)), size=10, seed=1)
    assert len(picked) == 10
    assert all(item["position_id"] % 2 == 1 for item in picked)
    # Everything answered recently: ask again rather than ask nothing.
    assert len(pick_set(pool, exclude=set(range(30)), size=10, seed=1)) == 10


def test_misses_come_back_first_and_finds_rest_longer_each_time() -> None:
    now = datetime(2026, 9, 30, 12, tzinfo=UTC)
    day = timedelta(days=1)
    answers = [
        (1, False, now - 2 * day),  # missed two days ago: due again
        (2, False, now - day / 2),  # missed this morning: resting a day
        (3, True, now - 6 * day),  # found once, six days ago: resting a week
        (4, True, now - 20 * day), (4, True, now - 10 * day),  # found twice: resting two weeks
        (5, True, now - 8 * day),  # found once, eight days ago: back in the pool
        (6, False, now - 5 * day),  # missed first, and longer ago: asked before 1
    ]
    resting, due = schedule(answers, now)
    assert resting == {2, 3, 4}
    assert due == [6, 1]

    pool = [{"position_id": n} for n in range(30)]
    picked = pick_set(pool, exclude=resting, due=due, size=10, seed=1)
    assert [item["position_id"] for item in picked[:2]] == [6, 1]
    assert all(item.get("again") for item in picked[:2])
    assert len(picked) == 10 and len({item["position_id"] for item in picked}) == 10
    assert not {2, 3, 4} & {item["position_id"] for item in picked}
    # At most half the set is repeats.
    assert len([i for i in pick_set(pool, exclude=set(), due=list(range(20)), size=10) if i.get("again")]) == 5


# Twenty plies of knights going out and back, so what follows is past the opening.
SHUFFLE = ["Nf3", "Nf6", "Ng1", "Ng8"] * 5


@pytest.mark.asyncio
async def test_an_opponents_mistake_handed_back_is_asked_from_the_players_side() -> None:
    library = Library()
    fens = library.game([*SHUFFLE, "e4", "d5", "Nc3"])
    library.score(fens[21], 30, "d5")
    # ...d5 gives a pawn: +3.0. Nc3 hands it back instead of taking.
    library.score(fens[22], 300, "exd5")
    library.score(fens[23], 20, "dxe4")
    [item] = await library.pool(build_punish_pool)
    assert (item["their_move_san"], item["your_move_san"], item["answer_san"]) == ("d5", "Nc3", "exd5")
    assert item["fen"] == fens[22]
    assert item["player_color"] == "white"
    assert item["gift_cp"] == 270
    assert item["kind"] == "capture"


@pytest.mark.asyncio
async def test_a_gift_kept_or_a_quiet_answer_is_not_asked() -> None:
    library = Library()
    kept = library.game([*SHUFFLE, "e4", "d5", "exd5"])
    library.score(kept[21], 30, "d5")
    library.score(kept[22], 300, "exd5")
    library.score(kept[23], 290, "Qxd5")
    quiet = library.game([*SHUFFLE, "d4", "e6", "a3"])
    library.score(quiet[21], 30, "e6")
    library.score(quiet[22], 300, "e4")
    library.score(quiet[23], 0, "c5")
    assert await library.pool(build_punish_pool) == []


def test_a_hint_names_the_kind_of_move_then_the_piece_and_never_the_move() -> None:
    from app.services.threats import hint_for

    # 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4?? — Nxe5 takes a pawn, Bxf7+ is a capture with check.
    fen = "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq -"
    assert hint_for(fen, "f3e5", 1) == {"level": 1, "text": "A capture.", "square": None}
    assert hint_for(fen, "c4f7", 1)["text"] == "A capture with check."
    assert hint_for(fen, "e1g1", 1)["text"] == "A king move."
    assert hint_for(fen, "f3e5", 2) == {
        "level": 2, "text": "Look at the knight on f3.", "square": "f3",
    }
    mate = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq -"
    assert hint_for(mate, "h5f7", 1)["text"] == "It is mate in one."
    assert hint_for("4k3/8/8/8/8/8/8/4K2R w K -", "h1h8", 1)["text"] == "A check."
