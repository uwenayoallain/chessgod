import { memo, useMemo } from 'react'

import { getAnnotationAppearance } from '@/components/ui/annotation-icon'
import {
  buildAreaPath,
  buildLinePath,
  EVAL_CLAMP_CP,
  layoutEvalPoints,
  xForIndex,
} from '@/lib/analysis/eval-graph'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

const WIDTH = 1000
const HEIGHT = 200
const MARKED: ReadonlySet<string> = new Set(['Blunder', 'Mistake', 'Brilliant'])

function cpFor(
  fen: string,
  analysisByFen: ReturnType<typeof useEngineStore.getState>['analysisByFen'],
) {
  const top = analysisByFen[fen]?.lines?.find((line) => line.multipv === 1)
  if (!top) return null
  const white = scoreToWhitePerspective(top.score, fen)
  return white.type === 'mate' ? Math.sign(white.value || 1) * EVAL_CLAMP_CP : white.value
}

/**
 * The shape of the game: White's advantage over time, with the moves that
 * changed it marked. Clicking anywhere jumps the board to that position, which
 * makes it the fastest way to get to the moment a game turned.
 */
export function EvalGraph({
  annotations,
  fenHistory,
}: {
  annotations: ReplayMoveAnnotation[]
  fenHistory: string[]
}) {
  const currentFen = useAppStore((state) => state.currentFen)
  const version = useEngineStore((state) => state.analysisVersion)

  const { points, linePath, areaPath, markers, judged } = useMemo(() => {
    const analysisByFen = useEngineStore.getState().analysisByFen
    const evaluations = fenHistory.map((fen) => cpFor(fen, analysisByFen))
    const laid = layoutEvalPoints({ evaluations, width: WIDTH, height: HEIGHT })

    // A move's mark belongs on the position it produced, which is the ply
    // after the parent: index `ply` in the FEN history. Points are looked up
    // through a map; a `find` per marked move scanned the whole game each time.
    const pointByIndex = new Map(laid.map((point) => [point.index, point]))
    const marks: { annotation: ReplayMoveAnnotation; point: (typeof laid)[number] }[] = []
    for (const annotation of annotations) {
      if (annotation.label == null || !MARKED.has(annotation.label)) continue
      const point = pointByIndex.get(annotation.ply)
      if (point) marks.push({ annotation, point })
    }

    return {
      points: laid,
      linePath: buildLinePath(laid),
      areaPath: buildAreaPath(laid, HEIGHT),
      markers: marks,
      judged: evaluations.filter((value) => value != null).length,
    }
    // analysisVersion is the reactivity gate for the imperatively-read store.
  }, [annotations, fenHistory, version])

  if (fenHistory.length < 2) return null

  const currentIndex = fenHistory.indexOf(currentFen)
  const cursorX = currentIndex >= 0 ? xForIndex(currentIndex, fenHistory.length, WIDTH) : null

  return (
    <div className="eval-graph">
      <svg
        aria-label={`Evaluation across the game, ${judged} of ${fenHistory.length} positions analyzed`}
        className="eval-graph__svg"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        {/* Black's half of the board, so the fill reads as "who was winning". */}
        <rect className="eval-graph__ground" height={HEIGHT} width={WIDTH} x={0} y={0} />
        {points.length ? (
          <>
            <path className="eval-graph__area" d={areaPath} />
            <path className="eval-graph__line" d={linePath} vectorEffect="non-scaling-stroke" />
          </>
        ) : null}
        <line
          className="eval-graph__midline"
          vectorEffect="non-scaling-stroke"
          x1={0}
          x2={WIDTH}
          y1={HEIGHT / 2}
          y2={HEIGHT / 2}
        />
        {cursorX != null ? (
          <line
            className="eval-graph__cursor"
            vectorEffect="non-scaling-stroke"
            x1={cursorX}
            x2={cursorX}
            y1={0}
            y2={HEIGHT}
          />
        ) : null}
        {markers.map(({ annotation, point }) => (
          <circle
            className="eval-graph__marker"
            cx={point.x}
            cy={point.y}
            fill={getAnnotationAppearance(annotation.label!)?.tone ?? 'currentColor'}
            key={annotation.ply}
            r={7}
          />
        ))}
      </svg>

      <HitTargets currentIndex={currentIndex} fenHistory={fenHistory} />
    </div>
  )
}

/**
 * One button per position, laid over the curve: keyboard reachable and far
 * easier to hit than the 2px-wide slice each ply occupies.
 *
 * Memoised on the game and the cursor, so the few hundred buttons of a long
 * game are not rebuilt each time the curve gains a point while a review runs.
 * One handler on the row reads the position off the button pressed, instead of
 * a closure per button. A click reaches it from the keyboard too: Enter and
 * Space on a button fire `click`.
 */
const HitTargets = memo(function HitTargets({
  currentIndex,
  fenHistory,
}: {
  currentIndex: number
  fenHistory: string[]
}) {
  function jump(event: React.MouseEvent<HTMLDivElement>) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-ply]')
    const fen = button ? fenHistory[Number(button.dataset.ply)] : undefined
    // The graph plots the loaded game, so a click jumps to that game's node.
    if (fen) useAppStore.getState().jumpToFen(fen)
  }

  return (
    <div className="eval-graph__hits" onClick={jump}>
      {fenHistory.map((fen, index) => (
        <button
          aria-label={index === 0 ? 'Starting position' : `Move ${Math.ceil(index / 2)}`}
          className={`eval-graph__hit${index === currentIndex ? ' eval-graph__hit--active' : ''}`}
          data-ply={index}
          key={`${fen}-${index}`}
          type="button"
        />
      ))}
    </div>
  )
})
