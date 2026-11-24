"""Import annotated course material and train it with shared move progress."""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from hashlib import sha256
from io import StringIO

import chess
import chess.pgn
import httpx
from fastapi import HTTPException
from sqlalchemy import and_, case, delete, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer
from starlette.concurrency import run_in_threadpool

from app.models.study_course import StudyChapter, StudyCourse
from app.models.training import LineMoveProgress, TrainingEvent
from app.services import training
from app.services.training import LEVEL_INTERVALS, MASTERED_LEVEL, MAX_MOVE_LEVEL, _LINE_REVIEW_RECEIPT
from app.utils.fen import normalize_fen

MAX_CHAPTERS = 50
MAX_LINES = 40
MAX_PLIES = 60
MAX_PGN_BYTES = 4 * 1024 * 1024
_STUDY_ID = re.compile(r"[A-Za-z0-9]{8}")
_STUDY_URL = re.compile(r"https://lichess\.org/study/([A-Za-z0-9]{8})(?:/[A-Za-z0-9]{8})?")
_LINE_ID = re.compile(r"ch([1-9][0-9]?)-l[1-9][0-9]?")
_ANNOTATION = re.compile(r"\[%(cal|csl|clk|eval)(?:\s+([^\]]*))?\]")
_SQUARE = r"[a-h][1-8]"
_ARROW = re.compile(rf"([GRBY])({_SQUARE})({_SQUARE})")
_HIGHLIGHT = re.compile(rf"([GRBY])({_SQUARE})")
_COLORS = {"G": "green", "R": "red", "B": "blue", "Y": "yellow"}


class _CourseGameBuilder(chess.pgn.GameBuilder):
    def handle_error(self, error: Exception) -> None:
        self.game.errors.append(error)

    def visit_move(self, board: chess.Board, move: chess.Move) -> None:
        if not move:
            self.handle_error(ValueError("Null moves cannot be trained."))
        super().visit_move(board, move)


def _annotations(note: str) -> dict:
    arrows = []
    highlights = []
    for tag, entries in _ANNOTATION.findall(note):
        if tag == "cal":
            for entry in entries.split(","):
                if match := _ARROW.fullmatch(entry.strip()):
                    color, start, end = match.groups()
                    arrows.append({"from": start, "to": end, "color": _COLORS[color]})
        elif tag == "csl":
            for entry in entries.split(","):
                if match := _HIGHLIGHT.fullmatch(entry.strip()):
                    color, square = match.groups()
                    highlights.append({"square": square, "color": _COLORS[color]})
    prose = " ".join(_ANNOTATION.sub(" ", note).split())
    return {"comment": prose or None, "arrows": arrows, "highlights": highlights}


def _chapter_lines(game: chess.pgn.Game, board: chess.Board, position: int, color: str) -> list[dict]:
    start_fen = normalize_fen(board.fen())
    lines = []
    seen_paths = set()
    # Each stack entry follows a single PGN edge from the supplied board.
    # Reverse insertion keeps the main line and its nearest branches first.
    stack = [
        (node, board, [], "" if index else None)
        for index, node in reversed(list(enumerate(game.variations)))
    ]
    while stack and len(lines) < MAX_LINES:
        node, before, prefix, variation_title = stack.pop()
        move = node.move
        san = before.san(move)
        note = " ".join(filter(None, (game.comment if not prefix else "", node.starting_comment, node.comment)))
        steps = [
            *prefix,
            {
                "ply": len(prefix) + 1,
                "fen": normalize_fen(before.fen()),
                "san": san,
                "uci": move.uci(),
                "side": "you" if before.turn == (color == "white") else "opponent",
                **_annotations(note),
            },
        ]
        if variation_title == "":
            variation_title = f"{before.fullmove_number}{'.' if before.turn else '...'}{san}"
        if node.variations and len(steps) < MAX_PLIES:
            after = before.copy(stack=False)
            after.push(move)
            for index in range(len(node.variations) - 1, -1, -1):
                title = "" if index else variation_title
                stack.append((node.variations[index], after, steps, title))
            continue

        path = tuple(step["uci"] for step in steps)
        if path in seen_paths:
            continue
        seen_paths.add(path)
        lines.append({
            "id": f"ch{position}-l{len(lines) + 1}",
            "title": "Main line" if variation_title is None else f"Variation: {variation_title}",
            "start_fen": start_fen,
            "moves": steps,
        })
    return lines


def _chapter_title(game: chess.pgn.Game, position: int) -> tuple[str, str | None]:
    headers = game.headers
    event = headers.get("Event", "").strip()
    study_title = headers.get("StudyName", "").strip()
    chapter_title = headers.get("ChapterName", "").strip()
    if not chapter_title and ": " in event:
        event_study, event_chapter = event.split(": ", 1)
        if headers.get("Site", "").startswith("https://lichess.org/study/"):
            study_title = study_title or event_study
            chapter_title = event_chapter
    return chapter_title or (event if event != "?" else "") or f"Chapter {position}", study_title or None


def parse_pgn_chapters(pgn: str, color: str = "auto") -> list[dict]:
    """Read standard-chess PGN into a bounded set of lines with one course orientation."""
    if len(pgn.encode("utf-8")) > MAX_PGN_BYTES:
        raise HTTPException(status_code=400, detail="A course PGN must be at most 4 MiB.")
    if "\x00" in pgn:
        raise HTTPException(status_code=400, detail="The PGN contains an invalid null character.")

    pgn = pgn.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    stream = StringIO(pgn)
    chapters = []
    while len(chapters) < MAX_CHAPTERS:
        start = stream.tell()
        game = chess.pgn.read_game(stream, Visitor=_CourseGameBuilder)
        if game is None:
            break
        position = len(chapters) + 1
        if game.errors:
            raise HTTPException(status_code=400, detail=f"Invalid PGN moves or headers in chapter {position}.")
        if not game.variations:
            continue

        board = game.board()
        if type(board) is not chess.Board or board.chess960 or not board.is_valid():
            raise HTTPException(
                status_code=400,
                detail=f"Chapter {position} must begin from a valid standard chess position.",
            )
        if color == "auto":
            color = "black" if game.headers.get("Orientation", "").strip().lower() == "black" else "white"

        title, study_title = _chapter_title(game, position)
        chapters.append({
            "position": position,
            "title": title,
            "study_title": study_title,
            "color": color,
            "start_fen": normalize_fen(board.fen()),
            "pgn": pgn[start:stream.tell()].strip(),
            "lines": _chapter_lines(game, board, position, color),
        })
    return chapters


def lichess_study_id(value: str) -> str:
    value = value.strip()
    if _STUDY_ID.fullmatch(value):
        return value
    if match := _STUDY_URL.fullmatch(value):
        return match[1]
    raise HTTPException(status_code=400, detail="Enter a Lichess study URL or an 8-character study ID.")


async def fetch_lichess_study_pgn(lichess_url: str) -> str:
    study_id = lichess_study_id(lichess_url)
    url = f"https://lichess.org/api/study/{study_id}.pgn"
    params = {"comments": "true", "variations": "true", "clocks": "false", "orientation": "true"}
    try:
        async with httpx.AsyncClient(
            timeout=20.0, headers={"User-Agent": "ChessGod/1.0"}, follow_redirects=False,
        ) as client:
            async with client.stream("GET", url, params=params) as response:
                if response.status_code in (403, 404):
                    raise HTTPException(status_code=404, detail="This Lichess study is private or could not be found.")
                if response.status_code == 429:
                    raise HTTPException(status_code=502, detail="Lichess is rate limiting study exports. Try again shortly.")
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > MAX_PGN_BYTES:
                        raise HTTPException(status_code=502, detail="The Lichess study export exceeds 4 MiB.")
                    body.extend(chunk)
                return body.decode(response.encoding or "utf-8", errors="replace")
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Could not download the PGN from Lichess.") from error


def _utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def _player_moves(lines: Iterable[dict]) -> Iterator[dict]:
    return (move for line in lines for move in line["moves"] if move["side"] == "you")


async def _load_progress(
    session: AsyncSession,
    username: str,
    color: str,
    lines: Iterable[dict],
) -> dict[tuple[str, str], LineMoveProgress]:
    wanted = {(move["fen"], move["uci"]) for move in _player_moves(lines)}
    fens = sorted({fen for fen, _ in wanted})
    progress: dict[tuple[str, str], LineMoveProgress] = {}
    for offset in range(0, len(fens), 500):
        rows = await session.scalars(
            select(LineMoveProgress)
            .where(
                LineMoveProgress.username == username,
                LineMoveProgress.color == color,
                LineMoveProgress.fen.in_(fens[offset:offset + 500]),
            )
            .execution_options(populate_existing=True)
        )
        progress.update({
            (row.fen, row.move_uci): row for row in rows if (row.fen, row.move_uci) in wanted
        })
    return progress


def _line_progress(
    line: dict, progress: dict[tuple[str, str], LineMoveProgress], now: datetime, *,
    include_moves: bool = True,
) -> dict:
    moves = []
    levels = []
    due_moves = 0
    for move in line["moves"]:
        if move["side"] == "opponent":
            if include_moves:
                moves.append(move)
            continue
        row = progress.get((move["fen"], move["uci"]))
        level = row.level if row else 0
        due_at = _utc(row.due_at) if row else None
        due = level > 0 and due_at is not None and due_at <= now
        levels.append(level)
        due_moves += int(due)
        if include_moves:
            moves.append({
                **move, "level": level, "due": due, "seen": row is not None,
                "next_review_at": due_at.isoformat() if due_at else None,
            })

    known = sum(level > 0 for level in levels)
    if not levels or known < len(levels):
        status = "new"
    elif due_moves:
        status = "due"
    elif min(levels) >= MASTERED_LEVEL:
        status = "mastered"
    else:
        status = "learning"
    result = {"your_moves": len(levels), "known_moves": known, "due_moves": due_moves, "status": status}
    if include_moves:
        return {**line, **result, "moves": moves}
    return result


def _course_data(
    course: StudyCourse,
    chapters: list[StudyChapter],
    progress: dict[tuple[str, str], LineMoveProgress],
    now: datetime,
    *,
    detail: bool = False,
) -> dict:
    summary = {
        "id": course.id,
        "title": course.title,
        "color": course.color,
        "source_type": course.source_type,
        "source_ref": course.source_ref,
        "description": course.description,
        "created_at": _utc(course.created_at).isoformat(),
        "updated_at": _utc(course.updated_at).isoformat(),
        "chapter_count": len(chapters),
        "line_count": 0,
        "your_moves": 0,
        "known_moves": 0,
        "due_moves": 0,
    }
    chapter_details = []
    for chapter in chapters:
        lines = [_line_progress(line, progress, now, include_moves=detail) for line in chapter.lines_json]
        summary["line_count"] += len(lines)
        for field in ("your_moves", "known_moves", "due_moves"):
            summary[field] += sum(line[field] for line in lines)
        if detail:
            chapter_details.append({
                "id": chapter.id, "position": chapter.position, "title": chapter.title,
                "start_fen": chapter.start_fen, "lines": lines,
            })
    if detail:
        summary["chapters"] = chapter_details
    return summary


async def _owned_course(
    session: AsyncSession, username: str, course_id: int, *, lock: bool = False,
) -> StudyCourse:
    query = select(StudyCourse).where(StudyCourse.id == course_id, StudyCourse.username == username)
    course = await session.scalar(query.with_for_update() if lock else query)
    if course is None:
        raise HTTPException(status_code=404, detail="Study course not found.")
    return course


async def _course_chapters(session: AsyncSession, course_id: int) -> list[StudyChapter]:
    rows = await session.scalars(
        select(StudyChapter)
        .options(defer(StudyChapter.pgn))
        .where(StudyChapter.course_id == course_id)
        .order_by(StudyChapter.position)
    )
    return list(rows)


async def list_courses(session: AsyncSession, username: str) -> dict:
    rows = await session.execute(
        select(StudyCourse, StudyChapter)
        .options(defer(StudyChapter.pgn))
        .outerjoin(StudyChapter)
        .where(StudyCourse.username == username)
        .order_by(StudyCourse.created_at.desc(), StudyCourse.id.desc(), StudyChapter.position)
    )
    courses = {}
    for course, chapter in rows:
        chapters = courses.setdefault(course, [])
        if chapter is not None:
            chapters.append(chapter)
    progress = {}
    for color in {course.color for course in courses}:
        lines = (
            line for course, chapters in courses.items() if course.color == color
            for chapter in chapters for line in chapter.lines_json
        )
        progress[color] = await _load_progress(session, username, color, lines)
    now = datetime.now(UTC)
    return {
        "courses": [
            _course_data(course, chapters, progress[course.color], now)
            for course, chapters in courses.items()
        ],
        "presets": [
            {key: value for key, value in preset.items() if key != "pgn"}
            for preset in BUILTIN_COURSE_PRESETS.values()
        ],
    }


async def get_course(session: AsyncSession, username: str, course_id: int) -> dict:
    course = await _owned_course(session, username, course_id)
    chapters = await _course_chapters(session, course_id)
    progress = await _load_progress(
        session, username, course.color, (line for chapter in chapters for line in chapter.lines_json),
    )
    return _course_data(course, chapters, progress, datetime.now(UTC), detail=True)


async def import_course(
    session: AsyncSession, *, username: str, title: str | None, color: str,
    lichess_url: str | None, pgn: str | None, preset_id: str | None,
) -> dict:
    source_type, source_ref, description = "pgn", None, None
    if preset_id is not None:
        preset = BUILTIN_COURSE_PRESETS.get(preset_id)
        if preset is None:
            raise HTTPException(status_code=404, detail="Study course preset not found.")
        title = title or preset["title"]
        color, pgn, description = preset["color"], preset["pgn"], preset["description"]
        source_type, source_ref = "builtin", preset_id
    elif lichess_url is not None:
        study_id = lichess_study_id(lichess_url)
        source_type, source_ref = "lichess", f"https://lichess.org/study/{study_id}"
        pgn = await fetch_lichess_study_pgn(study_id)

    chapters = await run_in_threadpool(parse_pgn_chapters, pgn or "", color)
    if not chapters:
        raise HTTPException(status_code=400, detail="The PGN does not contain any playable moves.")
    first = chapters[0]
    course = StudyCourse(
        username=username, title=title or first["study_title"] or first["title"], color=first["color"],
        source_type=source_type, source_ref=source_ref, description=description,
    )
    session.add(course)
    await session.flush()
    stored_chapters = [
        StudyChapter(
            course_id=course.id, position=chapter["position"], title=chapter["title"],
            start_fen=chapter["start_fen"], pgn=chapter["pgn"], lines_json=chapter["lines"],
        )
        for chapter in chapters
    ]
    session.add_all(stored_chapters)
    await session.flush()
    progress = await _load_progress(
        session, username, course.color, (line for chapter in stored_chapters for line in chapter.lines_json),
    )
    result = _course_data(course, stored_chapters, progress, datetime.now(UTC), detail=True)
    await session.commit()
    return result


async def delete_course(session: AsyncSession, username: str, course_id: int) -> dict:
    course = await _owned_course(session, username, course_id, lock=True)
    # Explicit cleanup also works on SQLite connections without FK enforcement.
    await session.execute(delete(StudyChapter).where(StudyChapter.course_id == course_id))
    await session.delete(course)
    await session.commit()
    return {"deleted": True, "id": course_id}


def _grade_review(line: dict, moves: list[dict]) -> tuple[dict[tuple[str, str], bool], int]:
    remaining = Counter((move["fen"], move["uci"]) for move in _player_moves([line]))
    results = {}
    recalled = 0
    for move in moves:
        key = (normalize_fen(" ".join(move["fen"].split())), move["expected_uci"])
        if not remaining[key]:
            raise HTTPException(status_code=400, detail="A reviewed move does not match a player move in this line.")
        remaining[key] -= 1
        correct = move["played_uci"] == key[1] and not move["hinted"]
        recalled += int(correct)
        # A repeated position shares memory. A miss in any occurrence takes priority.
        results[key] = results.get(key, True) and correct
    return results, recalled


async def _upsert_progress(
    session: AsyncSession, course: StudyCourse, results: dict[tuple[str, str], bool], now: datetime,
) -> None:
    if not results:
        return

    insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
    progress = LineMoveProgress
    due = or_(progress.level < 1, progress.due_at <= now)
    higher_level = case((progress.level < MAX_MOVE_LEVEL, progress.level + 1), else_=MAX_MOVE_LEVEL)
    next_due = case(
        {level - 1: now + interval for level, interval in LEVEL_INTERVALS.items()},
        value=progress.level, else_=now + LEVEL_INTERVALS[MAX_MOVE_LEVEL],
    )
    first_due = now + LEVEL_INTERVALS[1]
    # A consistent lock order handles overlapping lines and courses safely on PostgreSQL.
    statement = insert(progress).values([
        {
            "username": course.username, "color": course.color, "fen": fen, "move_uci": uci,
            "level": 1, "due_at": first_due, "reviews": 1, "recalls": int(correct),
            "lapses": int(not correct), "last_reviewed_at": now,
        }
        for (fen, uci), correct in sorted(results.items())
    ])
    recalled = statement.excluded.recalls == 1
    climbs = and_(recalled, due)
    await session.execute(statement.on_conflict_do_update(
        index_elements=["username", "fen", "move_uci"],
        set_={
            "color": course.color,
            "level": case((climbs, higher_level), (recalled, progress.level), else_=1),
            "due_at": case((climbs, next_due), (recalled, progress.due_at), else_=first_due),
            "reviews": progress.reviews + 1,
            "recalls": progress.recalls + statement.excluded.recalls,
            "lapses": progress.lapses + statement.excluded.lapses,
            "last_reviewed_at": now,
        },
    ))


async def _claim_review(
    session: AsyncSession, username: str, request_id: str, fingerprint: str,
) -> tuple[TrainingEvent | None, dict | None]:
    key = f"study-course-review:{sha256(request_id.encode()).hexdigest()}"
    insert = sqlite_insert if session.get_bind().dialect.name == "sqlite" else pg_insert
    receipt = await session.scalar(
        insert(TrainingEvent)
        .values(username=username, kind=_LINE_REVIEW_RECEIPT, xp=0, request_id=key)
        .on_conflict_do_nothing(index_elements=["username", "request_id"])
        .returning(TrainingEvent)
    )
    if receipt is not None:
        return receipt, None
    detail = await session.scalar(select(TrainingEvent.detail).where(
        TrainingEvent.username == username, TrainingEvent.request_id == key,
        TrainingEvent.kind == _LINE_REVIEW_RECEIPT,
    ))
    if detail is None or detail["fingerprint"] != fingerprint:
        raise HTTPException(status_code=409, detail="This request ID belongs to a different review.")
    return None, detail["result"]


async def _due_before(
    session: AsyncSession, username: str, keys: Iterable[tuple[str, str]], now: datetime,
) -> dict[tuple[str, str], bool]:
    """Which of these moves were due before this pass, whatever course or colour last wrote them.

    Read as plain booleans before the upsert: the ORM rows are refreshed in
    place later in the request, which would turn them into the new state.
    """
    wanted = set(keys)
    fens = sorted({fen for fen, _ in wanted})
    progress: dict[tuple[str, str], LineMoveProgress] = {}
    for offset in range(0, len(fens), 500):
        rows = await session.scalars(
            select(LineMoveProgress)
            .where(LineMoveProgress.username == username, LineMoveProgress.fen.in_(fens[offset:offset + 500]))
            .execution_options(populate_existing=True)
        )
        progress.update({
            (row.fen, row.move_uci): row for row in rows if (row.fen, row.move_uci) in wanted
        })
    return {move: _was_due(progress.get(move), now) for move in wanted}


def _was_due(row: LineMoveProgress | None, now: datetime) -> bool:
    # The ladder's own rule (`_upsert_progress`): never learned, or its review time has come.
    return row is None or (row.level or 0) < 1 or _utc(row.due_at) <= now


def _reward_delta(before: dict, after: dict) -> dict:
    """What changed, in the shape `/api/training/repertoire/review` returns."""
    unlocked_before = {a["key"] for a in before["achievements"] if a["unlocked_at"]}
    return {
        "leveled_up": after["level"] > before["level"],
        "goal_just_met": after["goal_met_today"] and not before["goal_met_today"],
        "unlocked": [
            a for a in after["achievements"] if a["unlocked_at"] and a["key"] not in unlocked_before
        ],
    }


async def _award_review(
    session: AsyncSession,
    *,
    course: StudyCourse,
    line: dict,
    mode: str,
    results: dict[tuple[str, str], bool],
    reviewed: int,
    recalled: int,
    due_before: dict[tuple[str, str], bool],
    key: str | None,
) -> int:
    """Pay a pass exactly as the repertoire trainer does (`training.record_line_review`).

    Practice pays per move: a due move recalled 3 XP, one recalled early 1, a
    miss (a hinted move included) 1; a clean pass with something due adds the
    perfect-line bonus. Learn pays nothing per move, since the move is shown,
    and pays `line_learned` once for a whole line played without a miss.
    """
    username = course.username
    player_moves = [(move["fen"], move["uci"]) for move in _player_moves([line])]
    complete = reviewed == len(player_moves) and recalled == reviewed and reviewed > 0
    detail = {
        "source": "study_course", "course_id": course.id, "line_id": line["id"],
        "changes": 0, "traps": 0, "moves": len(player_moves),
    }
    xp = 0
    if mode == "practice":
        any_due = False
        for index, ((fen, uci), correct) in enumerate(sorted(results.items())):
            due = due_before[(fen, uci)]
            any_due = any_due or due
            if not correct:
                kind = "move_missed"
            else:
                kind = "move_recalled" if due else "move_early"
            xp += await training.award(
                session, username, kind,
                detail={"fen": fen, "uci": uci, "source": "study_course", "course_id": course.id},
                request_id=f"{key}:move:{index}" if key else None,
            )
        # A clean pass pays only when something in it was due: replaying a line
        # nothing in is due yet would otherwise farm XP.
        if complete and any_due:
            xp += await training.award(
                session, username, "line_perfect", detail=detail,
                request_id=f"{key}:perfect" if key else None,
            )
    elif complete:
        # Once per line content, so deleting and re-importing a course cannot pay it again.
        fingerprint = sha256(json.dumps([course.color, player_moves]).encode()).hexdigest()
        xp += await training.award(
            session, username, "line_learned", detail=detail,
            request_id=f"study-learned:{fingerprint}",
        )
    return xp


async def record_course_review(
    session: AsyncSession, *, username: str, course_id: int, line_id: str,
    mode: str, moves: list[dict], request_id: str | None, now: datetime | None = None,
    tz: str | None = "UTC", daily_goal: int = training.DEFAULT_DAILY_GOAL,
) -> dict:
    course = await _owned_course(session, username, course_id, lock=True)
    match = _LINE_ID.fullmatch(line_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Study course line not found.")
    lines = await session.scalar(
        select(StudyChapter.lines_json).where(
            StudyChapter.course_id == course_id, StudyChapter.position == int(match[1]),
        )
    )
    line = next((line for line in lines or [] if line["id"] == line_id), None)
    if line is None:
        raise HTTPException(status_code=404, detail="Study course line not found.")
    if not moves and any(_player_moves([line])):
        raise HTTPException(status_code=400, detail="Submit at least one player move to review the line.")
    results, recalled = _grade_review(line, moves)

    receipt = None
    key = None
    if request_id is not None:
        fingerprint = sha256(json.dumps([course_id, line_id, mode, moves], sort_keys=True).encode()).hexdigest()
        receipt, previous = await _claim_review(session, course.username, request_id, fingerprint)
        if previous is not None:
            await session.commit()
            return previous
        key = receipt.request_id

    now = now or datetime.now(UTC)
    # Profiles are read on the wall clock: events are stamped with it, so the
    # day, the goal and the streak belong to it even when `now` is supplied.
    profile_before = await training.profile(session, course.username, tz=tz, goal=daily_goal)
    due_before = await _due_before(session, course.username, results, now)
    await _upsert_progress(session, course, results, now)
    xp = await _award_review(
        session, course=course, line=line, mode=mode, results=results,
        reviewed=len(moves), recalled=recalled, due_before=due_before, key=key,
    )
    await training.settle_quests(session, course.username, tz=tz)
    profile_after = await training.profile(session, course.username, tz=tz, goal=daily_goal)
    progress = await _load_progress(session, course.username, course.color, [line])
    stats = _line_progress(line, progress, now, include_moves=False)
    result = {
        "line_id": line_id, "recalled": recalled, "missed": len(moves) - recalled, "total": len(moves),
        "known_moves": stats["known_moves"], "due_moves": stats["due_moves"], "status": stats["status"],
        "xp_gained": xp,
        "reward": {"xp_gained": xp, **_reward_delta(profile_before, profile_after), "profile": profile_after},
    }
    course.updated_at = now
    if receipt is not None:
        receipt.detail = {"fingerprint": fingerprint, "result": result}
    await session.commit()
    return result


BUILTIN_COURSE_PRESETS = {
    "scotch_kings_gambit_black": {
        "id": "scotch_kings_gambit_black",
        "title": "Anti-Scotch & Anti-King's Gambit Survival",
        "color": "black",
        "description": "Answer early central attacks with development, then learn the Italian bishop retreat and Polerio counterattack.",
        "chapter_count": 3,
        "tags": ["Scotch", "King's Gambit", "Italian"],
        "pgn": """
[Event "Scotch: Challenge the queen on d4"]
[Orientation "Black"]

1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nxd4
{Know the escape route from this early trade. The other branches show how to keep more tension on move four.}
(4... Bc5 {The bishop makes the d4 knight account for a second attacker. [%cal Gc5d4]}
 5. Be3 Qf6 {Pressure on d4 ties the e3 bishop to the defense. Recheck c7 before committing to castling. [%cal Gf6d4,Rd4c6]}
 6. c3 Nge7 7. Bc4 O-O 8. O-O Bb6 {The bishop stays on the long diagonal and the c6 knight can move without cutting off the queen.})
(4... Nf6 {Attack e4 immediately. The exchange on c6 gives Black the b-file and a pawn that can contest d5. [%cal Gf6e4]}
 5. Nxc6 bxc6 6. e5 Qe7 {Pin the e-pawn and force White to account for e5 before pushing the knight again. [%cal Ge7e5]}
 7. Qe2 Nd5 8. c4 Ba6 {The c4 pawn is pinned to the queen on e2. Use the tempo to develop. [%cal Ga6e2]})
5. Qxd4 Qf6! {Meet a centralized queen with a direct challenge. A knight on f6 instead gives 6.e5 a useful tempo. [%cal Gf6d4,Re4e5]}
6. Be3 Qxd4 7. Bxd4 Ne7 {Head for c6 and make the bishops spend time finding useful diagonals. [%cal Ge7c6]}
8. Nc3 Nc6 9. Be3 Bb4 {The pin means White cannot immediately use the c3 knight for a kingside jump. [%cal Gb4e1]} *

[Event "King's Gambit: Return the pawn and open the center"]
[Orientation "Black"]

1. e4 e5 2. f4 exf4 {Accept the pawn and prepare to challenge e4 while White's king is still central.}
(2... d5! {The Falkbeer gets the center moving immediately. [%cal Gd7d5,Gd5e4]}
 3. exd5 e4 {Give up the pawn to obstruct Nf3 and gain time for development. [%csl Gf3]}
 (3... exf4 4. Nf3 Nf6 {This move order transposes to the Modern Defense after the exchange on d5.})
 4. d3 Nf6 5. dxe4 Nxe4 6. Nf3 Bc5 {Develop with pressure on f2 and castle as soon as the position permits. [%cal Gc5f2]})
3. Nf3
(3. Bc4 d5 4. Bxd5 Nf6 5. Nc3 c6 6. Bb3 Bd6
 {After gaining time against the bishop, develop and prepare castling. The d6 bishop still protects f4. [%cal Gd6f4]})
3... d5! {An immediate central break deprives White of time to build d4 and Bc4 under ideal conditions. [%cal Gd7d5]}
4. exd5 Nf6 5. Bb5+
(5. Bc4 Nxd5 6. O-O Be7 {Use your turn to unpin the king from the e-file by castling next.})
5... c6 {Give the knight a natural recapture and make White spend another tempo moving the bishop. [%cal Gc7c6]}
6. dxc6 Nxc6 7. O-O Be7 8. d4 O-O {Both kings are safe. Check ...Bd6 and ...Bg4 before deciding whether f4 is worth holding.} *

[Event "Italian: The safe bishop retreat and the Polerio"]
[Orientation "Black"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5
(3... Nf6 4. Ng5 d5 5. exd5 Na5! {The Polerio gains tempo on the c4 bishop. Recapturing on d5 immediately invites Nxf7. [%cal Ga5c4,Rg5f7]}
 6. Bb5+ c6 7. dxc6 bxc6 8. Be2 h6 9. Nf3 e4
 {Keep making threats until the surrendered pawn has paid for active pieces. Now the f3 knight has to move again. [%cal Ge4f3]})
4. c3 Nf6 5. d3 d6 6. O-O O-O 7. d4
(7. Re1 a6 8. a4 Ba7 {In the quieter setup, a7 is a useful retreat. Check for b4 before it arrives with tempo. [%cal Gc5a7]}
 9. h3 h6 {Take g5 away from White and look for a well-supported ...d5 break. [%csl Gg5,Gd5]})
7... Bb6! {Keep the bishop on the a7-g1 diagonal without committing it to a vulnerable check on b4. [%cal Gc5b6,Gb6f2]}
8. Re1 Bg4 {Pin the knight to make White's center harder to reinforce. [%cal Gg4d1]}
9. Be3 Re8 {Strengthen e5 before playing for exchanges in the center. [%cal Ge8e5]} *
""",
    },
    "qgd_vs_d4_black": {
        "id": "qgd_vs_d4_black",
        "title": "Classical QGD & Anti-London System",
        "color": "black",
        "description": "Use the c-pawn to challenge d4, activate the c8 bishop in the Carlsbad, and test the London before it settles.",
        "chapter_count": 3,
        "tags": ["Queen's Gambit Declined", "Carlsbad", "London"],
        "pgn": """
[Event "Classical QGD: Time the c5 break"]
[Orientation "Black"]

1. d4 d5 2. c4 e6 {Reinforce d5 and keep the c-pawn available to challenge White's center. [%cal Ge6d5,Gc7c5]}
3. Nc3 Nf6 4. Bg5
(4. Nf3 Be7 5. Bf4 O-O 6. e3 c5 7. dxc5 Bxc5
 {Once your king is safe, let the bishop recapture on c5. Its pressure on e3 makes White's next central move less obvious. [%cal Gc5e3]})
4... Be7 {Break the pin by interposing your own bishop and prepare to castle. [%cal Gf8e7]}
5. e3 O-O 6. Nf3 h6
(6... c5 7. dxc5 Bxc5 8. cxd5 exd5 9. Be2 Nc6
 {If the center leaves you with an isolated d-pawn, use the active pieces it buys. Look for d4 before White blockades it. [%cal Gd5d4]})
7. Bh4 b6 {Prepare to develop the light bishop. The option of ...Bb7 also makes an exchange on d5 less awkward. [%cal Gc8b7]}
8. cxd5 Nxd5 9. Bxe7 Qxe7 10. Nxd5 exd5 11. Rc1 Be6 12. Bd3 c5
{The bishop from c8 supports the pawn on d5. If the pawns become hanging pawns, keep them mobile so White cannot blockade both. [%cal Gc7c5,Ge6d5]} *

[Event "Exchange QGD: Fight the minority attack"]
[Orientation "Black"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. cxd5 exd5 5. Bg5 c6
{Hold d5, then decide whether the c8 bishop should go to f5 or stay home for a few moves. White's queen placement matters. [%cal Gc6d5,Gc8f5]}
6. Qc2
(6. e3 Bf5 {Here you can develop the bishop outside the pawn chain. White can test the bishop with Qf3. [%cal Gc8f5]}
 7. Qf3 Bg6 8. Bxf6 Qxf6 9. Qxf6 gxf6 10. Nge2 Nd7 11. Nf4 Bd6
 {Black has doubled f-pawns but two active bishops. Use the open g-file and keep d5 protected. [%cal Gd6f4,Gh8g8]})
6... Be7 {With the queen eyeing f5, clear the path to castle first. [%cal Rc2f5]}
7. e3 O-O 8. Bd3 Nbd7 9. Nf3 Re8 10. O-O Nf8
{Free d7 and bring the knight toward g6. White's rook on b1 will telegraph the push to b5. [%cal Gf8g6,Rb2b4]}
11. Rab1 Ne4 {Putting the f6 knight on e4 forces White to consider the kingside before pushing b4-b5. [%cal Gf6e4]}
(11... a5 12. a3 Bd6 {Fix the a-pawn before b4, then aim the bishop at h2. White can still prepare b4, so use the time. [%cal Gd6h2]})
12. Bxe7 Qxe7 13. b4 Bf5 {Develop outside the pawn chain and reinforce e4, keeping the knight in place while White advances on the queenside. [%cal Gf5e4]} *

[Event "Anti-London: Attack the base and trade the bishop"]
[Orientation "Black"]

1. d4 d5 2. Bf4 c5! {Challenge d4 before White can reinforce with e3 and c3. [%cal Gc5d4]}
3. e3 Nc6 4. c3
(4. Nf3 Qb6 {Without c3, White's queen has fewer easy ways to cover b2. The pressure makes White commit to a defense. [%cal Gb6b2]}
 5. Nc3 Nf6 6. Bb5 e6 {Break the pin by developing and castling. Keep the c5 pawn in play while White's queen is still home.})
4... Nf6 5. Nd2 e6 6. Ngf3 Bd6 {Question White's best bishop before a knight establishes itself on e5. [%cal Gd6f4,Gf6e4]}
7. Bg3 O-O
(7... Bxg3 8. hxg3 Qd6 9. Bd3 e5 {Strike e3 and d4 through the center. Before castling short, also account for the newly open h-file. [%cal Ge5d4,Rh1h8]})
8. Bd3 b6 9. O-O Bb7 {The bishop behind d5 becomes active when the center opens. Consider ...Ne4 with c5 still attacking d4. [%cal Gb7e4,Gf6e4]} *
""",
    },
    "italian_giuoco_white": {
        "id": "italian_giuoco_white",
        "title": "Complete Giuoco Pianissimo & Italian Plans",
        "color": "white",
        "description": "Learn when to tour the knight, preserve the Italian bishop, and open the center against the Two Knights.",
        "chapter_count": 3,
        "tags": ["Italian", "Giuoco Pianissimo", "Two Knights"],
        "pgn": """
[Event "Pianissimo: The knight tour and a4"]
[Orientation "White"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6
{The c-pawn supports a later d4 break. With d3 you can finish development before choosing when to open the center. [%cal Gc3d4,Gd3d4]}
6. O-O O-O 7. Re1 a6
(7... a5 8. Nbd2 h6 9. Nf1 Re8 10. Ng3 Be6 11. Bb5
 {When Black already controls b4, use the time for the knight tour. Bb5 keeps pressure on the c6 knight. [%cal Gb5c6,Gg3f5]})
8. a4 {Discourage ...b5 and keep a2 available as a bishop retreat. [%cal Ga4b5,Gc4a2]}
8... Ba7 9. h3 h6 10. Nbd2 Re8 11. Nf1 {The rook on e1 covers e4 while the knight crosses to g3. [%cal Gd2f1,Gf1g3]}
11... Be6 12. Ng3 Bxc4 13. dxc4 {You can accept doubled c-pawns here. The open d-file gives you play, and both the c4 pawn and the g3 knight fight for d5 and f5. [%csl Gd5,Gf5]} *

[Event "Pianissimo: Decide what to do with the bishop"]
[Orientation "White"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. O-O d6 6. c3 O-O 7. Re1 Be6
(7... Na5 8. Bb5 c6 9. Ba4 b5 10. Bc2
 {Let Black spend pawn moves chasing your bishop. From c2 it can support e4 and watch h7 once you have shifted the d-pawn. [%cal Gc2e4,Gc2h7]})
8. Bb3 {Preserve the Italian bishop's pressure on f7. If Black trades on b3, the a-pawn recapture opens a file for your rook. [%cal Ga2b3]}
(8. Bxe6 fxe6 9. b4 Bb6 10. Nbd2
 {The exchange gives up the bishop pair but invites Black to defend e6. Watch the semi-open f-file before attacking there yourself. [%csl Re6,Rf2]})
8... Qd7 9. Nbd2 a5 10. Nf1 {The next knight jump is usually g3. Look at ...Bxb3 axb3 before committing a4, since an open a-file can favor your rook. [%cal Gf1g3,Ga1a7]} *

[Event "Two Knights: Meet d5 with development"]
[Orientation "White"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 {Defend e4 so you can enter Italian structures without the forced complications of Ng5. [%cal Gd3e4]}
4... Bc5
(4... Be7 5. O-O O-O 6. Re1 d6 7. c3
 {With Black's bishop on e7, keep d4 in reserve until your queen knight can enter without leaving e4 weak. [%cal Gc3d4]})
5. O-O O-O 6. c3 d5 7. exd5 {Release the tension. If Black uses the knight to recover on d5, the e5 pawn is now a lasting target. [%cal Ge4d5,Ge1e5]}
7... Nxd5
(7... Na5 8. b4 Nxc4 9. dxc4 Be7 10. Nxe5
 {Black has exchanged the c6 knight that guarded e5. Check that the capture on e5 is available before letting the bishop go. [%cal Gf3e5]})
8. Re1 Re8 9. b4 Bf8 10. Qb3 Be6
{The queen and bishop both look at f7, and b4 has earned time to place the queen. Bring the queenside knight out before counting on tactics. [%cal Gb3f7,Gc4f7]} *
""",
    },
    "anti_sicilian_caro_white": {
        "id": "anti_sicilian_caro_white",
        "title": "Anti-Sicilian (Rossolimo & Closed) + Caro-Kann Exchange",
        "color": "white",
        "description": "Choose a Rossolimo structure, time f5 in the Closed Sicilian, and learn practical Exchange Caro-Kann and Scandinavian plans.",
        "chapter_count": 4,
        "tags": ["Rossolimo", "Closed Sicilian", "Caro-Kann", "Scandinavian"],
        "pgn": """
[Event "Rossolimo: Exploit the recapture"]
[Orientation "White"]

1. e4 c5 2. Nf3 Nc6 3. Bb5 g6
(3... e6 4. O-O Nge7 5. Re1 a6 6. Bf1
 {Save the bishop and keep the e-pawn protected by the rook. If Black plays ...d5, the center can open while you are already castled. [%cal Ge1e4]}
 6... d5 7. exd5 Nxd5 8. d4 {Challenge the knight's center and give the c1 bishop a way out. [%cal Gd4c5]})
4. Bxc6 dxc6 {The doubled c-pawns give you targets. The d-file also opens, so avoid casual queen trades that hand Black control of it. [%csl Rc5,Rc6]}
(4... bxc6 5. O-O Bg7 6. Re1 d6 7. e5
 {With Black's d-pawn still on the board, e5 comes with a threat to loosen the center. Check the g7 bishop before releasing that tension. [%cal Ge5d6,Rg7b2]})
5. d3 Bg7 6. h3 Nf6 7. Nc3 O-O 8. Be3 b6 9. Qd2
{Put pressure on c5 and keep a kingside trade on h6 available. Be ready for ...c4, which can turn a passive pawn into a useful lever. [%cal Ge3c5,Ge3h6,Rc5c4]} *

[Event "Closed Sicilian: Decide when to push f5"]
[Orientation "White"]

1. e4 c5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7 5. d3 d6 6. Be3 e6
(6... Nf6 7. h3 O-O 8. Qd2 Rb8 9. Nge2 b5 10. O-O
 {The knight on e2 keeps the f-pawn free. You can play f4 once castled, but check whether ...b4 will dislodge the c3 knight first. [%cal Gf2f4,Rb5b4]})
7. Qd2 Nge7 8. Bh6 {Trade the g7 bishop to loosen the dark squares around a castled king. [%cal Gh6g7,Gd2h6]}
8... O-O 9. Bxg7 Kxg7 10. f4 f6 11. Nf3 Rb8 12. O-O b5 13. f5
{Black has begun queenside play. Open a kingside file while the center is still stable, and calculate the recaptures before pushing. [%cal Gf4f5,Gf5e6,Gf5g6]}
13... exf5 14. exf5 Bxf5 15. Nh4 {Attack the bishop with tempo. The g2 bishop has gained an open diagonal toward c6. [%cal Gh4f5,Gg2c6]} *

[Event "Exchange Caro-Kann: Fight for e5"]
[Orientation "White"]

1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Bd3 {Develop before Black can comfortably put the c8 bishop on f5. The bishop also targets h7. [%cal Gd3h7,Rc8f5]}
4... Nc6 5. c3 Nf6 6. Bf4 {Control the b8-h2 diagonal, cover e5, and prepare to develop the knights without blocking this bishop. [%cal Gf4e5,Gf4b8]}
6... e6
(6... Bg4 7. Qb3 Qd7 8. Nd2 e6 9. Ngf3 Bd6 10. Bxd6 Qxd6 11. O-O O-O 12. Rfe1
 {The queen put pressure on b7 and pulled Black's queen away from its starting square. Use the open e-file to prepare Ne5. [%cal Gf3e5,Ge1e5]})
7. Nf3 Bd6 8. Bg3 O-O 9. Nbd2 Qc7 10. O-O Bxg3 11. hxg3 b6 12. Re1 Bb7 13. Ne5
{Your c3 and d4 pawns stand opposite Black's d5 pawn. The d4 pawn anchors e5, and after ...Nxe5 dxe5 your rook supports the advanced pawn. [%cal Gd4e5,Ge1e5]} *

[Event "Scandinavian: Gain time against the queen"]
[Orientation "White"]

1. e4 d5 2. exd5! {Capture before developing. If the queen recaptures, developing Nc3 attacks it with tempo. [%cal Ge4d5,Gb1c3]}
2... Qxd5
(2... Nf6 3. d4 Nxd5 4. Nf3 g6 5. c4 Nb6 6. Nc3
 {Against the knight recapture, build a broad center and make the knight spend a tempo retreating. [%cal Gc4d5]})
3. Nc3 Qa5
(3... Qd6 4. d4 Nf6 5. Nf3 c6 6. Ne5 Nbd7 7. Nc4 Qc7 8. Qf3
 {Nc4 forces the queen to move again and controls e5. Qf3 eyes f7 while leaving the bishop's route to c4 clear once the knight moves. [%cal Gc4e5,Gf3f7]})
4. d4 Nf6 5. Nf3 c6 6. Bc4 Bf5 7. Ne5 {The knight threatens f7 with the bishop's help. Even after ...e6, it makes Black commit a piece to contest it. [%cal Ge5f7,Gc4f7]}
7... e6 8. O-O Nbd7 9. Nxd7 Nxd7 10. Re1 {Place a rook on the central file while Black's king is still on e8. [%cal Ge1e8]} *
""",
    },
    "london_aggressive_white": {
        "id": "london_aggressive_white",
        "title": "Modern Aggressive London System",
        "color": "white",
        "description": "Build a supported attack with Ne5 and f4, handle early queenside pressure, and adapt your plan against a fianchetto.",
        "chapter_count": 3,
        "tags": ["London", "Queenside pressure", "King's Indian"],
        "pgn": """
[Event "London: Build the Ne5 and f4 attack"]
[Orientation "White"]

1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 Bd6 5. Bg3! {Keep the diagonal aimed at the center. An exchange will open your h-file, so Black has to weigh the trade. [%cal Gf4g3,Gh1h7]}
5... O-O
(5... Bxg3 6. hxg3 O-O 7. Bd3 c5 8. c3 Nc6 9. Nbd2
 {Use the open h-file as a threat. Support the center first because ...cxd4 can deprive your attacking knight of its anchor. [%cal Gh1h7,Rc5d4]})
6. Bd3 c5 7. c3 Nc6 8. Nbd2 b6 9. Ne5 {The d4 pawn anchors the knight. If the f6 knight exchanges it, check whether you can recapture with a pawn and gain space. [%cal Gd4e5,Ge5f7]}
9... Bb7 10. f4 {Support e5 again and clear f3 for the other knight. Assess ...cxd4 before committing the queen to h5. [%cal Gf4e5,Gd2f3,Rc5d4]} *

[Event "London: Answer c5 and Qb6 with Qb3"]
[Orientation "White"]

1. d4 d5 2. Bf4 c5 3. e3 Nc6 4. c3 Qb6 5. Qb3
{Defend b2 while offering a queen trade on your terms. The c3 pawn is needed to support d4 if Black exchanges on either flank. [%cal Gb3b2,Gc3d4]}
5... Qxb3
(5... c4 6. Qc2 Bf5 7. Qc1 {Black's pawn chain is fixed for now. Prepare b3 to challenge c4 while keeping b2 covered. [%cal Gb2b3,Gb3c4]})
6. axb3 cxd4 7. exd4 Bf5 8. b4 {The a-file is open for your rook. Gain queenside space before Black can put pressure on b3. [%cal Ga1a7,Gb4b5]}
8... e6 9. Nd2 {Develop while watching ...Nf6 and ...Nh5. Your extra queenside pawn is most useful when it can advance with support. [%cal Gd2b3]} *

[Event "London: Adjust to a kingside fianchetto"]
[Orientation "White"]

1. d4 Nf6 2. Bf4 g6 3. e3 Bg7 4. Nf3 O-O 5. Be2 d6
(5... d5 6. h3 c5 7. c3 Nc6 8. Nbd2
 {Against a fixed d5 pawn, keep your d4 strong and let h3 provide a retreat on h2 against ...Nh5. [%cal Gf4h2,Gc3d4]})
6. O-O Nbd7 7. h3 Qe8
(7... e5 8. Bh2 Re8 9. c4
 {Take the bishop out of attack while keeping the long diagonal. c4 gains room for Nc3 and encourages Black to clarify the center. [%cal Gh2e5,Gb1c3]})
8. c4 e5 9. Bh2 {Against ...e5, use the bishop's retreat and keep tension. If Black exchanges on d4, the e-file can be more valuable than a premature kingside attack. [%cal Gh2e5,Ge3d4]} *
""",
    },
    "middlegame_mastery_white": {
        "id": "middlegame_mastery_white",
        "title": "Middlegame Plans, Prophylaxis & Blunder-Check",
        "color": "white",
        "description": (
            "Step-by-step board lessons on quiet-move planning, Carlsbad minority attacks, "
            "worst-piece improvement, prophylaxis, and punishing loose pieces."
        ),
        "chapter_count": 4,
        "tags": ["middlegame", "strategy", "prophylaxis", "tactics"],
        "pgn": """
[Event "Carlsbad Minority Attack & Worst-Piece Improvement"]
[SetUp "1"]
[FEN "r1bqrnk1/pp2bppp/2p2n2/3p2B1/3P4/2NBPN2/PPQ2PPP/R4RK1 w - - 7 11"]

{The Exchange Queen's Gambit has left White two queenside pawns against three. Use yours to dislodge the c6 pawn, which holds up Black's center. [%cal Gc6d5,Gb2b4] [%csl Yc6]}
11. Rab1 {Put the a-rook behind the pawn you intend to push. Keep the f-rook free for central play if Black contests e4. [%cal Ga1b1,Gb2b4] [%csl Gb1]}
11... a6 {Black prepares ...axb5 to remove the lever and open the a-file. Decide who will recapture on b5 before pushing. [%cal Ra6b5] [%csl Yb5]}
(11... Ne4 {Black uses the time to occupy e4, where the knight attacks c3 and g5. Check the threats before advancing. [%cal Re4c3,Re4g5] [%csl Re4]}
 12. Bxe7 {Trade the attacked bishop for Black's bishop and make the queen commit to a square. [%cal Gg5e7] [%csl Ge7]}
 12... Qxe7 {The queen keeps e4 reinforced along the e-file. [%cal Ge7e4] [%csl Ye4]}
 13. b4 {Now start the pawn advance. The b-rook supports it, and the knight on c3 has the queen's protection. [%cal Gb2b4,Gc2c3] [%csl Gb4]}
 13... Bf5 {Black develops with another defender of e4, so the knight is staying for now. [%cal Gf5e4] [%csl Ye4]}
 14. Rfc1 {Add a rook behind the queen on the c-file. If Black exchanges on c3, the queen can recapture and face c6. [%cal Gf1c1,Gc2c3] [%csl Yc6]})
12. b4 {Gain space with the rook already behind the advance. The specific threat is b5, undermining c6. [%cal Gb2b4,Gb4b5] [%csl Gc6]}
12... Bd6 {Black points a bishop at h2. Check for a queen or knight joining it before spending another tempo on the wing. [%cal Rd6h2] [%csl Rh2]}
13. a4 {Prepare to replace the b5 pawn with the a-pawn when Black captures it. This keeps the lever alive. [%cal Ga2a4,Ga4b5] [%csl Gb5]}
13... Ng6 {The knight gains access to f4 and h4. The g5 bishop still keeps the other knight from moving freely because the queen is behind it. [%cal Rg6f4,Rg6h4,Gg5d8] [%csl Yf6]}
14. b5 {Attack both a6 and c6. Calculate ...axb5 axb5 and see that White still attacks c6. [%cal Gb4b5,Gb5c6] [%csl Rc6]}
14... axb5 {Black takes first and clears the a-file for the rook. [%cal Ga6b5,Ga8a1] [%csl Ya1]}
15. axb5 {Restore the lever. Now choose which black pawn you want to leave exposed after the next exchange. [%cal Ga4b5,Gb5c6] [%csl Gc6]}
15... Bd7 {The bishop guards c6 and gives Black a choice of recapture there. [%cal Gd7c6] [%csl Yc6]}
16. bxc6 {Remove the c-pawn. A pawn recapture gives you a backward c6 target, while a bishop recapture leaves an isolated d5 pawn. [%cal Gb5c6] [%csl Rc6,Rd5]}
16... bxc6 {Black restores a pawn to c6. Advancing it is hard because your d4 pawn controls c5. [%cal Gb7c6,Gd4c5] [%csl Rc6]}
(16... Bxc6 {The bishop is active, but the d5 pawn has lost its neighbor on both files. [%cal Gd7c6] [%csl Rd5]}
 17. Rfc1 {Put the f-rook behind the queen. Your other rook attacks b7, and the queen can move to open the c-file battery. [%cal Gf1c1,Gb1b7] [%csl Rb7,Rd5]})
17. Na4 {Improve the c3 knight before piling up on c6. From c5 it will be supported by d4 and will attack the bishop on d7. [%cal Gc3a4,Ga4c5] [%csl Gc5,Rc6]}
17... h6 {Black asks the bishop to decide and makes an escape square for the king. [%cal Rh6g5] [%csl Yh7]}
18. Bxf6 {Remove the knight that can play ...Ne4, then return to the queenside. [%cal Gg5f6] [%csl Ge4]}
18... Qxf6 {Keep the kingside pawn cover intact and bring the queen to a diagonal that attacks d4. [%cal Gd8f6,Rf6d4] [%csl Yd4]}
19. Nc5 {Plant the knight on its supported square. The bishop on d7 is under attack, and c6 stays fixed. [%cal Ga4c5,Gd4c5,Gc5d7] [%csl Gc5,Rc6]}
19... Bxc5 {Black gives up the active bishop to remove the knight and prevent it from taking on d7. [%cal Gd6c5] [%csl Yc5]}
20. Qxc5 {Recapture with the queen, keeping d4 in place to control c5. The queen attacks c6, and a rook can join on the c-file. [%cal Gc2c5,Gc5c6,Gb1c1] [%csl Rc6]} *

[Event "Prophylaxis Before Attacking"]
[SetUp "1"]
[FEN "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 2 7"]

{Both kings have castled in the Italian. Before rerouting the b1 knight, ask how Black can interrupt the plan with ...Bg4, ...Na5, or ...d5. [%cal Rc8g4,Rc6a5,Rd6d5] [%csl Yg4,Ya5,Yd5]}
7. h3 {Cover g4 so Black cannot pin the f3 knight there without sacrificing. Keep an eye on ...Na5, which is still available. [%cal Gh3g4,Rc6a5] [%csl Gg4]}
7... a6 {Black gives the bishop a retreat and prepares ...b5 with tempo against c4. [%cal Ga6b5,Rb5c4] [%csl Yb5]}
(7... Na5 {The knight attacks the Italian bishop. Check where it can retreat while keeping a diagonal into the center. [%cal Ra5c4] [%csl Rc4]}
 8. Bb5 {Keep the bishop active and make Black spend a pawn move if they want it off this diagonal. [%cal Gc4b5] [%csl Gb5]}
 8... c6 {Black attacks the bishop again and prepares to contest d5. [%cal Rc6b5,Gc6d5] [%csl Yd5]}
 9. Ba4 {Retreat with a route to c2 now that your c-pawn has vacated c2. [%cal Gb5a4,Ga4c2] [%csl Gc2]}
 9... b5 {Gain another tempo on the bishop, at the cost of spending a third move on the queenside chase. [%cal Rb5a4] [%csl Ya4]}
 10. Bc2 {Tuck the bishop away. It can defend e4 once the d3 pawn advances or exchanges. [%cal Ga4c2,Gc2e4] [%csl Ge4]})
8. a4 {Control b5 and give the bishop a2 as a retreat. Black can still play ...b5, but it now needs more preparation. [%cal Ga2a4,Ga4b5] [%csl Gb5,Ga2]}
8... Ba7 {Preserve pressure on f2 and leave c5 open for later play. [%cal Gc5a7,Ra7f2] [%csl Yf2]}
9. Re1 {Reinforce e4 and clear f1 for the knight. If Black opens the center with ...d5, your rook is already on the right file. [%cal Gf1e1,Ge1e4] [%csl Gf1]}
9... h6 {Black keeps a knight or bishop off g5 and waits to see where White commits the b1 knight. [%cal Gh6g5] [%csl Yg5]}
(9... d5 {Black challenges e4 before the knight tour. Handle the center first. [%cal Rd6d5,Rd5e4] [%csl Yd5]}
 10. exd5 {Exchange and take away the threat to e4. The rook now faces the e5 pawn. [%cal Ge4d5,Ge1e5] [%csl Re5]}
 10... Nxd5 {Keep the queen out of range of the c4 bishop and centralize the knight. [%cal Gf6d5] [%csl Yd5]}
 11. Nbd2 {Develop while reinforcing f3. The queen knight can still head for f1 once you have checked ...Nf4 and ...Be6. [%cal Gb1d2,Gd2f3,Gd2f1] [%csl Gd2]})
10. Nbd2 {Start the tour with e4 covered and ...Bg4 discouraged. The knight also backs up f3 on its way through. [%cal Gb1d2,Gd2f1] [%csl Gf1]}
10... Re8 {Reinforce e5 for a possible central opening. Black's queenside bishop still needs a route into play. [%cal Gf8e8,Ge8e5] [%csl Ye5]}
11. Nf1 {Use the square the rook vacated. The knight is one step away from attacking the kingside without abandoning e4. [%cal Gd2f1,Gf1g3] [%csl Gg3]}
11... b6 {Black chooses to develop the c8 bishop via b7, where it will look down the long diagonal. [%cal Gb7b6,Gc8b7] [%csl Yb7]}
12. Ng3 {Cover e4 and prepare Nf5. Before jumping, check whether Black can drive the knight out with ...g6. [%cal Gf1g3,Gg3e4,Gg3f5] [%csl Gf5]}
12... Bb7 {The bishop aims through c6 toward e4 once the c6 knight moves. That knight can redeploy with tempo later, so keep e4 defended. [%cal Gb7e4] [%csl Ye4]}
13. Nf5 {Occupy f5 with the e4 pawn behind you. The knight now eyes g7 and h6. If ...g6 chases it, calculate useful retreats and note the weakened squares around the king. [%cal Gg3f5,Ge4f5,Gf5g7,Gf5h6] [%csl Gf5,Rg7,Rh6]} *

[Event "Good Knight vs Bad Bishop & Outpost Domination"]
[SetUp "1"]
[FEN "r2q1rk1/pp1bbppp/4p3/1N1pP1B1/3P4/8/PP3PPP/R2Q1RK1 w - - 0 1"]

{In this French-style structure the fixed d5 and e6 pawns restrict Black's light-squared bishop. Find what can still trade a knight on d6. [%cal Re7d6,Ge5d6] [%csl Gd6,Yd5,Ye6]}
1. Bxe7 {Trade the bishop that can take on d6. The remaining bishop has the wrong square color to challenge that outpost. [%cal Gg5e7] [%csl Ge7,Gd6]}
1... Qxe7 {Black recaptures with the queen, keeps both rooks, and covers d6. The queen is too valuable to swap for a protected knight there. [%cal Gd8e7,Re7d6] [%csl Yd6]}
2. Nd6 {Land on the square the e5 pawn supports. Black's c- and e-files offer no pawn that can evict this knight. It also controls c8 and f7. [%cal Gb5d6,Ge5d6,Gd6f7,Gd6c8] [%csl Gd6]}
2... Bc6 {Black looks for counterplay on the queenside and reinforces d5, but the bishop's diagonal toward e4 is blocked by its own pawn. [%cal Gd7c6,Gc6d5] [%csl Yd5]}
(2... b6 {Black protects a5 and c5 and keeps the bishop on d7. That leaves the open c-file available. [%cal Gb6a5,Gb6c5] [%csl Yc7]}
 3. Rc1 {Occupy the open file and eye c7. The knight controls c8, making it harder for Black to contest the file from there. [%cal Ga1c1,Gc1c7,Gd6c8] [%csl Gc7]})
3. f4 {Support e5 and prepare f5. The knight limits Black's queenside coordination while you build on the other wing. [%cal Gf2f4,Gf4e5,Gf4f5] [%csl Gf5]}
3... Rad8 {Black puts a rook opposite the knight and supports d5. If the rook takes on d6, the e5 pawn wins the exchange. [%cal Ra8d8,Rd8d6,Ge5d6] [%csl Yd6]}
(3... g6 {Black makes f5 harder to use and loosens the dark squares around the king. You can switch targets. [%cal Rg6f5] [%csl Yf6,Yh6]}
 4. Qb3 {Put pressure on d5 and b7 from the same square. Black's restricted bishop still has a pawn to keep defended. [%cal Gb3d5,Gb3b7] [%csl Rd5,Rb7]})
4. f5 {Challenge e6 and create a new route to f5 for the knight if Black takes. Check the knight's landing square before opening the position. [%cal Gf4f5,Gf5e6,Gd6f5] [%csl Re6]}
4... exf5 {Black removes the f-pawn and opens the position. The knight can recapture from d6 and remains supported on f5. [%cal Re6f5,Gd6f5] [%csl Yf5]}
5. Nxf5 {Recapture with tempo on the queen. The knight now supports an attack on g7. [%cal Gd6f5,Gf5e7,Gf5g7] [%csl Re7,Rg7]}
5... Qe6 {Black saves the queen and keeps the knight under attack. The knight has the rook on f1 behind it. [%cal Re6f5,Gf1f5] [%csl Yf5]}
6. Qg4 {Bring the queen in behind the knight. Qxg7 is a threat that makes Black address the king before seeking queenside play. [%cal Gd1g4,Gg4g7,Gf5g7] [%csl Rg7]} *

[Event "Blunder-Check & Punishing Loose Pieces"]
[SetUp "1"]
[FEN "2brr1k1/ppp2p1p/6p1/2nq4/5B2/1N6/PPPQ1PPP/R3R1K1 w - - 0 1"]

{Checks, captures, threats. The d5 queen has just one defender, the d8 rook, which also guards the back rank. Check Black's replies to your forcing candidates. [%cal Gd8d5,Ge1e8,Re8e1] [%csl Rd5,Yd8]}
1. Rxe8+ {Start with the check. Black must move the king to g7 or move the d8 rook off the d-file. Calculate both replies. [%cal Ge1e8,Rd8e8,Rg8g7] [%csl Yg7,Rd5]}
(1. Qxd5 {The queen looks free, but check Black's forcing reply before assuming a recapture on d5. [%cal Gd2d5,Re8e1] [%csl Ye1]}
 1... Rxe1+ {The in-between check forces White to address the back rank with the queen still attacked. [%cal Re8e1,Re1g1] [%csl Rg1,Rd5]}
 2. Rxe1 {Recapture with the a-rook to answer check. Black's d8 rook remains available to take the queen. [%cal Ga1e1,Rd8d5] [%csl Rd5]}
 2... Rxd5 {Recover the queen. The opponent's e-file check gave this rook time to stay on the d-file. [%cal Rd8d5] [%csl Yd5]}
 3. Re8+ {Check before grabbing more material. The king has an escape on g7, so calculate what Black can threaten from there. [%cal Ge1e8,Rg8g7] [%csl Yg7]}
 3... Kg7 {Leave the back rank. White's rook can see c8, but taking the bishop allows ...Rd1 mate. [%cal Rg8g7,Rd5d1,Ge8c8] [%csl Rd1]}
 4. h3 {Create an escape square before chasing the bishop. A back-rank check can now be met by Kh2. [%cal Gh2h3,Gg1h2] [%csl Gh2]})
1... Rxe8 {Block the check with the d8 rook. Its move leaves the queen on d5 undefended. [%cal Rd8e8] [%csl Rd5]}
(1... Kg7 {Use the escape square and leave the rook on d8 under attack. Now check whether it has a useful defender. [%cal Rg8g7,Ge8d8] [%csl Rd8]}
 2. Rxd8 {Remove the rook with the rook you already brought to e8. The queen is behind it on the same file. [%cal Ge8d8,Gd2d8] [%csl Rd8]}
 2... Qxd8 {Black recovers the rook, but the capture puts the queen on your queen's open file. [%cal Rd5d8] [%csl Rd8]}
 3. Qxd8 {Take the queen and count the exchanges. White has won a queen and both black rooks for a rook. [%cal Gd2d8] [%csl Gd8]})
2. Qxd5 {Take the queen with the a1 rook still available to answer ...Re1+. The difference is the order of the captures. [%cal Gd2d5,Ga1e1] [%csl Gd5]}
2... Ne6 {Save the c5 knight and attack the f4 bishop. Even a queen ahead, check what your opponent's last move threatens. [%cal Rc5e6,Re6f4] [%csl Rf4]}
(2... Re1+ {Black tries another check on the back rank. Recount the defenders of e1. [%cal Re8e1,Re1g1] [%csl Ye1]}
 3. Rxe1 {The a-rook answers the check and captures the last black rook. [%cal Ga1e1] [%csl Ge1]})
3. Be3 {Save the bishop and cover c5. With the forcing sequence over, keep your pieces and give the king room when you can. [%cal Gf4e3,Ge3c5,Gh2h3] [%csl Ge3]} *
""",
    },
    "defense_endgame_mastery_white": {
        "id": "defense_endgame_mastery_white",
        "title": "Active Defense & Essential 2000-Level Endgames",
        "color": "white",
        "description": (
            "Interactive board drills for active defense under attack, the Lucena bridge, "
            "Philidor defense, king activity, and converting winning endgames."
        ),
        "chapter_count": 3,
        "tags": ["defense", "endgame", "rook-endgames"],
        "pgn": """
[Event "Active Defense & Counterplay"]
[SetUp "1"]
[FEN "r1b2rk1/ppp2ppp/3bpn2/3p3q/3PP3/8/PPP1NPPP/RNBQ1RK1 w - - 0 1"]

{Black threatens ...Qxh2 mate because the bishop on d6 guards h2. Can you break the diagonal while developing a piece? [%cal Rd6h2,Rh5h2] [%csl Rh2]}
1. Bf4 {Interpose on the bishop's diagonal and offer a trade. If ...Qxh2+ comes immediately, your king can capture the queen because the bishop on d6 is blocked. [%cal Gc1f4,Gf4d6,Gg1h2] [%csl Gf4,Rh2]}
1... Bxf4 {Black trades the bishop to clear the diagonal, but the queen has lost the partner that made ...Qxh2 mate. [%cal Rd6f4] [%csl Yh2]}
2. Nxf4 {Recapture with tempo. The knight attacks the queen on h5 and is ready to pressure d5 later. [%cal Ge2f4,Gf4h5,Gf4d5] [%csl Rh5]}
2... Qg4 {The queen retreats while attacking f4. Check whether you can trade queens before moving the knight again. [%cal Rh5g4,Rg4f4] [%csl Yg4]}
(2... Qh4 {Black keeps queens on and attacks the knight on f4 along the fourth rank. [%cal Rh4f4] [%csl Rf4]}
 3. g3 {Gain a tempo on the queen and protect f4 with the same pawn. The absence of the d6 bishop makes the king less exposed than it looks. [%cal Gg3h4,Gg3f4] [%csl Gf4]}
 3... Qg5 {Black steps away and keeps the knight under pressure. The g3 pawn can now answer ...Qxf4. [%cal Rg5f4,Gg3f4] [%csl Yf4]}
 4. c4 {Challenge d5 once your knight is secure. Opening the center gives the undeveloped b1 knight useful squares and asks Black to defend. [%cal Gc2c4,Gc4d5,Gb1c3] [%csl Rd5]})
3. Qxg4 {Trade the queens while the path from d1 is clear. The knight on f6 can recapture, but Black's mating attack is over. [%cal Gd1g4,Rf6g4] [%csl Gg4]}
3... Nxg4 {Recover the queen with an active knight. Black now has to decide how to support the center. [%cal Rf6g4] [%csl Yd5]}
4. exd5 {Resolve the central tension while you can choose the terms. If Black recaptures with the pawn, d5 becomes a target. [%cal Ge4d5,Re6d5] [%csl Rd5]}
4... exd5 {Black restores material equality but leaves d5 under attack from the f4 knight. [%cal Re6d5,Gf4d5] [%csl Rd5]}
5. Nc3 {Develop the last knight with a threat against d5. The same move that improves your piece makes Black spend a move defending or exchanging. [%cal Gb1c3,Gc3d5,Gf4d5] [%csl Rd5]} *

[Event "Rook Endgame Mastery: The Lucena Bridge"]
[SetUp "1"]
[FEN "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1"]

{White's pawn is one square from promotion, but its own king blocks it. Separate Black's king from the pawn and plan a shelter from rook checks. [%cal Gc1d1,Gd1d4] [%csl Gb7,Yb8,Gd4]}
1. Rd1+ {Check on the d-file to push the king away. Your king protects c7 and c8, so Black has to step toward the e-file. [%cal Gc1d1,Gd1d8,Gb8c7] [%csl Rc7,Rc8]}
1... Ke7 {Black stays as close as possible while leaving the d-file. Your king can move out now, but repeated checks would still spoil the escape. [%cal Rd8e7,Ra2c2] [%csl Ye7]}
2. Rd4 {Build the bridge before moving your king. From the fourth rank, the rook can meet a check on the b-file by moving to b4. [%cal Gd1d4,Gd4b4] [%csl Gd4,Gb4]}
2... Ra1 {Black puts the rook on the first rank, ready to switch files and check from behind. [%cal Ra2a1,Ra1c1] [%csl Yc1]}
3. Kc7 {Step off b8 while protecting the pawn and its promotion square. Black has to check or deal with promotion. [%cal Gb8c7,Gc7b7,Gc7b8] [%csl Gb8]}
3... Rc1+ {Black checks from behind to keep your king from standing beside the pawn. [%cal Ra1c1,Rc1c7] [%csl Rc7]}
(3... Rb1 {Black aims at b7 instead of checking. Your king already guards b8, so calculate the promotion. [%cal Ra1b1,Rb1b7,Gc7b8] [%csl Gb8]}
 4. b8=Q {Promote even though the rook can take. The king on c7 guards the new queen. [%cal Gb7b8,Gc7b8] [%csl Gb8]}
 4... Rxb8 {Black takes the queen, leaving the rook within reach of your king. [%cal Rb1b8] [%csl Yb8]}
 5. Kxb8 {Take the rook. Your remaining rook wins against the bare king. [%cal Gc7b8] [%csl Gb8]})
4. Kb6 {Stay beside the b-pawn and head toward the fourth-rank shelter. [%cal Gc7b6,Gb6b7] [%csl Gb6,Gb4]}
4... Rb1+ {Black checks on the b-file before your king can settle. [%cal Rc1b1,Rb1b6] [%csl Rb6]}
5. Kc6 {Use c6 as a stepping stone to b5. The black king is cut off from this route. [%cal Gb6c6,Gc6b5] [%csl Gc6,Gb5]}
5... Rc1+ {Black keeps checking, now on the c-file again. The rook has to follow your king across. [%cal Rb1c1,Rc1c6] [%csl Rc6]}
6. Kb5 {Reach the square that protects b4. Your rook can now block a b-file check without being lost. [%cal Gc6b5,Gb5b4,Gd4b4] [%csl Gb4]}
6... Rb1+ {Black tries one last check on the pawn's file. Look for a block your king can support. [%cal Rc1b1,Rb1b5] [%csl Rb5,Gb4]}
7. Rb4 {Shield the king with the rook. If Black trades on b4, your king can take and the pawn is free to promote. [%cal Gd4b4,Gb5b4,Gb7b8] [%csl Gb4,Gb8]}
7... Rxb4+ {Black exchanges on the bridge. The recapture removes the last source of checks. [%cal Rb1b4,Gb5b4] [%csl Yb4]}
8. Kxb4 {Take the rook. Black's king is too far from the promotion square. [%cal Gb5b4,Gb7b8] [%csl Gb8]}
8... Kd6 {Black heads toward the pawn, but the earliest arrival on c7 would take another move. [%cal Re7d6,Rd6c7] [%csl Yc7]}
9. b8=Q+ {Promote with check. The bridge bought the single move White needed to end the checks and advance the pawn. [%cal Gb7b8,Gb8d6] [%csl Gb8]} *

[Event "King Activity, Opposition & Passed Pawn Creation"]
[SetUp "1"]
[FEN "4k3/3r4/8/p3K3/1P2P3/8/8/3R4 w - - 0 1"]

{Compare the pawn ending after a rook trade with keeping rooks on. Count how many moves Black needs to catch an outside a-pawn. [%cal Gd1d7,Gb4a5] [%csl Ga5,Ye4]}
1. Rxd7 {Trade while you can still capture on a5. In the pawn ending, Black's king will have to split its attention between two widely separated passers. [%cal Gd1d7,Gb4a5] [%csl Gd7,Ga5]}
(1. Ra1 {Keep the rooks while attacking a5. Black can eliminate the queenside pawns and use the Philidor defense against your e-pawn. [%cal Gd1a1,Ga1a5,Ra5b4] [%csl Ya5]}
 1... axb4 {Black captures before you can make an outside passer. The pawn on b4 can be returned for an easier rook ending. [%cal Ra5b4] [%csl Yb4]}
 2. Rb1 {Get behind the pawn so you can remove it. Check what Black does with the time. [%cal Ga1b1,Gb1b4] [%csl Rb4]}
 2... Rh7 {Black prepares ...Rh6. The king remains in front of the e-pawn while the rook moves to cut off yours. [%cal Rd7h7,Rh7h6] [%csl Ye8,Yh6]}
 3. Rxb4 {Remove the b-pawn. You are a pawn up, but your king still needs entry squares on the sixth rank. [%cal Gb1b4,Ge5f6] [%csl Ye6,Yf6]}
 3... Rh6 {The Philidor setup is in place. The king holds the promotion square and the rook denies your king the sixth rank. [%cal Rh7h6,Rh6a6] [%csl Re6,Rf6,Re8]}
 4. Rb7 {Activate the rook and test whether Black will give up the barrier. Your rook still has to help your king reach the sixth rank. [%cal Gb4b7] [%csl Gb7,Ye6]}
 4... Ra6 {Black waits on the sixth rank. Until the pawn advances to e6, stay on this rank and keep the king out. [%cal Rh6a6,Ra6f6] [%csl Re6,Rf6]}
 5. Kf5 {Try an entry from the other side. The rook on a6 still covers f6, so your king has to stay on the fifth rank. [%cal Ge5f5,Ra6f6] [%csl Rf6]}
 5... Rh6 {Slide along the barrier. The rook keeps f6 covered and can check from the first rank once the pawn advances. [%cal Ra6h6,Rh6f6] [%csl Rf6]}
 6. e5 {Advance to the fifth rank. This still leaves space for your king to hide in front of the pawn, so Black should keep the barrier. [%cal Ge4e5] [%csl Ye6]}
 6... Ra6 {Wait again. Giving up the sixth rank now would allow your king to advance before the pawn blocks its shelter. [%cal Rh6a6,Ra6f6] [%csl Re6,Rf6]}
 7. e6 {Gain space but take away e6 as shelter for your king. This pawn push is Black's signal to switch the rook behind you. [%cal Ge5e6,Ra6a1] [%csl Ye6]}
 7... Ra1 {Drop to the first rank and prepare checks from behind. The king on e8 continues to block promotion. [%cal Ra6a1,Ra1f1] [%csl Re8,Yf1]}
 8. Kf6 {Try to escort the pawn from the side. Count the empty squares behind the king on the f-file. [%cal Gf5f6,Ra1f1] [%csl Rf1]}
 8... Rf1+ {Check from behind. The king cannot make forward progress while each exposed file offers a checking square. [%cal Ra1f1,Rf1f6] [%csl Rf6]}
 9. Ke5 {Step toward the pawn. On e5, the king is still open to checks from below. [%cal Gf6e5,Rf1e1] [%csl Re1]}
 9... Re1+ {Switch files and check again. The rook keeps its distance from the white king. [%cal Rf1e1,Re1e5] [%csl Re5]}
 10. Kd6 {Try the d-file, still next to the pawn. Black has another check available from behind. [%cal Ge5d6,Re1d1] [%csl Rd1]}
 10... Rd1+ {Continue the checks. The king on e8 holds the promotion square, and the exposed white king has no way to force progress. [%cal Re1d1,Rd1d6] [%csl Rd6,Re8]})
1... Kxd7 {Black recaptures, but the king is too far from a5 to prevent White's next capture. [%cal Re8d7,Gb4a5] [%csl Ya5]}
2. bxa5 {Create the outside passed pawn. Your e-pawn is also passed, so the king can head for one while Black deals with the other. [%cal Gb4a5,Ga5a8,Ge4e8] [%csl Ga5,Ge4]}
2... Kc6 {Black heads toward a5 to stop the more distant pawn. Use the time to put your king ahead of the e-pawn. [%cal Rd7c6,Rc6b5,Ge5e6] [%csl Ge6]}
(2... Ke7 {Black stays on the kingside to stop the e-pawn. Look for a way around the block with your spare pawn moves. [%cal Rd7e7] [%csl Ye7,Ga5]}
 3. Kd5 {Approach the center from the side and threaten to reach e6. [%cal Ge5d5,Gd5e6] [%csl Ge6]}
 3... Kd7 {Black takes the opposition on the d-file. The single square between the kings, combined with White to move, lets Black deny a direct advance. [%cal Re7d7] [%csl Yd6]}
 4. a6 {Use a pawn tempo to give Black the move without moving your king. Black must step aside or let the a-pawn run. [%cal Ga5a6,Ga6a7] [%csl Ga6,Yd6]}
 4... Kc7 {Black turns back toward the outside passer. The e6 entry square is now available. [%cal Rd7c7,Rc7b8] [%csl Ge6]}
 5. Ke6 {Penetrate ahead of the e-pawn. Black cannot cover both promotion squares from one wing. [%cal Gd5e6,Ge4e8,Ga6a8] [%csl Ge8,Ga8]})
3. Ke6 {Get ahead of your remaining pawn. Your king will control its path while the a-pawn draws Black away. [%cal Ge5e6,Ge6d7,Ge4e5] [%csl Ge6]}
3... Kb5 {Black threatens to capture a5. Check the race before spending a move to save it. [%cal Rc6b5,Rb5a5] [%csl Ra5]}
4. Kd6 {Let Black take the decoy and move the king off the e-file. From d6 you control e7 while leaving the pawn's path open. [%cal Ge6d6,Gd6e7,Ge4e5] [%csl Ge7]}
4... Kxa5 {Black removes one threat but ends up too far from the e-pawn. [%cal Rb5a5,Ge4e8] [%csl Ge8]}
5. e5 {Start the advance with your king already in front. Black cannot get close enough to take the pawn from the side. [%cal Ge4e5,Gd6e5] [%csl Ge5]}
5... Kb6 {Black heads for the promotion square by the shortest route available. [%cal Ra5b6,Rb6c7] [%csl Yc7]}
6. e6 {Advance under your king's protection. Black's king cannot cross through c7 while yours is on d6. [%cal Ge5e6,Gd6e6,Gd6c7] [%csl Ge6,Rc7]}
6... Kb7 {Black approaches from the seventh rank, but c7 is still covered. [%cal Rb6b7,Gd6c7] [%csl Rc7]}
7. Kd7 {Move alongside the promotion route and cover both e7 and e8. The pawn can take the last two steps safely. [%cal Gd6d7,Gd7e7,Gd7e8] [%csl Ge7,Ge8]}
7... Kb6 {Black stays as close as possible without entering a square your king controls. [%cal Rb7b6,Gd7c7] [%csl Rc7]}
8. e7 {Reach the seventh rank. Your king covers the final square even if Black approaches again. [%cal Ge6e7,Gd7e8] [%csl Ge8]}
8... Kb5 {Black has no way into the pawn's path and steps toward the center from below. [%cal Rb6b5,Rb5c5] [%csl Ge8]}
9. e8=Q {Promote. The outside pawn bought the time for your king to escort the other passer. [%cal Ge7e8,Gd7e8] [%csl Ge8]} *
""",
    },
}
