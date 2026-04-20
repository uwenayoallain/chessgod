import { useMemo } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { useAppStore, type MoveNode } from '@/store/app-store'

function MoveButton({
  node,
  isActive,
  annotation,
  onClick,
}: {
  node: MoveNode
  isActive: boolean
  annotation?: { label: string | null; cpLoss: number | null; bestMove: string | null }
  onClick: () => void
}) {
  return (
    <button
      className={`move-btn${isActive ? ' move-btn--active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {node.ply % 2 === 1 ? <span className="move-btn__num">{Math.ceil(node.ply / 2)}.</span> : null}
      <span className="move-btn__san">{node.san}</span>
      {annotation?.label ? (
        <span className="move-annotation" title={annotationTitle(annotation.label)}>
          <AnnotationIcon label={annotation.label} size={14} />
        </span>
      ) : null}
    </button>
  )
}

function VariationLine({
  nodes,
  startNodeId,
  allNodes,
  currentNodeId,
  mainLine,
  annotationMap,
  jumpToNode,
  depth,
}: {
  nodes: Record<string, MoveNode>
  startNodeId: string
  allNodes: Record<string, MoveNode>
  currentNodeId: string
  mainLine: string[]
  annotationMap: Map<string, { label: string | null; cpLoss: number | null; bestMove: string | null }>
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
        annotation={annotationMap.get(node.id)}
        isActive={node.id === currentNodeId}
        node={node}
        onClick={() => jumpToNode(node.id)}
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
              mainLine={mainLine}
              nodes={nodes}
              startNodeId={sideId}
            />
          </div>,
        )
      }
    }

    nodeId = node.children[0] ?? null
  }

  return <div className={`move-tree__line${depth > 0 ? ' move-tree__line--nested' : ''}`}>{elements}</div>
}

export function MoveList({ showHeader = true }: { showHeader?: boolean }) {
  const nodes = useAppStore((state) => state.nodes)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const mainLine = useAppStore((state) => state.mainLine)
  const jumpToNode = useAppStore((state) => state.jumpToNode)
  const { nodeIds: activeLineNodeIds } = useActiveReplayLine()
  const annotations = useMoveAnnotations()

  const annotationMap = useMemo(() => {
    const map = new Map<string, { label: string | null; cpLoss: number | null; bestMove: string | null }>()
    for (let i = 0; i < annotations.length; i++) {
      const nodeId = activeLineNodeIds[i]
      const a = annotations[i]
      if (nodeId && a) {
        map.set(nodeId, { label: a.label, cpLoss: a.cpLoss, bestMove: a.bestMove })
      }
    }
    return map
  }, [activeLineNodeIds, annotations])

  const rootNode = nodes['root']
  const hasAnyMoves = rootNode && rootNode.children.length > 0

  const content = (
    <>
      {!hasAnyMoves ? <div className="muted">Play a move or load a game/opening line.</div> : null}
      {hasAnyMoves ? (
        <VariationLine
          allNodes={nodes}
          annotationMap={annotationMap}
          currentNodeId={currentNodeId}
          depth={0}
          jumpToNode={jumpToNode}
          mainLine={mainLine}
          nodes={nodes}
          startNodeId={rootNode.children[0]}
        />
      ) : null}
      {rootNode && rootNode.children.length > 1 ? (
        rootNode.children.slice(1).map((sideId) => (
          <div className="move-tree__branch" key={`root-branch-${sideId}`}>
            <VariationLine
              allNodes={nodes}
              annotationMap={annotationMap}
              currentNodeId={currentNodeId}
              depth={1}
              jumpToNode={jumpToNode}
              mainLine={mainLine}
              nodes={nodes}
              startNodeId={sideId}
            />
          </div>
        ))
      ) : null}
    </>
  )

  if (!showHeader) {
    return <div className="column">{content}</div>
  }

  return (
    <Card>
      <CardHeader>
        <h2>Move History</h2>
      </CardHeader>
      <CardBody>{content}</CardBody>
    </Card>
  )
}
