import { useQuery } from '@tanstack/react-query'
import { Shield } from 'lucide-react'

import { revealSection } from '@/components/ui/collapsible-section'
import { Emblem } from '@/components/training/trophies'
import { Button } from '@/components/ui/button'
import { StatTile } from '@/components/training/stat-tile'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { api } from '@/lib/api'
import { describeClock, describeFinish, formatClock } from '@/lib/training/clock'
import type { ClockReport } from '@/lib/training/types'

/**
 * Big mistakes by how long the player thought: counts, not rates. Rates rise
 * with think time because long thinks are the hard positions; what matters to
 * a player is where their mistakes actually come from.
 */
function ThinkBars({ report }: { report: ClockReport }) {
  const bands = report.by_think ?? []
  if (!bands.length) return null
  const most = Math.max(...bands.map((band) => band.mistakes), 1)
  return (
    <figure className="clock-bars">
      <figcaption className="muted">Big mistakes after move 10, by how long you thought</figcaption>
      <ul>
        {bands.map((band) => (
          <li
            key={band.label}
            title={`${band.label}: ${band.mistakes.toLocaleString()} big mistakes in ${band.moves.toLocaleString()} moves`}
          >
            <span className="clock-bars__label">{band.label}</span>
            <span aria-hidden="true" className="clock-bars__track">
              <span style={{ width: `${(band.mistakes / most) * 100}%` }} />
            </span>
            <span className="clock-bars__value">
              {band.mistakes.toLocaleString()}
              <span className="muted"> of {band.moves.toLocaleString()} moves</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

/** How the player spends their clock, and whether that is where their mistakes come from. */
export function ClockCard({ username }: { username: string }) {
  const query = useQuery({
    queryKey: ['training-clock', username],
    queryFn: async ({ signal }) =>
      (await api.get<ClockReport>('/api/training/clock', { params: { username }, signal })).data,
    staleTime: 10 * 60 * 1000,
  })
  if (query.error && !query.data) {
    return <PanelError error={query.error} onRetry={() => void query.refetch()} what="your clock" />
  }
  const report = query.data
  if (!report) return <PanelSkeleton label="Reading your clock" rows={4} rowHeight={40} />
  const words = describeClock(report)
  // Only say the mistakes came fast when they did: under ten seconds for most of them.
  const bands = report.by_think ?? []
  const fast = bands.slice(0, 2).reduce((n, band) => n + band.mistakes, 0)
  const mostlyFast = report.mistakes > 0 && fast / report.mistakes >= 0.5
  const finish = describeFinish(report)
  const measured = report.verdict !== 'insufficient' && report.initial_seconds
  return (
    <div className="clock-card train-card" data-verdict={report.verdict}>
      <p className="train-card__headline train-card__headline--icon">
        <Emblem name="hourglass" size={24} /> <span>{words.headline}</span>
      </p>
      {words.detail ? <p className="train-card__detail">{words.detail}</p> : null}
      {measured ? (
        <>
          <div className="train-tiles">
            <StatTile
              label="Clock left when you lose"
              note={`of ${formatClock(report.initial_seconds!)}${report.losses ? ` · median of ${report.losses.toLocaleString()} losses` : ''}`}
              value={report.left_in_losses != null ? formatClock(report.left_in_losses) : '—'}
            />
            <StatTile
              label="A big mistake takes"
              note={
                report.mistake_left != null
                  ? `with\u00a0${formatClock(report.mistake_left)}\u00a0left`
                  : undefined
              }
              value={report.mistake_think != null ? `${Math.round(report.mistake_think)}s` : '—'}
            />
            <StatTile
              label="Mistakes with half the clock left"
              note={`${Math.round((report.hasty_mistakes ?? 0) * 100)}% in under 10 seconds`}
              value={`${Math.round((report.mistakes_with_half_clock ?? 0) * 100)}%`}
            />
          </div>
          <ThinkBars report={report} />
          <p className="train-card__note">
            Long thinks go wrong more often because those are the hard positions.
            {mostlyFast ? ' Most of your big mistakes still came fast.' : ''}
            {finish ? ` ${finish}` : ''}
          </p>
        </>
      ) : null}
      {words.advice ? (
        <div className="train-callout">
          <p>{words.advice}</p>
          <Button onClick={() => revealSection('review-threats')} type="button" variant="default">
            <Shield size={14} /> Train it in Blunder Check
          </Button>
        </div>
      ) : null}
    </div>
  )
}
