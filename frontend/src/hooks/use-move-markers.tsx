import { useCallback, useMemo, type CSSProperties } from 'react'

import { AnnotationIcon, annotationTitle } from '@/components/ui/annotation-icon'
import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { annotateLine } from '@/hooks/use-move-annotations'
import type { ActiveReplayLine } from '@/lib/analysis/active-line'
import { buildGuidanceArrows, type BoardArrow } from '@/lib/analysis/board-guidance'
import { buildBookMarkers, bookMarkerTitle } from '@/lib/analysis/book-markers'
import { buildReplayMoveAnnotations } from '@/lib/analysis/replay-annotations'
import { useTheory } from '@/hooks/use-theory'
import { useAppStore, type MoveNode } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { useIsSparring } from '@/store/spar-store'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'

type AnalysisByFen = ReturnType<typeof useEngineStore.getState>['analysisByFen']
type MoveLabel = ReplayMoveAnnotation['label']

function uciToSquare(uci: string): string {
  return uci.slice(2, 4)
}

function sameBoard(a: string, b: string): boolean {
  return a.split(' ', 4).join(' ') === b.split(' ', 4).join(' ')
}

/**
 * A marked square: a ring inside the square's edge over a light tint of the
 * same colour, both under the piece. The tint is a gradient on its own layer,
 * so the square's own colour and any last-move highlight still show through.
 */
function highlightStyle(color: string): CSSProperties {
  const tint = `color-mix(in srgb, ${color} 30%, transparent)`
  return {
    position: 'absolute',
    inset: 0,
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
    boxShadow: `inset 0 0 0 4px ${color}`,
    pointerEvents: 'none',
  }
}

/**
 * What the voice is naming right now: a bright ring with a soft inner glow
 * over a light tint, on its own layer above any trainer mark, so the author's
 * squares still show through it and come back the moment she moves on.
 */
function speechStyle(color: string): CSSProperties {
  const tint = `color-mix(in srgb, ${color} 26%, transparent)`
  const glow = `color-mix(in srgb, ${color} 55%, transparent)`
  return {
    position: 'absolute',
    inset: 0,
    backgroundImage: `radial-gradient(circle, ${tint} 35%, transparent 100%), linear-gradient(${tint}, ${tint})`,
    boxShadow: `inset 0 0 0 3px ${color}, inset 0 0 14px 4px ${glow}`,
    pointerEvents: 'none',
  }
}

/**
 * Speech arrows first, then the rest, each from-to drawn once. What the voice
 * is saying wins a square pair over any arrow already pointing the same way.
 */
export function mergeSpeechArrows(speech: BoardArrow[], others: BoardArrow[]): BoardArrow[] {
  if (!speech.length) return others
  const seen = new Set<string>()
  const merged: BoardArrow[] = []
  for (const arrow of [...speech, ...others]) {
    const key = `${arrow.startSquare}-${arrow.endSquare}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(arrow)
  }
  return merged
}

/**
 * The grade of the move that produced the position on the board. It is read
 * off the grading of the line leading here, which the move list asks for too
 * and which is graded once for both (`annotateLine`). Only when that leaves
 * the move unlabelled is it judged on its own, from its parent position.
 */
export function currentMoveLabel({
  analysisByFen,
  bookPlies,
  hasLoadedLine,
  line,
  node,
  parentFen,
}: {
  analysisByFen: AnalysisByFen
  bookPlies: number[]
  hasLoadedLine: boolean
  line: Pick<ActiveReplayLine, 'fenHistory' | 'nodeIds' | 'replayMoves'>
  node: MoveNode | undefined
  parentFen: string | null
}): MoveLabel {
  if (!node?.uci || !node.san) return null

  const last = line.nodeIds.length - 1
  const index = line.nodeIds[last] === node.id ? last : line.nodeIds.indexOf(node.id)
  if (index >= 0) {
    const onLine = annotateLine({ analysisByFen, bookPlies, hasLoadedLine, line })[index]?.label
    if (onLine) return onLine
  }

  if (!parentFen) return null
  const [alone] = buildReplayMoveAnnotations({
    analysisByFen,
    bookPlies: new Set(bookPlies),
    fenHistory: [parentFen, node.fen],
    implicitBookPlyLimit: hasLoadedLine ? 12 : 0,
    replayMoves: [{ ply: node.ply, san: node.san, uci: node.uci, fen: node.fen }],
  })
  return alone?.label ?? null
}

/**
 * Subscribes the board to one string. A review finishes several positions a
 * second and each one used to hand the board a fresh annotation object, which
 * rebuilt the square renderer and redrew all 64 squares; a label only changes
 * when this move's grade does. The selector also remembers the evaluations it
 * last read, so engine updates that touch no evaluation cost a comparison.
 */
function useCurrentMoveLabel(): MoveLabel {
  const line = useActiveReplayLine()
  const node = useAppStore((state) => state.nodes[state.currentNodeId])
  const parentFen = useAppStore((state) => {
    const current = state.nodes[state.currentNodeId]
    return current?.parentId ? (state.nodes[current.parentId]?.fen ?? null) : null
  })
  const bookPlies = useAppStore((state) => state.bookPlies)
  const hasLoadedLine = useAppStore((state) => state.hasLoadedLine)

  const select = useMemo(() => {
    let readFrom: AnalysisByFen | null = null
    let label: MoveLabel = null
    return (state: { analysisByFen: AnalysisByFen }) => {
      if (state.analysisByFen !== readFrom) {
        readFrom = state.analysisByFen
        label = currentMoveLabel({
          analysisByFen: state.analysisByFen,
          bookPlies,
          hasLoadedLine,
          line,
          node,
          parentFen,
        })
      }
      return label
    }
  }, [bookPlies, hasLoadedLine, line, node, parentFen])

  return useEngineStore(select)
}

/**
 * react-chessboard only applies its own `squareStyles` on the fallback square
 * it renders itself; supplying a `squareRenderer` silently drops them. Since
 * this board always supplies one (for classification badges), the highlight
 * styles have to be merged in here or last-move, selection and legal-move
 * markers never paint.
 */
export function useMoveMarkers(
  showAnnotations: boolean = true,
  squareStyles: Record<string, CSSProperties> = {},
) {
  const label = useCurrentMoveLabel()
  const lastUci = useAppStore((state) => state.nodes[state.currentNodeId]?.uci ?? null)

  const currentFen = useAppStore((state) => state.currentFen)
  const isSolvingDrill = useAppStore((state) => state.drillSolving)
  const trainerArrows = useAppStore((state) => state.trainerArrows)
  const trainerArrowsFen = useAppStore((state) => state.trainerArrowsFen)
  const trainerHighlights = useAppStore((state) => state.trainerHighlights)
  const trainerHighlightsFen = useAppStore((state) => state.trainerHighlightsFen)
  const hintSquare = useAppStore((state) => state.hintSquare)
  const speechHighlights = useAppStore((state) => state.speechHighlights)
  const speechArrows = useAppStore((state) => state.speechArrows)
  const hintSquareFen = useAppStore((state) => state.hintSquareFen)
  // The hint's ring shows on the question's board alone.
  const hintOn =
    hintSquare != null && (hintSquareFen == null || sameBoard(hintSquareFen, currentFen))
      ? hintSquare
      : null
  const sparring = useIsSparring()
  // One string, for this position only. The evaluations object is replaced on
  // every position a review finishes; subscribing to that (or to its version
  // counter) recomputed the arrows, and with them the whole board, each time.
  const bestMove = useEngineStore(
    (state) =>
      state.analysisByFen[currentFen]?.bestMove ??
      (state.analyzedFen === currentFen ? state.bestMove : null),
  )

  // Shares TanStack Query's cache with the Theory panel, so marking the board
  // costs no extra request. Skip fetching during drills, sparring, or when
  // annotations are hidden.
  const { data: theory } = useTheory(currentFen, {
    enabled: showAnnotations && !isSolvingDrill && !sparring,
  })

  const bookMarkers = useMemo(() => {
    // A book move is an answer to the question a drill is asking, and a hint
    // in a game against the engine. Not fetching is not enough for the game:
    // a disabled query still hands back what is cached, and the opponent's own
    // book lookup fills this very cache for the position on the board.
    if (isSolvingDrill || sparring || !showAnnotations) return {}
    return buildBookMarkers({ masterMoves: theory?.master_moves, fen: currentFen })
  }, [theory, currentFen, isSolvingDrill, sparring, showAnnotations])

  // A trainer's marked squares, on the board they were drawn for alone.
  const highlightsBySquare = useMemo(() => {
    const map = new Map<string, string>()
    if (!trainerHighlights.length) return map
    if (trainerHighlightsFen != null && !sameBoard(trainerHighlightsFen, currentFen)) return map
    for (const mark of trainerHighlights) map.set(mark.square, mark.color)
    return map
  }, [currentFen, trainerHighlights, trainerHighlightsFen])

  // What the voice names, lit whatever else is on: lessons are solved with
  // `drillSolving` set, and the narration is the lesson, not a hint.
  const spokenBySquare = useMemo(() => {
    const map = new Map<string, string>()
    for (const mark of speechHighlights) map.set(mark.square, mark.color)
    return map
  }, [speechHighlights])

  const markersBySquare = useMemo(() => {
    const map = new Map<string, NonNullable<MoveLabel>>()
    if (showAnnotations && label && lastUci) {
      map.set(uciToSquare(lastUci), label)
    }
    return map
  }, [label, lastUci, showAnnotations])

  const baseArrows: BoardArrow[] = useMemo(() => {
    // A trainer's own arrows are the lesson; nothing else may compete with them.
    // Arrows scoped to a position apply there alone: the moment the board moves
    // on, they are gone rather than pointing at squares of another game.
    const arrowsApply = trainerArrowsFen == null || sameBoard(trainerArrowsFen, currentFen)
    if (trainerArrows.length && arrowsApply) return trainerArrows
    // The engine's best move and the opponent's hanging-piece threat are both
    // answers to the question a drill is asking, so neither is drawn while
    // solving, nor during a game against the engine, where every move is one.
    if (isSolvingDrill || sparring) return []

    return buildGuidanceArrows({ bestMove, fen: currentFen })
  }, [bestMove, currentFen, isSolvingDrill, sparring, trainerArrows, trainerArrowsFen])

  // The voice's arrows join whatever is drawn, drill or not, as she says them.
  const customArrows = useMemo(
    () => mergeSpeechArrows(speechArrows, baseArrows),
    [baseArrows, speechArrows],
  )

  const squareRenderer = useCallback(
    ({ square, children }: { piece: unknown; square: string; children?: React.ReactNode }) => {
      const label = markersBySquare.get(square)
      const book = bookMarkers[square]
      const marked = highlightsBySquare.get(square)
      const spoken = spokenBySquare.get(square)

      return (
        <div
          style={{ position: 'relative', width: '100%', height: '100%', ...squareStyles[square] }}
        >
          {hintOn === square ? (
            // The whole square lit, under the piece: the mark chess sites use
            // for "look here". A ring was mostly hidden by the piece on it.
            <div aria-hidden="true" className="board-hint-square" />
          ) : null}
          {marked ? (
            <div aria-hidden="true" data-marked={square} style={highlightStyle(marked)} />
          ) : null}
          {spoken ? (
            <div aria-hidden="true" data-spoken={square} style={speechStyle(spoken)} />
          ) : null}
          {children}
          {label ? (
            <div className="board-move-marker" title={annotationTitle(label)}>
              <AnnotationIcon fluid label={label} />
            </div>
          ) : null}
          {book ? (
            // Bottom-left, because the classification badge owns the top-right
            // corner and the two must never sit on top of each other.
            <div
              className={`board-book-marker board-book-marker--${book.rank}`}
              title={bookMarkerTitle(book)}
            >
              {book.share >= 0.05 ? `${Math.round(book.share * 100)}%` : '·'}
            </div>
          ) : null}
        </div>
      )
    },
    [markersBySquare, bookMarkers, squareStyles, hintOn, highlightsBySquare, spokenBySquare],
  )

  return {
    squareRenderer,
    hasMarkers: markersBySquare.size > 0,
    bookMarkerCount: Object.keys(bookMarkers).length,
    customArrows,
  }
}
