import { Badge } from '@/components/ui/badge'
import { StatsBar } from '@/components/tree/stats-bar'
import type { TreeMove } from '@/hooks/use-opening-tree'

type MoveRowProps = {
  move: TreeMove
  onSelect: (move: TreeMove) => void
}

export function MoveRow({ move, onSelect }: MoveRowProps) {
  return (
    <div className="move-row">
      <button onClick={() => onSelect(move)} type="button">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <strong className="san">{move.san}</strong>
          <div className="toolbar" style={{ gap: 6 }}>
            <span className="muted">
              {move.game_count.toLocaleString()}
              <span className="faint" style={{ fontSize: 11, marginLeft: 3 }}>
                ({move.white_wins}W-{move.draws}D-{move.black_wins}L)
              </span>
            </span>
            {move.is_book_move ? <Badge>Book</Badge> : null}
          </div>
        </div>
        <div style={{ marginTop: 6 }}>
          <StatsBar whiteWins={move.white_wins} draws={move.draws} blackWins={move.black_wins} />
        </div>
      </button>
    </div>
  )
}
