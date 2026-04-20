import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { OpeningStat } from '@/hooks/use-game-stats'

export function TopOpenings({ openings }: { openings: OpeningStat[] }) {
  if (!openings.length) return null

  return (
    <Card className="stats-panel stats-panel--wide">
      <CardHeader>
        <h2>Top Openings</h2>
      </CardHeader>
      <CardBody className="stats-panel__body stats-panel__body--list">
        {openings.map((opening, index) => (
          <div
            className="stats-opening-row"
            key={opening.opening_name}
          >
            <span className="muted stats-opening-row__rank">
              {index + 1}
            </span>
            <span className="stats-opening-row__name">{opening.opening_name}</span>
            <span className="badge">{opening.games} games</span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}
