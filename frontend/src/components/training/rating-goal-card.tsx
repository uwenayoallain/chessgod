import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Minus, Plus } from 'lucide-react'

import { StatTile } from '@/components/training/stat-tile'
import { Emblem } from '@/components/training/trophies'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { api } from '@/lib/api'
import { formatGameDate } from '@/lib/format-date'
import { describeRatingGoal, monthOf, readRatingGoal, writeRatingGoal } from '@/lib/training/rating'
import type { RatingGoal } from '@/lib/training/types'

const WIDTH = 320
const HEIGHT = 96
const PAD = 8
const STEP = 50

/** Rating over the last six months on one axis, with the goal as a dashed line. */
function RatingLine({ data }: { data: RatingGoal }) {
  const points = data.points
  if (points.length < 2) return null
  const values = [...points.map((point) => point.rating), data.goal]
  const low = Math.min(...values) - 20
  const high = Math.max(...values) + 20
  const x = (index: number) => PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2)
  const y = (value: number) => HEIGHT - PAD - ((value - low) / (high - low)) * (HEIGHT - PAD * 2)
  const path = points
    .map(
      (point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.rating).toFixed(1)}`,
    )
    .join(' ')
  const peakIndex = points.findIndex(
    (point) => point.rating === Math.max(...points.map((p) => p.rating)),
  )
  const last = points[points.length - 1]
  const step = (WIDTH - PAD * 2) / (points.length - 1)
  return (
    <figure className="rating-line">
      <svg
        aria-label={`${data.time_class} rating over the last six months, from ${points[0].rating} to ${last.rating}, against a goal of ${data.goal}.`}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <line
          className="rating-line__goal"
          x1={PAD}
          x2={WIDTH - PAD}
          y1={y(data.goal)}
          y2={y(data.goal)}
        />
        <text className="rating-line__goal-label" x={WIDTH - PAD} y={y(data.goal) - 3}>
          {data.goal}
        </text>
        <path className="rating-line__path" d={path} />
        <circle
          className="rating-line__peak"
          cx={x(peakIndex)}
          cy={y(points[peakIndex].rating)}
          r={3}
        />
        <circle
          className="rating-line__now"
          cx={x(points.length - 1)}
          cy={y(last.rating)}
          r={3.5}
        />
        {points.map((point, index) => (
          <rect
            className="rating-line__hit"
            height={HEIGHT}
            key={point.date}
            width={step}
            x={x(index) - step / 2}
            y={0}
          >
            <title>{`${formatGameDate(`${point.date}T12:00:00`)}: ${point.rating}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="muted">
        Last six months · peak {points[peakIndex].rating} in {monthOf(points[peakIndex].date, true)}
      </figcaption>
    </figure>
  )
}

/** A rating goal: the line, the pace, and the score against players already there. */
export function RatingGoalCard({ username }: { username: string }) {
  const timeClass = 'rapid'
  const [goal, setGoal] = useState<number | null>(() => readRatingGoal(username, timeClass))
  const query = useQuery({
    queryKey: ['rating-goal', username, timeClass, goal],
    queryFn: async ({ signal }) =>
      (
        await api.get<RatingGoal>('/api/training/rating-goal', {
          params: { username, time_class: timeClass, goal: goal ?? undefined },
          signal,
        })
      ).data,
    placeholderData: (previous) => previous,
    staleTime: 10 * 60 * 1000,
  })
  if (query.error && !query.data) {
    return (
      <PanelError
        error={query.error}
        onRetry={() => void query.refetch()}
        what="your rating goal"
      />
    )
  }
  const data = query.data
  if (!data) return <PanelSkeleton label="Loading your rating goal" rows={4} rowHeight={36} />
  const shown = goal ?? data.goal

  function change(delta: number) {
    const next = Math.max(400, Math.min(3200, shown + delta))
    writeRatingGoal(username, timeClass, next)
    setGoal(next)
  }

  const words = describeRatingGoal(data)
  return (
    <div className="rating-goal train-card">
      <div className="train-card__title">
        <Emblem name="podium" size={24} />
        <strong aria-live="polite">Road to {shown}</strong>
        <span className="muted">{timeClass}</span>
        <span className="rating-goal__stepper" role="group" aria-label="Goal">
          <button
            aria-label={`Lower the goal to ${shown - STEP}`}
            disabled={shown - STEP < 400}
            onClick={() => change(-STEP)}
            type="button"
          >
            <Minus size={12} />
          </button>
          <button
            aria-label={`Raise the goal to ${shown + STEP}`}
            disabled={shown + STEP > 3200}
            onClick={() => change(STEP)}
            type="button"
          >
            <Plus size={12} />
          </button>
        </span>
      </div>
      <p className="train-card__headline">{words.headline}</p>
      <div className="train-tiles">
        <StatTile
          label="Now"
          note={
            data.change_30d != null
              ? `${data.change_30d > 0 ? '+' : ''}${data.change_30d} in 30 days`
              : undefined
          }
          value={data.current != null ? String(data.current) : '—'}
        />
        <StatTile
          label="Peak"
          note={data.peak_at ? monthOf(data.peak_at) : undefined}
          value={data.peak != null ? String(data.peak) : '—'}
        />
        <StatTile
          label={`Against ~${shown} players`}
          note={
            data.vs_goal
              ? `${data.vs_goal.games.toLocaleString()} games · half is the goal`
              : undefined
          }
          value={data.vs_goal?.score != null ? `${Math.round(data.vs_goal.score * 100)}%` : '—'}
        />
      </div>
      <RatingLine data={data} />
      {words.detail ? <p className="train-card__detail">{words.detail}</p> : null}
    </div>
  )
}
