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
          {/* Badge first, so the counts keep the right edge and line up down
              the list whether or not a row is a book move. */}
          <div className="toolbar" style={{ gap: 6 }}>
            {move.is_book_move ? <Badge>Book</Badge> : null}
            <span className="muted move-row__count">
              {move.game_count.toLocaleString()}
              <span className="faint" style={{ fontSize: 11, marginLeft: 3 }}>
                ({move.white_wins}W-{move.draws}D-{move.black_wins}L)
              </span>
            </span>
          </div>
        </div>
        <div style={{ marginTop: 6 }}>
          <StatsBar whiteWins={move.white_wins} draws={move.draws} blackWins={move.black_wins} />
        </div>
      </button>
    </div>
  )
}
