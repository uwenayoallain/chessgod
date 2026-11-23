import type { TrainingProfile } from './types'

export const DAILY_GOALS = [
  { xp: 20, label: 'Casual' },
  { xp: 50, label: 'Regular' },
  { xp: 100, label: 'Serious' },
] as const

const GOAL_KEY = 'chessgod.dailyGoal'

export function readDailyGoal(): number {
  try {
    const stored = Number(window.localStorage.getItem(GOAL_KEY))
    return DAILY_GOALS.some((goal) => goal.xp === stored) ? stored : 50
  } catch {
    return 50
  }
}

export function writeDailyGoal(xp: number) {
  try {
    window.localStorage.setItem(GOAL_KEY, String(xp))
  } catch {
    // A private window: the goal lasts for this visit.
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** How far through the current level, 0-1. */
export function levelProgress(profile: TrainingProfile): number {
  const span = profile.next_level_xp - profile.level_floor_xp
  if (span <= 0) return 1
  return Math.max(0, Math.min(1, (profile.xp - profile.level_floor_xp) / span))
}

export function goalProgress(profile: TrainingProfile): number {
  return Math.max(0, Math.min(1, profile.today_xp / profile.daily_goal))
}

/** One line about the streak, written to make today's goal feel worth meeting. */
export function streakMessage(profile: TrainingProfile): string {
  const left = Math.max(0, profile.daily_goal - profile.today_xp)
  // The streak count is always in view beside this line (the Today card's flame
  // row, the header chip), so the message never repeats the number.
  if (profile.goal_met_today) {
    return profile.streak > 1
      ? 'Goal met. Come back tomorrow to keep the streak.'
      : 'Goal met. Come back tomorrow to start a streak.'
  }
  if (profile.streak > 0) {
    return `${left.toLocaleString()} XP keeps the streak.`
  }
  if (profile.best_streak > 1) {
    return `${left.toLocaleString()} XP today starts a new streak. Your best is ${profile.best_streak.toLocaleString()} days.`
  }
  return `${left.toLocaleString()} XP today starts a streak.`
}

/** The race against last week, in a sentence that says who is ahead. */
export function rivalMessage(profile: TrainingProfile): string {
  const { this_week, last_week_so_far, last_week } = profile.rival
  if (!last_week) {
    return this_week
      ? `${this_week.toLocaleString()} XP this week. Next week you race against it.`
      : 'Earn XP this week, and next week you race against it.'
  }
  const gap = this_week - last_week_so_far
  if (gap > 0) return `${gap.toLocaleString()} XP ahead of where you were last week.`
  if (gap === 0) return 'Level with where you were last week.'
  return `${(-gap).toLocaleString()} XP behind where you were last week. Beat ${last_week.toLocaleString()} by Sunday.`
}

/** How far the next streak freeze is, or that the freezes are full. */
export function freezeMessage(profile: TrainingProfile): string {
  const held = profile.freezes
  const holding = held
    ? `${held} streak freeze${held === 1 ? '' : 's'} ready.`
    : 'No streak freezes yet.'
  if (held >= 2) return `${holding} Miss a day and one covers it.`
  const toNext = profile.freeze_every_xp - (profile.xp % profile.freeze_every_xp)
  return `${holding} Next one in ${toNext.toLocaleString()} XP.`
}

/** The titles in order, the level each arrives at (services/training.py TITLES) and its XP. */
export const TITLE_LADDER = [
  { title: 'Pawn', level: 1 },
  { title: 'Knight', level: 3 },
  { title: 'Bishop', level: 5 },
  { title: 'Rook', level: 8 },
  { title: 'Queen', level: 12 },
  { title: 'King', level: 18 },
].map((step) => ({ ...step, xp: 50 * step.level * (step.level - 1) }))

/** The next title up, or null at King. */
export function nextTitle(profile: TrainingProfile) {
  return TITLE_LADDER.find((step) => step.level > profile.level) ?? null
}

/**
 * The rival race on one rank: how far along it this week's XP and last week's
 * (at the same point) stand, 0 to 1. The last square is last week's whole
 * total, so reaching it is beating last week — a promotion. With no last week
 * to race, the finish is this week's own goal-sized stride.
 */
export function raceTrack(profile: TrainingProfile) {
  const { this_week, last_week_so_far, last_week } = profile.rival
  const finish = last_week > 0 ? last_week : Math.max(this_week, profile.daily_goal * 7)
  const clamp = (value: number) => Math.max(0, Math.min(1, value / finish))
  return {
    finish,
    you: clamp(this_week),
    rival: last_week > 0 ? clamp(last_week_so_far) : null,
    promoted: last_week > 0 && this_week >= last_week,
  }
}

/** The badges in families, each family in the order it is earned. */
export const ACHIEVEMENT_FAMILIES: { title: string; keys: string[] }[] = [
  {
    title: 'Tactics',
    keys: ['first_drill', 'drills_50', 'drills_250', 'hawk_eye', 'second_chance', 'recall_100'],
  },
  {
    title: 'Openings',
    keys: ['first_line', 'lines_10', 'leak_plugged', 'trap_setter', 'rush_10', 'rush_25'],
  },
  {
    title: 'Habits',
    keys: ['streak_3', 'streak_7', 'streak_30', 'quest_master', 'rival_beaten', 'xp_1000'],
  },
  { title: 'Over the board', keys: ['board_challenge', 'sparring_5', 'boss_slayer'] },
]

/** Unearned badges with some progress, closest first: what to aim at next. */
export function closestAchievements(achievements: TrainingProfile['achievements'], count = 3) {
  return achievements
    .filter((a) => !a.unlocked_at && a.progress > 0)
    .sort((a, b) => b.progress / b.target - a.progress / a.target)
    .slice(0, count)
}

/** Families with their badges, plus any badge no family names, so none is ever hidden. */
export function groupAchievements(achievements: TrainingProfile['achievements']) {
  const byKey = new Map(achievements.map((a) => [a.key, a]))
  const named = new Set(ACHIEVEMENT_FAMILIES.flatMap((family) => family.keys))
  const groups = ACHIEVEMENT_FAMILIES.map((family) => ({
    title: family.title,
    items: family.keys.map((key) => byKey.get(key)).filter((a) => a !== undefined),
  })).filter((group) => group.items.length)
  const rest = achievements.filter((a) => !named.has(a.key))
  return rest.length ? [...groups, { title: 'More', items: rest }] : groups
}

// From this hour a live streak with today's goal unmet is in danger.
const RISK_FROM_HOUR = 18

/**
 * Minutes left until midnight when the streak is at risk — a live streak,
 * today's goal not met, evening — or null when it is not.
 */
export function streakAtRisk(profile: TrainingProfile, now = new Date()): number | null {
  if (profile.streak <= 0 || profile.goal_met_today || now.getHours() < RISK_FROM_HOUR) return null
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return Math.max(1, Math.round((midnight.getTime() - now.getTime()) / 60_000))
}

/** "Your 4-day streak ends in 3h 20m — 30 XP keeps it." */
export function riskMessage(profile: TrainingProfile, minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const left = hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  const xp = Math.max(0, profile.daily_goal - profile.today_xp)
  return `Your ${profile.streak.toLocaleString()}-day streak ends in ${left}. ${xp.toLocaleString()} XP keeps it.`
}
