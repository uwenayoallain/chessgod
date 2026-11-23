import { describe, expect, it } from 'vite-plus/test'

import {
  describeAfterOpening,
  describeFix,
  describeOneIn,
  describeOpeningAdvice,
  describeOpeningVerdict,
  describeOutOfOpening,
  shortOpeningName,
  type PointsLost,
} from './points-lost'

// The first real corpus, as the endpoint returned it.
const measured: PointsLost = {
  username: 'saint_uwe',
  color: 'both',
  time_class: 'rapid_blitz',
  min_user_rating: 1000,
  analyzed_decisions: 87844,
  total_decisions: 93945,
  phases: [
    {
      phase: 'opening',
      analyzed_decisions: 19077,
      share_of_moves: 0.24,
      share_of_loss: 0.1928,
      average_loss: 0.0321,
    },
    {
      phase: 'middlegame',
      analyzed_decisions: 51799,
      share_of_moves: 0.5725,
      share_of_loss: 0.7007,
      average_loss: 0.0489,
    },
    {
      phase: 'endgame',
      analyzed_decisions: 16968,
      share_of_moves: 0.1875,
      share_of_loss: 0.1065,
      average_loss: 0.0227,
    },
  ],
  big_error_threshold: 0.1,
  big_error_share_of_moves: 0.1104,
  big_error_share_of_loss: 0.7112,
  kinds: [
    {
      key: 'left_capturable',
      label: 'Left something the opponent could take',
      decisions: 4876,
      share_of_loss: 0.3084,
    },
    {
      key: 'allowed_check',
      label: 'Allowed a check that hurt',
      decisions: 1994,
      share_of_loss: 0.0968,
    },
    {
      key: 'missed_forcing',
      label: 'Missed a capture or check of your own',
      decisions: 2266,
      share_of_loss: 0.1339,
    },
    { key: 'quiet', label: 'Quiet moves that went wrong', decisions: 6926, share_of_loss: 0.313 },
    {
      key: 'small',
      label: 'Small slips, under a pawn each',
      decisions: 52705,
      share_of_loss: 0.1479,
    },
  ],
  opening_fixes: [
    {
      position_id: 3134,
      fen: 'r1bqkbnr/pppp1ppp/8/8/3QP3/8/PPP2PPP/RNB1KB1R b KQkq -',
      last_move_uci: 'd1d4',
      side_to_move: 'black',
      opening_name: 'Scotch Game',
      played_san: 'Nf6',
      played_uci: 'g8f6',
      best_san: 'Qf6',
      best_uci: 'd8f6',
      occurrences: 21,
      average_loss_cp: 221,
    },
  ],
  opening_verdict: 'lighter',
}

describe('describeOpeningVerdict', () => {
  it('reads the opening against its share of the moves, not against nothing', () => {
    const verdict = describeOpeningVerdict(measured)
    expect(verdict.headline).toBe("Your openings aren't where you lose points.")
    expect(verdict.detail).toBe(
      'Your first 10 moves are 24% of the moves you make and 19% of the winning chances you give away. The middlegame is 70%, the endgame 11%.',
    )
  })

  it('says so when the openings really are the problem', () => {
    expect(describeOpeningVerdict({ ...measured, opening_verdict: 'heavier' }).headline).toBe(
      'Your openings are costing you games.',
    )
  })

  it('refuses to judge a library that is mostly unanalysed', () => {
    // m_pacifique: 6.6% analysed and no middlegame at all, so the phase split
    // is an artefact of what happened to be analysed.
    const verdict = describeOpeningVerdict({
      ...measured,
      analyzed_decisions: 6818,
      total_decisions: 103289,
      opening_verdict: 'insufficient',
    })
    expect(verdict.headline).toBe('Not enough of your games are analyzed to say yet.')
    expect(verdict.detail).toContain('6,818 of your 103,289 moves')
  })
})

describe('describeOpeningAdvice', () => {
  it('tells a player whose openings are fine not to study theory', () => {
    expect(describeOpeningAdvice(measured)).toBe(
      "You don't need more theory. Just stop playing this move:",
    )
    expect(describeOpeningAdvice({ ...measured, opening_fixes: [] })).toBe(
      "You don't need more theory. Keep playing what you know.",
    )
  })

  it('points at the quiz only when the opening costs more than its share', () => {
    expect(
      describeOpeningAdvice({ ...measured, opening_verdict: 'heavier', opening_fixes: [] }),
    ).toContain('Opening Quiz')
  })

  it('still lists repeated slips before there is enough evidence for a verdict', () => {
    expect(describeOpeningAdvice({ ...measured, opening_verdict: 'insufficient' })).toBe(
      'Opening moves you keep repeating that lose material:',
    )
    expect(
      describeOpeningAdvice({ ...measured, opening_verdict: 'insufficient', opening_fixes: [] }),
    ).toBeNull()
  })
})

describe('describeAfterOpening', () => {
  it('names how few moves carry most of the loss, and the habit that catches it', () => {
    const after = describeAfterOpening(measured)
    expect(after.bigErrors).toBe(
      '71% of what you lose comes from about 1 move in 9: the big mistakes.',
    )
    expect(after.forcingShare).toBeCloseTo(0.5391)
    expect(after.habit).toMatch(/^54% of it came down to a capture or a check/)
  })

  it('does not claim a forcing-move habit the evidence does not show', () => {
    const quiet = describeAfterOpening({
      ...measured,
      kinds: measured.kinds.map((kind) => ({
        ...kind,
        share_of_loss: kind.key === 'quiet' ? 0.9 : 0.025,
      })),
    })
    expect(quiet.habit).not.toMatch(/capture or a check/)
  })
})

describe('describeOneIn', () => {
  it('rounds to a whole move and handles the edges', () => {
    expect(describeOneIn(0.1104)).toBe('about 1 move in 9')
    expect(describeOneIn(0.9)).toBe('almost every move')
    expect(describeOneIn(0)).toBeNull()
  })
})

it('describeFix gives the played move, the answer and what it costs', () => {
  expect(describeFix(measured.opening_fixes[0])).toBe(
    'You played Nf6 here 21 times, giving away 2.2 pawns on average. Play Qf6.',
  )
})

it('shortOpeningName drops the moves Chess.com appends to a name', () => {
  expect(shortOpeningName('Scotch Game 3...exd4 4.Nxd4 Nxd4 5.Qxd4')).toBe('Scotch Game')
  expect(shortOpeningName('Italian Game Traxler Knight Sacrifice Line 5...Bxf2 6.Kxf2 Nxe4')).toBe(
    'Italian Game Traxler Knight Sacrifice Line',
  )
  expect(shortOpeningName('Vienna Game Anderssen Defense 3.Nf3 d6')).toBe(
    'Vienna Game Anderssen Defense',
  )
  expect(shortOpeningName('Giuoco Piano Game Center Attack...6.cxd4 Bb4')).toBe(
    'Giuoco Piano Game Center Attack',
  )
  expect(shortOpeningName('Scandinavian Defense')).toBe('Scandinavian Defense')
  expect(shortOpeningName(null)).toBeNull()
})

it('describeOutOfOpening names the colour whose opening hands over a worse position', () => {
  const described = describeOutOfOpening({
    ...measured,
    out_of_opening: [
      {
        color: 'white',
        games: 1112,
        average_cp: 83,
        worse_share: 0.13,
        score_when_worse: 0.4,
        score_when_level: 0.56,
      },
      {
        color: 'black',
        games: 1137,
        average_cp: -73,
        worse_share: 0.34,
        score_when_worse: 0.37,
        score_when_level: 0.55,
      },
    ],
  })
  expect(described.headline).toBe('Your Black openings are costing you games.')
  expect(described.leaking).toBe('black')
  expect(described.rows[1].text).toBe(
    'As Black: -0.7 on average after move 10, and a pawn or more down in 34% of games. You score 37% in those, 55% when level.',
  )
  expect(described.rows[0].leaking).toBe(false)
  expect(describeOutOfOpening(measured).headline).toBeNull()
})
