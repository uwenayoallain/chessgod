import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import { MoveRow } from '@/components/tree/move-row'
import { StatsBar } from '@/components/tree/stats-bar'
import { useFamilyDetail } from '@/hooks/use-family-detail'
import type { FamilySummary } from '@/hooks/use-families'
import { useAppStore } from '@/store/app-store'
import { MistakeReview } from './mistake-review'
import { VariationTree } from './variation-tree'

export function FamilyDetail({
  color,
  familyId,
  onSelectFamily,
  timeClass,
  username,
}: {
  color: 'white' | 'black' | 'both'
  familyId: number | null
  onSelectFamily: (family: FamilySummary) => void
  timeClass: string | null
  username: string | null
}) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const detail = useFamilyDetail({ familyId, username, color, timeClass })

  if (!familyId) {
    return (
      <Card>
        <CardHeader>
          <h2>Opening</h2>
        </CardHeader>
        <CardBody>
          <EmptyState
            title="Nothing selected"
            message="Pick an opening to see its moves, games and mistakes."
          />
        </CardBody>
      </Card>
    )
  }

  if (detail.error && !detail.data) {
    return (
      <Card>
        <CardHeader>
          <h2>Opening</h2>
        </CardHeader>
        <CardBody>
          <PanelError error={detail.error} what="this opening" />
        </CardBody>
      </Card>
    )
  }

  if (detail.isLoading || !detail.data) {
    return (
      <Card>
        <CardHeader>
          <h2>Opening</h2>
        </CardHeader>
        <CardBody>
          <PanelSkeleton label="Loading this opening" rows={6} />
        </CardBody>
      </Card>
    )
  }

  const { family, ancestors, children, position_tree: tree, top_mistakes } = detail.data

  return (
    <div className="theory-stack">
      <Card>
        <CardHeader>
          <h2>{family.display_name}</h2>
          <div className="panel-header__meta">
            {detail.isRefreshing ? <span className="refresh-badge">Updating</span> : null}
            <span className="muted">{ancestors.map((item) => item.display_name).join(' / ')}</span>
          </div>
        </CardHeader>
        <CardBody className="column">
          <button
            className="move-row move-row--button"
            onClick={() => loadPosition(family.root_fen)}
            type="button"
          >
            <div className="workspace-list__title">
              <strong>Show this opening on the board</strong>
              {family.eco ? <span className="badge">{family.eco}</span> : null}
            </div>
            <div className="workspace-list__meta">
              <span>{family.user_game_count.toLocaleString()} games</span>
              <span>{Math.round(family.user_win_rate * 100)}% score</span>
            </div>
          </button>
          <VariationTree families={children} onSelect={onSelectFamily} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2>Your moves from here</h2>
          <span className="muted">{tree.total_games.toLocaleString()} games</span>
        </CardHeader>
        <CardBody className="column">
          {tree.total_games > 0 ? (
            <StatsBar whiteWins={tree.white_wins} draws={tree.draws} blackWins={tree.black_wins} />
          ) : null}
          {tree.moves.map((move) => (
            <MoveRow
              key={`${move.uci}-${move.resulting_fen}`}
              move={move}
              onSelect={(selected) => loadPosition(selected.resulting_fen, selected.uci)}
            />
          ))}
          {!tree.moves.length ? (
            <div className="muted">None of your games go on from this position.</div>
          ) : null}
        </CardBody>
      </Card>

      <MistakeReview
        isRefreshing={detail.isRefreshing}
        mistakes={top_mistakes}
        emptyHint="No analyzed mistakes in this opening yet."
      />
    </div>
  )
}
