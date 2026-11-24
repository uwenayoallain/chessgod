"""Grandmaster-level study curriculum and curated course catalog.

Encodes original, structured 1600-2200 strategic and opening playbooks built
around proven master frameworks (pawn structures, positional imbalances,
prophylaxis, candidate-move calculation, active defense, and practical endgame
technique), paired with verified Chess.com Premium courses, classic books, and
free modern resources.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CourseResource:
    """A recommended course, study, or video series for a weakness."""

    title: str
    author: str
    platform: str  # "Chess.com Premium" | "Lichess Study" | "Chessable Free" | "YouTube" | "Listudy"
    source: str  # "chesscom_premium" | "free_modern"
    why: str
    url: str
    level: str = "1600-2000"


@dataclass(frozen=True)
class BookReference:
    """A classic or modern chess book chapter mapped to this concept."""

    title: str
    author: str
    focus: str
    level: str = "1600-2200"


@dataclass(frozen=True)
class MasterPlaybook:
    """Complete, structured understanding for one opening structure or skill area."""

    id: str
    category: str  # "opening" | "middlegame" | "tactics" | "defense" | "endgame" | "habits"
    title: str
    subtitle: str
    color: str  # "white" | "black" | "both"
    structure_name: str
    level: str
    tabiya_fen: str | None
    tabiya_label: str | None
    summary: str
    core_ideas: tuple[str, ...]
    white_plans: tuple[str, ...] = ()
    black_plans: tuple[str, ...] = ()
    key_breaks: tuple[str, ...] = ()
    piece_guide: tuple[str, ...] = ()
    checklist: tuple[str, ...] = ()
    common_traps: tuple[str, ...] = ()
    eco_prefixes: tuple[str, ...] = ()
    opening_keywords: tuple[str, ...] = ()
    books: tuple[BookReference, ...] = field(default_factory=tuple)
    courses: tuple[CourseResource, ...] = field(default_factory=tuple)


PLAYBOOKS: tuple[MasterPlaybook, ...] = (
    # ------------------------------------------------------------------
    # CORE SKILL PLAYBOOKS (Middlegame, Tactics, Defense, Endgame, Habits)
    # ------------------------------------------------------------------
    MasterPlaybook(
        id="quiet_moves_planning",
        category="middlegame",
        title="Middlegame Plans, Pawn Structures & Prophylaxis",
        subtitle="Turn quiet moves from guesswork into purposeful positional pressure",
        color="both",
        structure_name="Universal Middlegame Framework",
        level="1600-2200",
        tabiya_fen="r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - -",
        tabiya_label="Typical Carlsbad / semi-closed middlegame: choose a plan, not a random move",
        summary=(
            "Most 1600-2000 points are lost on quiet moves where nothing looks urgent. "
            "Instead of pushing random flank pawns or drifting without a plan, anchor every "
            "quiet move to four master checks: the pawn structure's key break, your worst-placed "
            "piece, your opponent's next threat (prophylaxis), and which minor pieces you want to trade."
        ),
        core_ideas=(
            "Read the pawn skeleton first: fixed central pawns tell you which wing to attack and which pawn break opens lines for your rooks.",
            "Worst-Piece Rule (Grooten / Yusupov): when no tactic exists, find your least active piece and route it toward a central outpost or open file.",
            "Prophylaxis before ambition (Hellsten / Dvoretsky): ask 'what does my opponent want to play if I pass?' Stop their freeing break before launching yours.",
            "Favorable trades (Silman): keep the pieces that cover your weak color complex and trade off the opponent's best defender or active knight.",
            "Avoid unprovoked pawn pushes in front of your castled king; every pawn move leaves permanent holes behind it.",
        ),
        key_breaks=(
            "Identify your primary central or wing break (c4/c5, d4/d5, e4/e5, or f4/f5) and prepare it with rooks and minor pieces before pushing.",
            "Never release central tension prematurely unless the capture wins concrete structure, an outpost, or a tactical tempo.",
        ),
        piece_guide=(
            "Knights need secure outposts on the 5th or 6th rank that enemy pawns can no longer attack.",
            "Bishops need open diagonals and targets on both wings; trade off a 'bad' bishop locked behind your own central pawns.",
            "Rooks belong on open files, half-open files pointing at backward pawns, or the 7th rank.",
        ),
        checklist=(
            "1. What changed after my opponent's last move, and what is their next threat or pawn break?",
            "2. What is the pawn structure asking both sides to do?",
            "3. Which of my pieces is doing the least right now, and what is its ideal square in 2-3 moves?",
            "4. Before committing to a quiet move, verify it does not drop a tactical shot or weaken a key square.",
        ),
        common_traps=(
            "Moving a piece twice with no concrete target while your rooks are still unconnected.",
            "Trading pieces just to simplify when your opponent actually had the cramped position.",
            "Pushing h3/a3 automatically without checking whether it creates a hook for an enemy pawn storm.",
        ),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide",
                author="GM Mauricio Flores Rios",
                focus="The 28 recurring pawn structures with concrete plans, breaks, and typical piece trades for both sides.",
                level="1600-2200",
            ),
            BookReference(
                title="Mastering Chess Strategy",
                author="GM Johan Hellsten",
                focus="Prophylaxis, restriction, improving the worst piece, and converting small positional edges.",
                level="1700-2200",
            ),
            BookReference(
                title="How to Reassess Your Chess (4th Ed.)",
                author="IM Jeremy Silman",
                focus="Diagnosing imbalances (minor pieces, pawn structure, space, files, king safety) to build a plan.",
                level="1500-2000",
            ),
            BookReference(
                title="Chess Strategy for Club Players",
                author="IM Herman Grooten",
                focus="Steinitz's elements, weak squares, outposts, and turning strategic rules into over-the-board moves.",
                level="1500-2000",
            ),
        ),
        courses=(
            CourseResource(
                title="Positional Masterpieces",
                author="GM Romain Edouard",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Breaks down how grandmasters outplay equal positions with quiet moves, restriction, and minor-piece trades.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="Middlegame Strategy Track (Intermediate & Advanced)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Interactive lessons on weak squares, outposts, candidate moves, and planning included in your membership.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="16 Essential Middlegame Plans & Tactics",
                author="Lichess Community Study",
                platform="Lichess Study",
                source="free_modern",
                why="Free interactive study walking through worst-piece improvement, pawn levers, and rook lifts.",
                url="https://lichess.org/study/search?q=16+essential+middlegame+plans",
                level="1600-2000",
            ),
            CourseResource(
                title="GM Daniel Naroditsky Speedrun (1500-2000 episodes)",
                author="GM Daniel Naroditsky",
                platform="YouTube",
                source="free_modern",
                why="Explains quiet moves, prophylaxis, and threat-checks out loud in real rapid games at your exact rating.",
                url="https://www.youtube.com/results?search_query=Daniel+Naroditsky+speedrun+1700+1800+1900",
                level="1500-2100",
            ),
        ),
    ),
    MasterPlaybook(
        id="blunder_prevention",
        category="tactics",
        title="Blunder-Check & Loose-Piece Discipline",
        subtitle="Eliminate one-move oversights and undefended-piece drops",
        color="both",
        structure_name="Pre-Move Safety Protocol",
        level="1500-2100",
        tabiya_fen="r2q1rk1/pp2bppp/2n1bn2/3pp3/4P3/2NP1N2/PPP1BPPP/R1BQ1RK1 w - -",
        tabiya_label="Complex middlegame: scan loose pieces and enemy forcing replies before moving",
        summary=(
            "Leaving material capturable is rarely about not knowing tactics; it comes from "
            "calculating only your own idea and forgetting to scan your opponent's forcing "
            "replies on the resulting board. Grandmasters rely on a short, automatic safety "
            "filter before every single move."
        ),
        core_ideas=(
            "LPDO (John Nunn): Loose Pieces Drop Off. Count every undefended piece (yours and theirs) every time the board changes.",
            "Overloaded defenders: a piece defending two targets at once is effectively defending neither.",
            "Visualize the board AFTER your chosen move: what new checks, captures, forks, pins, or back-rank threats did you just uncover?",
            "Watch what your moving piece STOPS defending (leaving a pawn, rook, or mating square unguarded).",
        ),
        checklist=(
            "1. Before touching a piece, list every check and capture your opponent will have on the very next ply.",
            "2. Check what square or piece your moving piece is leaving behind.",
            "3. Spot any piece of yours that is undefended or defended only once against two attackers.",
            "4. Never play a 'reflex recapture' without spending 3 seconds checking for an in-between move (zwischenzug).",
        ),
        common_traps=(
            "Playing a natural developing move that drops a hanging bishop or knight to a queen fork.",
            "Missing discovered attacks or x-rays along the newly opened file or diagonal.",
            "Speeding up in winning positions instead of slowing down to extinguish counterplay.",
        ),
        books=(
            BookReference(
                title="Build Up Your Chess 1-3 (Fundamentals / Beyond the Basics / Mastery)",
                author="GM Artur Yusupov",
                focus="Systematic tactical vision, blunder-checking, and disciplined calculation habits.",
                level="1500-2100",
            ),
            BookReference(
                title="The Woodpecker Method",
                author="GM Axel Smith & GM Hans Tikkanen",
                focus="Building instant pattern recognition through spaced cycles of curated tactical motifs.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Advanced Tactics & Blunder Prevention",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Drills multi-move tactical threats, overloaded pieces, and pre-move checks inside Chess.com Lessons.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="ChessGod Blunder Check & Punish Drills",
                author="Built into ChessGod",
                platform="ChessGod",
                source="free_modern",
                why="Drills your own real hanging-material and missed-tactic positions with Stockfish 19 verification.",
                url="#review-threats",
                level="Personalized",
            ),
        ),
    ),
    MasterPlaybook(
        id="tactical_punishment",
        category="tactics",
        title="Forcing-Move Calculation & Punishing Mistakes",
        subtitle="Stop handing back winning advantages when your opponent slips",
        color="both",
        structure_name="Candidate Moves & Forcing Lines",
        level="1600-2200",
        tabiya_fen="r1bq1rk1/ppp2ppp/2n2n2/3pp3/1bB1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - -",
        tabiya_label="Tactical tension: calculate every check, capture, and direct threat first",
        summary=(
            "At 1600-2000, opponents make game-losing mistakes in almost every rapid game, "
            "yet players hand over a third of those gifts straight back by playing a routine "
            "move instead of pausing to punish. Whenever an opponent's move looks suspicious, "
            "switch immediately into forcing-move calculation."
        ),
        core_ideas=(
            "Forcing order (Kotov / Aagaard): always check Checks -> Captures -> Direct Threats first because they narrow the opponent's replies.",
            "Candidate moves first: list 2-3 candidate moves before calculating deeply so you do not get tunnel vision on the first move you saw.",
            "Compare-and-eliminate: when your first move looks 'pretty good', ask if there is a cleaner move order (like an intermediate check or capture).",
            "When ahead in material, trade queens and active pieces cleanly rather than inviting chaotic complications.",
        ),
        checklist=(
            "1. Opponent just played a surprising or greedy move: pause for 15 seconds and ask 'what did this weaken?'",
            "2. Scan ALL legal checks, ALL captures (even sacrifices), and ALL double-attack threats.",
            "3. Look for undefended pieces on the opponent's side of the board and geometry (forks, skewers, pins).",
            "4. Calculate one move past the end of the sequence to make sure you did not walk into a counter-check.",
        ),
        common_traps=(
            "Seeing a good move and playing it instantly when a forcing tactic won a full piece or forced mate.",
            "Assuming a defended piece cannot be captured (ignoring deflection, pin, or removing the defender).",
            "Stopping calculation right after your own capture without checking the opponent's strongest reply.",
        ),
        books=(
            BookReference(
                title="Grandmaster Preparation: Calculation",
                author="GM Jacob Aagaard",
                focus="Candidate moves, forcing lines, comparison, elimination, and disciplined visualization.",
                level="1800-2300",
            ),
            BookReference(
                title="Excelling at Chess Calculation",
                author="GM Jacob Aagaard",
                focus="Accessible bridge into structured calculation methods for 1600-2000 club players.",
                level="1600-2000",
            ),
        ),
        courses=(
            CourseResource(
                title="Advanced Tactics & Calculation",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Trains intermediate moves, deflection, and forcing sequences with guided feedback.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="Lichess Puzzle Themes (Deflection, Hanging Piece, Intermezzo)",
                author="Lichess",
                platform="Lichess Study",
                source="free_modern",
                why="Unlimited free themed calculation sets to sharpen punishment instincts.",
                url="https://lichess.org/training/themes",
                level="1600-2200",
            ),
        ),
    ),
    MasterPlaybook(
        id="defensive_resilience",
        category="defense",
        title="Active Defense & Breaking the Second-Mistake Spiral",
        subtitle="Stay composed under pressure and turn bad positions into saves",
        color="both",
        structure_name="Defensive Technique & Composure",
        level="1600-2200",
        tabiya_fen="r2q1rk1/pp3ppp/2n1b3/3pP3/3P2b1/2N2N2/PP2BPPP/R1BQ1RK1 b - -",
        tabiya_label="Under pressure: defend actively and trade attackers rather than collapsing passively",
        summary=(
            "A single mistake rarely loses a 1700-2000 rapid game on the spot; the follow-up "
            "panic move does. Strong defenders treat an inferior position as a fresh puzzle: "
            "they slow down, neutralize the main threat with active counterplay, and force "
            "the attacker to prove every single step."
        ),
        core_ideas=(
            "The Post-Mistake Reset: the moment you realize you blundered, take your hands off the mouse for 10 seconds. Do not play a fast 'anger' or 'hope' move.",
            "Active defense beats passive defense (Dvoretsky / Hellsten): defend while creating a counter-threat or attacking the opponent's center.",
            "Trade the attacker's key pieces: neutralizing their attacking bishop or queen often collapses the entire assault.",
            "Do not create extra king-side pawn holes when defending; move pieces to defend squares before pushing shelter pawns.",
            "Know when to return a pawn to break the initiative and reach a holdable endgame.",
        ),
        checklist=(
            "1. Just made a mistake? Pause, breathe, and judge the position objectively as if you sat down to solve someone else's puzzle.",
            "2. Name the opponent's #1 concrete threat (mate, check, fork, or pawn break).",
            "3. Look for a defensive move that ALSO develops, improves a piece, trades an attacker, or counter-attacks.",
            "4. Check every check your opponent can give on your king before choosing a quiet defensive move.",
        ),
        common_traps=(
            "Playing instantly after a slip to 'hide' the mistake and blundering a second, fatal time.",
            "Retreating all pieces to the back rank with zero counterplay while the opponent builds freely.",
            "Ignoring king safety and allowing a forcing queen or knight check that wins a rook or forces mate.",
        ),
        books=(
            BookReference(
                title="Mastering Chess Strategy (Defense & Counterattack chapters)",
                author="GM Johan Hellsten",
                focus="Practical defensive methods: active counterplay, timely exchanges, and fortress building.",
                level="1700-2200",
            ),
            BookReference(
                title="Small Steps to Giant Improvement",
                author="GM Sam Shankland",
                focus="Practical pawn play, prophylaxis, and avoiding unnecessary weaknesses under pressure.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Clever Escapes from Common Mating Attacks & Defense Track",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Dedicated Chess.com Premium lessons on surviving attacks, countering threats, and holding tough positions.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="The Drawing Zone (Parts 1 & 2)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Teaches stubborn defensive technique and how to save inferior positions against stronger players.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="endgame_technique",
        category="endgame",
        title="Practical 2000-Level Endgame Technique",
        subtitle="Convert small advantages and hold tough rook and minor-piece endings",
        color="both",
        structure_name="Practical Endgame Conversion",
        level="1600-2100",
        tabiya_fen="8/5pk1/6p1/3P3p/8/5P2/4R1PP/6K1 w - -",
        tabiya_label="Rook endgame: activate your king and place your rook behind the passed pawn",
        summary=(
            "You do not need encyclopedic study-composer endgames to reach 2000. Mastering "
            "five practical rules (active king, rook activity, creating a passed pawn, "
            "Lucena/Philidor, and the principle of two weaknesses) converts won games "
            "cleanly and rescues half-points under low time."
        ),
        core_ideas=(
            "King becomes a fighting piece: march the king toward the center as soon as queens come off.",
            "Rooks belong behind passed pawns (yours to push them, theirs to stop them). Activity beats clinging to one passive pawn.",
            "Principle of Two Weaknesses: fix one weakness on the opponent's side, tie down their pieces, then open a second front on the opposite wing.",
            "Do not rush (Yusupov): in winning endgames with no counterplay, improve your king and pieces before committing pawns.",
            "Know the four mandatory theoretical positions cold: King+Pawn opposition, Philidor defense, Lucena bridge, and wrong-colored rook pawn.",
        ),
        checklist=(
            "1. Is my king as active as possible, or still sleeping on g1/g8?",
            "2. Should I trade pieces (ahead in material) or trade pawns (defending a pawn down)?",
            "3. Where can I create an outside passed pawn to deflect the enemy king?",
            "4. Before pushing a pawn, verify it does not allow the opponent's king or rook to infiltrate.",
        ),
        common_traps=(
            "Defending passively with a rook in front of a passed pawn instead of giving checks from behind.",
            "Trading into a losing king-and-pawn endgame without calculating opposition.",
            "Allowing stalemate tricks or perpetual check when converting a queen or extra rook.",
        ),
        books=(
            BookReference(
                title="Silman's Complete Endgame Course",
                author="IM Jeremy Silman",
                focus="Rating-tiered chapters (Class B, Class A, Expert) covering every practical ending up to 2200.",
                level="1400-2200",
            ),
            BookReference(
                title="100 Endgames You Must Know",
                author="GM Jesus de la Villa",
                focus="The essential theoretical rook, pawn, and minor-piece endings that recur in tournament games.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Mastering Rook Endgames & Advanced Endgames",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Interactive Lucena, Philidor, opposition, and rook-activity drills included with Chess.com Premium.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="Lichess Practice: Basic & Intermediate Endgames",
                author="Lichess",
                platform="Lichess Study",
                source="free_modern",
                why="Free interactive drills against Stockfish for opposition, Lucena, Philidor, and minor-piece endings.",
                url="https://lichess.org/practice",
                level="1500-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="session_discipline",
        category="habits",
        title="Peak-Form Session Discipline",
        subtitle="Protect your rating from late-session fatigue",
        color="both",
        structure_name="Training & Playing Routine",
        level="All Levels",
        tabiya_fen=None,
        tabiya_label=None,
        summary=(
            "Chess performance drops steeply once working memory fatigues, even when you "
            "do not feel tilted. Hard-capping rated rapid sittings before your proven drop-off "
            "game turns losing marathons into steady rating climbs."
        ),
        core_ideas=(
            "Play in short, focused blocks of 3-4 rapid games, then stop rated play for at least 30 minutes.",
            "Warm up with 5-10 minutes of ChessGod Blunder Check or Opening Course drills before game 1.",
            "Review every rapid game immediately after playing while your thought process is still fresh.",
            "If you want more chess after game 4, switch to unrated sparring, puzzles, or studying a playbook rather than risking rated Elo while tired.",
        ),
        checklist=(
            "1. Decide your game cap (3 or 4 rated games) BEFORE clicking Play.",
            "2. Take a 2-minute reset between games instead of insta-queuing.",
            "3. Stop the rated session immediately if you hit your cap or drop two games in a row.",
        ),
        common_traps=(
            "Chasing back lost rating points on game 5, 6, and 7 while calculation accuracy is already sliding.",
        ),
        books=(
            BookReference(
                title="The Chess Improvement Guide / Perpetual Chess Framework",
                author="IM Kostya Kavutskiy & ChessDojo",
                focus="Structuring high-quality rapid play, post-mortem analysis, and focused study blocks.",
                level="1500-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="ChessGod Daily Loop (Drills -> 3-4 Rapid Games -> Game Review)",
                author="Built into ChessGod",
                platform="ChessGod",
                source="free_modern",
                why="Uses your own Habits tracker to keep sessions inside your winning window.",
                url="#review-habits",
                level="Personalized",
            ),
        ),
    ),
    # ------------------------------------------------------------------
    # OPENING & PAWN-STRUCTURE MASTER PLAYBOOKS
    # ------------------------------------------------------------------
    MasterPlaybook(
        id="italian_white",
        category="opening",
        title="Italian Game & Giuoco Pianissimo (White)",
        subtitle="Complete 1800-2000 plans: slow squeeze, knight tour, and timed central breaks",
        color="white",
        structure_name="Giuoco Pianissimo / Classical e4-e5",
        level="1600-2200",
        tabiya_fen="r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - -",
        tabiya_label="Giuoco Pianissimo tabiya after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6 5.d3 d6 6.O-O O-O",
        summary=(
            "Modern grandmaster Italian play is not about cheap Fried Liver traps; it is a "
            "rich positional battle built around c3+d3, preserving the c4 bishop via a4/Bb3/Bc2, "
            "rerouting the b1 knight (Nbd2-f1-g3) toward f5, and choosing the exact moment to "
            "strike with d4 or launch a kingside attack."
        ),
        core_ideas=(
            "Preserve the Italian bishop: play a4 to stop ...b5 and give the c4 bishop a safe retreat on a2 or b3 against ...Na5.",
            "The classic knight maneuver: Nbd2-f1-g3 (or h2-g4) eyes the monster f5 outpost once Black commits ...h6 or ...g6.",
            "Choose between the slow squeeze (c3, d3, Re1, h3, Nbd2) and the sharp central break (c3 + d4) depending on whether Black's pieces are coordinated.",
            "Meet ...Be6 calmly: Bxe6 fxe6 is fine when it opens the f-file only if you can control d4 and target the e6/e5 pawns; otherwise retreat Bb3 or let Black take on e6.",
            "Always respect Black's freeing ...d5 break: control d5 with Re1, Bb3, and exd5 only when your pieces stand better in the open center.",
        ),
        white_plans=(
            "Slow Pianissimo: O-O, Re1, a4, h3, Nbd2-f1-g3, fighting for f5 and preparing d4 when ready.",
            "Kingside expansion: after Nf5 or Nh4, bring the queen to f3/g4 and lift a rook via Re3-g3.",
            "Central rupture: play d4 only when your e4 pawn is overprotected and Black's queen or bishop is awkwardly placed.",
        ),
        black_plans=(
            "Neutralize the c4 bishop with ...Be6 or ...Na5 and break in the center with ...d5.",
            "Counter on the kingside with ...h6, ...g5, or ...Nh5-f4 if White plays too slowly.",
        ),
        key_breaks=("White: d3-d4 (central opening), b2-b4 (queenside space), f2-f4 (rare kingside storm).", "Black: ...d6-d5 (main equalizer), ...f7-f5 (if center is locked)."),
        piece_guide=(
            "Light-squared bishop (c4 -> b3/a2/c2): your pride piece; avoid trading it carelessly for a knight on a5.",
            "Queen's knight (b1 -> d2 -> f1 -> g3 -> f5): the signature Italian route.",
            "Dark-squared bishop (c1 -> e3 or g5): often supports d4 from e3 or pins f6 only after Black has castled and you have h3/a4 ready.",
        ),
        checklist=(
            "1. Did Black threaten ...Na5 to win my c4 bishop? Check if a4 or Bb5/Ba2 is needed.",
            "2. Is Black ready to play ...d5? Make sure my e4 pawn is defended before moving the f3 knight.",
            "3. Where is my b1 knight going? Plan Nbd2-f1-g3 early.",
            "4. Before pushing d4, check if ...exd4 cxd4 ...Bb4+ or ...d5 disrupts my center.",
        ),
        common_traps=(
            "Playing Bg5 before Black castles (running into ...h6, ...g5, ...Nh5/g4 counterplay).",
            "Allowing ...Nxe4 tactical forks (...Nxe4 Nxe4 ...d5) when your c4 bishop and e4 pawn are undefended.",
            "Letting Black trade off your c4 bishop on a5 and smoothly equalize with ...d5.",
        ),
        eco_prefixes=("C50", "C51", "C52", "C53", "C54", "C55", "C56", "C57", "C58", "C59"),
        opening_keywords=("italian", "giuoco", "evans", "two knights"),
        books=(
            BookReference(
                title="The Modernized Italian",
                author="GM Pavel Eljanov / Modern 1.e4 Repertoires",
                focus="Slow c3/d3/a4 setups, Nbd2-f1-g3 plans, and handling Black's ...Be6 and ...d5 counterplay.",
                level="1700-2200",
            ),
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Closed Lopez / e4-e5 chapters)",
                author="GM Mauricio Flores Rios",
                focus="Piece rerouting, central tension, and kingside vs queenside timing in 1.e4 e5 structures.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Play The Italian",
                author="IM Yuriy Krykun",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Modern GM-inspired Italian plans for White moving past beginner templates into active piece play.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="The Loud Italian / Quiet Italian Series",
                author="GM Alexandra Kosteniuk",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers both positional Giuoco Pianissimo ideas and sharp attacking variations in your Chess.com membership.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Short & Sweet: Krykun's Italian Game",
                author="IM Yuriy Krykun",
                platform="Chessable Free",
                source="free_modern",
                why="Free spaced-repetition companion covering key Italian plans and move orders.",
                url="https://www.chessable.com/courses/all/all/free/?search=Italian",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="italian_black",
        category="opening",
        title="Defending the Italian & Two Knights (Black)",
        subtitle="Stay active against Giuoco Piano, Albin/Greco lines, and the Knight Attack",
        color="black",
        structure_name="Classical Italian / Polerio Defense",
        level="1600-2100",
        tabiya_fen="r1bqk2r/ppp2ppp/2np1n2/2b1p3/2BPP3/2P2N2/PP3PPP/RNBQK2R b KQkq -",
        tabiya_label="Main-line Italian center strike: retreat cleanly to b6, never blunder on b4",
        summary=(
            "As Black against 3.Bc4, most losses come from two concrete mistakes: giving "
            "unnecessary bishop checks on b4 that lose a piece or tempo to Bd2/d5, and "
            "getting passive against 4.Ng5 (Knight Attack). Active piece play and the right "
            "retreat squares equalize comfortably."
        ),
        core_ideas=(
            "Against the c3+d4 center strike (4.c3 Nf6 5.d4 exd4 6.cxd4): play 6...Bb4+ only when you know the sharp Nc3/Bd2 theory; against d3/d4 after ...d6, retreat ...Bb6! (not ...Bb4? which often hangs tactics).",
            "In the Giuoco Pianissimo (d3/c3): tuck the c5 bishop back via ...a6 and ...Ba7 so White's d4 or Be3 never hits it with tempo.",
            "Against 3...Nf6 4.Ng5 (Knight Attack): play 4...d5 5.exd5 Na5! (Polerio Defense). Do NOT play 5...Nxd5? (walks into Nxf7 Fried Liver or d4).",
            "After 5...Na5 6.Bb5+ c6 7.dxc6 bxc6 8.Be2 h6 9.Nf3 e4: you are down a pawn temporarily, with massive piece activity and initiative.",
        ),
        white_plans=(
            "Build a huge d4+e4 pawn center or attack f7 early with Ng5.",
            "Squeeze slowly with c3, d3, a4, and Nbd2-f1-g3.",
        ),
        black_plans=(
            "Preserve the dark-squared bishop on a7/b6, complete development (...O-O, ...Re8, ...h6), and challenge the center with ...d5 or ...Be6.",
            "In the Polerio (4.Ng5 d5 5.exd5 Na5), drive White's pieces back with ...c6, ...h6, and ...e4, seizing the initiative.",
        ),
        key_breaks=("Black: ...d6-d5 (classical central break), ...c7-c6 and ...e5-e4 (Polerio counterattack)."),
        piece_guide=(
            "Dark-squared bishop (c5 -> b6/a7): keep it alive on the a7-g1 diagonal; avoid hanging it on b4.",
            "Queen's knight: in quiet lines ...Ne7-g6 targets f4; in Polerio ...Na5 kicks the bishop and re-enters via b7/d6 or c4.",
        ),
        checklist=(
            "1. If White plays d4 and opens the center, double-check whether ...Bb4+ runs into Bd2/Bxb4 or a5/Qa4+ forks. When in doubt, ...Bb6 keeps the bishop safe.",
            "2. Against 4.Ng5, remember the exact order: 4...d5 5.exd5 Na5! 6.Bb5+ c6 7.dxc6 bxc6.",
            "3. In quiet d3 lines, play ...a6 early so your c5 bishop always has the a7 shelter.",
        ),
        common_traps=(
            "Playing ...Bb4? in the ...d6 / cxd4 structure where White wins a piece or crushes with Qa4+/d5.",
            "Recapturing 5...Nxd5? against 4.Ng5 instead of 5...Na5!.",
            "Castle-into-pin oversights when White plays Bg5 and Nd5 before you play ...h6.",
        ),
        eco_prefixes=("C50", "C53", "C54", "C55", "C56", "C57", "C58", "C59"),
        opening_keywords=("italian", "giuoco", "knight attack", "polerio", "albin"),
        books=(
            BookReference(
                title="Playing 1.e4 e5: A Classical Repertoire",
                author="GM Nikolaos Ntirlis",
                focus="Rock-solid, practical plans for Black against every Italian and Two Knights weapon.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn The Italian Game (Both Colors)",
                author="GM Alexandra Kosteniuk",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers both sides of the Italian, including how Black neutralizes the sharp center breaks.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Short & Sweet: 1...e5",
                author="GM Jan Gustafsson / IM Christof Sielecki",
                platform="Chessable Free",
                source="free_modern",
                why="Free, clean 1...e5 lines against the Italian, Polerio, Scotch, and King's Gambit.",
                url="https://www.chessable.com/courses/all/all/free/?search=1...e5",
                level="1600-2100",
            ),
        ),
    ),
    MasterPlaybook(
        id="scotch_black",
        category="opening",
        title="Neutralizing the Scotch Game (Black)",
        subtitle="Fix the 5.Qxd4 trap and counterattack White's open center cleanly",
        color="black",
        structure_name="Open e4-e5 / Scotch Center",
        level="1600-2100",
        tabiya_fen="r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -",
        tabiya_label="Scotch after 1.e4 e5 2.Nf3 Nc6 3.d4 exd4 4.Nxd4 Nxd4 5.Qxd4: play 5...Qf6! (never 5...Nf6?)",
        summary=(
            "The Scotch Game punishes passive play ruthlessly. Most club losses happen in "
            "one of two ways: trading knights on d4 and then walking into 5...Nf6? 6.e5! "
            "(which traps the knight or wrecks development), or failing to counterattack e4 "
            "immediately with 4...Bc5 or 4...Nf6."
        ),
        core_ideas=(
            "Best practical cure: avoid 4...Nxd4 altogether! Play 4...Bc5 (Classical Scotch) or 4...Nf6 (Schmidt Scotch) to keep active pieces and immediately attack e4/d4.",
            "If you DO enter 4...Nxd4 5.Qxd4: NEVER play 5...Nf6? (6.e5 Qe7 7.Be3 or 6.e5 Ng8 leaves Black miserable). Play 5...Qf6! or 5...d6 6.Nc3 Nf6, challenging the queen immediately.",
            "After 4...Bc5 5.Be3 Qf6 6.c3 Nge7: your queen eyes b2 and f2, your knight supports ...d5 or ...Ne5, and you follow with ...O-O and ...d5/Bb6.",
            "After 4...Nf6 5.Nxc6 bxc6 6.e5 Qe7 7.Qe2 Nd5: your king-side pawn structure is healthy, and ...Ba6 or ...g6/...Bg7 puts heavy pressure on e5.",
        ),
        white_plans=(
            "Use the extra central space (e4-e5) to squeeze Black's knights and castle queenside for a kingside attack.",
            "Trade into an endgame with a 4-vs-3 kingside majority if Black allows doubled c-pawns without counterplay.",
        ),
        black_plans=(
            "Attack White's e4 pawn immediately (4...Nf6) or target d4/f2 (4...Bc5 + ...Qf6) before White can consolidate.",
            "Break with ...d5 as soon as development is complete to dissolve White's space edge.",
        ),
        key_breaks=("Black: ...d7-d5 (primary central equalizer), ...f7-f6 (undermining White's e5 wedge in 4...Nf6 lines)."),
        piece_guide=(
            "Queen: Qf6 is uniquely strong in the Scotch because it challenges White's d4 queen/knight and stops e5.",
            "Dark-squared bishop: active on c5/b6 or fianchettoed on g7 in the 4...Nf6 line.",
        ),
        checklist=(
            "1. On move 4 of the Scotch, choose 4...Bc5 or 4...Nf6 rather than 4...Nxd4.",
            "2. If White's queen reaches d4 after ...Nxd4 Qxd4, answer 5...Qf6! (never 5...Nf6? which walks into 6.e5!).",
            "3. Finish castling quickly and time ...d5 to prevent White from rolling e5-f4.",
        ),
        common_traps=(
            "Playing 4...Nxd4 5.Qxd4 Nf6? 6.e5! (instant -2 pawn position).",
            "Playing 4...Bc5 5.Be3 Qf6 6.c3 Nge7 without watching for Nb5/Qd2 tactics on c7.",
            "Leaving the king in the center while White opens the e-file.",
        ),
        eco_prefixes=("C44", "C45"),
        opening_keywords=("scotch",),
        books=(
            BookReference(
                title="Playing 1.e4 e5: A Classical Repertoire",
                author="GM Nikolaos Ntirlis",
                focus="Complete anti-Scotch coverage with 4...Bc5 and 4...Nf6 middlegame blueprints.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn Every Chess Opening (Scotch Game Module)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Walks through key Scotch traps, move orders, and Black counterplay inside your Chess.com Premium library.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Lichess Study: How to Beat the Scotch Game as Black",
                author="Lichess Community",
                platform="Lichess Study",
                source="free_modern",
                why="Free interactive chapters covering 4...Bc5, 4...Nf6, and punishing inaccurate White setups.",
                url="https://lichess.org/study/search?q=scotch+game+black",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="kings_gambit_black",
        category="opening",
        title="Dismantling the King's Gambit (Black)",
        subtitle="Counter-strike the center with ...d5 instead of defending passively",
        color="black",
        structure_name="King's Gambit / Falkbeer & Classical Counterplay",
        level="1600-2100",
        tabiya_fen="rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq -",
        tabiya_label="King's Gambit (1.e4 e5 2.f4): counter-strike the center with 2...d5! or 2...exf4 3.Nf3 d5!",
        summary=(
            "The King's Gambit only works when Black plays timidly or tries greedily to "
            "cling to the f4 pawn while falling behind in development. The grandmaster rule "
            "against any flank gambit is simple: counter-strike the center immediately with "
            "...d5! and exploit White's weakened e1-h4 diagonal."
        ),
        core_ideas=(
            "Two rock-solid weapons: 2...d5! (Falkbeer Countergambit: 3.exd5 exf4 or 3...c6) OR 2...exf4 3.Nf3 d5! (Modern Defense: give the pawn back to seize fast, clean development).",
            "Never try to cling to the f4 pawn with ...g5 unless you know deep razor-sharp theory; returning the pawn for central control and piece speed leaves White's king permanently drafty.",
            "Every time White plays f4, the e1-h4 diagonal and e4/g3 squares are weakened forever.",
            "Develop rapidly (...Nf6, ...Bd6/...Bc5, ...O-O, ...Re8) and open the e-file against White's uncastled king.",
        ),
        white_plans=(
            "Open the f-file after O-O, dominate the center with d4, and overwhelm f7 before Black castles.",
        ),
        black_plans=(
            "Strike with ...d5 on move 2 or move 3 to shatter White's center and seize easy piece activity.",
            "Castle swiftly, place a rook on e8, and punish White's exposed kingside.",
        ),
        key_breaks=("Black: ...d7-d5! (the universal antidote to 2.f4).",),
        piece_guide=(
            "Dark-squared bishop: d6 or c5 exerts painful pressure against White's kingside and d4.",
            "Knights: f6 and c6/d7 combine quickly with ...Re8 to pressure e4.",
        ),
        checklist=(
            "1. Against 1.e4 e5 2.f4, choose 2...exf4 3.Nf3 d5! (or 2...d5! immediately).",
            "2. After 2...exf4 3.Bc4, play 3...d5! 4.Bxd5 Nf6 or 3...Nf6 4.Nc3 c6 5.Qf3 d5!.",
            "3. Do not grab extra side pawns with the queen; prioritize castling and opening lines against White's king.",
        ),
        common_traps=(
            "Playing 2...Nc6? or 2...d6? passively and letting White build a dream d4+Nf3+Bc4+O-O f-file attack.",
            "Hanging f7 or allowing Bxf7+ tactics when playing ...Bc5 before checking White's fxe5/d4 ideas.",
        ),
        eco_prefixes=("C30", "C31", "C32", "C33", "C34", "C35", "C36", "C37", "C38", "C39"),
        opening_keywords=("king's gambit", "kings gambit", "falkbeer"),
        books=(
            BookReference(
                title="Playing 1.e4 e5: A Classical Repertoire",
                author="GM Nikolaos Ntirlis",
                focus="The Modern 2...exf4 3.Nf3 d5! counter-strike that neutralizes the King's Gambit cleanly.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn Every Chess Opening (King's Gambit Module)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers core King's Gambit ideas and how Black refutes over-ambitious attacks.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Lichess Study: Refuting the King's Gambit with ...d5",
                author="Lichess Community",
                platform="Lichess Study",
                source="free_modern",
                why="Interactive move-by-move lines for 2...exf4 3.Nf3 d5! and the Falkbeer Countergambit.",
                url="https://lichess.org/study/search?q=king%27s+gambit+d5",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="qgd_vs_d4_black",
        category="opening",
        title="Classical Queen's Gambit Declined vs 1.d4 & London (Black)",
        subtitle="Replace shaky ...Nc6 setups with the Carlsbad & classical 1...d5 2...e6 backbone",
        color="black",
        structure_name="Carlsbad & Classical QGD (Flores Rios Family 1)",
        level="1600-2200",
        tabiya_fen="rnbq1rk1/ppp1bppp/4pn2/3p4/2PP4/2N2N2/PP2PPPP/R1BQKB1R b KQ -",
        tabiya_label="Classical QGD setup (1...d5 2...e6): solid center, clear plans against both 2.c4 and 2.Bf4",
        summary=(
            "Meeting 1.d4 with Chigorin/Marshall setups (...Nc6 blocking the c-pawn) often "
            "leaves Black fighting from an inferior center with zero pawn break. Switching to "
            "1...d5 and 2...e6 (Queen's Gambit Declined) keeps your c-pawn free for ...c5, "
            "gives you a rock-solid, grandmaster-proven structure against 2.c4, AND gives you "
            "an active anti-London blueprint (...c5 + ...Bd6)."
        ),
        core_ideas=(
            "Rule #1 vs 1.d4: NEVER block your c-pawn with ...Nc6 before pushing ...c5 or ...c6! The c-pawn is your lever to challenge White's d4 center.",
            "Against 2.c4 (QGD): 1.d4 d5 2.c4 e6 3.Nc3 Nf6 gives you rock-solid central control. Meet Bg5 with ...Be7, ...O-O, ...h6, and free your position with ...c5 or ...c6 + ...Nbd7 + ...dxc4/...Nd5.",
            "In the Exchange QGD (Carlsbad Structure, cxd5 exd5): expect White's minority attack (b4-b5). Counter it actively by placing a knight on e4, trading dark-squared bishops (...Bf5/Be7-d6), and playing on the kingside or blocking b5 with ...a6/...b5 or ...c6/...Bf5.",
            "Against the London / Accelerated London (1.d4 d5 2.Bf4): strike early with ...c5! and ...Nc6/...Nf6/...Bd6 to challenge White's pride bishop on f4 (and ...Qb6 targeting b2 if White forgets c3).",
        ),
        white_plans=(
            "Exchange QGD (Carlsbad): launch the queenside minority attack (Rb1, b4-b5) to saddle Black with a backward c6 pawn, OR push e4 in the Nge2+f3 plan.",
            "London: build the e3/c3/d4 pyramid, plant Ne5, and attack the kingside.",
        ),
        black_plans=(
            "QGD main lines: trade off one pair of knights (...Ne4 or ...Nd5), activate the c8 bishop (...b6/...Bb7 or ...Bf5 after cxd5 exd5), and break with ...c5.",
            "Against the London: challenge d4 with ...c5, neutralize Bf4 with ...Bd6 or ...Nh5, and seize space on the queenside.",
        ),
        key_breaks=("Black: ...c7-c5 (main central counter-break), ...e6-e5 (secondary freeing break).", "White: b2-b4-b5 (Carlsbad minority attack), e3-e4 (central expansion)."),
        piece_guide=(
            "Light-squared bishop (c8): your key strategic problem; solve it by developing to f5 (in Exchange lines), b7 (after ...b6), or trading it cleanly after ...dxc4/...e5.",
            "Knights: f6-e4 is a monster outpost in Carlsbad structures; d7 supports ...c5 or ...e5 without blocking the c-pawn.",
        ),
        checklist=(
            "1. Against 1.d4 d5, keep the c-pawn free: play 2...e6 (vs 2.c4) or 2...c5/2...Nf6 (vs 2.Bf4), NOT 2...Nc6.",
            "2. Against Exchange QGD (cxd5 exd5), remember: ...c6, ...Bf5 (or ...Be7/...Nbd7/...Re8/...Nf8-e6), and prepare kingside counterplay before b4-b5 lands.",
            "3. Against the London, test White immediately with ...c5 and ...Bd6/...Qb6 so they cannot autopilot.",
        ),
        common_traps=(
            "Playing ...Nc6 in front of the c7 pawn (Chigorin/Marshall) and getting squeezed off the board by d4-d5 or c4-d5.",
            "Falling for the Elephant Trap in reverse or losing the d5 pawn to cxd5 Nxd5 when your f6 knight is pinned by Bg5.",
            "Letting White complete b4-b5xc6 untouched while your c8 bishop sits trapped behind e6.",
        ),
        eco_prefixes=("D00", "D02", "D06", "D07", "D30", "D31", "D35", "D37", "D40", "D50", "D52", "D53", "D55", "D60"),
        opening_keywords=("queen's gambit", "chigorin", "marshall", "zukertort", "london", "queen's pawn"),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Family 1: Carlsbad, IQP, Slav)",
                author="GM Mauricio Flores Rios",
                focus="The definitive guide to Carlsbad minority-attack defense, ...Ne4 counterplay, and QGD piece placement.",
                level="1600-2200",
            ),
            BookReference(
                title="The Queen's Gambit Declined (Move by Move / Ntirlis)",
                author="GM Nikolaos Ntirlis",
                focus="Complete modern QGD repertoire with clear middlegame plans against both 2.c4 and 1.d4 sidelines.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="The Complete Queen's Gambit Declined",
                author="GM Gregory Kaidanov",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Full GM-taught QGD course included in your Chess.com Premium subscription: covers structures, breaks, and plans.",
                url="https://www.chess.com/lessons",
                level="1600-2100",
            ),
            CourseResource(
                title="Learn the Queen's Gambit Declined",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Interactive drills on QGD main lines, Carlsbad counterplay, and avoiding early tactical traps.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Short & Sweet: Queen's Gambit Declined",
                author="Chessable Free",
                platform="Chessable Free",
                source="free_modern",
                why="Free MoveTrainer spaced-repetition course to lock in 1...d5 2...e6 lines quickly.",
                url="https://www.chessable.com/courses/all/all/free/?search=Queen%27s+Gambit+Declined",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="london_white",
        category="opening",
        title="Modern Aggressive London System (White)",
        subtitle="Move past autopilot setups into Ne5 outposts, e4 breaks, and kingside attacks",
        color="white",
        structure_name="London Pyramid / Slav-Stonewall Hybrid",
        level="1600-2100",
        tabiya_fen="rnbq1rk1/pp2bppp/4pn2/2pp4/3P1B2/2P1PN2/PP1N1PPP/R2QKB1R w KQ -",
        tabiya_label="Modern London battleground: handle ...c5 cleanly and choose Ne5, e4, or kingside storm",
        summary=(
            "Above 1600, playing the London on autopilot leads to lifeless positions where "
            "Black equalizes easily with ...c5 and ...Qb6. Strong London players treat it as "
            "a flexible attacking weapon: anchoring a knight on e5, meeting ...Bd6 cleanly "
            "(Bg3!), challenging early ...c5/...Qb6 concretely, and timing the e4 or f4 break."
        ),
        core_ideas=(
            "Never play on autopilot: when Black plays early ...c5 and ...Qb6, answer with Qb3 (inviting ...Qxb3 axb3 to open the a-file!) or Qc1/c3 depending on b2 safety.",
            "Meet ...Bd6 with Bg3! (not Bxd6 unless it ruins Black's structure or wins e5): if Black takes ...Bxg3 hxg3, your h-file opens for a fierce kingside attack.",
            "Plant the knight on e5 supported by d4 and f4 (Stonewall attacking chain) followed by Qf3, Qh3, and g4-g5 against a castled Black king.",
            "Keep the c4 break alive against passive King's Indian / ...g6 setups (switching into a strong Jobava/c4 space grab instead of a sterile c3).",
            "Prepare the e3-e4 central break (via Nbd2, Qe2, Rfe1) whenever Black leaves the e4 square underdefended.",
        ),
        white_plans=(
            "Kingside assault: Ne5, f4, Qf3-h3, Rf3-h3, or g4-g5 with the h-file opened via Bg3.",
            "Central expansion: Nbd2, Qe2, Bd3, e3-e4 to seize the center and activate both bishops.",
            "Queenside pressure: after ...Qb6 Qb3 c4 Qc2, strike with b3 or e4.",
        ),
        black_plans=(
            "Undermine d4 and b2 early with ...c5 and ...Qb6.",
            "Trade off White's f4 bishop (...Bd6 or ...Nh5) and break in the center with ...e5 or ...c5.",
        ),
        key_breaks=("White: e3-e4 (central break), c3-c4 (against passive setups), f2-f4 + g2-g4 (kingside storm).", "Black: ...c7-c5, ...e6-e5."),
        piece_guide=(
            "Dark-squared bishop (f4 -> g3): retreat to g3 against ...Bd6 to fight for the h-file and e5 square.",
            "Light-squared bishop (f1 -> d3): eyes h7 (Greek Gift Bxh7+ motif whenever Black's f6 knight moves).",
            "Knights: Nf3-e5 is the anchor; Nbd2 supports e4 and recaptures on e5/f3.",
        ),
        checklist=(
            "1. Did Black play ...c5 and ...Qb6? Protect b2 cleanly (Qb3 or Qc2) instead of autopiloting Bd3?.",
            "2. Did Black play ...Bd6? Retreat Bg3! and welcome ...Bxg3 hxg3.",
            "3. Can I land Ne5 safely without losing the d4 pawn or allowing ...Bxe5 dxe5 Nd7?",
            "4. Check if Bxh7+ (Greek Gift) is live once Black castles and removes the f6 defender.",
        ),
        common_traps=(
            "Playing 1.d4 d5 2.Bf4 c5 3.e3 Nc6 4.Nf3 Qb6 and hanging the b2 pawn with autopilot Bd3.",
            "Trading Bxd6?! automatically and helping Black develop their queen with tempo.",
            "Playing c3 against ...g6/...Bg7 setups where c4+Nc3 grabs way more space.",
        ),
        eco_prefixes=("D00", "D02"),
        opening_keywords=("london", "accelerated london"),
        books=(
            BookReference(
                title="Win with the London System",
                author="GM Sverre Johnsen & IM Vlatko Kovacevic",
                focus="Classic attacking plans, Ne5-f4 chains, and thematic sacrifices in the London.",
                level="1600-2100",
            ),
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Stonewall & Slav chapters)",
                author="GM Mauricio Flores Rios",
                focus="Understanding when to pivot into Stonewall kingside attacks vs central e4 breaks.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Practice the London System",
                author="Chess.com Team",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Puzzle-driven London course teaching Bxh7+ sacrifices, outposts, and pawn breaks in Chess.com Premium.",
                url="https://www.chess.com/lessons",
                level="1600-2000",
            ),
            CourseResource(
                title="London System for the Busy Chess Player",
                author="GM Simon Williams",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Aggressive, attacking approach to the London from GingerGM inside Chess.com Lessons.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Short & Sweet: The London System",
                author="Chessable Free",
                platform="Chessable Free",
                source="free_modern",
                why="Free spaced-repetition lines against Black's main replies (...d5, ...Nf6, ...c5, ...g6).",
                url="https://www.chessable.com/courses/all/all/free/?search=London+System",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="sicilian_white",
        category="opening",
        title="Anti-Sicilian Structures: Rossolimo & Closed Sicilian (White)",
        subtitle="Control 1.e4 c5 with clear structural plans instead of getting out-tacticked",
        color="white",
        structure_name="Rossolimo Doubled c-Pawns & Closed Sicilian",
        level="1600-2200",
        tabiya_fen="r1bqkbnr/pp1ppp1p/2n3p1/1Bp5/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq -",
        tabiya_label="Rossolimo Sicilian (1.e4 c5 2.Nf3 Nc6 3.Bb5 g6): choose 4.O-O or 4.Bxc6 for clear structural pressure",
        summary=(
            "Open Sicilians reward whichever player memorized move 18. The Rossolimo (3.Bb5 "
            "against 2...Nc6) and Closed Sicilian (2.Nc3, g3, Bg2, d3, f4) let you fight for "
            "a clear positional and attacking advantage using recurring plans you can master "
            "completely."
        ),
        core_ideas=(
            "Rossolimo (1.e4 c5 2.Nf3 Nc6 3.Bb5): when you capture Bxc6 dxc6 (or bxc6), fix Black's doubled c-pawns and blockade on dark squares (d3, c4, Be3, Nc3), then push f4 or e5.",
            "Against 3...g6 in the Rossolimo: castle quickly (4.O-O Bg7 5.Re1 or 5.c3), build a broad c3+d4 center, and keep strong pressure on e5.",
            "Closed Sicilian (2.Nc3, g3, Bg2, d3, f4): expand on the kingside (Nf3, O-O, f4-f5, Qe1-h4, Bh6) while restraining Black's queenside ...b5-b4 counterplay with a4/a3.",
            "In both systems, control the d5 square tightly so Black cannot easily free their game with ...d5.",
        ),
        white_plans=(
            "Rossolimo doubled-c-pawn squeeze: O-O, Re1, d3, h3, Nbd2-c4, targeting c5 and preparing e5 or f4.",
            "Closed Sicilian kingside storm: f4-f5, Bh6 (trade off Black's g7 defender), Qh4, and Ng5.",
        ),
        black_plans=(
            "Use the bishop pair and open d-file/b-file to break with ...c4 or ...f5.",
            "In the Closed Sicilian, push ...b5-b4, put a knight on d4, and counterattack on the queenside.",
        ),
        key_breaks=("White: f2-f4-f5 (kingside attack), c2-c3 + d2-d4 (central takeover).", "Black: ...b7-b5-b4 (queenside attack), ...d6-d5 or ...f7-f5."),
        piece_guide=(
            "Light-squared bishop (Rossolimo): gladly trade on c6 when Black must ruin their structure or lose tempo; otherwise tuck back to a4/c2.",
            "Dark-squared bishop (Closed Sicilian): Be3-h6 trades off Black's king defender on g7.",
            "Knights: keep control over d5/f5; avoid letting Black's knight sit unchallenged on d4.",
        ),
        checklist=(
            "1. Against 1.e4 c5 2.Nf3 Nc6, know your exact follow-up after 3.Bb5 g6 (4.O-O or 4.Bxc6) and 3.Bb5 e6 (4.O-O or 4.Bxc6).",
            "2. If you choose the Closed Sicilian (where your win rate is strong), commit to the f4-f5 kingside plan and stop ...b5-b4 early.",
            "3. Never let Black play ...d5 for free; keep e4/c3/Nc3 covering d5.",
        ),
        common_traps=(
            "Trading Bxc6 too late after Black already played ...Nd4 or ...Qc7 and recaptures smoothly.",
            "Playing slowly in the Closed Sicilian without f4, letting Black crush your queenside with ...Rb8 and ...b5-b4.",
            "Hanging the e4 pawn to ...Qa5+ tactics in the Rossolimo.",
        ),
        eco_prefixes=("B20", "B21", "B22", "B23", "B24", "B25", "B26", "B30", "B31", "B51", "B52"),
        opening_keywords=("sicilian", "rossolimo", "moscow", "closed sicilian", "old sicilian"),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Family 2: Sicilian Structures)",
                author="GM Mauricio Flores Rios",
                focus="Understanding Sicilian pawn breaks, d5 control, and kingside vs queenside timing.",
                level="1600-2200",
            ),
            BookReference(
                title="Mastering the Chess Openings, Vol. 1",
                author="IM John Watson",
                focus="Strategic logic behind the Rossolimo, Moscow, and Closed Sicilian structures.",
                level="1600-2100",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn The Sicilian Rossolimo And Moscow Variations",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Directly fixes 1.e4 c5 2.Nf3 Nc6 3.Bb5 plans, trades, and middlegame structures in your Chess.com Premium library.",
                url="https://www.chess.com/lessons",
                level="1600-2100",
            ),
            CourseResource(
                title="Short & Sweet: Anti-Sicilians / Rossolimo",
                author="Chessable Free",
                platform="Chessable Free",
                source="free_modern",
                why="Free spaced-repetition lines for the Rossolimo and Closed Sicilian.",
                url="https://www.chessable.com/courses/all/all/free/?search=Rossolimo",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="caro_kann_white",
        category="opening",
        title="Playing Against the Caro-Kann (White)",
        subtitle="Master the Exchange Carlsbad minority attack and Advance space plans",
        color="white",
        structure_name="Carlsbad / Caro-Kann Formation (Flores Rios Family 1)",
        level="1600-2200",
        tabiya_fen="rnbqkbnr/pp2pppp/8/3p4/3P4/8/PP3PPP/RNBQKBNR w KQkq -",
        tabiya_label="Exchange Caro-Kann (1.e4 c6 2.d4 d5 3.exd5 cxd5): play 4.Bd3! for the reversed Carlsbad plan",
        summary=(
            "The Caro-Kann Exchange (3.exd5 cxd5 4.Bd3) looks quiet, which is why players "
            "drift and get outplayed by Black's simple development. Treating it as a reversed "
            "Carlsbad structure (c3, Bf4, Nf3, Nbd2, O-O, Re1, Ne5) gives White a crystal-clear "
            "kingside attacking and outpost plan, while the Advance (3.e5) offers dynamic space."
        ),
        core_ideas=(
            "In the Exchange Caro-Kann (3.exd5 cxd5 4.Bd3 Nc6 5.c3): play Bf4 (preventing Black's queen/bishop from dominating the b8-h2 diagonal), Nf3, Nbd2, O-O, and plant a knight on e5.",
            "Never play passively in the Exchange: your structural trump is the e-file and the e5 outpost; Black's trump is the queenside minority attack (...b5-b4).",
            "Meet Black's ...b5-b4 minority attack by either stopping it with a3/b4 (locking the queenside) or launching a faster kingside attack with Ne5, Ndf3, Re3-g3, and Qh5.",
            "Alternative weapon (Panov Attack 4.c4): enter an active Isolated Queen's Pawn (IQP) middlegame where your pieces fly out to c3, f3, g5, and e5.",
            "Alternative weapon (Advance 3.e5 Bf5): claim space with h4! (Tal/Short plans) or Nf3-Be2-O-O while trading off Black's active light-squared bishop.",
        ),
        white_plans=(
            "Exchange (4.Bd3): c3, Bf4, Nf3, Nbd2, O-O, Re1, Ne5, followed by Ndf3 and a kingside attack.",
            "Panov (4.c4): develop every piece toward the center, seize the e5 outpost, and strike with d4-d5.",
        ),
        black_plans=(
            "Develop ...Nc6, ...Nf6, ...Bg4/Bf5, ...e6, ...Bd6, ...Qc7, and launch the queenside minority attack (...Rb8, ...b5-b4).",
            "Trade off White's light-squared bishop on f4 or d3 to neutralize White's kingside attack.",
        ),
        key_breaks=("White: f2-f4-f5 (kingside storm after Ne5), c3-c4 (in Panov/dynamic lines).", "Black: ...b7-b5-b4 (queenside minority attack), ...e6-e5 (rare central break)."),
        piece_guide=(
            "Light-squared bishop (d3): aims straight at h7; do not trade it on f5 unless it damages Black's structure or wins e5.",
            "Dark-squared bishop (c1 -> f4): contests the key h2-b8 diagonal and supports the e5 square.",
            "Knights: Nf3-e5 backed up by Nbd2-f3 is your main engine of attack.",
        ),
        checklist=(
            "1. In the Exchange Caro-Kann, play 4.Bd3 and 5.c3 (keeping d4 solid) plus Bf4 before Black dominates the diagonal.",
            "2. Watch for Black's ...b5-b4 queenside push: meet it with a3 or faster kingside play on e5/h7.",
            "3. Ask yourself: 'Have I secured the e5 outpost for my knight?'",
        ),
        common_traps=(
            "Playing autopilot Nf3/Bd3/O-O in the Exchange without Bf4 or Ne5, then getting crushed by Black's ...b5-b4 minority attack.",
            "Allowing ...Bg4 followed by ...Nxd4 tactical drops on d4 when c3 was omitted.",
        ),
        eco_prefixes=("B10", "B11", "B12", "B13", "B14", "B15", "B17", "B18", "B19"),
        opening_keywords=("caro", "caro-kann", "caro kann"),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Carlsbad, Caro-Kann, & Panov chapters)",
                author="GM Mauricio Flores Rios",
                focus="Explains both sides of the Exchange Carlsbad and Panov structures in full detail.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="The Complete Caro",
                author="GM Sam Shankland",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Even though it teaches the Caro-Kann from Black's side, learning Black's exact minority-attack and ...c5 plans reveals how to counter them as White.",
                url="https://www.chess.com/lessons",
                level="1600-2200",
            ),
            CourseResource(
                title="Learn The Caro-Kann Defense",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers main plans and tactical ideas for both sides of the Exchange, Advance, and Classical lines.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="french_white",
        category="opening",
        title="French Defense Structures & Pawn Chains (White)",
        subtitle="Exploit space and Black's bad c8 bishop without overextending d4",
        color="white",
        structure_name="French Type I & Exchange French (Flores Rios Family 5)",
        level="1600-2200",
        tabiya_fen="rnbqkbnr/pp3ppp/4p3/2ppP3/3P4/8/PPP2PPP/RNBQKBNR w KQkq -",
        tabiya_label="French Advance (1.e4 e6 2.d4 d5 3.e5 c5): defend d4 solidly with 4.c3! and attack the kingside",
        summary=(
            "Against 1.e4 e6, White's structural mission is clear: either keep the pawn chain "
            "(Advance 3.e5 / Tarrasch 3.Nd2) to suffocate Black's c8 bishop while defending d4 "
            "solidly with c3, OR play an active Exchange French (3.exd5 exd5 4.c4! or 4.Nf3/Bd3/O-O/Re1) "
            "that fights for an imbalance rather than drifting into a sleepy symmetrical position."
        ),
        core_ideas=(
            "Pawn-chain rule (Nimzowitsch / Flores Rios): in e5/d4 vs e6/d5 chains, Black attacks the BASE of your chain with ...c5 and ...f6. Defend d4 with c3 and Nf3, and attack where your chain points (the kingside!).",
            "Do not let Black trade off their 'bad' c8 bishop cheaply (e.g. ...Ba6 trading your good f1 bishop) without getting concrete compensation.",
            "In the Exchange French (3.exd5 exd5): break symmetry early! Play 4.c4 (Monte Carlo IQP) or castle opposite sides / play c3+Bf4+Nd2-f3-e5 with an active piece plan.",
            "Against 2.Nf3 d5 (Knight Variation): advance 3.e5 c5 4.b4 (Wing Gambit) or play 3.Nc3 to transpose into real classical tension rather than passively defending e4.",
        ),
        white_plans=(
            "Advance/Tarrasch: lock the center (e5), reinforce d4 (c3, Nf3), develop Bd3, O-O, and build a kingside attack (f4-f5 or Bxh7+ sacrifices).",
            "Active Exchange: 4.c4 to create dynamic piece play, or Bd3/Bf4/Nf3/O-O/Re1 aiming for the e5 outpost.",
        ),
        black_plans=(
            "Attack d4 relentlessly with ...c5, ...Nc6, ...Qb6, and undermine e5 with ...f6.",
            "Trade off the bad light-squared bishop via ...Bd7-b5 or ...Ba6.",
        ),
        key_breaks=("White: f2-f4-f5 (kingside attack), c2-c4 (in Exchange/Tarrasch lines).", "Black: ...c7-c5 (primary break against d4), ...f7-f6 (secondary break against e5)."),
        piece_guide=(
            "Light-squared bishop (f1 -> d3): points straight at h7; keep it alive against ...Ba6 tricks.",
            "Knights: Nf3 defends d4 and eyes g5/e5; b1 knight goes to d2-f3 or a3-c2 to overprotect d4.",
        ),
        checklist=(
            "1. When playing e5 against the French, reinforce d4 immediately with c3 and Nf3 before chasing side pawns.",
            "2. Watch for ...Qb6 hitting BOTH d4 and b2; defend calmly with a3/Be2/c3 rather than panicking.",
            "3. In the Exchange French, pick an active imbalance (4.c4 or opposite-side castling / Ne5) instead of copying Black's moves.",
        ),
        common_traps=(
            "Pushing e5 without c3 and dropping the d4 pawn to ...c5, ...Nc6, ...Qb6.",
            "Allowing ...Qb6 Qxb2 tactics when the c1 bishop leaves too early.",
            "Trading into a lifeless symmetrical Exchange French and blundering out of boredom.",
        ),
        eco_prefixes=("C00", "C01", "C02", "C03", "C04", "C05", "C06", "C10", "C11", "C15"),
        opening_keywords=("french",),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Family 5: French Type I, II, III)",
                author="GM Mauricio Flores Rios",
                focus="Complete breakdown of d4 defense, kingside attacks, and trading the bad French bishop.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn Every Chess Opening (French Defense Module)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers French pawn chains, d4 defense, and active Exchange plans inside Chess.com Premium.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Lichess Study: Beating the French Defense for White",
                author="Lichess Community",
                platform="Lichess Study",
                source="free_modern",
                why="Free annotated chapters on Tarrasch, Advance, and Monte Carlo Exchange French plans.",
                url="https://lichess.org/study/search?q=beat+french+defense+white",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="scandinavian_white",
        category="opening",
        title="Punishing the Scandinavian Defense (White)",
        subtitle="Always take 2.exd5! and convert your free lead in development",
        color="white",
        structure_name="Open Scandinavian / Development Lead",
        level="1500-2000",
        tabiya_fen="rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -",
        tabiya_label="Scandinavian (1.e4 d5): always capture 2.exd5! (never 2.Nf3?)",
        summary=(
            "The Scandinavian hands White a clear, risk-free lead in development, provided "
            "you take on move 2 (2.exd5!). Declining with 2.Nf3? hands Black an easy, extra-tempo "
            "center after 2...dxe4 3.Ng5. After 2.exd5 Qxd5 3.Nc3, every developing move gains "
            "time against Black's exposed queen."
        ),
        core_ideas=(
            "Move 2 is non-negotiable: ALWAYS play 2.exd5!. Never play 2.Nf3? (drops the e4 pawn to 2...dxe4).",
            "Against 2...Qxd5: play 3.Nc3 (free tempo on the queen), followed by 4.d4, 5.Nf3, 6.Bc4 (or Be2), 7.Bd2 (threatening Nd5 discovered attacks on a5!), and O-O.",
            "Against 2...Nf6 (Modern Scandinavian): play 3.d4 Nxd5 4.Nf3 Bg4 5.Be2 e6 6.O-O and kick the knight later with c4 for a huge space edge.",
            "Keep pieces on the board and open lines before Black can finish ...e6, ...c6, ...Nd7, and ...O-O-O.",
        ),
        white_plans=(
            "Rapid development (Nc3, d4, Nf3, Bc4, Bd2, Qe2, O-O-O or O-O) with Ne5 and d4-d5 central breakthroughs.",
            "Target Black's queenside if they castle long (b4-b5, Rb1) or launch Ne5/Bd2 tactics against ...Qa5.",
        ),
        black_plans=(
            "Retreat the queen safely (...Qa5, ...Qd6, or ...Qd8), build a Caro-Kann-like ...c6+...e6 pawn fortress, and trade pieces.",
        ),
        key_breaks=("White: d4-d5 (shattering Black's solid c6/e6 shell once developed), c2-c4 (against 2...Nf6)."),
        piece_guide=(
            "Queen's knight (c3): jumps to d5 (hitting c7 and opening a discovered attack from Bd2 onto Black's a5 queen) or e4.",
            "Dark-squared bishop (d2): lines up tactically against ...Qa5.",
        ),
        checklist=(
            "1. See 1.e4 d5 -> play 2.exd5! immediately.",
            "2. Against 2...Qxd5 -> 3.Nc3, 4.d4, 5.Nf3, 6.Bc4/Bd2.",
            "3. Look for Nd5! tactics once your bishop sits on d2 and Black's queen is on a5.",
        ),
        common_traps=(
            "Playing 2.Nf3? and gifting Black the center after 2...dxe4.",
            "Over-chasing Black's queen with reckless pawn moves (b4? a4?) instead of developing minor pieces.",
        ),
        eco_prefixes=("B01",),
        opening_keywords=("scandinavian",),
        books=(
            BookReference(
                title="Mastering the Chess Openings, Vol. 1",
                author="IM John Watson",
                focus="How to convert a classical development lead cleanly against 1...d5.",
                level="1500-2000",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn Every Chess Opening (Scandinavian Module)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Teaches the exact Nc3/d4/Bd2 attacking setups against ...Qa5, ...Qd6, and 2...Nf6.",
                url="https://www.chess.com/lessons",
                level="1500-1900",
            ),
        ),
    ),
    MasterPlaybook(
        id="pirc_modern_white",
        category="opening",
        title="Crushing the Pirc & Modern Defense (White)",
        subtitle="Use the 150 Attack (Be3-Qd2-Bh6) to neutralize the g7 bishop and storm h4-h5",
        color="white",
        structure_name="Anti-Fianchetto / 150 Attack",
        level="1600-2100",
        tabiya_fen="rnbq1rk1/ppp1ppbp/3p1np1/8/3PP3/2N1BN2/PPP1QPPP/R3KB1R w KQ -",
        tabiya_label="150 Attack setup (Be3, Qd2, Bh6, O-O-O): simple, lethal plan against ...g6/...Bg7",
        summary=(
            "Players lose to the Pirc and Modern when they push pawns recklessly (f4/e5 too "
            "early) and let Black's g7 dragon bishop shred their center. The 150 Attack "
            "(1.e4 d6 2.d4 Nf6 3.Nc3 g6 4.Be3 Bg7 5.Qd2, followed by Bh6, O-O-O, f3, h4-h5) "
            "gives White a clean, repeatable attacking blueprint that works against both the "
            "Pirc and the Modern."
        ),
        core_ideas=(
            "Universal anti-fianchetto setup: d4, e4, Nc3, Be3, Qd2, f3 (stops ...Ng4! and overprotects e4), then O-O-O, Bh6, and h4-h5.",
            "Trading off Black's g7 bishop with Bh6 strips Black's castled king of its dark-square defenders.",
            "Keep your center intact (do not rush e5 unless it wins concrete material); let your pawn storm on the h-file do the heavy lifting.",
            "Meet Black's ...b5-b4 counterplay calmly by tucking the king to b1 and defending c3.",
        ),
        white_plans=(
            "150 Attack: Be3, Qd2, f3, O-O-O, Bh6, h4-h5xg6, opening the h-file for mate.",
            "Central clamp: if Black delays castling, strike in the center with e4-e5 or d4-d5.",
        ),
        black_plans=(
            "Attack White's d4/e4 center with ...c5 or ...e5, or launch a queenside storm (...a6, ...b5, ...c5) once White castles long.",
        ),
        key_breaks=("White: h2-h4-h5 (kingside attack), e4-e5 (if Black neglects the center).", "Black: ...c7-c5, ...e7-e5, ...b7-b5."),
        piece_guide=(
            "Dark-squared bishop (e3 -> h6): sole mission is to trade off Black's g7 bishop.",
            "Light-squared bishop (c4 or d3): eyes f7 or supports the center while f3 locks out ...Ng4.",
        ),
        checklist=(
            "1. Against ...g6 + ...Bg7, set up d4, e4, Nc3, Be3, Qd2, and f3 (preventing ...Ng4).",
            "2. Once Black castles kingside, play Bh6 and launch h4-h5.",
            "3. Play Kb1 after O-O-O to keep your king safe from ...c5/...Qa5 checks.",
        ),
        common_traps=(
            "Forgetting f3 and letting ...Ng4 harass your e3 bishop before Qd2.",
            "Pushing e4-e5 too early without support, letting Black's g7 bishop and ...c5 rip open your center.",
        ),
        eco_prefixes=("B06", "B07", "B08", "B09"),
        opening_keywords=("pirc", "modern defense", "geller"),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Dragon / KID Complex chapters)",
                author="GM Mauricio Flores Rios",
                focus="Opposite-side castling races, Bh6 exchanges, and pawn-storm timing against ...g6/...Bg7.",
                level="1600-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn Every Chess Opening (Pirc & Modern Modules)",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Covers the Be3-Qd2-Bh6 attacking template against fianchetto defenses inside Chess.com Premium.",
                url="https://www.chess.com/lessons",
                level="1500-2000",
            ),
            CourseResource(
                title="Lichess Study: The 150 Attack vs Pirc & Modern",
                author="Lichess Community",
                platform="Lichess Study",
                source="free_modern",
                why="Free move-by-move interactive guide to the Be3-Qd2-f3-Bh6 setup.",
                url="https://lichess.org/study/search?q=150+attack+pirc+modern",
                level="1600-2000",
            ),
        ),
    ),
    MasterPlaybook(
        id="ruy_lopez_e4_e5",
        category="opening",
        title="Ruy Lopez & Classical 1.e4 e5 Mastery",
        subtitle="Master slow tension, the d4 break, and flank maneuvering",
        color="both",
        structure_name="Closed Ruy Lopez (Flores Rios Miscellaneous)",
        level="1700-2200",
        tabiya_fen="r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - -",
        tabiya_label="Closed Ruy Lopez tabiya: c3, h3, d4, Nbd2-f1-g3 vs Black's ...Na5/...c5 counterplay",
        summary=(
            "The Ruy Lopez is the ultimate training ground for 1800-2200 chess because it "
            "teaches patience, piece maneuvers across both flanks, central tension, and "
            "knowing when to lock or open the center."
        ),
        core_ideas=(
            "White builds c3+d4, preserves the Spanish bishop on b3/c2, plays h3 to stop ...Bg4, and reroutes Nbd2-f1-g3.",
            "Black counters on the queenside with ...a6, ...b5, ...Na5, and ...c5, fighting for the c-file and the d4 square.",
            "Never release the d4-e5 tension without a concrete gain; let the opponent commit first.",
        ),
        white_plans=("c3, h3, d4, Nbd2-f1-g3, fighting for f5 and kingside initiative."),
        black_plans=("...Na5, ...c5, ...Qc7, ...Nc6, pressuring d4 and playing on the queenside."),
        key_breaks=("White: d2-d4, a2-a4 (undermining b5).", "Black: ...c7-c5, ...d6-d5 (Marshall/Chigorin counterplay)."),
        piece_guide=(
            "Spanish bishop (b5 -> a4 -> b3 -> c2): never let Black trap it on b3 with ...Na5 without c3/Bc2 ready.",
            "Knights: White aims for f5 via d2-f1-g3; Black uses c6-a5-c4 or f6-d7-b6.",
        ),
        checklist=(
            "1. Watch for the Noah's Ark trap (...a6, ...b5, ...c5, ...c4 trapping the b3 bishop).",
            "2. Keep e4 protected with Re1 before moving the f3 knight or pushing d4.",
        ),
        common_traps=(
            "Losing the light-squared bishop to ...c5-c4 (Noah's Ark Trap) when c3 was skipped.",
        ),
        eco_prefixes=("C60", "C65", "C67", "C70", "C78", "C80", "C84", "C88", "C89", "C90", "C92"),
        opening_keywords=("ruy lopez", "spanish"),
        books=(
            BookReference(
                title="Chess Structures: A Grandmaster Guide (Closed Ruy Lopez chapter)",
                author="GM Mauricio Flores Rios",
                focus="Classic maneuvering plans for both White and Black in Spanish structures.",
                level="1700-2200",
            ),
        ),
        courses=(
            CourseResource(
                title="Learn the Ruy Lopez",
                author="Chess.com Lessons",
                platform="Chess.com Premium",
                source="chesscom_premium",
                why="Structured overview of Ruy Lopez plans, traps, and main lines inside Chess.com Premium.",
                url="https://www.chess.com/lessons",
                level="1600-2100",
            ),
        ),
    ),
)

PLAYBOOK_BY_ID: dict[str, MasterPlaybook] = {p.id: p for p in PLAYBOOKS}
