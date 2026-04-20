import { useMemo } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { TheoryDeviation } from '@/hooks/use-theory'
import { useTheoryDeviations } from '@/hooks/use-theory'
import type { OpeningSelection } from '@/hooks/use-board-workspace'

type OpeningRecommendation = {
  openingName: string
  eco: string | null
  side: 'white' | 'black' | 'both'
  total: number
  major: number
  moderate: number
  minor: number
}

export function aggregateDeviations(
  whiteDeviations: TheoryDeviation[],
  blackDeviations: TheoryDeviation[],
): OpeningRecommendation[] {
  const map = new Map<string, OpeningRecommendation>()

  function process(deviations: TheoryDeviation[], side: 'white' | 'black') {
    for (const d of deviations) {
      const key = d.opening_name ?? d.eco ?? 'Unknown'
      const existing = map.get(key)
      if (existing) {
        existing.total += 1
        if (d.severity === 'major') existing.major += 1
        else if (d.severity === 'moderate') existing.moderate += 1
        else existing.minor += 1
        if (existing.side !== side) existing.side = 'both'
      } else {
        map.set(key, {
          openingName: d.opening_name ?? 'Unknown',
          eco: d.eco ?? null,
          side,
          total: 1,
          major: d.severity === 'major' ? 1 : 0,
          moderate: d.severity === 'moderate' ? 1 : 0,
          minor: d.severity === 'minor' ? 1 : 0,
        })
      }
    }
  }

  process(whiteDeviations, 'white')
  process(blackDeviations, 'black')

  return Array.from(map.values()).sort((a, b) => {
    const scoreA = a.major * 3 + a.moderate * 2 + a.minor
    const scoreB = b.major * 3 + b.moderate * 2 + b.minor
    return scoreB - scoreA
  })
}

function sideLabel(side: 'white' | 'black' | 'both') {
  if (side === 'both') return 'W+B'
  return side === 'white' ? 'W' : 'B'
}

export function OpeningRecommendations({
  onSelectOpening,
}: {
  onSelectOpening: (opening: OpeningSelection) => void
}) {
  const { data: whiteDeviations, isLoading: wLoading } = useTheoryDeviations('white')
  const { data: blackDeviations, isLoading: bLoading } = useTheoryDeviations('black')

  const recommendations = useMemo(
    () => aggregateDeviations(whiteDeviations, blackDeviations).slice(0, 15),
    [whiteDeviations, blackDeviations],
  )

  const isLoading = wLoading || bLoading

  return (
    <Card>
      <CardHeader>
        <h2>Needs Work</h2>
        <span className="muted">both repertoires</span>
      </CardHeader>
      <CardBody className="column">
        {isLoading ? <div className="muted">Loading deviations…</div> : null}
        {!isLoading && !recommendations.length ? (
          <div className="muted">No deviations found yet. Import games and load some openings first.</div>
        ) : null}
        {recommendations.map((rec) => (
          <button
            key={`${rec.eco ?? ''}:${rec.openingName}`}
            className="move-row move-row--button"
            onClick={() => onSelectOpening({ eco: rec.eco, openingName: rec.openingName })}
            type="button"
          >
            <div className="workspace-list__title">
              <strong>{rec.openingName}</strong>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className="badge" style={{ fontSize: 10, padding: '1px 5px' }}>{sideLabel(rec.side)}</span>
                {rec.eco ? <span className="badge">{rec.eco}</span> : null}
              </div>
            </div>
            <div className="workspace-list__meta">
              <span>{rec.total} deviations</span>
              <span>
                {rec.major > 0 ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{rec.major} major</span> : null}
                {rec.major > 0 && rec.moderate > 0 ? ' · ' : null}
                {rec.moderate > 0 ? <span style={{ color: 'var(--warning)' }}>{rec.moderate} moderate</span> : null}
              </span>
            </div>
          </button>
        ))}
      </CardBody>
    </Card>
  )
}
