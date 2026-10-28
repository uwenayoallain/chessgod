import { describe, expect, it } from 'vite-plus/test'

import { closestAchievements, groupAchievements } from './progress'
import type { Achievement } from './types'

function badge(key: string, progress: number, target: number, unlocked = false): Achievement {
  return {
    key,
    title: key,
    description: '',
    target,
    progress,
    unlocked_at: unlocked ? '2026-09-30' : null,
  }
}

describe('achievements', () => {
  it('aims at the closest unearned badges, never earned or untouched ones', () => {
    const list = [
      badge('drills_50', 40, 50),
      badge('first_drill', 1, 1, true),
      badge('streak_7', 2, 7),
      badge('rush_25', 0, 25),
      badge('lines_10', 6, 10),
    ]
    expect(closestAchievements(list).map((a) => a.key)).toEqual([
      'drills_50',
      'lines_10',
      'streak_7',
    ])
  })

  it('groups into families and keeps any badge no family names', () => {
    const groups = groupAchievements([
      badge('first_drill', 0, 1),
      badge('streak_3', 0, 3),
      badge('brand_new', 0, 1),
    ])
    expect(groups.map((group) => group.title)).toEqual(['Tactics', 'Habits', 'More'])
  })
})
