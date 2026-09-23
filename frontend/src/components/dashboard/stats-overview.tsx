import type { GameStats } from '@/hooks/use-game-stats'

export function StatsOverview({ stats }: { stats: GameStats }) {
  const totalWins = stats.by_color.white.wins + stats.by_color.black.wins
  const totalLosses = stats.by_color.white.losses + stats.by_color.black.losses
  const totalDraws = stats.by_color.white.draws + stats.by_color.black.draws

  return (
    <div className="card-grid">
      <div className="stat-card">
        <div className="stat-card__label">Total Games</div>
        <div className="stat-card__value">{stats.total_games.toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="stat-card__label">Win Rate</div>
        <div className="stat-card__value">{(stats.win_rate * 100).toFixed(1)}%</div>
      </div>
      <div className="stat-card">
        <div className="stat-card__label">Wins</div>
        <div className="stat-card__value" style={{ color: 'var(--success)' }}>
          {totalWins.toLocaleString()}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-card__label">Losses</div>
        <div className="stat-card__value" style={{ color: 'var(--danger)' }}>
          {totalLosses.toLocaleString()}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-card__label">Draws</div>
        <div className="stat-card__value" style={{ color: 'var(--draw)' }}>
          {totalDraws.toLocaleString()}
        </div>
      </div>
    </div>
  )
}
