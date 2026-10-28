import type { FamilySummary } from '@/hooks/use-families'

export function variationRowClass(family: Pick<FamilySummary, 'is_main_line'>) {
  return `move-row move-row--button${family.is_main_line ? ' move-row--main-line' : ' muted'}`
}

export function VariationTree({
  families,
  onSelect,
}: {
  families: FamilySummary[]
  onSelect: (family: FamilySummary) => void
}) {
  if (!families.length) {
    return <div className="muted">No named variations from here.</div>
  }

  return (
    <div className="column" style={{ gap: 0 }}>
      {families.map((family) => (
        <button
          className={variationRowClass(family)}
          key={family.id}
          onClick={() => onSelect(family)}
          type="button"
        >
          <div className="workspace-list__title">
            <strong>{family.display_name}</strong>
            {family.eco ? <span className="badge">{family.eco}</span> : null}
          </div>
          <div className="workspace-list__meta">
            <span>
              {family.child_count} {family.child_count === 1 ? 'variation' : 'variations'}
            </span>
            <span>{family.user_game_count.toLocaleString()} games</span>
          </div>
        </button>
      ))}
    </div>
  )
}
