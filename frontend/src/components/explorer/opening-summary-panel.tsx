import { useMemo, useState } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatsBar } from '@/components/tree/stats-bar'
import { Skeleton } from '@/components/ui/skeleton'
import { useOpeningStats } from '@/hooks/use-opening-stats'
import { useTheoryDeviations, type TheoryDeviation } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'

type SortMode = 'games' | 'win_rate' | 'deviations'

export function OpeningSummaryPanel() {
  const username = useAppStore((state) => state.username)
  const colorFilter = useAppStore((state) => state.colorFilter)
  const timeClassFilter = useAppStore((state) => state.timeClassFilter)
  const [expanded, setExpanded] = useState(true)
  const [sortBy, setSortBy] = useState<SortMode>('games')

  const effectiveColor = colorFilter === 'both' ? 'white' : colorFilter
  const { data: openings, isLoading } = useOpeningStats(username, effectiveColor, timeClassFilter)
  const { data: deviations } = useTheoryDeviations(effectiveColor)

  const deviationsByOpening = useMemo(() => {
    const map = new Map<string, number>()
    for (const d of deviations) {
      const name = d.opening_name ?? 'Unknown'
      map.set(name, (map.get(name) ?? 0) + 1)
    }
    return map
  }, [deviations])

  const sortedOpenings = useMemo(() => {
    const items = openings.map((o) => ({
      ...o,
      deviationCount: deviationsByOpening.get(o.opening_name) ?? 0,
    }))
    switch (sortBy) {
      case 'win_rate':
        return items.sort((a, b) => a.win_rate - b.win_rate)
      case 'deviations':
        return items.sort((a, b) => b.deviationCount - a.deviationCount)
      default:
        return items.sort((a, b) => b.game_count - a.game_count)
    }
  }, [openings, sortBy, deviationsByOpening])

  return (
    <Card>
      <CardHeader>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <h2>
            Opening Summary
            <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
              ({effectiveColor})
            </span>
          </h2>
          <Button onClick={() => setExpanded(!expanded)} type="button" variant="ghost" style={{ fontSize: 12 }}>
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>
      </CardHeader>
      {expanded ? (
        <CardBody className="column">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Button onClick={() => setSortBy('games')} type="button" variant={sortBy === 'games' ? 'primary' : 'ghost'} style={{ fontSize: 12 }}>
              By Games
            </Button>
            <Button onClick={() => setSortBy('win_rate')} type="button" variant={sortBy === 'win_rate' ? 'primary' : 'ghost'} style={{ fontSize: 12 }}>
              Lowest Win Rate
            </Button>
            <Button onClick={() => setSortBy('deviations')} type="button" variant={sortBy === 'deviations' ? 'primary' : 'ghost'} style={{ fontSize: 12 }}>
              Most Deviations
            </Button>
          </div>

          {isLoading ? (
            <div className="column" style={{ gap: 12 }}>
              <Skeleton />
              <Skeleton width="88%" />
              <Skeleton width="72%" />
            </div>
          ) : null}

          {!isLoading && sortedOpenings.length === 0 ? (
            <div className="muted">No openings found for this filter.</div>
          ) : null}

          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {sortedOpenings.map((opening) => (
              <div
                key={`${opening.eco}-${opening.opening_name}`}
                style={{
                  padding: '8px 0',
                  borderBottom: '1px solid var(--border-soft)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  {opening.eco ? (
                    <span className="badge" style={{ fontSize: 11 }}>{opening.eco}</span>
                  ) : null}
                  <span style={{ flex: 1, fontSize: 13 }}>{opening.opening_name}</span>
                  <span className="mono" style={{ fontSize: 12 }}>{opening.game_count} games</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <StatsBar whiteWins={opening.wins} draws={opening.draws} blackWins={opening.losses} />
                  </div>
                  <span style={{ fontSize: 12, width: 48, textAlign: 'right' }}>
                    {(opening.win_rate * 100).toFixed(0)}%
                  </span>
                  {opening.deviationCount > 0 ? (
                    <span
                      className="badge"
                      style={{
                        fontSize: 11,
                        background: opening.deviationCount >= 3 ? 'var(--danger)' : 'var(--warning)',
                        color: 'white',
                      }}
                    >
                      {opening.deviationCount} dev
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {sortBy === 'deviations' && sortedOpenings.length > 0 && sortedOpenings[0].deviationCount > 0 ? (
            <div
              style={{
                marginTop: 12,
                padding: '8px 12px',
                background: 'var(--accent-soft)',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              Study suggestion: <strong>{sortedOpenings[0].opening_name}</strong> has the most
              deviations ({sortedOpenings[0].deviationCount}) from master theory.
            </div>
          ) : null}
        </CardBody>
      ) : null}
    </Card>
  )
}
