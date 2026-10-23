import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { MoveRow } from '@/components/tree/move-row'
import { StatsBar } from '@/components/tree/stats-bar'
import { useOpeningTree } from '@/hooks/use-opening-tree'
import { useAppStore } from '@/store/app-store'

export function MoveTreePanel() {
  const currentFen = useAppStore((state) => state.currentFen)
  const colorFilter = useAppStore((state) => state.colorFilter)
  const timeClassFilter = useAppStore((state) => state.timeClassFilter)
  const pushPosition = useAppStore((state) => state.pushPosition)
  const { data, isLoading, isRefreshing, error } = useOpeningTree(
    currentFen,
    colorFilter,
    timeClassFilter,
  )

  return (
    <Card>
      <CardHeader>
        <h2>Your games from here</h2>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <span className="muted">{(data?.total_games ?? 0).toLocaleString()} games</span>
        </div>
      </CardHeader>
      <CardBody className="column">
        {data && data.total_games > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <StatsBar whiteWins={data.white_wins} draws={data.draws} blackWins={data.black_wins} />
          </div>
        ) : null}

        {/* Sized like the move list it becomes: three short bars stood in for
            what turns into a dozen rows, and everything below jumped. */}
        {isLoading ? (
          <PanelSkeleton label="Loading moves from this position" rowHeight={56} rows={8} />
        ) : null}

        {error ? <PanelError error={error} what="your games from this position" /> : null}

        {!isLoading && !error && data?.moves?.length === 0 ? (
          <EmptyState
            title="No games from this position"
            message="You have not reached this position before."
          />
        ) : null}

        {data?.moves?.map((move) => (
          <MoveRow
            key={`${move.uci}-${move.resulting_fen}`}
            move={move}
            onSelect={(selected) =>
              pushPosition(selected.resulting_fen, selected.san, selected.uci)
            }
          />
        ))}
      </CardBody>
    </Card>
  )
}
