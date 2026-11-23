import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ResultBar } from '@/components/dashboard/result-bar'
import type { GameStats } from '@/hooks/use-game-stats'

export function ColorBreakdown({ stats }: { stats: GameStats }) {
  const white = stats.by_color.white
  const black = stats.by_color.black
  const whiteTotal = white.wins + white.losses + white.draws
  const blackTotal = black.wins + black.losses + black.draws

  return (
    <Card className="stats-panel">
      <CardHeader>
        <h2>Results by color</h2>
      </CardHeader>
      <CardBody className="stats-panel__body">
        <div className="stats-color-grid">
          <div className="stats-color-row">
            <div className="stats-color-row__header">
              <span>As White</span>
              <span className="muted">{whiteTotal.toLocaleString()} games</span>
            </div>
            <ResultBar draws={white.draws} losses={white.losses} wins={white.wins} />
            <div className="stats-result-row">
              <span style={{ color: 'var(--success)' }}>{white.wins.toLocaleString()}W</span>
              <span style={{ color: 'var(--draw)' }}>{white.draws.toLocaleString()}D</span>
              <span style={{ color: 'var(--danger)' }}>{white.losses.toLocaleString()}L</span>
            </div>
          </div>
          <div className="stats-color-row">
            <div className="stats-color-row__header">
              <span>As Black</span>
              <span className="muted">{blackTotal.toLocaleString()} games</span>
            </div>
            <ResultBar draws={black.draws} losses={black.losses} wins={black.wins} />
            <div className="stats-result-row">
              <span style={{ color: 'var(--success)' }}>{black.wins.toLocaleString()}W</span>
              <span style={{ color: 'var(--draw)' }}>{black.draws.toLocaleString()}D</span>
              <span style={{ color: 'var(--danger)' }}>{black.losses.toLocaleString()}L</span>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
