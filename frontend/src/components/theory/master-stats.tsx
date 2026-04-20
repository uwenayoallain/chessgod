import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { TheoryMove } from '@/hooks/use-theory'

export function MasterStats({ moves }: { moves: TheoryMove[] }) {
  return (
    <Card>
      <CardHeader>
        <h2>Master Moves</h2>
      </CardHeader>
      <CardBody className="column">
        {!moves.length ? <div className="muted">No master data for this position yet.</div> : null}
        {moves.map((move) => (
          <div className="move-row" key={move.san}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{move.san}</strong>
              <span className="muted">{move.game_count} games</span>
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}
