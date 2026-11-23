/**
 * What the engine has actually looked at, broken down by game phase.
 *
 * The drill queue can only ever surface a mistake from a decision that was
 * analysed, so a library analysed almost entirely in the opening produces
 * almost entirely opening lessons. Without this breakdown that reads as a fact
 * about the player — "no middlegame weaknesses" — when the truth is that their
 * middlegame was never examined. Measured on the first real corpus: 3,575 of
 * 3,641 analysed decisions were openings, against 26 middlegame and 40 endgame.
 */

export type PhaseCoverageInput = {
  phase: string
  analyzed_decisions: number
  /** Share of analysed decisions, as the API computes it. */
  share: number
}

export type PhaseCoverageRow = {
  phase: string
  label: string
  analyzed: number
  /** Share of everything analysed so far, 0-1. */
  share: number
}

export type PhaseCoverage = {
  rows: PhaseCoverageRow[]
  /**
   * Phases with too little analysis to say anything about, in display order.
   * Empty once every phase has a usable sample.
   */
  unexamined: PhaseCoverageRow[]
}

// Display order is the order a game is played, not the order of the counts:
// the row a reader looks for is the phase they were thinking about.
const PHASE_ORDER = ['opening', 'middlegame', 'endgame'] as const

const PHASE_LABEL: Record<string, string> = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  endgame: 'Endgame',
}

/**
 * A phase holding less than this share of the analysed sample cannot support a
 * claim about the player. It is a threshold on attention, not on skill: at this
 * level the queue has barely visited the phase, so an absence of lessons there
 * says nothing.
 */
export const UNEXAMINED_SHARE = 0.05

function toLabel(phase: string) {
  return PHASE_LABEL[phase] ?? phase.charAt(0).toUpperCase() + phase.slice(1)
}

export function summarizePhaseCoverage(phases: PhaseCoverageInput[]): PhaseCoverage {
  const byPhase = new Map(phases.map((entry) => [entry.phase, entry]))
  const known = phases.filter((entry) => !PHASE_ORDER.includes(entry.phase as never))
  const ordered = [
    ...PHASE_ORDER.filter((phase) => byPhase.has(phase)),
    ...known.map((e) => e.phase),
  ]

  const analyzedTotal = phases.reduce((total, entry) => total + entry.analyzed_decisions, 0)
  const rows: PhaseCoverageRow[] = ordered.map((phase) => {
    const entry = byPhase.get(phase)
    const analyzed = entry?.analyzed_decisions ?? 0
    return {
      phase,
      label: toLabel(phase),
      analyzed,
      // Recompute rather than trust the API's rounded share, so the bars and
      // the counts beside them cannot disagree.
      share: analyzedTotal > 0 ? analyzed / analyzedTotal : 0,
    }
  })

  return {
    rows,
    // Nothing analysed at all is not a skew — it is the empty state, and the
    // panel says that in its own words.
    unexamined: analyzedTotal > 0 ? rows.filter((row) => row.share < UNEXAMINED_SHARE) : [],
  }
}

/**
 * The sentence to put under the bars, or null when the sample is balanced
 * enough that the absence of lessons in a phase means something.
 */
export function describePhaseSkew(coverage: PhaseCoverage): string | null {
  const { unexamined, rows } = coverage
  if (unexamined.length === 0 || unexamined.length === rows.length) return null

  const names = unexamined.map((row) => row.label.toLowerCase())
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `Your ${list} play has barely been analyzed, so it has no lessons yet. That doesn't mean it has no mistakes.`
}
