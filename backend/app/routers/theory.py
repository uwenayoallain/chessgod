from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.game import Game
from app.schemas.theory import (
    DeviationOut,
    TheoryComparisonOut,
    TheoryMove,
    TrainingLineOut,
    TrainingMoveOut,
)
from app.services.pgn_parser import parse_game_pgn
from app.services.theory import (
    build_deep_training_line,
    build_training_line_from_parsed_game,
    build_deviation,
    build_seeded_deviation,
    get_local_master_data,
    load_candidate_positions,
    load_moves_for_position,
    load_position_by_fen,
    master_data_state,
    serialize_master_move,
    serialize_user_move,
)
from app.services.common_book import get_common_book_moves

router = APIRouter()


def empty_master_data() -> dict:
    return {"white": 0, "draws": 0, "black": 0, "opening": {}, "moves": []}


@router.get("/compare", response_model=TheoryComparisonOut)
async def theory_compare(
    fen: str = Query(...),
    session: AsyncSession = Depends(get_db),
) -> TheoryComparisonOut:
    position = await load_position_by_fen(session, fen)
    user_moves = []
    master_data = empty_master_data()
    color = "white"
    data_state = "missing"
    if position is not None:
        user_moves = await load_moves_for_position(session, position.id)
        color = "white" if user_moves and user_moves[0].is_white_move else "black"
        data_state = master_data_state(position, user_moves)
        master_data = get_local_master_data(position, user_moves)

    combined_master_moves: list[dict] = list(master_data.get("moves", []))
    combined_move_ucis = {
        move.get("uci") for move in combined_master_moves if move.get("uci")
    }
    combined_move_sans = {
        move.get("san") for move in combined_master_moves if move.get("san")
    }
    for book_move in get_common_book_moves(fen):
        uci = book_move.get("uci")
        san = book_move.get("san")
        if (uci and uci in combined_move_ucis) or (san and san in combined_move_sans):
            continue
        combined_master_moves.append(
            {
                "san": san,
                "uci": uci,
                "white": 0,
                "draws": 0,
                "black": 0,
            }
        )
        if uci:
            combined_move_ucis.add(uci)
        if san:
            combined_move_sans.add(san)

    return TheoryComparisonOut(
        fen=fen,
        user_moves=[
            TheoryMove(
                san=move["san"],
                uci=move["uci"],
                game_count=move["game_count"],
                win_rate=move["win_rate"],
            )
            for move in [serialize_user_move(move, color) for move in user_moves]
        ],
        master_moves=[
            TheoryMove(
                san=move["san"],
                uci=move.get("uci"),
                game_count=move["game_count"],
                win_rate=move["win_rate"],
            )
            for move in [
                serialize_master_move(move, color) for move in combined_master_moves
            ]
        ],
        eco=master_data.get("opening", {}).get("eco"),
        opening_name=master_data.get("opening", {}).get("name"),
        master_data_state=data_state,
    )


@router.get("/deviations", response_model=list[DeviationOut])
async def theory_deviations(
    color: str = Query(..., pattern="^(white|black)$"),
    min_games: int = Query(5, ge=1),
    session: AsyncSession = Depends(get_db),
) -> list[DeviationOut]:
    candidates = await load_candidate_positions(
        session, color=color, min_games=min_games
    )
    deviations: list[DeviationOut] = []

    for position, moves in candidates:
        data_state = master_data_state(position, moves)
        if data_state == "missing":
            continue
        user_moves = [serialize_user_move(move, color) for move in moves]
        master_data = get_local_master_data(position, moves)
        master_moves = [
            serialize_master_move(move, color) for move in master_data.get("moves", [])
        ]
        deviation_builder = build_deviation if data_state == "synced" else build_seeded_deviation
        deviation = deviation_builder(
            fen=position.fen,
            user_moves=user_moves,
            master_moves=master_moves,
            eco=master_data.get("opening", {}).get("eco"),
            opening_name=master_data.get("opening", {}).get("name"),
        )
        if deviation is not None:
            deviations.append(DeviationOut.model_validate(deviation))

    return deviations


@router.get("/eco")
async def theory_eco(
    fen: str = Query(...),
    session: AsyncSession = Depends(get_db),
) -> dict[str, str | None]:
    position = await load_position_by_fen(session, fen)
    if position is None:
        raise HTTPException(status_code=404, detail="Opening not found")
    data = get_local_master_data(position, await load_moves_for_position(session, position.id))
    opening = data.get("opening")
    if not opening:
        raise HTTPException(status_code=404, detail="Opening not found")
    return {"eco": opening.get("eco"), "name": opening.get("name")}


@router.get("/training-line", response_model=TrainingLineOut)
async def theory_training_line(
    username: str = Query(...),
    opening_name: str = Query(...),
    eco: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> TrainingLineOut:
    stmt = select(Game).where(
        Game.username == username, Game.opening_name == opening_name
    )
    if eco:
        stmt = stmt.where(Game.eco == eco)
    if color != "both":
        stmt = stmt.where(Game.user_color == color)
    if time_class:
        stmt = stmt.where(Game.time_class == time_class)

    game = await session.scalar(
        stmt.order_by(Game.played_at.desc(), Game.id.desc()).limit(1)
    )
    if game is None:
        raise HTTPException(status_code=404, detail="Training line not found")

    moves = await build_deep_training_line(session)
    if not moves:
        parsed = parse_game_pgn(game.pgn)
        moves = await build_training_line_from_parsed_game(session, parsed)
    if not moves:
        raise HTTPException(
            status_code=404, detail="No master-theory line found for this opening"
        )

    return TrainingLineOut(
        eco=game.eco,
        opening_name=game.opening_name or opening_name,
        source_game_id=game.id,
        moves=[TrainingMoveOut.model_validate(move) for move in moves],
    )
