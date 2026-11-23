import { describe, expect, it } from 'vite-plus/test'

import { describePhaseSkew, summarizePhaseCoverage } from './phase-coverage'

const REAL_CORPUS = [
  { phase: 'opening', analyzed_decisions: 3575, share: 0.982 },
  { phase: 'middlegame', analyzed_decisions: 26, share: 0.007 },
  { phase: 'endgame', analyzed_decisions: 40, share: 0.011 },
]

describe('phase coverage', () => {
  it('orders phases the way a game is played, not by size', () => {
    const { rows } = summarizePhaseCoverage([
      { phase: 'endgame', analyzed_decisions: 40, share: 0.011 },
      { phase: 'opening', analyzed_decisions: 3575, share: 0.982 },
      { phase: 'middlegame', analyzed_decisions: 26, share: 0.007 },
    ])
    expect(rows.map((row) => row.phase)).toEqual(['opening', 'middlegame', 'endgame'])
  })

  it('names the phases too thinly analyzed to support a claim', () => {
    const coverage = summarizePhaseCoverage(REAL_CORPUS)
    expect(coverage.unexamined.map((row) => row.phase)).toEqual(['middlegame', 'endgame'])
    expect(describePhaseSkew(coverage)).toContain('middlegame and endgame')
    // The point of the sentence: an empty queue is not a verdict on the player.
    expect(describePhaseSkew(coverage)).toContain("doesn't mean it has no mistakes")
  })

  it('says nothing when every phase has a usable sample', () => {
    const coverage = summarizePhaseCoverage([
      { phase: 'opening', analyzed_decisions: 500, share: 0.5 },
      { phase: 'middlegame', analyzed_decisions: 300, share: 0.3 },
      { phase: 'endgame', analyzed_decisions: 200, share: 0.2 },
    ])
    expect(coverage.unexamined).toEqual([])
    expect(describePhaseSkew(coverage)).toBeNull()
  })

  it('does not call an empty library skewed', () => {
    const coverage = summarizePhaseCoverage([
      { phase: 'opening', analyzed_decisions: 0, share: 0 },
      { phase: 'middlegame', analyzed_decisions: 0, share: 0 },
      { phase: 'endgame', analyzed_decisions: 0, share: 0 },
    ])
    expect(coverage.unexamined).toEqual([])
    expect(describePhaseSkew(coverage)).toBeNull()
    expect(coverage.rows.every((row) => row.share === 0)).toBe(true)
  })

  it('derives shares from the counts it displays', () => {
    // The API rounds its own share to four places; bars drawn from that can
    // disagree with the counts printed beside them.
    const { rows } = summarizePhaseCoverage([
      { phase: 'opening', analyzed_decisions: 1, share: 0.9999 },
      { phase: 'middlegame', analyzed_decisions: 1, share: 0.0001 },
    ])
    expect(rows.map((row) => row.share)).toEqual([0.5, 0.5])
  })
})
