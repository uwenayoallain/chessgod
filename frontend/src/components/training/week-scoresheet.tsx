import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { Emblem } from '@/components/training/trophies'
import { revealSection } from '@/components/ui/collapsible-section'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { api } from '@/lib/api'
import { shortOpeningName } from '@/lib/analysis/points-lost'
import { browserTimeZone } from '@/lib/training/progress'
import type { WeekScoresheet as Sheet } from '@/lib/training/types'
import { habitsLine, ratingLines, weekLabel, weekLine } from '@/lib/training/week'

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/**
 * A week of real games written up the way a game is: a numbered sheet, one
 * line per game in the order played, the result from White's side, and the
 * training's marks beside it — the book when the game stayed in the
 * repertoire, the hourglass when the clock was used the way the challenge asks.
 */
function useWeekSheet(username: string, weeksBack: number, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['week-scoresheet', username, weeksBack],
    queryFn: async ({ signal }) =>
      (
        await api.get<Sheet>('/api/training/week', {
          params: { username, tz: browserTimeZone(), weeks_back: weeksBack },
          signal,
        })
      ).data,
    placeholderData: (previous) => previous,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Early in the week, last week in one line on the Today card, opening the
 * scoresheet: the start of a week is when "how did it go?" is worth asking.
 */
export function LastWeekTeaser({ username, now = new Date() }: { username: string; now?: Date }) {
  // Monday and Tuesday only.
  const early = now.getDay() === 1 || now.getDay() === 2
  const query = useWeekSheet(username, 1, early)
  const sheet = query.data
  if (!early || !sheet || !sheet.played) return null
  return (
    <div className="week-teaser">
      <Emblem name="scroll" size={26} />
      <span className="week-teaser__text">
        <span className="scoresheet__eyebrow">Last week</span>
        <span>
          {weekLine(sheet)}
          {sheet.best_win?.opponent_rating ? ` · best win ${sheet.best_win.opponent_rating}` : ''}
        </span>
      </span>
      <button className="link-button" onClick={() => revealSection('review-week')} type="button">
        See your scoresheet
      </button>
    </div>
  )
}

export function WeekScoresheet({ username }: { username: string }) {
  const [weeksBack, setWeeksBack] = useState(1)
  const query = useWeekSheet(username, weeksBack)
  if (query.error && !query.data) {
    return <PanelError error={query.error} onRetry={() => void query.refetch()} what="your week" />
  }
  const sheet = query.data
  if (!sheet) return <PanelSkeleton label="Loading your week" rows={6} rowHeight={28} />
  const habits = habitsLine(sheet)
  return (
    <div className="scoresheet train-card">
      <div className="scoresheet__head">
        <div>
          <span className="scoresheet__eyebrow">Scoresheet · {weekLabel(sheet)}</span>
          <p className="train-card__headline">{weekLine(sheet)}</p>
          {ratingLines(sheet).map((line) => (
            <p className="train-card__detail" key={line}>
              {line}
            </p>
          ))}
        </div>
        <div aria-label="Week" className="scoresheet__weeks" role="group">
          {[
            { back: 1, label: 'Last week' },
            { back: 0, label: 'This week' },
          ].map((option) => (
            <button
              aria-pressed={weeksBack === option.back}
              className="today-card__goal-option"
              key={option.back}
              onClick={() => setWeeksBack(option.back)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {sheet.best_win ? (
        <p className="scoresheet__best">
          <Emblem name="crown" size={22} />
          <span>
            Best win: {sheet.best_win.opponent} ({sheet.best_win.opponent_rating}),{' '}
            {shortOpeningName(sheet.best_win.opening) ?? 'no opening name'}
          </span>
        </p>
      ) : null}

      {sheet.games.length ? (
        <ol className="scoresheet__lines">
          {sheet.games.map((line, index) => (
            <li
              data-best={sheet.best_win?.game_id === line.game_id || undefined}
              data-result={line.result}
              key={line.game_id}
            >
              <span className="scoresheet__number">{index + 1}.</span>
              <span
                aria-label={`You had ${line.color}`}
                className="scoresheet__side"
                data-color={line.color}
                role="img"
              />
              <a className="scoresheet__result" href={line.url} rel="noreferrer" target="_blank">
                {line.notation}
              </a>
              <span className="scoresheet__who">
                <span>
                  {line.opponent}
                  {line.opponent_rating ? (
                    <span className="muted"> ({line.opponent_rating})</span>
                  ) : null}
                </span>
                <span className="muted scoresheet__opening">
                  {DAY.format(new Date(line.played_at))} ·{' '}
                  {shortOpeningName(line.opening) ?? line.time_class}
                </span>
              </span>
              <span className="scoresheet__marks">
                {line.in_book ? (
                  <span title="Stayed in your repertoire">
                    <Emblem name="book" size={18} />
                    <span className="sr-only-inline">in your repertoire</span>
                  </span>
                ) : null}
                {line.used_clock ? (
                  <span title="Used the clock without a scramble">
                    <Emblem name="hourglass" size={18} />
                    <span className="sr-only-inline">clock used well</span>
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {habits && sheet.played ? <p className="train-card__note">{habits}</p> : null}
    </div>
  )
}
