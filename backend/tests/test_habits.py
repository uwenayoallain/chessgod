from datetime import UTC, datetime, timedelta

from app.services import habits

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def _evals(cp: int, depth: int = 22, best: str | None = "Nf3") -> list[tuple[int, int, str | None]]:
    return [(depth, cp, best)]


def test_a_pair_uses_the_closest_depths_and_never_a_gap_past_the_contract() -> None:
    parent = [(22, 50, "e4"), (30, 40, "d4")]
    child = [(23, -200, None)]
    assert habits.pair(parent, child) == (50, -200, "e4")
    assert habits.pair([(30, 40, "d4")], [(22, 0, None)]) is None
    assert habits.pair(None, child) is None


def test_a_sitting_breaks_after_half_an_hour_between_games() -> None:
    games = [{"id": i, "played_at": T0 + offset} for i, offset in enumerate(
        [timedelta(0), timedelta(minutes=15), timedelta(minutes=29), timedelta(hours=3)])]
    assert habits.sessions(games) == {0: 1, 1: 2, 2: 3, 3: 1}


def _game(color: str = "white") -> dict:
    return {"id": 1, "user_color": color}


def test_a_mistake_right_after_a_mistake_is_marked_as_the_second_one() -> None:
    # White moves on odd plies. Ply 21 drops +0.5 -> -2.0, ply 23 drops again.
    plies = {20: ("Nc6", 2.0, 20), 21: ("Qh5", 3.0, 21), 22: ("Nf6", 1.0, 22), 23: ("Qxf7+", 2.0, 23)}
    evals = {20: _evals(50, best="Nf3"), 21: _evals(-200), 22: _evals(-200, best="Qe2"), 23: _evals(-700)}
    reading = habits.read_game(_game(), plies, evals)
    first, second = reading["moves"]
    assert first["big"] and not first["after_own_big"]
    assert second["big"] and second["after_own_big"]
    assert second["better_san"] == "Qe2"
    assert [m["kind"] for m in habits.moments(reading)] == ["second_mistake"]


def test_handing_back_the_opponents_gift_is_a_missed_punishment() -> None:
    # Black to move on even plies: White's ply 21 blunders (0 -> -400 for White,
    # i.e. +4 for Black), and Black's ply 22 gives it all back.
    plies = {20: ("Nf6", 4.0, 20), 21: ("Bxh7+", 5.0, 21), 22: ("Kh8", 1.5, 22)}
    evals = {20: _evals(0), 21: _evals(-400, best="Kxh7"), 22: _evals(0)}
    reading = habits.read_game(_game("black"), plies, evals)
    (move,) = reading["moves"]
    assert move["opponent_gift"] and move["big"]
    (moment,) = habits.moments(reading)
    assert moment == {
        "kind": "missed_punishment", "ply": 22, "move_number": 11, "san": "Kh8",
        "better_san": "Kxh7", "opponent_san": "Bxh7+", "think_seconds": 1.5,
        "position_id": 21,
    }
    report = habits.missed_punishment([reading])
    assert (report["events"], report["handed_back"], report["rate"]) == (1, 1, 1.0)
    assert report["shows"] is False  # one event is not a habit


def test_a_long_sitting_is_a_habit_only_when_its_late_games_score_below_the_ratings() -> None:
    games, place = [], {}
    for i in range(400):
        index = i % 8 + 1
        late = index > 4
        games.append({"id": i, "my_rating": 1600, "opp_rating": 1600,
                      "user_result": ("loss" if i % 3 else "win") if late else ("win" if i % 3 else "loss")})
        place[i] = index
    report = habits.long_session(games, place)
    assert report["shows"] and report["stop_after"] == 4
    flat = [{**g, "user_result": "draw"} for g in games]
    assert habits.long_session(flat, place)["shows"] is False
