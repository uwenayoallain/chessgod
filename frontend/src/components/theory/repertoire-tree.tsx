import type { RepertoireNode } from '@/hooks/use-repertoire'
import { useAppStore } from '@/store/app-store'
import { MarkButton } from './mark-button'

function RepertoireNodeView({
  color,
  node,
  username,
}: {
  color: 'white' | 'black'
  node: RepertoireNode
  username: string
}) {
  const pushPosition = useAppStore((state) => state.pushPosition)
  return (
    <div className="column">
      {node.move ? (
        <div className="move-row">
          <button
            className="move-row--button"
            onClick={() => pushPosition(node.fen, node.move?.san, node.move?.uci ?? undefined)}
            type="button"
          >
            <div className="workspace-list__title">
              <strong className="san">{node.move.san}</strong>
              {node.marked ? <span className="badge">marked</span> : null}
            </div>
            <div className="workspace-list__meta">
              <span>{node.game_count.toLocaleString()} games</span>
              <span>{Math.round(node.win_rate * 100)}% score</span>
            </div>
          </button>
          <MarkButton color={color} node={node} username={username} />
        </div>
      ) : null}
      {node.children.map((child) => (
        <div
          key={`${child.fen}:${child.move?.uci ?? 'root'}`}
          className={node.move ? 'tree-indent' : undefined}
        >
          <RepertoireNodeView color={color} node={child} username={username} />
        </div>
      ))}
    </div>
  )
}

export function RepertoireTree({
  color,
  root,
  username,
}: {
  color: 'white' | 'black'
  root: RepertoireNode
  username: string
}) {
  return <RepertoireNodeView color={color} node={root} username={username} />
}
