import type { Habit, HabitMoment, HabitsReport } from './types'

export type HabitTone = 'good' | 'bad' | 'neutral'

export type HabitWords = {
  title: string
  line: string
  advice: string | null
  /** How the last games compare with the rest, when there are enough of them. */
  recent: { text: string; tone: HabitTone } | null
}

function percent(share: number | null | undefined): string {
  return `${Math.round((share ?? 0) * 100)}%`
}

/** A score against the ratings, in percentage points: "4 points above your rating". */
function points(diff: number | null | undefined): string {
  const value = Math.round(Math.abs(diff ?? 0) * 100)
  if (value === 0) return 'level with your rating'
  return `${value} point${value === 1 ? '' : 's'} ${(diff ?? 0) > 0 ? 'above' : 'below'} your rating`
}

const MIN_RECENT_EVENTS = 20
const CHANGE = 0.15

function recentTrend(habit: Habit): HabitWords['recent'] {
  const { rate, recent_rate: recent, recent_events: events } = habit
  if (rate == null || recent == null || (events ?? 0) < MIN_RECENT_EVENTS || rate === 0) return null
  const ratio = recent / rate
  const tone: HabitTone = ratio <= 1 - CHANGE ? 'good' : ratio >= 1 + CHANGE ? 'bad' : 'neutral'
  const verdict =
    tone === 'good' ? 'Better lately.' : tone === 'bad' ? 'Worse lately.' : 'About the same lately.'
  return { text: `Last 30 games: ${percent(recent)}. ${verdict}`, tone }
}

/** The words for one habit, in the player's own numbers. */
export function describeHabit(habit: Habit): HabitWords {
  switch (habit.key) {
    case 'second_mistake':
      return habit.shows
        ? {
            title: 'One mistake becomes two',
            line: `After a big mistake, the next move is another one ${percent(habit.rate)} of the time. Other moves: ${percent(habit.baseline)}.`,
            advice: 'After a mistake, take 30 seconds. Find their best reply first.',
            recent: recentTrend(habit),
          }
        : {
            title: 'One mistake stays one',
            line: `After a big mistake your next move goes wrong ${percent(habit.rate)} of the time, close to your usual ${percent(habit.baseline)}.`,
            advice: null,
            recent: null,
          }
    case 'missed_punishment':
      return habit.shows
        ? {
            title: 'You give back their mistakes',
            line: `After their big mistake, you hand it back on the next move ${percent(habit.rate)} of the time: ${(habit.handed_back ?? 0).toLocaleString()} of ${(habit.events ?? 0).toLocaleString()}.`,
            advice: 'A surprising move may be a mistake. Look at every capture and check first.',
            recent: recentTrend(habit),
          }
        : {
            title: 'You punish their mistakes',
            line: `When your opponent slips, you keep it: you gave it back ${percent(habit.rate)} of the time.`,
            advice: null,
            recent: null,
          }
    case 'long_session': {
      const stop = habit.stop_after
      if (!stop) {
        return {
          title: 'Long sittings',
          line: 'Not enough long sittings yet to say whether they cost you.',
          advice: null,
          recent: null,
        }
      }
      return habit.shows
        ? {
            title: 'Long sittings cost you',
            line: `Your first ${stop} games in a sitting score ${points(habit.early)}. From game ${stop + 1} on: ${points(habit.late)}.`,
            advice: `Stop after ${stop} games in a row and take a break of at least 30 minutes.`,
            recent: null,
          }
        : {
            title: 'Long sittings are fine',
            line: `Games after ${stop} in a row score about as well as the first ones.`,
            advice: null,
            recent: null,
          }
    }
    case 'tilt':
      return habit.shows
        ? {
            title: 'A loss tilts you',
            line: `The game after a loss scores ${points(habit.after_loss)}. Other games: ${points(habit.otherwise)}.`,
            advice: 'After a loss, take ten minutes before you start another game.',
            recent: null,
          }
        : {
            title: 'A loss does not tilt you',
            line: `The game after a loss scores ${points(habit.after_loss)}, as well as any other.`,
            advice: null,
            recent: null,
          }
  }
}

/** Habits the player has first, then the ones they do not. */
export function orderHabits(habits: Habit[]): Habit[] {
  return [...habits.filter((habit) => habit.shows), ...habits.filter((habit) => !habit.shows)]
}

/**
 * What to tell a player in the middle of a sitting, or null when they are not
 * in one or their sittings do not cost them.
 */
export function describeSitting(
  report: Pick<HabitsReport, 'sitting' | 'habits'>,
): { text: string; stop: boolean } | null {
  const { sitting } = report
  const habit = report.habits.find((item) => item.key === 'long_session')
  if (!sitting.active || !habit?.shows || !habit.stop_after) return null
  const stop = habit.stop_after
  if (sitting.games >= stop) {
    return {
      text: `${sitting.games} games in a row. After game ${stop} you score ${points(habit.late)}. A good place to stop.`,
      stop: true,
    }
  }
  const left = stop - sitting.games
  return {
    text: `Game ${sitting.games} of this sitting. Your best are the first ${stop}: ${left === 1 ? 'one more' : `${left} more`}, then stop.`,
    stop: false,
  }
}

function inSeconds(seconds: number | null): string {
  return seconds == null ? '' : ` in ${Math.max(1, Math.round(seconds))}s`
}

/** One move where a habit showed, as a coach would say it. */
export function describeMoment(moment: HabitMoment): string {
  const played = `${moment.san ?? 'your move'}${inSeconds(moment.think_seconds)}`
  const better = moment.better_san ? ` ${moment.better_san} was the move.` : ''
  if (moment.kind === 'missed_punishment') {
    return `Move ${moment.move_number}: their ${moment.opponent_san ?? 'move'} was a mistake, and you answered ${played}.${better}`
  }
  return `Move ${moment.move_number}: a second mistake straight after the first, ${played}.${better}`
}
