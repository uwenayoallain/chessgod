import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MoveRow } from '@/components/tree/move-row'
import { StatsBar } from '@/components/tree/stats-bar'
import { useOpeningTree } from '@/hooks/use-opening-tree'
import { useAppStore } from '@/store/app-store'

export function MoveTreePanel() {
  const currentFen = useAppStore((state) => state.currentFen)
  const colorFilter = useAppStore((state) => state.colorFilter)
  const timeClassFilter = useAppStore((state) => state.timeClassFilter)
  const pushPosition = useAppStore((state) => state.pushPosition)
  const { data, isLoading, error } = useOpeningTree(currentFen, colorFilter, timeClassFilter)

  return (
    <Card>
      <CardHeader>
        <h2>Opening Tree</h2>
        <span className="muted">{data?.total_games ?? 0} games</span>
      </CardHeader>
      <CardBody className="column">
        {data && data.total_games > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <StatsBar whiteWins={data.white_wins} draws={data.draws} blackWins={data.black_wins} />
          </div>
        ) : null}
        
        {isLoading ? (
          <div className="column" style={{ gap: 12 }}>
            <Skeleton />
            <Skeleton width="88%" />
            <Skeleton width="72%" />
          </div>
        ) : null}

        {error ? (
          <div className="empty-state">
            <div className="empty-state__title">Tree Unavailable</div>
            <div className="empty-state__message">{error.message}</div>
          </div>
        ) : null}

        {!isLoading && !error && data?.moves?.length === 0 ? (
          <div className="empty-state" style={{ padding: '48px 16px' }}>
            <div className="empty-state__icon">♙</div>
            <div className="empty-state__title">End of Theory</div>
            <div className="empty-state__message">No games found from this position.</div>
          </div>
        ) : null}

        {data?.moves?.map((move) => (
          <MoveRow
            key={`${move.uci}-${move.resulting_fen}`}
            move={move}
            onSelect={(selected) => pushPosition(selected.resulting_fen, selected.san, selected.uci)}
          />
        ))}
      </CardBody>
    </Card>
  )
}
