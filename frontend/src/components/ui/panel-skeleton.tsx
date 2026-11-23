/**
 * A placeholder shaped like the content that will replace it.
 *
 * The point is height, not decoration: a panel that loads as a single "Loading…"
 * line and then expands to its real size shoves everything below it down the
 * page. Standing in at roughly the right size means the content settles into
 * space that was already reserved.
 */
export function PanelSkeleton({
  rows = 4,
  rowHeight = 40,
  label = 'Loading',
}: {
  rows?: number
  rowHeight?: number
  label?: string
}) {
  return (
    <div aria-busy="true" aria-label={label} className="panel-skeleton" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span className="skeleton panel-skeleton__row" key={i} style={{ height: rowHeight }} />
      ))}
    </div>
  )
}
