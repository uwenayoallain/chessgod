import { memo, useCallback, useState } from 'react'
import { Bookmark } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { RepertoireNode } from '@/hooks/use-repertoire'
import { useRepertoireMark } from '@/hooks/use-repertoire'
import { useAppStore } from '@/store/app-store'

const NO_PENDING: ReadonlySet<string> = new Set()

/** Names a node for React and for the pending set: the position plus the move into it. */
function nodeKey(node: RepertoireNode) {
  return `${node.fen}:${node.move?.uci ?? 'root'}`
}

/**
 * A node holds no hooks of its own. A full repertoire is hundreds of nodes, and
 * a mutation observer plus a store subscription in each one meant hundreds of
 * both; the tree owns the single mutation and hands every node the same two
 * callbacks instead.
 */
const RepertoireNodeView = memo(function RepertoireNodeView({
  node,
  onShow,
  onToggleMark,
  pendingKeys,
}: {
  node: RepertoireNode
  onShow: (node: RepertoireNode) => void
  onToggleMark: (node: RepertoireNode) => void
  pendingKeys: ReadonlySet<string>
}) {
  const move = node.move
  const markLabel = move
    ? node.marked
      ? `Remove ${move.san} from your repertoire`
      : `Add ${move.san} to your repertoire`
    : ''
  return (
    <div className="column">
      {move ? (
        <div className="move-row">
          <button className="move-row--button" onClick={() => onShow(node)} type="button">
            <div className="workspace-list__title">
              <strong className="san">{move.san}</strong>
              {node.marked ? <span className="badge">marked</span> : null}
            </div>
            <div className="workspace-list__meta">
              <span>{node.game_count.toLocaleString()} games</span>
              <span>{Math.round(node.win_rate * 100)}% score</span>
            </div>
          </button>
          {move.uci ? (
            <Button
              aria-label={markLabel}
              aria-pressed={node.marked}
              disabled={pendingKeys.has(nodeKey(node))}
              onClick={() => onToggleMark(node)}
              title={markLabel}
              type="button"
              variant={node.marked ? 'primary' : 'ghost'}
            >
              <Bookmark size={14} />
            </Button>
          ) : null}
        </div>
      ) : null}
      {node.children.map((child) => (
        <div key={nodeKey(child)} className={move ? 'tree-indent' : undefined}>
          <RepertoireNodeView
            node={child}
            onShow={onShow}
            onToggleMark={onToggleMark}
            pendingKeys={pendingKeys}
          />
        </div>
      ))}
    </div>
  )
})

export function RepertoireTree({
  color,
  root,
  username,
}: {
  color: 'white' | 'black'
  root: RepertoireNode
  username: string
}) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const { mutateAsync } = useRepertoireMark()
  // A set, not one key: the mutation's own `isPending` follows only its latest
  // call, so marking a second move while the first request is still out would
  // re-enable the first button mid-flight.
  const [pendingKeys, setPendingKeys] = useState(NO_PENDING)

  const showNode = useCallback(
    (node: RepertoireNode) => loadPosition(node.fen, node.move?.uci ?? null),
    [loadPosition],
  )

  const toggleMark = useCallback(
    (node: RepertoireNode) => {
      const uci = node.move?.uci
      if (!node.move || !uci) return
      const key = nodeKey(node)
      setPendingKeys((current) => new Set(current).add(key))
      mutateAsync({
        username,
        fen: node.fen,
        color,
        intended_move_uci: uci,
        intended_move_san: node.move.san,
        remove: node.marked,
      })
        // The button coming back unpressed is the report of a failed mark.
        .catch(() => undefined)
        .finally(() => {
          setPendingKeys((current) => {
            const next = new Set(current)
            next.delete(key)
            return next.size ? next : NO_PENDING
          })
        })
    },
    [color, mutateAsync, username],
  )

  return (
    <RepertoireNodeView
      node={root}
      onShow={showNode}
      onToggleMark={toggleMark}
      pendingKeys={pendingKeys}
    />
  )
}
