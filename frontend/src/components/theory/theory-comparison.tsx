import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EcoBadge } from '@/components/theory/eco-badge'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import type { TheoryComparison as TheoryComparisonData, TheoryMove } from '@/hooks/use-theory'

/** Rows the list reserves space for, whatever it ends up holding. */
const RESERVED_ROWS = 5
const ROW_HEIGHT = 44

function formatPercent(value: number | null) {
  if (value == null) return 'n/a'
  return `${Math.round(value * 100)}%`
}

function formatGames(value: number) {
  const formatted = new Intl.NumberFormat(undefined, {
    compactDisplay: 'short',
    maximumFractionDigits: 0,
    notation: value >= 10_000 ? 'compact' : 'standard',
  })
    .format(value)
    .replace('K', 'k')
  return `${formatted} ${value === 1 ? 'game' : 'games'}`
}

function sourceLabel(state?: TheoryComparisonData['master_data_state']) {
  if (state === 'synced') return 'Lichess masters'
  if (state === 'seeded') return 'Built-in book'
  return 'No master data yet'
}

function MoveStatRow({ move, share }: { move: TheoryMove; share?: number | null }) {
  return (
    <div className="move-row move-row--stacked">
      <div className="workspace-list__title">
        <strong>{move.san}</strong>
        <span className="mono">{formatPercent(move.win_rate)}</span>
      </div>
      <div className="workspace-list__meta">
        <span>{formatGames(move.game_count)}</span>
        {/* The share of the book this move is, which is what "theory" means
            here — a move played in 2% of master games is not the main line. */}
        {share != null ? (
          <span className="mono">{formatPercent(share)} of master games</span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One column of moves, always the same height.
 *
 * The list can hold nothing, three moves or twenty — the API returns up to
 * twenty — so letting it size to its content means the panel resizes under the
 * reader every time the board moves. Reserving the height and scrolling inside
 * keeps everything below it still; see the CLS notes in CLAUDE.md.
 */
function MoveColumn({
  title,
  moves,
  isLoading,
  emptyLabel,
  loadingLabel,
  shares,
}: {
  title: string
  moves: TheoryMove[] | undefined
  isLoading: boolean
  emptyLabel: string
  loadingLabel: string
  shares?: boolean
}) {
  const total = shares ? (moves ?? []).reduce((sum, move) => sum + (move.game_count || 0), 0) : 0

  return (
    <div className="column">
      <div className="section-subtitle">{title}</div>
      <div
        className="theory-move-list"
        style={{
          ['--theory-rows' as string]: RESERVED_ROWS,
          ['--theory-row-h' as string]: `${ROW_HEIGHT}px`,
        }}
      >
        {isLoading ? (
          <PanelSkeleton label={loadingLabel} rowHeight={ROW_HEIGHT} rows={RESERVED_ROWS} />
        ) : null}
        {!isLoading && !moves?.length ? <div className="empty-state">{emptyLabel}</div> : null}
        {!isLoading
          ? moves?.map((move) => (
              <MoveStatRow
                key={`${title}-${move.san}`}
                move={move}
                share={shares && total > 0 ? move.game_count / total : null}
              />
            ))
          : null}
      </div>
    </div>
  )
}

export function TheoryComparison({
  data,
  isRefreshing = false,
}: {
  data: TheoryComparisonData | null
  isRefreshing?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <h2>You against the book</h2>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <EcoBadge eco={data?.eco} name={data?.opening_name} />
          <span className="badge">{sourceLabel(data?.master_data_state)}</span>
        </div>
      </CardHeader>
      <CardBody className="split">
        <MoveColumn
          emptyLabel="You have no games from this position."
          isLoading={!data}
          loadingLabel="Loading your moves"
          moves={data?.user_moves}
          title="Your moves"
        />
        <MoveColumn
          emptyLabel="Masters have no games from this position."
          isLoading={!data}
          loadingLabel="Loading master moves"
          moves={data?.master_moves}
          shares
          title="Master moves"
        />
      </CardBody>
    </Card>
  )
}
