type StatsBarProps = {
  whiteWins: number
  draws: number
  blackWins: number
}

export function StatsBar({ whiteWins, draws, blackWins }: StatsBarProps) {
  const total = Math.max(whiteWins + draws + blackWins, 1)

  return (
    <div className="stats-bar">
      <div className="stats-bar__segment--win" style={{ width: `${(whiteWins / total) * 100}%` }} />
      <div className="stats-bar__segment--draw" style={{ width: `${(draws / total) * 100}%` }} />
      <div
        className="stats-bar__segment--loss"
        style={{ width: `${(blackWins / total) * 100}%` }}
      />
    </div>
  )
}
