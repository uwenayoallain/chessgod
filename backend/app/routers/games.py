from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.position import Position
from app.schemas.game import (
    ColorStats,
    GameListOut,
    GameOut,
    GameStatsOut,
    OpeningDetailStat,
    OpeningGroupListOut,
    OpeningGroupOut,
    OpeningPreviewOut,
    OpeningStat,
    TimeClassStats,
)

router = APIRouter()


def build_game_filters(
    username: str,
    time_class: str | None = None,
    user_result: str | None = None,
    color: str | None = None,
    opening_name: str | None = None,
    eco: str | None = None,
) -> list:
    filters = [Game.username == username]
    if time_class:
        filters.append(Game.time_class == time_class)
    if user_result:
        filters.append(Game.user_result == user_result)
    if color and color != "both":
        filters.append(Game.user_color == color)
    if opening_name:
        if opening_name == "Unknown":
            filters.append(or_(Game.opening_name.is_(None), Game.opening_name == ""))
        else:
            filters.append(Game.opening_name == opening_name)
    if eco:
        filters.append(Game.eco == eco)
    return filters


def apply_position_join(stmt, fen: str | None):
    if not fen:
        return stmt
    return (
        stmt.join(GamePosition, GamePosition.game_id == Game.id)
        .join(Position, Position.id == GamePosition.position_id)
        .where(Position.fen == fen)
    )


@router.get("", response_model=GameListOut)
async def list_games(
    username: str = Query(...),
    time_class: str | None = None,
    user_result: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    opening_name: str | None = None,
    eco: str | None = None,
    fen: str | None = None,
    page: int = 1,
    per_page: int = 50,
    session: AsyncSession = Depends(get_db),
) -> GameListOut:
    filters = build_game_filters(
        username=username,
        time_class=time_class,
        user_result=user_result,
        color=color,
        opening_name=opening_name,
        eco=eco,
    )

    total_stmt = apply_position_join(
        select(func.count(func.distinct(Game.id))).select_from(Game).where(*filters),
        fen,
    )
    total = await session.scalar(total_stmt)
    id_stmt = apply_position_join(
        select(Game.id, Game.played_at)
        .where(*filters)
        .group_by(Game.id, Game.played_at)
        .order_by(Game.played_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page),
        fen,
    )
    result = await session.execute(id_stmt)
    game_ids = [row[0] for row in result.all()]
    if not game_ids:
        return GameListOut(games=[], total=total or 0, page=page, per_page=per_page)

    games_result = await session.execute(select(Game).where(Game.id.in_(game_ids)))
    games_by_id = {game.id: game for game in games_result.scalars().all()}
    games = [
        GameOut.model_validate(games_by_id[game_id])
        for game_id in game_ids
        if game_id in games_by_id
    ]
    return GameListOut(games=games, total=total or 0, page=page, per_page=per_page)


@router.get("/stats", response_model=GameStatsOut)
async def game_stats(
    username: str = Query(...),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> GameStatsOut:
    filters = [Game.username == username]
    if time_class:
        filters.append(Game.time_class == time_class)

    result = await session.execute(select(Game).where(*filters))
    games = list(result.scalars().all())
    if not games:
        return GameStatsOut(
            by_color={"white": ColorStats(), "black": ColorStats()},
            by_time_class={},
            by_opening=[],
        )

    wins = sum(1 for game in games if game.user_result == "win")
    color_stats = {
        "white": ColorStats(
            wins=sum(
                1
                for game in games
                if game.user_color == "white" and game.user_result == "win"
            ),
            losses=sum(
                1
                for game in games
                if game.user_color == "white" and game.user_result == "loss"
            ),
            draws=sum(
                1
                for game in games
                if game.user_color == "white" and game.user_result == "draw"
            ),
        ),
        "black": ColorStats(
            wins=sum(
                1
                for game in games
                if game.user_color == "black" and game.user_result == "win"
            ),
            losses=sum(
                1
                for game in games
                if game.user_color == "black" and game.user_result == "loss"
            ),
            draws=sum(
                1
                for game in games
                if game.user_color == "black" and game.user_result == "draw"
            ),
        ),
    }
    openings = Counter(game.opening_name or "Unknown" for game in games)
    grouped_by_time_class: dict[str, list[Game]] = {}
    for game in games:
        grouped_by_time_class.setdefault(game.time_class, []).append(game)

    by_time_class: dict[str, TimeClassStats] = {}
    for time_class_name, grouped_games in grouped_by_time_class.items():
        class_wins = sum(1 for game in grouped_games if game.user_result == "win")
        class_losses = sum(1 for game in grouped_games if game.user_result == "loss")
        class_draws = sum(1 for game in grouped_games if game.user_result == "draw")
        class_total = len(grouped_games)
        by_time_class[time_class_name] = TimeClassStats(
            games=class_total,
            wins=class_wins,
            losses=class_losses,
            draws=class_draws,
            win_rate=round(class_wins / class_total, 4) if class_total else 0.0,
        )

    return GameStatsOut(
        total_games=len(games),
        win_rate=round(wins / len(games), 4),
        by_color=color_stats,
        by_time_class=by_time_class,
        by_opening=[
            OpeningStat(opening_name=name, games=count)
            for name, count in openings.most_common(10)
        ],
    )


@router.get("/openings", response_model=list[OpeningDetailStat])
async def game_openings(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> list[OpeningDetailStat]:
    filters = build_game_filters(username=username, color=color, time_class=time_class)

    result = await session.execute(select(Game).where(*filters))
    games = list(result.scalars().all())

    grouped: dict[str, list] = {}
    for game in games:
        key = game.opening_name or "Unknown"
        grouped.setdefault(key, []).append(game)

    stats = []
    for opening_name, group in grouped.items():
        wins = sum(1 for g in group if g.user_result == "win")
        losses = sum(1 for g in group if g.user_result == "loss")
        draws = sum(1 for g in group if g.user_result == "draw")
        count = len(group)
        ratings = [
            g.black_rating if g.user_color == "white" else g.white_rating
            for g in group
            if (g.black_rating if g.user_color == "white" else g.white_rating)
            is not None
        ]
        eco = next((g.eco for g in group if g.eco), None)
        stats.append(
            OpeningDetailStat(
                eco=eco,
                opening_name=opening_name,
                game_count=count,
                wins=wins,
                losses=losses,
                draws=draws,
                win_rate=round(wins / count, 4) if count else 0.0,
                avg_rating=round(sum(ratings) / len(ratings), 1) if ratings else None,
            )
        )

    stats.sort(key=lambda s: s.game_count, reverse=True)
    return stats


@router.get("/opening-groups", response_model=OpeningGroupListOut)
async def game_opening_groups(
    username: str = Query(...),
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    page: int = 1,
    per_page: int = 20,
    session: AsyncSession = Depends(get_db),
) -> OpeningGroupListOut:
    filters = build_game_filters(username=username, color=color, time_class=time_class)
    result = await session.execute(
        select(Game).where(*filters).order_by(Game.played_at.desc(), Game.id.desc())
    )
    games = list(result.scalars().all())

    grouped: dict[tuple[str | None, str], list[Game]] = {}
    for game in games:
        key = (game.eco, game.opening_name or "Unknown")
        grouped.setdefault(key, []).append(game)

    openings: list[OpeningGroupOut] = []
    for (eco, opening_name), group in grouped.items():
        wins = sum(1 for game in group if game.user_result == "win")
        losses = sum(1 for game in group if game.user_result == "loss")
        draws = sum(1 for game in group if game.user_result == "draw")
        representative = group[0]
        openings.append(
            OpeningGroupOut(
                eco=eco,
                opening_name=opening_name,
                game_count=len(group),
                wins=wins,
                losses=losses,
                draws=draws,
                latest_played_at=representative.played_at,
                representative_game_id=representative.id,
            )
        )

    openings.sort(
        key=lambda opening: (opening.latest_played_at, opening.game_count), reverse=True
    )
    start = (page - 1) * per_page
    end = start + per_page
    return OpeningGroupListOut(
        openings=openings[start:end],
        total=len(openings),
        page=page,
        per_page=per_page,
    )


@router.get("/opening-preview", response_model=OpeningPreviewOut)
async def get_opening_preview(
    username: str = Query(...),
    opening_name: str = Query(...),
    eco: str | None = None,
    color: str = Query("both", pattern="^(white|black|both)$"),
    time_class: str | None = None,
    session: AsyncSession = Depends(get_db),
) -> OpeningPreviewOut:
    filters = build_game_filters(
        username=username,
        color=color,
        time_class=time_class,
        opening_name=opening_name,
        eco=eco,
    )
    game = await session.scalar(
        select(Game)
        .where(*filters)
        .order_by(Game.played_at.desc(), Game.id.desc())
        .limit(1)
    )
    if game is None:
        raise HTTPException(status_code=404, detail="Opening preview not found")

    return OpeningPreviewOut(
        eco=game.eco,
        opening_name=game.opening_name or opening_name,
        representative_game=GameOut.model_validate(game),
    )


@router.get("/{game_id}", response_model=GameOut)
async def get_game(game_id: int, session: AsyncSession = Depends(get_db)) -> GameOut:
    game = await session.get(Game, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found")
    return GameOut.model_validate(game)
