import { ResultBar } from '@/components/dashboard/result-bar'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { TimeClassStats } from '@/hooks/use-game-stats'

export function TimeClassChart({ byTimeClass }: { byTimeClass: Record<string, TimeClassStats> }) {
  const entries = Object.entries(byTimeClass).sort(([, a], [, b]) => b.games - a.games)

  if (!entries.length) {
    return null
  }

  return (
    <Card className="stats-panel">
      <CardHeader>
        <h2>Time Controls</h2>
      </CardHeader>
      <CardBody className="stats-panel__body stats-panel__body--list">
        {entries.map(([timeClass, results]) => {
          const total = Math.max(results.games, 1)
          const winPercent = (results.wins / total) * 100
          const lossPercent = (results.losses / total) * 100
          const drawPercent = (results.draws / total) * 100

          return (
            <div className="stats-time-row" key={timeClass}>
              <div className="stats-time-row__main">
                <span className="stats-time-row__label">{timeClass}</span>
                <ResultBar draws={results.draws} losses={results.losses} wins={results.wins} />
                <span className="mono stats-time-row__count">{results.games.toLocaleString()}</span>
              </div>
              <div className="mono muted stats-time-row__meta">
                W {winPercent.toFixed(1)}% · D {drawPercent.toFixed(1)}% · L{' '}
                {lossPercent.toFixed(1)}%
              </div>
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}
