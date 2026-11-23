/**
 * Wins / draws / losses for the player, in that order. Distinct from
 * `StatsBar`, which reports how a position scores for White and Black and is
 * therefore coloured like the pieces rather than like a result.
 */
export function ResultBar({
  wins,
  draws,
  losses,
}: {
  wins: number
  draws: number
  losses: number
}) {
  const total = Math.max(wins + draws + losses, 1)
  const pct = (value: number) => `${(value / total) * 100}%`

  return (
    <div
      aria-label={`${wins} wins, ${draws} draws, ${losses} losses`}
      className="result-bar"
      role="img"
    >
      <span style={{ width: pct(wins), background: 'var(--success)' }} />
      <span style={{ width: pct(draws), background: 'var(--draw)' }} />
      <span style={{ width: pct(losses), background: 'var(--danger)' }} />
    </div>
  )
}
