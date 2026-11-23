import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Microscope, Swords } from 'lucide-react'
import { useState } from 'react'

import { openBlunderCheck } from '@/components/training/blunder-check'
import { Emblem } from '@/components/training/trophies'
import { Button } from '@/components/ui/button'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import type { PaginatedGames, WorkspaceGame } from '@/hooks/use-workspace-data'
import { api } from '@/lib/api'
import { BEST_MOVE_ARROW_COLOR, THREAT_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { sanToUci } from '@/lib/chess-utils'
import { formatGameDate } from '@/lib/format-date'
import { describeHabit, describeMoment, describeSitting, orderHabits } from '@/lib/training/habits'
import type { HabitMoment, HabitsReport } from '@/lib/training/types'
import { useAppStore } from '@/store/app-store'

export function habitsQueryKey(username: string) {
  return ['training-habits', username] as const
}

/** The habits report, shared by this page and the Today card's sitting line. */
export function useHabits(username: string, enabled = true) {
  return useQuery({
    queryKey: habitsQueryKey(username),
    queryFn: async ({ signal }) =>
      (await api.get<HabitsReport>('/api/training/habits', { params: { username }, signal })).data,
    // The sitting changes while the player is at the board.
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: true,
    enabled,
  })
}

const RESULT_WORDS: Record<string, string> = { win: 'Won', loss: 'Lost', draw: 'Drew' }

function arrow(fen: string, san: string | null, color: string) {
  const uci = san ? sanToUci(fen, san) : null
  return uci ? [{ startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color }] : []
}

/** What the player does wrong over the board, from their own games. */
export function HabitsCard({
  username,
  onOpenGame,
}: {
  username: string
  onOpenGame?: (game: WorkspaceGame) => void
}) {
  const query = useHabits(username)
  const jumpToFen = useAppStore((state) => state.jumpToFen)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const [opening, setOpening] = useState<number | null>(null)

  if (query.error && !query.data) {
    return (
      <PanelError error={query.error} onRetry={() => void query.refetch()} what="your habits" />
    )
  }
  const report = query.data
  if (!report) return <PanelSkeleton label="Reading your games" rows={5} rowHeight={56} />
  if (!report.habits.length) {
    return <p className="muted">Import and analyse some games to see your habits.</p>
  }

  const sitting = describeSitting(report)
  const last = report.last_game

  async function showMoment(moment: HabitMoment) {
    if (!last || !onOpenGame || !moment.fen) return
    setOpening(moment.ply)
    try {
      const game = (await api.get<WorkspaceGame>(`/api/games/${last.game_id}`)).data
      onOpenGame(game)
      const fen = moment.fen
      // The game loads on Explore first; then the board steps to the move.
      window.setTimeout(() => {
        jumpToFen(fen)
        setTrainerArrows(
          [
            ...arrow(fen, moment.san, THREAT_ARROW_COLOR),
            ...arrow(fen, moment.better_san, BEST_MOVE_ARROW_COLOR),
          ],
          fen,
        )
      }, 120)
    } finally {
      setOpening(null)
    }
  }

  async function reviewNewest() {
    if (!onOpenGame) return
    setOpening(-1)
    try {
      const page = (
        await api.get<PaginatedGames>('/api/games', { params: { username, page: 1, per_page: 1 } })
      ).data
      if (page.games[0]) onOpenGame(page.games[0])
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="habits train-card">
      {sitting ? (
        <div className="train-callout" data-tone={sitting.stop ? 'warn' : undefined}>
          <p>{sitting.text}</p>
        </div>
      ) : null}

      <ul className="habits__list">
        {orderHabits(report.habits).map((habit) => {
          const words = describeHabit(habit)
          return (
            <li className="habits__habit" data-shows={habit.shows || undefined} key={habit.key}>
              <p className="habits__title">
                <Emblem name={habit.shows ? 'eye' : 'shield'} size={20} />
                <strong>{words.title}</strong>
              </p>
              <p className="habits__line">{words.line}</p>
              {words.recent ? (
                <p className="habits__recent" data-tone={words.recent.tone}>
                  {words.recent.text}
                </p>
              ) : null}
              {words.advice ? <p className="habits__advice">{words.advice}</p> : null}
            </li>
          )
        })}
      </ul>

      {last ? (
        <section aria-label="Your last analysed game" className="habits__game">
          <p className="train-card__title">
            Your last analysed game · {formatGameDate(last.played_at)}
          </p>
          <p className="train-card__detail">
            {RESULT_WORDS[last.user_result] ?? 'Played'} as{' '}
            {last.user_color === 'white' ? 'White' : 'Black'} against {last.opponent}.{' '}
            {last.moments.length
              ? `${last.moments.length === 1 ? 'One habit' : `${last.moments.length} habits`} showed:`
              : last.big_mistakes
                ? `${last.big_mistakes === 1 ? 'One big mistake' : `${last.big_mistakes} big mistakes`} after the opening, ${last.big_mistakes === 1 ? 'not' : 'none of them'} one of your habits.`
                : 'No big mistakes after the opening.'}
          </p>
          {last.moments.length ? (
            <ul className="habits__moments">
              {last.moments.map((moment) => (
                <li key={moment.ply}>
                  <button
                    className="habits__moment"
                    disabled={!onOpenGame || !moment.fen || opening === moment.ply}
                    onClick={() => void showMoment(moment)}
                    type="button"
                  >
                    <span>{describeMoment(moment)}</span>
                    <ChevronRight aria-hidden="true" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {report.pending_games ? (
        <div className="train-callout">
          <p>
            {report.pending_games === 1
              ? 'Your newest game is not analysed yet.'
              : `Your ${report.pending_games} newest games are not analysed yet.`}{' '}
            {report.pending_games === 1
              ? 'Review it and its habits show here.'
              : 'Review the newest and its habits show here.'}
          </p>
          {onOpenGame ? (
            <Button
              disabled={opening === -1}
              onClick={() => void reviewNewest()}
              type="button"
              variant="default"
            >
              <Microscope size={14} /> Review your newest game
            </Button>
          ) : null}
        </div>
      ) : null}

      {report.habits.some((habit) => habit.key === 'missed_punishment' && habit.shows) ? (
        <div className="train-callout">
          <p>Positions where you gave their mistake back. Find the move you missed.</p>
          <Button onClick={() => openBlunderCheck('punish')} type="button" variant="default">
            <Swords size={14} /> Train it in Punish it
          </Button>
        </div>
      ) : null}
      <p className="train-card__note">
        From your last {report.games.toLocaleString()} rapid and blitz games.
      </p>
    </div>
  )
}
