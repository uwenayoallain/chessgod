"""A repertoire to train, built from the player's own games and the engine.

The player does not have time to learn openings, so this is not a book. It
starts from the positions they actually reach, follows what their opponents
actually play against them, and at each of their own moves makes one choice:

* **keep** the move they already play, when the engine says it is sound —
  nothing to learn is the cheapest repertoire there is;
* otherwise **change** it for the sound move masters play most, because a
  well-trodden move leads to positions that make sense;
* and mark the opponent replies that are mistakes (**traps**), so the line
  teaches how to punish them.

"Sound" is judged from one MultiPV search of the position, so every candidate
is compared inside the same search rather than across two. A position that
has no MultiPV search yet is listed in `needs_engine`; the app searches those
(the browser engine, or `scripts/engine/repertoire.mjs`) and uploads them
through `POST /api/analysis/evaluations`, after which the next build can judge
it. Until then the engine's single best move stands in, flagged as unchecked.

On the first real corpus this found the Black lines the opening statistics
pointed at: the Scotch (5...Nf6 in 21 games, -2.2 pawns), the Two Knights
(4...Bc5, -1.2), the King's Gambit and the Centre Game, and the ...Nc6 setup
against 1.d4 that left the player a pawn down by move 10 in 40% of games.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

import chess
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.engine_contract import DECISIVE_CP, ENGINE_NAME, ENGINE_VERSION, MIN_TRUSTED_DEPTH
from app.models.analysis import AnalysisResult
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.models.position_move import PositionMove
from app.models.repertoire_mark import RepertoireMark
from app.services.game_scope import time_class_condition, user_rating_condition
from app.utils.fen import normalize_fen

START_FEN = normalize_fen(chess.STARTING_FEN)

# A move within this much of the engine's best is sound: the bar a *new* move clears.
SOUND_CP = 35
# The bar for replacing a move the player already plays is higher, because every
# change is something to learn. Measured on the first corpus, a 35cp bar changed
# moves losing 0.37-0.57 pawns and turned the Scotch fix into a new variation
# (4...Nf6 5.Nxc6 bxc6 6.e5 Qe7); at 60 the player keeps 4...Nxd4 and learns the
# one move that actually lost, 5...Qf6 instead of 5...Nf6 (-2.2 pawns).
KEEP_CP = 60
# Lines stop here: the player's eighth move. Past it positions stop repeating.
MAX_PLY = 16
# In positions the player has never reached, lines are kept shorter: there is
# no evidence opponents go there, only that masters do.
MAX_NEW_PLY = 12
# An opponent reply is followed when this many games, and this share, reach it.
# A low share on purpose: the King's Gambit was 37 games but 5% of 1.e4 e5,
# and a sharp sideline faced 37 times is exactly what needs preparing.
MIN_REPLY_GAMES = 5
MIN_REPLY_SHARE = 0.03
MAX_REPLIES = 6
# In new territory, master replies with this share of master games.
MIN_MASTER_REPLY_SHARE = 0.25
MAX_MASTER_REPLIES = 2
# An opponent reply losing this much is a trap to punish.
TRAP_CP = 150
# How many MultiPV lines a repertoire search asks for.
MULTIPV = 4
MAX_LINES = 60


@dataclass
class _Edge:
    uci: str
    san: str
    child_id: int
    games: int = 0
    points: float = 0.0
    last_played: datetime | None = None


@dataclass
class _Line:
    rank: int
    depth: int
    eval_cp: int  # White's view, capped/folded
    uci: str
    pv_uci: str | None


@dataclass
class _NodeData:
    position_id: int | None
    fen: str
    # The player's own games through this position.
    edges: dict[str, _Edge] = field(default_factory=dict)
    # MultiPV lines of the deepest search that has more than one line, else rank one.
    lines: list[_Line] = field(default_factory=list)
    multipv: bool = False
    # Master games per move.
    master: dict[str, tuple[int, int]] = field(default_factory=dict)  # uci -> (games, child_id)

    @property
    def games(self) -> int:
        return sum(edge.games for edge in self.edges.values())


def _fold(eval_cp: int | None, eval_mate: int | None) -> int:
    if eval_cp is not None:
        return max(-DECISIVE_CP, min(DECISIVE_CP, eval_cp))
    mate = eval_mate or 0
    if mate > 0:
        return 2000 - min(mate, 20) * 10
    return -2000 + min(-mate, 20) * 10


def _score(result: str) -> float:
    return {"win": 1.0, "draw": 0.5}.get(result, 0.0)


def _line_id(ucis: list[str]) -> str:
    return hashlib.sha1(" ".join(ucis).encode()).hexdigest()[:12]


class _Loader:
    """Everything the walk reads, loaded in bulk and then by BFS level."""

    def __init__(self, session: AsyncSession, username: str, color: str,
                 time_class: str, min_user_rating: int) -> None:
        self.session = session
        self.username = username
        self.color = color
        self.time_class = time_class
        self.min_user_rating = min_user_rating
        self.nodes: dict[str, _NodeData] = {}
        self.fen_by_id: dict[int, str] = {}
        self.marks: dict[str, str] = {}
        self.opening_names: dict[int, str] = {}

    async def load_games(self) -> None:
        parent = aliased(GamePosition)
        child = aliased(GamePosition)
        filters = [
            Game.username == self.username,
            Game.user_color == self.color,
            user_rating_condition(Game, self.min_user_rating),
        ]
        time_filter = time_class_condition(Game.time_class, self.time_class)
        if time_filter is not None:
            filters.append(time_filter)
        rows = (
            await self.session.execute(
                select(
                    parent.position_id, child.position_id, child.move_uci, child.move_san,
                    Game.user_result, Game.played_at, Game.opening_name,
                )
                .join(child, child.game_id == Game.id)
                .join(parent, and_(parent.game_id == Game.id, parent.ply == child.ply - 1))
                .where(*filters, child.ply >= 1, child.ply <= MAX_PLY, child.move_uci.is_not(None))
            )
        ).all()
        edges: dict[int, dict[str, _Edge]] = defaultdict(dict)
        names: dict[int, defaultdict[str, int]] = defaultdict(lambda: defaultdict(int))
        for from_id, to_id, uci, san, result, played_at, opening_name in rows:
            edge = edges[from_id].get(uci)
            if edge is None:
                edge = edges[from_id][uci] = _Edge(uci=uci, san=san or uci, child_id=to_id)
            edge.games += 1
            edge.points += _score(result)
            if played_at is not None and (edge.last_played is None or played_at > edge.last_played):
                edge.last_played = played_at
            if opening_name:
                names[to_id][opening_name] += 1
        ids = set(edges) | {edge.child_id for moves in edges.values() for edge in moves.values()}
        await self._load_fens(ids)
        for from_id, moves in edges.items():
            fen = self.fen_by_id.get(from_id)
            if fen is None:
                continue
            node = self.nodes.setdefault(fen, _NodeData(position_id=from_id, fen=fen))
            node.edges = moves
        self.opening_names = {
            position_id: max(counts, key=counts.get) for position_id, counts in names.items()
        }
        marks = (
            await self.session.execute(
                select(RepertoireMark.fen, RepertoireMark.intended_move_uci).where(
                    RepertoireMark.username == self.username, RepertoireMark.color == self.color
                )
            )
        ).all()
        self.marks = {normalize_fen(fen): uci for fen, uci in marks}

    async def _load_fens(self, ids: set[int]) -> None:
        missing = [position_id for position_id in ids if position_id not in self.fen_by_id]
        for start in range(0, len(missing), 1000):
            chunk = missing[start:start + 1000]
            for position_id, fen in (
                await self.session.execute(select(Position.id, Position.fen).where(Position.id.in_(chunk)))
            ).all():
                self.fen_by_id[position_id] = fen

    async def node(self, fen: str) -> _NodeData:
        node = self.nodes.get(fen)
        if node is None:
            position_id = (
                await self.session.execute(select(Position.id).where(Position.fen == fen))
            ).scalar_one_or_none()
            node = self.nodes[fen] = _NodeData(position_id=position_id, fen=fen)
        return node

    async def enrich(self, nodes: list[_NodeData], *, with_evals: bool) -> None:
        """Master moves for every node; engine lines for the player's."""
        ids = [node.position_id for node in nodes if node.position_id is not None]
        if not ids:
            return
        by_id = {node.position_id: node for node in nodes if node.position_id is not None}
        for from_id, uci, games, to_id in (
            await self.session.execute(
                select(
                    PositionMove.from_position_id, PositionMove.move_uci,
                    PositionMove.master_game_count, PositionMove.to_position_id,
                ).where(PositionMove.from_position_id.in_(ids), PositionMove.master_game_count > 0)
            )
        ).all():
            by_id[from_id].master[uci] = (int(games), to_id)
        await self._load_fens({to_id for node in nodes for _, to_id in node.master.values()})
        if not with_evals:
            return
        rows = (
            await self.session.execute(
                select(
                    AnalysisResult.position_id, AnalysisResult.multipv_rank, AnalysisResult.depth,
                    AnalysisResult.eval_cp, AnalysisResult.eval_mate, AnalysisResult.best_move_uci,
                    AnalysisResult.pv_uci,
                ).where(
                    AnalysisResult.position_id.in_(ids),
                    AnalysisResult.engine == ENGINE_NAME,
                    AnalysisResult.engine_version == ENGINE_VERSION,
                    AnalysisResult.depth >= MIN_TRUSTED_DEPTH,
                )
            )
        ).all()
        grouped: dict[int, dict[int, list[_Line]]] = defaultdict(lambda: defaultdict(list))
        for position_id, rank, depth, eval_cp, eval_mate, uci, pv in rows:
            if eval_cp is None and eval_mate is None:
                continue
            grouped[position_id][depth].append(
                _Line(rank=rank, depth=depth, eval_cp=_fold(eval_cp, eval_mate), uci=uci, pv_uci=pv)
            )
        for position_id, by_depth in grouped.items():
            node = by_id[position_id]
            multi = [depth for depth, lines in by_depth.items() if len(lines) > 1]
            depth = max(multi) if multi else max(by_depth)
            node.lines = sorted(by_depth[depth], key=lambda line: line.rank)
            node.multipv = bool(multi)

    async def child_evals(self, ids: set[int]) -> dict[int, int]:
        """Rank-one evaluation of positions, White's view."""
        if not ids:
            return {}
        rows = (
            await self.session.execute(
                select(
                    AnalysisResult.position_id, AnalysisResult.depth,
                    AnalysisResult.eval_cp, AnalysisResult.eval_mate,
                ).where(
                    AnalysisResult.position_id.in_(list(ids)),
                    AnalysisResult.engine == ENGINE_NAME,
                    AnalysisResult.engine_version == ENGINE_VERSION,
                    AnalysisResult.multipv_rank == 1,
                    AnalysisResult.depth >= MIN_TRUSTED_DEPTH,
                )
            )
        ).all()
        best: dict[int, tuple[int, int]] = {}
        for position_id, depth, eval_cp, eval_mate in rows:
            if eval_cp is None and eval_mate is None:
                continue
            if position_id not in best or depth > best[position_id][0]:
                best[position_id] = (depth, _fold(eval_cp, eval_mate))
        return {position_id: value for position_id, (_, value) in best.items()}


def _san(fen: str, uci: str) -> str:
    board = chess.Board(f"{fen} 0 1")
    return board.san(chess.Move.from_uci(uci))


def _pv_san(fen: str, pv_uci: str | None, limit: int = 6) -> str | None:
    if not pv_uci:
        return None
    board = chess.Board(f"{fen} 0 1")
    sans = []
    for uci in pv_uci.split()[:limit]:
        move = chess.Move.from_uci(uci)
        if move not in board.legal_moves:
            break
        sans.append(board.san(move))
        board.push(move)
    return " ".join(sans) or None


def _after(fen: str, uci: str) -> str:
    board = chess.Board(f"{fen} 0 1")
    board.push(chess.Move.from_uci(uci))
    return normalize_fen(board.fen())


def _surely_worse(node: _NodeData, mover_sign: int, best_eval: int | None) -> bool:
    """Whether a move outside every MultiPV line must lose more than KEEP_CP.

    A move the search did not list is no better than its last line, so when
    that line is already KEEP_CP behind the best, the unlisted move is too.
    """
    if best_eval is None or len(node.lines) < MULTIPV:
        return False
    return best_eval - mover_sign * node.lines[-1].eval_cp > KEEP_CP


def _choose(node: _NodeData, *, mover_sign: int, child_eval: dict[int, int],
            mark: str | None) -> dict | None:
    """The player's move at `node`, and the evidence for it."""

    usual = max(node.edges.values(), key=lambda edge: edge.games, default=None)
    evals = {line.uci: mover_sign * line.eval_cp for line in node.lines}
    best_eval = max(evals.values()) if evals else None

    def eval_of(uci: str) -> int | None:
        if uci in evals:
            return evals[uci]
        edge = node.edges.get(uci)
        child_id = edge.child_id if edge else node.master.get(uci, (0, None))[1]
        if child_id is not None and child_id in child_eval:
            return mover_sign * child_eval[child_id]
        return None

    def sound(uci: str, bar: int = SOUND_CP) -> bool | None:
        value = eval_of(uci)
        if value is None or best_eval is None:
            return None
        return best_eval - value <= bar

    master_total = sum(games for games, _ in node.master.values())
    status = "new"
    reason = "engine"
    chosen: str | None = None
    for preferred, why in ((mark, "marked"), (usual.uci if usual else None, "usual")):
        if preferred and sound(preferred, KEEP_CP):
            chosen, reason = preferred, why
            # A marked move the player does not actually play yet is still one to learn.
            status = "keep" if usual is not None and preferred == usual.uci else (
                "change" if usual is not None else "new"
            )
            break
    if chosen is None:
        candidates = [
            line.uci for line in node.lines
            if best_eval is not None and best_eval - mover_sign * line.eval_cp <= SOUND_CP
        ]
        if candidates:
            chosen = max(
                candidates,
                key=lambda uci: (node.master.get(uci, (0, None))[0], -candidates.index(uci)),
            )
            reason = "masters" if node.master.get(chosen, (0, None))[0] else "engine"
        if usual is not None and sound(usual.uci) is None and (
            not candidates or not _surely_worse(node, mover_sign, best_eval)
        ):
            # No evidence against the move the player knows: keep it until the
            # engine has looked, rather than make them learn a replacement.
            chosen, reason = usual.uci, "unchecked"
        if chosen is None:
            return None
        if usual is not None:
            status = "keep" if chosen == usual.uci else "change"
        if status == "keep":
            reason = "usual" if reason != "unchecked" else reason

    line = next((line for line in node.lines if line.uci == chosen), None)
    usual_eval = eval_of(usual.uci) if usual else None
    chosen_eval = eval_of(chosen)
    return {
        "uci": chosen,
        "san": _san(node.fen, chosen),
        "status": status,
        "reason": reason,
        "checked": node.multipv,
        "eval_cp": chosen_eval,
        "best_eval_cp": best_eval,
        "idea_san": _pv_san(node.fen, line.pv_uci) if line else None,
        "master_games": node.master.get(chosen, (0, None))[0],
        "master_share": round(node.master.get(chosen, (0, None))[0] / master_total, 3)
        if master_total else None,
        "usual_uci": usual.uci if usual else None,
        "usual_san": usual.san if usual else None,
        "usual_games": usual.games if usual else 0,
        "usual_score": round(usual.points / usual.games, 3) if usual and usual.games else None,
        "usual_loss_cp": max(0, best_eval - usual_eval)
        if usual is not None and usual_eval is not None and best_eval is not None else None,
        "usual_last_played": usual.last_played.isoformat() if usual and usual.last_played else None,
        "games": node.games,
    }


async def build_repertoire(
    session: AsyncSession,
    *,
    username: str,
    color: str,
    time_class: str,
    min_user_rating: int,
) -> dict:
    loader = _Loader(session, username, color, time_class, min_user_rating)
    await loader.load_games()
    mover_sign = 1 if color == "white" else -1
    player_turn = "w" if color == "white" else "b"

    # Breadth first, one level of plies at a time, so each level's data loads in bulk.
    # A frontier entry is (fen, path of plies so far).
    frontier: list[tuple[str, list[dict]]] = [(START_FEN, [])]
    finished: list[list[dict]] = []
    needs_engine: set[str] = set()
    while frontier:
        nodes = [await loader.node(fen) for fen, _ in frontier]
        players = [node for node in nodes if node.fen.split(" ")[1] == player_turn]
        await loader.enrich(nodes, with_evals=False)
        await loader.enrich(players, with_evals=True)
        # The evaluation after each candidate, for moves outside the MultiPV lines,
        # and after each opponent reply, to spot the ones that are mistakes.
        child_ids = {
            edge.child_id for node in nodes for edge in node.edges.values()
        } | {
            to_id for node in players for _, to_id in node.master.values() if to_id is not None
        }
        opponent_ids = {node.position_id for node in nodes if node.position_id is not None}
        child_eval = await loader.child_evals(child_ids | opponent_ids)

        next_frontier: list[tuple[str, list[dict]]] = []
        for (fen, path), node in zip(frontier, nodes, strict=True):
            ply = len(path)
            in_games = node.games > 0
            limit = MAX_PLY if in_games else MAX_NEW_PLY
            if ply >= limit:
                finished.append(path)
                continue
            if fen.split(" ")[1] == player_turn:
                # Only a stored position can take an uploaded evaluation.
                if node.position_id is not None and not node.multipv:
                    needs_engine.add(fen)
                choice = _choose(node, mover_sign=mover_sign, child_eval=child_eval,
                                 mark=loader.marks.get(fen))
                if choice is None:
                    finished.append(path)
                    continue
                if choice["reason"] == "unchecked" and node.multipv:
                    # The move was not among the lines: judging it takes a search of
                    # the position it leads to.
                    edge = node.edges.get(choice["uci"])
                    if edge is not None and edge.child_id not in child_eval:
                        needs_engine.add(_after(fen, choice["uci"]))
                step = {"ply": ply + 1, "fen": fen, "side": "you", **choice}
                next_frontier.append((_after(fen, choice["uci"]), [*path, step]))
                continue

            # The opponent's move: what they actually play against this player.
            total = node.games
            replies = [
                edge for edge in sorted(node.edges.values(), key=lambda e: e.games, reverse=True)
                if edge.games >= MIN_REPLY_GAMES and edge.games >= MIN_REPLY_SHARE * total
            ][:MAX_REPLIES]
            source = "games"
            # Past a changed move the player's own games run out, so the line
            # carries on with what masters play, for a few moves.
            if not replies and ply < MAX_NEW_PLY and node.master:
                master_total = sum(games for games, _ in node.master.values())
                replies = [
                    _Edge(uci=uci, san=_san(fen, uci), child_id=to_id or 0, games=0)
                    for uci, (games, to_id) in sorted(
                        node.master.items(), key=lambda item: item[1][0], reverse=True
                    )
                    if games >= MIN_MASTER_REPLY_SHARE * master_total
                ][:MAX_MASTER_REPLIES]
                source = "masters"
            if not replies:
                finished.append(path)
                continue
            before = child_eval.get(node.position_id) if node.position_id is not None else None
            for edge in replies:
                after = child_eval.get(edge.child_id)
                # The opponent's loss, from their side.
                trap_cp = (
                    mover_sign * (after - before)
                    if before is not None and after is not None else None
                )
                step = {
                    "ply": ply + 1,
                    "fen": fen,
                    "side": "opponent",
                    "uci": edge.uci,
                    "san": edge.san,
                    "source": source,
                    "games": edge.games,
                    "share": round(edge.games / total, 3) if total else None,
                    "trap_cp": trap_cp if trap_cp is not None and trap_cp >= TRAP_CP else None,
                }
                next_frontier.append((_after(fen, edge.uci), [*path, step]))
        frontier = next_frontier

    lines = []
    seen: dict[tuple, int] = {}
    for path in finished:
        yours = [step for step in path if step["side"] == "you"]
        if not yours:
            continue
        # Move orders that transpose into the same position teach the same
        # thing unless they differ in what there is to learn: one lesson, taken
        # along the route played most. (Seven routes into one Giuoco Pianissimo
        # position otherwise made seven lessons of the same "keep" moves.)
        signature = (
            _after(path[-1]["fen"], path[-1]["uci"]),
            frozenset((step["fen"], step["uci"]) for step in yours if step["status"] == "change"),
            frozenset((step["fen"], step["uci"]) for step in path if step.get("trap_cp")),
        )
        ucis = [step["uci"] for step in path]
        last_known = next(
            (step for step in reversed(path) if step["side"] == "opponent" and step.get("games")),
            None,
        )
        first_games = next((step["games"] for step in path if step["side"] == "you"), 0)
        name_id = None
        for step in path:
            node = loader.nodes.get(_after(step["fen"], step["uci"]))
            if node and node.position_id in loader.opening_names:
                name_id = node.position_id
        games = last_known["games"] if last_known else first_games
        if signature in seen:
            kept = lines[seen[signature]]
            if games > kept["games"]:
                kept.update(moves=path, id=_line_id(ucis), first_move=path[0]["san"])
            kept["games"] = max(kept["games"], games)
            continue
        seen[signature] = len(lines)
        lines.append({
            "id": _line_id(ucis),
            "name": loader.opening_names.get(name_id) if name_id else None,
            "first_move": path[0]["san"],
            "moves": path,
            "games": games,
            "changes": sum(1 for step in yours if step["status"] == "change"),
            "traps": sum(1 for step in path if step.get("trap_cp")),
            "unchecked": sum(1 for step in yours if not step["checked"]),
        })
    lines.sort(key=lambda line: line["games"], reverse=True)
    return {
        "username": username,
        "color": color,
        "time_class": time_class,
        "min_user_rating": min_user_rating,
        "lines": lines[:MAX_LINES],
        "needs_engine": sorted(needs_engine),
        "multipv": MULTIPV,
    }
