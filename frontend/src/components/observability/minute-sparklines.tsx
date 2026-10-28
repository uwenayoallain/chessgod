import type { MinuteBucket } from './types'

type Props = {
  series: MinuteBucket[]
}

const WIDTH = 240
const HEIGHT = 56
const MAX_BUCKETS = 60

function buildPath(values: number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values, 1)
  const step = WIDTH / Math.max(values.length - 1, 1)
  return values
    .map((value, idx) => {
      const x = idx * step
      const y = HEIGHT - (value / max) * (HEIGHT - 4) - 2
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function Sparkline({
  label,
  values,
  color,
  suffix,
}: {
  label: string
  values: number[]
  color: string
  suffix?: string
}) {
  const padded =
    values.length >= MAX_BUCKETS
      ? values
      : Array(MAX_BUCKETS - values.length)
          .fill(0)
          .concat(values)
  const path = buildPath(padded)
  const last = values.length ? values[values.length - 1] : 0
  const peak = values.length ? Math.max(...values) : 0
  return (
    <div className="sparkline">
      <div className="sparkline__head">
        <span className="sparkline__label">{label}</span>
        <span className="sparkline__last mono">
          {last.toFixed(suffix === 'ms' ? 1 : 0)}
          {suffix}{' '}
          <span className="muted">
            peak {peak.toFixed(suffix === 'ms' ? 1 : 0)}
            {suffix}
          </span>
        </span>
      </div>
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${label} sparkline`}
      >
        <path
          d={path || `M0,${HEIGHT} L${WIDTH},${HEIGHT}`}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
        />
      </svg>
    </div>
  )
}

export function MinuteSparklines({ series }: Props) {
  const requests = series.map((b) => b.requests)
  const errors = series.map((b) => b.errors)
  const p95 = series.map((b) => b.p95_ms)
  return (
    <div className="sparkline-grid">
      <Sparkline label="Requests / min" values={requests} color="var(--accent, #3b82f6)" />
      <Sparkline label="Errors / min" values={errors} color="var(--danger, #ef4444)" />
      <Sparkline label="p95 latency" values={p95} color="var(--warning, #f59e0b)" suffix="ms" />
    </div>
  )
}
