import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EcoBadge } from '@/components/theory/eco-badge'
import type { TheoryComparison as TheoryComparisonData } from '@/hooks/use-theory'

export function TheoryComparison({ data }: { data: TheoryComparisonData | null }) {
  return (
    <Card>
      <CardHeader>
        <h2>Theory Comparison</h2>
        <EcoBadge eco={data?.eco} name={data?.opening_name} />
      </CardHeader>
      <CardBody className="split">
        <div className="column">
          <strong>Your Repertoire</strong>
          {!data?.user_moves.length ? <div className="muted">No imported moves from this position.</div> : null}
          {data?.user_moves.map((move) => (
            <div className="move-row" key={`user-${move.san}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{move.san}</span>
                <span className="muted">{move.game_count}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="column">
          <strong>Master Database</strong>
          {!data?.master_moves.length ? <div className="muted">No master moves available.</div> : null}
          {data?.master_moves.map((move) => (
            <div className="move-row" key={`master-${move.san}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{move.san}</span>
                <span className="muted">{move.game_count}</span>
              </div>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}
