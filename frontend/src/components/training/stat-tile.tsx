/**
 * One number with its label: the tile every training card uses. `change`
 * carries a better/worse judgement (coloured, and spoken to screen readers);
 * `note` is plain context.
 */
export function StatTile({
  label,
  value,
  change,
  note,
}: {
  label: string
  value: string
  change?: { text: string; good: boolean | null }
  note?: string
}) {
  return (
    <div className="progress-tile">
      <span className="muted progress-tile__label">{label}</span>
      <strong className="progress-tile__value">{value}</strong>
      {change ? (
        <span
          className="progress-tile__change"
          data-good={change.good == null ? undefined : String(change.good)}
        >
          {change.text}
          {change.good != null ? (
            <span className="sr-only-inline">{change.good ? ' better' : ' worse'}</span>
          ) : null}
        </span>
      ) : note ? (
        <span className="progress-tile__note">{note}</span>
      ) : null}
    </div>
  )
}
