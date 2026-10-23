import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import { Table } from '@/components/ui/table'
import type { TheoryDeviation } from '@/hooks/use-theory'
import { BEST_MOVE_ARROW_COLOR, THREAT_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { sanToUci } from '@/lib/chess-utils'
import { useAppStore } from '@/store/app-store'

function formatWinRate(rate: number | null | undefined) {
  if (rate == null) {
    return 'n/a'
  }
  return `${(rate * 100).toFixed(0)}%`
}

export function DeviationTable({
  deviations,
  error,
  isLoading,
  isRefreshing = false,
}: {
  deviations: TheoryDeviation[]
  error?: unknown
  isLoading: boolean
  isRefreshing?: boolean
}) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)

  // The row's whole point is the difference between two moves, so show both on
  // the board: yours in red, the masters' in best-move amber. The server sends
  // SANs; the UCIs replay from the FEN. Arrows are scoped to this position.
  function showDeviation(deviation: TheoryDeviation) {
    loadPosition(deviation.fen)
    // The deviation is the player's own move, so their side sits at the bottom.
    alignBoardToUserColor(deviation.fen.split(' ')[1] === 'b' ? 'black' : 'white')
    const yours = sanToUci(deviation.fen, deviation.user_top_move.san)
    const masters = sanToUci(deviation.fen, deviation.master_top_move.san)
    const arrows = []
    if (yours)
      arrows.push({
        startSquare: yours.slice(0, 2),
        endSquare: yours.slice(2, 4),
        color: THREAT_ARROW_COLOR,
      })
    if (masters)
      arrows.push({
        startSquare: masters.slice(0, 2),
        endSquare: masters.slice(2, 4),
        color: BEST_MOVE_ARROW_COLOR,
      })
    setTrainerArrows(arrows, deviation.fen)
  }

  return (
    <Card>
      {/* The section header already says "Theory deviations"; repeating it here
          left the panel titled twice in a row. */}
      <CardHeader>
        <span className="muted">
          {deviations.length
            ? `${deviations.length} ${deviations.length === 1 ? 'position' : 'positions'}`
            : ' '}
        </span>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
        </div>
      </CardHeader>
      {/* One fixed-height region for every state this panel can be in. The scan
          returns anywhere from nothing to a couple of hundred rows, so sizing to
          content moves everything below it each time the colour or filter
          changes — and a six-row skeleton growing into 150 table rows is the
          same shift by another name. */}
      <CardBody className="panel-region">
        {isLoading ? <PanelSkeleton label="Loading your deviations" rows={6} /> : null}
        {error && !deviations.length && !isLoading ? (
          <PanelError error={error} what="your deviations" />
        ) : null}
        {!isLoading && !error && !deviations.length ? (
          <EmptyState
            title="No deviations found"
            message="All your moves as this color match the masters. Try the other color."
          />
        ) : null}
        {!isLoading && deviations.length ? (
          <div className="table-scroll table-scroll--fill">
            <Table className="deviation-table">
              <thead>
                <tr>
                  <th>Move</th>
                  <th>Your move</th>
                  <th>Master move</th>
                  <th>Opening</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {deviations.map((deviation) => (
                  <tr key={`${deviation.fen}-${deviation.move_number}`}>
                    <td className="table__num">
                      <button
                        className="button button--ghost"
                        onClick={() => showDeviation(deviation)}
                        type="button"
                      >
                        {deviation.move_number}
                      </button>
                    </td>
                    <td>
                      <button
                        className="button button--ghost"
                        onClick={() => showDeviation(deviation)}
                        type="button"
                      >
                        {deviation.user_top_move.san} ·{' '}
                        {formatWinRate(deviation.user_top_move.win_rate)}
                      </button>
                    </td>
                    <td>
                      <button
                        className="button button--ghost"
                        onClick={() => showDeviation(deviation)}
                        type="button"
                      >
                        {deviation.master_top_move.san} ·{' '}
                        {formatWinRate(deviation.master_top_move.win_rate)}
                      </button>
                    </td>
                    <td
                      className="table__truncate"
                      title={deviation.opening_name ?? deviation.eco ?? undefined}
                    >
                      {/* No name is better than "Unknown" repeated down the table. */}
                      {deviation.opening_name ?? deviation.eco ?? ''}
                    </td>
                    <td className={`severity--${deviation.severity}`}>{deviation.severity}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
