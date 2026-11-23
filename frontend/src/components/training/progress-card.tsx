import { useQuery } from '@tanstack/react-query'

import { StatTile } from '@/components/training/stat-tile'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { api } from '@/lib/api'
import { formatGameDate } from '@/lib/format-date'
import {
  delta,
  describeProgress,
  describeSinceTraining,
  percent,
  rollingBigErrors,
} from '@/lib/training/progress-report'
import type { TrainingProgress } from '@/lib/training/types'

const WIDTH = 320
const HEIGHT = 86
const PAD = 6
/* Room under the curve for the date ticks. */
const AXIS = 14

/** "12 Oct", with the year once the games span more than one. */
function tickLabel(iso: string, withYear: boolean) {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: '2-digit' } : {}),
  })
}

/** Which points carry a date tick: first, last, and about every quarter between. */
function tickIndexes(count: number): number[] {
  if (count < 2) return [0]
  const ticks = new Set([0, count - 1])
  const slots = count >= 16 ? 3 : count >= 6 ? 1 : 0
  for (let slot = 1; slot <= slots; slot += 1) {
    ticks.add(Math.round(((count - 1) * slot) / (slots + 1)))
  }
  return [...ticks].sort((a, b) => a - b)
}

/**
 * Big mistakes a game, as a ten-game rolling mean, oldest on the left. One
 * series, one axis; each game is a hover target that names it.
 */
function Trend({ progress }: { progress: TrainingProgress }) {
  const points = rollingBigErrors(progress.games)
  if (points.length < 2) return null
  const max = Math.max(...points.map((point) => point.value), 1)
  const x = (index: number) => PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2)
  const floor = HEIGHT - PAD - AXIS
  const y = (value: number) => floor - (value / max) * (floor - PAD)
  const path = points
    .map(
      (point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`,
    )
    .join(' ')
  const last = points[points.length - 1]
  const trainingIndex = progress.training_since
    ? points.findIndex((point) => point.game.played_at >= progress.training_since!)
    : -1
  const step = (WIDTH - PAD * 2) / (points.length - 1)
  const first = points[0].game.played_at
  const withYear = first.slice(0, 4) !== last.game.played_at.slice(0, 4)
  const ticks = tickIndexes(points.length)
  return (
    <figure className="progress-trend">
      <svg
        aria-label={`Big mistakes a game over your last ${points.length} measured games, as a ten-game average. Now ${last.value.toFixed(1)}.`}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <line className="progress-trend__base" x1={PAD} x2={WIDTH - PAD} y1={floor} y2={floor} />
        {/* When each game was played: the curve is games in order, not time,
            so the dates say whether this is a week or a year. */}
        {ticks.map((index) => (
          <text
            className="progress-trend__tick"
            key={index}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            x={x(index)}
            y={HEIGHT - 2}
          >
            {tickLabel(points[index].game.played_at, withYear)}
          </text>
        ))}
        {trainingIndex > 0 ? (
          <>
            <line
              className="progress-trend__marker"
              x1={x(trainingIndex)}
              x2={x(trainingIndex)}
              y1={PAD}
              y2={floor}
            />
            <text
              className="progress-trend__marker-label"
              textAnchor={x(trainingIndex) > WIDTH * 0.7 ? 'end' : 'start'}
              x={x(trainingIndex) + (x(trainingIndex) > WIDTH * 0.7 ? -3 : 3)}
              y={PAD + 7}
            >
              Training began {tickLabel(progress.training_since!, withYear)}
            </text>
          </>
        ) : null}
        <path className="progress-trend__line" d={path} />
        <circle
          className="progress-trend__dot"
          cx={x(points.length - 1)}
          cy={y(last.value)}
          r={4}
        />
        {points.map((point, index) => (
          <rect
            className="progress-trend__hit"
            height={HEIGHT}
            key={point.game.game_id}
            width={step}
            x={x(index) - step / 2}
            y={0}
          >
            <title>
              {`${formatGameDate(point.game.played_at)} · ${point.game.big_errors} big mistakes (${point.game.result}) · average ${point.value.toFixed(1)}`}
            </title>
          </rect>
        ))}
      </svg>
      <figcaption className="muted progress-trend__caption">
        <span>
          Big mistakes a game, 10-game average · {tickLabel(first, withYear)} to{' '}
          {tickLabel(last.game.played_at, withYear)}
        </span>
        <strong>{last.value.toFixed(1)} now</strong>
      </figcaption>
    </figure>
  )
}

/** Whether the training is working, measured on the player's latest games. */
export function ProgressCard({ username }: { username: string }) {
  const progress = useQuery({
    queryKey: ['training-progress', username],
    queryFn: async ({ signal }) =>
      (await api.get<TrainingProgress>('/api/training/progress', { params: { username }, signal }))
        .data,
    staleTime: 10 * 60 * 1000,
  })
  if (progress.isLoading) return <PanelSkeleton label="Measuring your recent games" rows={4} />
  if (progress.error || !progress.data) {
    return (
      <PanelError
        error={progress.error}
        onRetry={() => void progress.refetch()}
        what="your progress"
      />
    )
  }
  const data = progress.data
  const { headline, detail } = describeProgress(data)
  const since = describeSinceTraining(data)
  const recent = data.recent
  const previous = data.previous
  return (
    <div className="progress-card train-card">
      <p className="train-card__headline">{headline}</p>
      {detail ? <p className="train-card__detail">{detail}</p> : null}
      {recent ? (
        <div className="train-tiles">
          <StatTile
            change={delta(recent.big_errors, previous?.big_errors, { lowerIsBetter: true })}
            label="Big mistakes a game"
            value={recent.big_errors.toFixed(1)}
          />
          <StatTile
            change={delta(recent.forcing_errors, previous?.forcing_errors, { lowerIsBetter: true })}
            label="Captures & checks missed"
            value={recent.forcing_errors.toFixed(1)}
          />
          <StatTile
            change={delta(
              (recent.worse_after_opening.black ?? 0) * 100,
              previous?.worse_after_opening.black != null
                ? previous.worse_after_opening.black * 100
                : null,
              { lowerIsBetter: true, digits: 0 },
            )}
            label="Black: worse after move 10"
            value={percent(recent.worse_after_opening.black)}
          />
          <StatTile
            change={delta(recent.rating_to, recent.rating_from, {
              lowerIsBetter: false,
              digits: 0,
            })}
            label="Rating over these games"
            value={recent.rating_to?.toLocaleString() ?? '—'}
          />
        </div>
      ) : null}
      <Trend progress={data} />
      {since ? <p className="train-card__detail">{since}</p> : null}
      <p className="train-card__note">
        {recent && previous
          ? `Your last ${recent.games} games against the ${previous.games} before. `
          : ''}
        A big mistake costs a tenth of the game or more. Only mostly analyzed games count (
        {data.games.length} of your last {data.checked_games}).
      </p>
    </div>
  )
}
