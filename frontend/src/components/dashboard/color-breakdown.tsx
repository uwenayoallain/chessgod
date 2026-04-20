import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { StatsBar } from '@/components/tree/stats-bar'
import type { GameStats } from '@/hooks/use-game-stats'

export function ColorBreakdown({ stats }: { stats: GameStats }) {
  const white = stats.by_color.white
  const black = stats.by_color.black
  const whiteTotal = white.wins + white.losses + white.draws
  const blackTotal = black.wins + black.losses + black.draws

  return (
    <Card className="stats-panel">
      <CardHeader>
        <h2>Results by Color</h2>
      </CardHeader>
      <CardBody className="stats-panel__body">
        <div className="stats-color-grid">
          <div className="stats-color-row">
            <div className="stats-color-row__header">
              <span>As White</span>
              <span className="muted">{whiteTotal} games</span>
            </div>
            <StatsBar whiteWins={white.wins} draws={white.draws} blackWins={white.losses} />
            <div className="stats-result-row">
              <span style={{ color: 'var(--success)' }}>{white.wins}W</span>
              <span style={{ color: 'var(--draw)' }}>{white.draws}D</span>
              <span style={{ color: 'var(--danger)' }}>{white.losses}L</span>
            </div>
          </div>
          <div className="stats-color-row">
            <div className="stats-color-row__header">
              <span>As Black</span>
              <span className="muted">{blackTotal} games</span>
            </div>
            <StatsBar whiteWins={black.wins} draws={black.draws} blackWins={black.losses} />
            <div className="stats-result-row">
              <span style={{ color: 'var(--success)' }}>{black.wins}W</span>
              <span style={{ color: 'var(--draw)' }}>{black.draws}D</span>
              <span style={{ color: 'var(--danger)' }}>{black.losses}L</span>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
