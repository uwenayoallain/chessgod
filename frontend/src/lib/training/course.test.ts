import { describe, expect, it } from 'vite-plus/test'

import {
  buildChapters,
  dueLines,
  explainStep,
  explainTrap,
  formatLine,
  lineStakes,
  lineStatusLabel,
  mostRecentlyTouched,
  nextCourseStep,
  nextLineToPractise,
  nextLineToLearn,
  numberedMove,
} from './course'
import { raceTrack, riskMessage, streakAtRisk } from './progress'
import { lineEnd } from '@/components/training/opening-course'
import { diffProfiles } from '@/hooks/use-training'
import { freezeMessage, goalProgress, levelProgress, rivalMessage, streakMessage } from './progress'
import {
  describeCheck,
  describeDeviation,
  deviationLineIds,
  formatRushTime,
  rushVerdict,
  threatLesson,
  threatPrompt,
  threatSummary,
} from './rush'
import type { OpponentStep, RepertoireLine, TrainingProfile, YourStep } from './types'

function opponent(ply: number, san: string, extra: Partial<OpponentStep> = {}): OpponentStep {
  return {
    side: 'opponent',
    ply,
    san,
    uci: san,
    fen: `f${ply}`,
    source: 'games',
    games: 10,
    share: 0.5,
    trap_cp: null,
    ...extra,
  }
}

function yours(ply: number, san: string, extra: Partial<YourStep> = {}): YourStep {
  return {
    side: 'you',
    ply,
    san,
    uci: san,
    fen: `f${ply}`,
    status: 'keep',
    reason: 'usual',
    checked: true,
    eval_cp: 0,
    best_eval_cp: 0,
    idea_san: null,
    master_games: 0,
    master_share: null,
    usual_uci: san,
    usual_san: san,
    usual_games: 30,
    usual_score: 0.55,
    usual_loss_cp: 0,
    usual_last_played: null,
    games: 30,
    level: null,
    due: false,
    due_at: null,
    recalled: false,
    ...extra,
  }
}

// The first real corpus's top fix: the Scotch, 4...Nxd4 -> 4...Nf6.
const scotch: RepertoireLine = {
  id: 'scotch',
  name: 'Scotch Game Schmidt Variation 4...Nf6',
  first_move: 'e4',
  moves: [
    opponent(1, 'e4'),
    yours(2, 'e5'),
    opponent(3, 'Nf3'),
    yours(4, 'Nc6'),
    opponent(5, 'd4'),
    yours(6, 'exd4'),
    opponent(7, 'Nxd4'),
    yours(8, 'Nf6', {
      status: 'change',
      reason: 'masters',
      usual_san: 'Nxd4',
      usual_games: 44,
      usual_score: 0.41,
      usual_loss_cp: 55,
      master_share: 0.52,
      master_games: 900,
      idea_san: 'Nxc6 bxc6 e5 Qe7',
    }),
  ],
  games: 44,
  changes: 1,
  traps: 0,
  unchecked: 0,
  your_moves: 4,
  known_moves: 0,
  new_moves: 4,
  due_moves: 0,
  recalled_moves: 0,
  practised: false,
  status: 'new',
}

function line(id: string, first: string, extra: Partial<RepertoireLine> = {}): RepertoireLine {
  return {
    ...scotch,
    id,
    name: null,
    moves: [opponent(1, first), yours(2, first === 'e4' ? 'e5' : 'd5')],
    games: 10,
    changes: 0,
    traps: 0,
    your_moves: 1,
    ...extra,
  }
}

describe('formatLine', () => {
  it('numbers moves the way a book writes them', () => {
    expect(formatLine(scotch.moves)).toBe('1.e4 e5 2.Nf3 Nc6 3.d4 exd4 4.Nxd4 Nf6')
    expect(formatLine(scotch.moves, 3)).toBe('1.e4 e5 2.Nf3')
    expect(numberedMove(scotch.moves[7])).toBe('4...Nf6')
    expect(numberedMove(scotch.moves[6])).toBe('4.Nxd4')
  })
})

describe('buildChapters', () => {
  it('puts every line with something to fix first, then groups the rest by first move', () => {
    const lines = [
      line('e4-a', 'e4', { games: 30 }),
      line('d4-a', 'd4'),
      line('e4-b', 'e4'),
      scotch,
      line('d4-b', 'd4'),
    ]
    const chapters = buildChapters(lines, 'black')
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      'Fix these first',
      'Against 1.e4',
      'Against 1.d4',
    ])
    expect(chapters[0].lines).toEqual([scotch])
    expect(chapters.flatMap((chapter) => chapter.lines)).toHaveLength(lines.length)
  })

  it('folds one-line groups into "Everything else"', () => {
    const chapters = buildChapters(
      [line('e4-a', 'e4'), line('e4-b', 'e4'), line('c4', 'c4')],
      'black',
    )
    expect(chapters.map((chapter) => chapter.title)).toEqual(['Against 1.e4', 'Everything else'])
  })
})

describe('explainStep', () => {
  it('says what the player did, what it cost, and why the new move', () => {
    expect(explainStep(scotch.moves[7] as YourStep)).toBe(
      `You played Nxd4 here in 44 games and scored 41%. It gives away 0.6 pawns. Nf6 keeps the balance. Masters play it in 52% of games. The engine's line: Nxc6 bxc6 e5 Qe7.`,
    )
  })

  it('tells the player to keep a sound move they already play', () => {
    expect(explainStep(scotch.moves[1] as YourStep)).toBe(
      "You've played this in 30 games. It's sound, so keep it.",
    )
  })

  it('names a trap and what it costs the opponent', () => {
    expect(explainTrap(opponent(3, 'Qh5', { trap_cp: 230, games: 11 }))).toBe(
      'Qh5 is a mistake that gives away 2.3 pawns. Opponents have played it against you 11 times. Punish it.',
    )
    expect(explainTrap(opponent(3, 'Nf3'))).toBeNull()
  })
})

describe('what to train next', () => {
  it("states the stakes in the player's own results", () => {
    expect(lineStakes(scotch)).toBe(
      'Reached in 44 of your games. Nxd4 gives away 0.6 pawns, and you scored 41% after it.',
    )
  })

  it('asks for a learned line to be practised before another is learned', () => {
    const learned = line('learned', 'd4', {
      status: 'learning',
      known_moves: 1,
      new_moves: 0,
      practised: false,
    })
    const lines = [learned, scotch]
    expect(nextCourseStep(lines, 'black')).toEqual({ mode: 'practice', line: learned })
    expect(lineStatusLabel(learned)).toBe('Learned · practice it')
    // Once played from memory, the course moves on to the next line to learn.
    const practised = { ...learned, practised: true, recalled_moves: 1 }
    expect(nextCourseStep([practised, scotch], 'black')).toEqual({ mode: 'learn', line: scotch })
    expect(lineStatusLabel(practised)).toBe('Learning')
    expect(nextCourseStep([practised], 'black')).toBeNull()
  })

  it('offers the line learned last, whichever chapter or colour it sits in', () => {
    const touched = (id: string, first: string, dueAt: string) =>
      line(id, first, {
        status: 'learning',
        known_moves: 1,
        new_moves: 0,
        moves: [opponent(1, first), yours(2, first === 'e4' ? 'e5' : 'd5', { due_at: dueAt })],
      })
    const older = touched('older', 'e4', '2026-10-28T20:00:00Z')
    const newer = touched('newer', 'd4', '2026-10-28T23:40:00Z')
    expect(nextLineToPractise([older, newer], 'black')?.id).toBe('newer')
    expect(mostRecentlyTouched([older, null, newer])?.id).toBe('newer')
    expect(mostRecentlyTouched([null])).toBeNull()
  })

  it('learns the biggest fix first and queues the most-due reviews first', () => {
    const lines = [line('e4-a', 'e4', { games: 99 }), scotch]
    expect(nextLineToLearn(lines, 'black')?.id).toBe('scotch')
    const due = dueLines([
      line('a', 'e4', { due_moves: 1 }),
      line('b', 'e4', { due_moves: 3 }),
      line('c', 'e4', { due_moves: 0 }),
    ])
    expect(due.map((item) => item.id)).toEqual(['b', 'a'])
  })
})

const profile: TrainingProfile = {
  username: 'saint_uwe',
  xp: 250,
  level: 2,
  title: 'Pawn',
  level_floor_xp: 100,
  next_level_xp: 300,
  daily_goal: 50,
  today_xp: 20,
  goal_met_today: false,
  streak: 4,
  best_streak: 6,
  freezes: 1,
  freeze_every_xp: 250,
  week: [],
  rival: { this_week: 55, last_week_so_far: 169, last_week: 169 },
  rush_best: 12,
  threats_spotted: 7,
  threats_seen: 10,
  due_repertoire_moves: 3,
  due_drills: 10,
  quests: { date: '2026-09-30', items: [], all_done: false, chest_xp: 20, chest_opened: false },
  achievements: [
    {
      key: 'first_drill',
      title: 'First solve',
      description: '',
      target: 1,
      progress: 1,
      unlocked_at: '2026-09-01',
    },
    {
      key: 'drills_50',
      title: 'Sharp eyes',
      description: '',
      target: 50,
      progress: 49,
      unlocked_at: null,
    },
  ],
}

describe('progress', () => {
  it('measures the level and the day', () => {
    expect(levelProgress(profile)).toBeCloseTo(0.75)
    expect(goalProgress(profile)).toBeCloseTo(0.4)
  })

  it('puts the streak on the line without repeating the count beside it', () => {
    expect(streakMessage(profile)).toBe('30 XP keeps the streak.')
    expect(streakMessage({ ...profile, goal_met_today: true, today_xp: 60, streak: 5 })).toBe(
      'Goal met. Come back tomorrow to keep the streak.',
    )
    expect(streakMessage({ ...profile, streak: 0 })).toBe(
      '30 XP today starts a new streak. Your best is 6 days.',
    )
    expect(streakMessage({ ...profile, streak: 0, best_streak: 0 })).toBe(
      '30 XP today starts a streak.',
    )
  })

  it('finds what a reward changed, so a drill can still level the player up', () => {
    const next: TrainingProfile = {
      ...profile,
      level: 3,
      goal_met_today: true,
      achievements: [
        profile.achievements[0],
        { ...profile.achievements[1], progress: 50, unlocked_at: '2026-09-30' },
      ],
    }
    const diff = diffProfiles(profile, next)
    expect(diff.leveled_up).toBe(true)
    expect(diff.goal_just_met).toBe(true)
    expect(diff.unlocked?.map((a) => a.key)).toEqual(['drills_50'])
    expect(diffProfiles(undefined, next)).toEqual({})
  })
})

describe('rival and freezes', () => {
  it('says who is ahead in the race against last week', () => {
    expect(rivalMessage(profile)).toBe(
      '114 XP behind where you were last week. Beat 169 by Sunday.',
    )
    expect(
      rivalMessage({ ...profile, rival: { this_week: 80, last_week_so_far: 50, last_week: 90 } }),
    ).toBe('30 XP ahead of where you were last week.')
    expect(
      rivalMessage({ ...profile, rival: { this_week: 0, last_week_so_far: 0, last_week: 0 } }),
    ).toMatch(/next week you race against it/)
  })

  it('counts down to the next freeze until two are held', () => {
    expect(freezeMessage(profile)).toBe('1 streak freeze ready. Next one in 250 XP.')
    expect(freezeMessage({ ...profile, xp: 260, freezes: 0 })).toBe(
      'No streak freezes yet. Next one in 240 XP.',
    )
    expect(freezeMessage({ ...profile, freezes: 2 })).toMatch(/Miss a day and one covers it/)
  })
})

describe('rush', () => {
  it('formats the clock and judges a run against the best', () => {
    expect(formatRushTime(125_000)).toBe('2:05')
    expect(formatRushTime(8_100)).toBe('0:09')
    expect(rushVerdict(14, 12)).toBe('14 moves from memory. Your best run.')
    expect(rushVerdict(9, 12)).toBe('9 moves from memory. 3 short of your best of 12.')
  })

  it('reads a deviation as a sentence and queues each line once', () => {
    const deviation = {
      game_id: 1,
      url: 'u',
      played_at: '2026-09-29T20:00:00Z',
      result: 'loss',
      color: 'black' as const,
      fen: 'f',
      ply: 10,
      played_san: 'Nf6',
      expected_san: 'Qf6',
      expected_uci: 'd8f6',
      line_id: 'scotch',
      line_name: 'Scotch Game',
    }
    expect(describeDeviation(deviation, new Date('2026-09-30T12:00:00Z'))).toBe(
      'Yesterday you played 5...Nf6 and lost. Your repertoire move is Qf6.',
    )
    const check = {
      games_checked: 15,
      games_followed: 12,
      deviations: [deviation, { ...deviation, game_id: 2 }],
      requeued: 1,
    }
    expect(describeCheck(check)).toBe('In your repertoire for 12 of your last 15 games (80%).')
    expect(deviationLineIds(check, 'black')).toEqual(['scotch'])
    expect(deviationLineIds(check, 'white')).toEqual([])
  })
})

describe('lineEnd', () => {
  it('starts a boss fight with the player to move, whichever side ended the line', () => {
    // Ends on the player's own move: start before it.
    expect(lineEnd(scotch)).toEqual({ fen: 'f8 0 1', lastUci: 'Nxd4' })
    const endsOnReply = {
      ...scotch,
      moves: [
        {
          ...opponent(1, 'e4'),
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
          uci: 'e2e4',
        },
      ],
    }
    expect(lineEnd(endsOnReply)?.fen.split(' ').slice(0, 2)).toEqual([
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR',
      'b',
    ])
  })
})

describe('blunder check', () => {
  it("asks in the player's terms and teaches the avoiding move", () => {
    expect(threatPrompt({ your_move_san: 'Qg4', kind: 'capture', ply: 3 })).toBe(
      'You played 2.Qg4. Now your opponent can win material. Find their move.',
    )
    expect(threatPrompt({ your_move_san: 'O-O', kind: 'check', ply: 22 })).toBe(
      'You played 11...O-O. Now your opponent has a check that wins. Find their move.',
    )
    expect(threatLesson({ correct: true, reply_san: 'Bxg4', better_san: 'exd5' }, 'Bxg4')).toBe(
      'Spotted: Bxg4. exd5 would have avoided it.',
    )
    expect(threatLesson({ correct: false, reply_san: 'Bxg4', better_san: 'exd5' }, 'Nf6')).toMatch(
      /^Nf6 isn't it\. The move was Bxg4\. exd5 would have avoided it\./,
    )
    expect(threatSummary(10, 10)).toMatch(/^All 10 spotted/)
    expect(threatSummary(7, 10)).toMatch(/^7 of 10 spotted/)
  })
})

describe('rival race', () => {
  it('puts last week at the finish and both pawns along the rank', () => {
    const track = raceTrack(profile)
    expect(track.finish).toBe(169)
    expect(track.you).toBeCloseTo(55 / 169)
    expect(track.rival).toBe(1)
    expect(track.promoted).toBe(false)
  })

  it('promotes the pawn once last week is beaten, and races the goal with no last week', () => {
    const ahead = { ...profile, rival: { this_week: 200, last_week_so_far: 90, last_week: 169 } }
    expect(raceTrack(ahead)).toMatchObject({ you: 1, promoted: true })
    const fresh = { ...profile, rival: { this_week: 70, last_week_so_far: 0, last_week: 0 } }
    expect(raceTrack(fresh)).toMatchObject({ finish: 350, rival: null, promoted: false })
  })
})

describe('streak at risk', () => {
  const evening = new Date(2026, 9, 1, 20, 40)
  it('counts down to midnight on an evening with the goal unmet', () => {
    expect(streakAtRisk(profile, evening)).toBe(200)
    expect(riskMessage(profile, 200)).toBe('Your 4-day streak ends in 3h 20m. 30 XP keeps it.')
  })

  it('is quiet before the evening, with no streak, or once the goal is met', () => {
    expect(streakAtRisk(profile, new Date(2026, 9, 1, 12, 0))).toBeNull()
    expect(streakAtRisk({ ...profile, streak: 0 }, evening)).toBeNull()
    expect(streakAtRisk({ ...profile, goal_met_today: true }, evening)).toBeNull()
  })
})
