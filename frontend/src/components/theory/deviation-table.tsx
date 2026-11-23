import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import { Table } from '@/components/ui/table'
import { useTheory, type TheoryComparison, type TheoryDeviation } from '@/hooks/use-theory'
import { BEST_MOVE_ARROW_COLOR, THREAT_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { sanToUci } from '@/lib/chess-utils'
import { STARTING_FEN, useAppStore } from '@/store/app-store'

function formatWinRate(rate: number | null | undefined) {
  if (rate == null) {
    return 'n/a'
  }
  return `${(rate * 100).toFixed(0)}%`
}

/**
 * Whether there are master games to compare against at all, read off the
 * starting position: the most played position there is, and the first one the
 * master sync fetches. An empty scan means "your moves match the masters" only
 * when this says `loaded`. With nothing fetched (no Lichess token, or a sync
 * that has not run) the scan is empty because it had nothing to compare with,
 * and saying the player matches the masters would be a claim about their chess
 * that nobody checked.
 */
export function masterGamesState(
  start: Pick<TheoryComparison, 'master_data_state' | 'master_moves'> | null | undefined,
): 'loaded' | 'unfetched' | 'unknown' {
  if (!start) return 'unknown'
  const hasGames =
    start.master_data_state === 'synced' && start.master_moves.some((move) => move.game_count > 0)
  return hasGames ? 'loaded' : 'unfetched'
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
  // Asked only when the scan came back empty, and through the Theory panel's
  // own cache entry for the starting position.
  const isEmpty = !isLoading && !error && !deviations.length
  const start = useTheory(STARTING_FEN, { enabled: isEmpty })
  const masterGames = masterGamesState(start.data)
  const checkingMasters = isEmpty && masterGames === 'unknown' && start.isLoading

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
        {isLoading || checkingMasters ? (
          <PanelSkeleton label="Loading your deviations" rows={6} />
        ) : null}
        {error && !deviations.length && !isLoading ? (
          <PanelError error={error} what="your deviations" />
        ) : null}
        {isEmpty && !checkingMasters ? (
          masterGames === 'loaded' ? (
            <EmptyState
              title="No deviations found"
              message="All your moves as this color match the masters. Try the other color."
            />
          ) : masterGames === 'unfetched' ? (
            <EmptyState
              title="No master games to compare with yet"
              message="Your moves have not been checked: the master games are not loaded. They are fetched from Lichess in the background."
            />
          ) : (
            <EmptyState
              title="No deviations listed"
              message="Could not confirm the master games are loaded, so your moves may not have been checked."
            />
          )
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
                  // One button a row. Three identical buttons made three tab
                  // stops and three announcements for one action; the row
                  // itself takes the click, and the button names the whole row.
                  <tr
                    className="deviation-table__row"
                    key={`${deviation.fen}-${deviation.move_number}`}
                    onClick={() => showDeviation(deviation)}
                  >
                    <td className="table__num">
                      <button
                        aria-label={`Show move ${deviation.move_number} on the board: you play ${deviation.user_top_move.san}, masters play ${deviation.master_top_move.san}`}
                        className="button button--ghost"
                        onClick={(event) => {
                          // The row hears the click too; once is enough.
                          event.stopPropagation()
                          showDeviation(deviation)
                        }}
                        type="button"
                      >
                        {deviation.move_number}
                      </button>
                    </td>
                    <td>
                      {deviation.user_top_move.san} ·{' '}
                      {formatWinRate(deviation.user_top_move.win_rate)}
                    </td>
                    <td>
                      {deviation.master_top_move.san} ·{' '}
                      {formatWinRate(deviation.master_top_move.win_rate)}
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
