import { memo, useEffect, useMemo, useRef } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { useAppStore, type MoveNode } from '@/store/app-store'
import { useIsSparring } from '@/store/spar-store'

/**
 * Memoised on plain values: stepping through a game used to re-render every
 * move button (170 in a long game) on every step; now only the two whose
 * highlight changes do.
 */
const MoveButton = memo(function MoveButton({
  nodeId,
  ply,
  san,
  isActive,
  label,
  onJump,
}: {
  nodeId: string
  ply: number
  san: string | null
  isActive: boolean
  label: string | null
  onJump: (nodeId: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)

  // Stepping through a long game must not leave the move you are on off-screen.
  useEffect(() => {
    if (!isActive) return
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [isActive])

  return (
    <button
      className={`move-btn${isActive ? ' move-btn--active' : ''}`}
      onClick={() => onJump(nodeId)}
      ref={ref}
      type="button"
    >
      {ply % 2 === 1 ? <span className="move-btn__num">{Math.ceil(ply / 2)}.</span> : null}
      <span className="move-btn__san">{san}</span>
      {/* The slot is always there, so a grade arriving moves nothing. */}
      <span className="move-annotation" title={label ? annotationTitle(label) : undefined}>
        {label ? <AnnotationIcon label={label} size={14} /> : null}
      </span>
    </button>
  )
})

function VariationLine({
  startNodeId,
  allNodes,
  currentNodeId,
  annotationMap,
  jumpToNode,
  depth,
}: {
  startNodeId: string
  allNodes: Record<string, MoveNode>
  currentNodeId: string
  annotationMap: Map<
    string,
    { label: string | null; cpLoss: number | null; bestMove: string | null }
  >
  jumpToNode: (id: string) => void
  depth: number
}) {
  const elements: React.ReactNode[] = []
  let nodeId: string | null = startNodeId

  while (nodeId) {
    const node: MoveNode | undefined = allNodes[nodeId]
    if (!node || !node.san) break

    elements.push(
      <MoveButton
        key={node.id}
        isActive={node.id === currentNodeId}
        label={annotationMap.get(node.id)?.label ?? null}
        nodeId={node.id}
        onJump={jumpToNode}
        ply={node.ply}
        san={node.san}
      />,
    )

    if (node.children.length > 1) {
      const sidelines = node.children.slice(1)
      for (const sideId of sidelines) {
        elements.push(
          <div className="move-tree__branch" key={`branch-${sideId}`}>
            <VariationLine
              allNodes={allNodes}
              annotationMap={annotationMap}
              currentNodeId={currentNodeId}
              depth={depth + 1}
              jumpToNode={jumpToNode}
              startNodeId={sideId}
            />
          </div>,
        )
      }
    }

    nodeId = node.children[0] ?? null
  }

  return (
    <div className={`move-tree__line${depth > 0 ? ' move-tree__line--nested' : ''}`}>
      {elements}
    </div>
  )
}

export function MoveList({ showHeader = true }: { showHeader?: boolean }) {
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const jumpToNode = useAppStore((state) => state.jumpToNode)
  const { nodeIds: activeLineNodeIds } = useActiveReplayLine()
  const annotations = useMoveAnnotations()
  const drillSolving = useAppStore((state) => state.drillSolving)
  const sparring = useIsSparring()

  const annotationMap = useMemo(() => {
    const map = new Map<
      string,
      { label: string | null; cpLoss: number | null; bestMove: string | null }
    >()
    // Grading moves mid-game tells the player which of their moves failed.
    if (sparring) return map
    for (let i = 0; i < annotations.length; i++) {
      const nodeId = activeLineNodeIds[i]
      const a = annotations[i]
      if (nodeId && a) {
        map.set(nodeId, { label: a.label, cpLoss: a.cpLoss, bestMove: a.bestMove })
      }
    }
    return map
  }, [activeLineNodeIds, annotations, sparring])

  const rootNode = nodes['root']
  const hasAnyMoves = rootNode && rootNode.children.length > 0

  const content = (
    <>
      {!hasAnyMoves ? (
        <div className="rail-empty">
          {drillSolving ? (
            <>
              <strong>Your turn</strong>
              <span>Play the move you would choose in a game.</span>
            </>
          ) : (
            <>
              <strong>No moves yet</strong>
              <span>Play a move, or load a game.</span>
            </>
          )}
        </div>
      ) : null}
      {hasAnyMoves ? (
        <VariationLine
          allNodes={nodes}
          annotationMap={annotationMap}
          currentNodeId={currentNodeId}
          depth={0}
          jumpToNode={jumpToNode}
          startNodeId={rootNode.children[0]}
        />
      ) : null}
      {rootNode && rootNode.children.length > 1
        ? rootNode.children.slice(1).map((sideId) => (
            <div className="move-tree__branch" key={`root-branch-${sideId}`}>
              <VariationLine
                allNodes={nodes}
                annotationMap={annotationMap}
                currentNodeId={currentNodeId}
                depth={1}
                jumpToNode={jumpToNode}
                startNodeId={sideId}
              />
            </div>
          ))
        : null}
    </>
  )

  if (!showHeader) {
    return <div className="column">{content}</div>
  }

  return (
    <Card>
      <CardHeader>
        <h2>Moves</h2>
      </CardHeader>
      <CardBody>{content}</CardBody>
    </Card>
  )
}
