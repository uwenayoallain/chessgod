export type PhaseLoss = {
  phase: 'opening' | 'middlegame' | 'endgame'
  analyzed_decisions: number
  share_of_moves: number
  share_of_loss: number
  average_loss: number
}

export type LossKind = {
  key: 'left_capturable' | 'allowed_check' | 'missed_forcing' | 'quiet' | 'small'
  label: string
  decisions: number
  share_of_loss: number
}

export type OpeningFix = {
  position_id: number
  fen: string
  last_move_uci: string | null
  side_to_move: 'white' | 'black'
  opening_name: string | null
  played_san: string
  played_uci: string
  best_san: string
  best_uci: string
  occurrences: number
  average_loss_cp: number
}

export type OpeningVerdict = 'lighter' | 'even' | 'heavier' | 'insufficient'

export type OutOfOpening = {
  color: 'white' | 'black'
  games: number
  average_cp: number
  worse_share: number
  score_when_worse: number | null
  score_when_level: number | null
}

export type PointsLost = {
  username: string
  color: string
  time_class: string
  min_user_rating: number
  analyzed_decisions: number
  total_decisions: number
  phases: PhaseLoss[]
  big_error_threshold: number
  big_error_share_of_moves: number
  big_error_share_of_loss: number
  kinds: LossKind[]
  opening_fixes: OpeningFix[]
  opening_verdict: OpeningVerdict
  out_of_opening?: OutOfOpening[]
}

/** The kinds that one habit catches: look at every capture and check first. */
export const FORCING_KINDS: ReadonlySet<LossKind['key']> = new Set([
  'left_capturable',
  'allowed_check',
  'missed_forcing',
])

export const PHASE_LABELS: Record<PhaseLoss['phase'], string> = {
  opening: 'Opening (moves 1–10)',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
}

export function percent(share: number) {
  return `${Math.round(share * 100)}%`
}

function phase(points: PointsLost, key: PhaseLoss['phase']) {
  return points.phases.find((item) => item.phase === key)
}

/**
 * The answer to "should I be learning openings?", in one line.
 *
 * It compares the opening's share of what the player loses with its share of
 * the moves they make, so "your openings cost 19%" is read against the 24% of
 * moves it covers rather than against nothing.
 */
export function describeOpeningVerdict(points: PointsLost): { headline: string; detail: string } {
  const opening = phase(points, 'opening')
  if (points.opening_verdict === 'insufficient' || !opening) {
    return {
      headline: 'Not enough of your games are analyzed to say yet.',
      detail: `${points.analyzed_decisions.toLocaleString()} of your ${points.total_decisions.toLocaleString()} moves are analyzed. Analyze more games to see where you lose points.`,
    }
  }
  const middlegame = phase(points, 'middlegame')
  const endgame = phase(points, 'endgame')
  const detail =
    `Your first 10 moves are ${percent(opening.share_of_moves)} of the moves you make and ` +
    `${percent(opening.share_of_loss)} of the winning chances you give away.` +
    (middlegame && endgame
      ? ` The middlegame is ${percent(middlegame.share_of_loss)}, the endgame ${percent(endgame.share_of_loss)}.`
      : '')
  const headline = {
    lighter: "Your openings aren't where you lose points.",
    even: 'Your openings cost you about their fair share.',
    heavier: 'Your openings are costing you games.',
  }[points.opening_verdict]
  return { headline, detail }
}

/** What to do about the opening, given the verdict and the fixes found. */
export function describeOpeningAdvice(points: PointsLost): string | null {
  const fixes = points.opening_fixes.length
  switch (points.opening_verdict) {
    case 'lighter':
    case 'even':
      return fixes
        ? `You don't need more theory. Just stop playing ${fixes === 1 ? 'this move' : `these ${fixes} moves`}:`
        : "You don't need more theory. Keep playing what you know."
    case 'heavier':
      return fixes
        ? `Start with ${fixes === 1 ? 'this move' : `these ${fixes} moves`} you keep repeating, then take the Opening Quiz for the rest:`
        : 'Start with the Opening Quiz. It tests your own opening positions against master games.'
    default:
      return fixes ? 'Opening moves you keep repeating that lose material:' : null
  }
}

/** "about 1 move in 9", from the share of moves that were big errors. */
export function describeOneIn(share: number): string | null {
  if (share <= 0) return null
  const every = Math.max(1, Math.round(1 / share))
  return every === 1 ? 'almost every move' : `about 1 move in ${every.toLocaleString()}`
}

/** Where the rest of the game goes, and the habit that would catch most of it. */
export function describeAfterOpening(points: PointsLost): {
  bigErrors: string | null
  forcingShare: number
  habit: string
} {
  const oneIn = describeOneIn(points.big_error_share_of_moves)
  const bigErrors =
    oneIn && points.big_error_share_of_loss > 0
      ? `${percent(points.big_error_share_of_loss)} of what you lose comes from ${oneIn}: the big mistakes.`
      : null
  const forcingShare = points.kinds
    .filter((kind) => FORCING_KINDS.has(kind.key))
    .reduce((total, kind) => total + kind.share_of_loss, 0)
  const habit =
    forcingShare >= 0.3
      ? `${percent(forcingShare)} of it came down to a capture or a check you allowed or missed. Before every move, look at your opponent's captures and checks, then your own.`
      : 'Before every move, compare two candidates and find your opponent’s best reply to each.'
  return { bigErrors, forcingShare, habit }
}

/**
 * The opening's name without the moves Chess.com appends to it.
 *
 * Chess.com names a game by where it ended up ("Italian Game Traxler Knight
 * Sacrifice Line 5...Bxf2 6.Kxf2 Nxe4"), so on a fix at move four the tail
 * names moves that were never played in the position being shown.
 */
export function shortOpeningName(name: string | null): string | null {
  if (!name) return null
  // The moves follow a space, or an ellipsis when the slug ran them together
  // ("Giuoco Piano Game Center Attack...6.cxd4 Bb4").
  const trimmed = name.replace(/(\s+|\.{3})\d+\.(\.\.)?.*$/, '').trim()
  return trimmed || name
}

export function describeFix(fix: OpeningFix): string {
  const pawns = (fix.average_loss_cp / 100).toFixed(1)
  return `You played ${fix.played_san} here ${fix.occurrences.toLocaleString()} times, giving away ${pawns} pawns on average. Play ${fix.best_san}.`
}

// A colour whose opening leaves the player a pawn down this often is leaking.
const LEAKING_SHARE = 0.25
const MIN_COLOUR_GAMES = 50

/**
 * How each colour comes out of the opening. This, not where the evaluation
 * drops, answers "do my openings cost me games": an opening that hands over a
 * worse position shows up later as middlegame mistakes.
 */
export function describeOutOfOpening(points: PointsLost): {
  headline: string | null
  rows: { color: 'white' | 'black'; text: string; leaking: boolean }[]
  leaking: 'white' | 'black' | null
} {
  const rows = (points.out_of_opening ?? [])
    .filter((row) => row.games >= MIN_COLOUR_GAMES)
    .map((row) => {
      const side = row.color === 'white' ? 'As White' : 'As Black'
      const average = `${row.average_cp >= 0 ? '+' : ''}${(row.average_cp / 100).toFixed(1)}`
      const cost =
        row.score_when_worse != null && row.score_when_level != null
          ? ` You score ${percent(row.score_when_worse)} in those, ${percent(row.score_when_level)} when level.`
          : ''
      return {
        color: row.color,
        leaking: row.worse_share >= LEAKING_SHARE,
        text: `${side}: ${average} on average after move 10, and a pawn or more down in ${percent(row.worse_share)} of games.${cost}`,
      }
    })
  const worst = [...(points.out_of_opening ?? [])]
    .filter((row) => row.games >= MIN_COLOUR_GAMES && row.worse_share >= LEAKING_SHARE)
    .sort((a, b) => b.worse_share - a.worse_share)[0]
  return {
    rows,
    leaking: worst?.color ?? null,
    headline: worst
      ? `Your ${worst.color === 'white' ? 'White' : 'Black'} openings are costing you games.`
      : null,
  }
}
