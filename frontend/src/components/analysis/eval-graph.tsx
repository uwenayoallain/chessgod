import { useMemo } from 'react'

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
  const pushPosition = useAppStore((state) => state.pushPosition)
  const currentFen = useAppStore((state) => state.currentFen)
  const version = useEngineStore((state) => state.analysisVersion)

  const { points, linePath, areaPath, markers, judged } = useMemo(() => {
    const analysisByFen = useEngineStore.getState().analysisByFen
    const evaluations = fenHistory.map((fen) => cpFor(fen, analysisByFen))
    const laid = layoutEvalPoints({ evaluations, width: WIDTH, height: HEIGHT })

    const marks = annotations
      .filter((annotation) => annotation.label != null && MARKED.has(annotation.label))
      .map((annotation) => {
        // A move's mark belongs on the position it produced, which is the ply
        // after the parent — index `ply` in the FEN history.
        const point = laid.find((candidate) => candidate.index === annotation.ply)
        return point ? { annotation, point } : null
      })
      .filter((mark): mark is { annotation: ReplayMoveAnnotation; point: (typeof laid)[number] } =>
        Boolean(mark),
      )

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

      {/* One button per position, laid over the curve — keyboard reachable and
          far easier to hit than the 2px-wide slice each ply occupies. */}
      <div className="eval-graph__hits">
        {fenHistory.map((fen, index) => (
          <button
            aria-label={index === 0 ? 'Starting position' : `Move ${Math.ceil(index / 2)}`}
            className={`eval-graph__hit${index === currentIndex ? ' eval-graph__hit--active' : ''}`}
            key={`${fen}-${index}`}
            onClick={() => pushPosition(fen)}
            type="button"
          />
        ))}
      </div>
    </div>
  )
}
