import { useEffect, useMemo } from 'react'

import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import {
  buildContinuation,
  formatContinuationScore,
  type Continuation,
} from '@/lib/analysis/continuation'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

/** Plies to show: enough to answer "and then what?", short enough to read. */
const CONTINUATION_PLIES = 6

function pickTopLine(fen: string) {
  const cached = useEngineStore.getState().analysisByFen[fen]
  if (!cached?.lines?.length) return null
  return cached.lines.find((line) => line.multipv === 1) ?? cached.lines[0]
}

/**
 * What the engine says happens after the drill position.
 *
 * A finished drill says which move was right and why, then stops — leaving the
 * question the position actually raises unanswered. This answers it from a
 * search rather than from the card's stored text, so it holds for the lines the
 * card never wrote down.
 */
export function DrillContinuation({ fen, active }: { fen: string; active: boolean }) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const currentFen = useAppStore((state) => state.currentFen)
  // Subscribing to the version counter rather than to `analysisByFen` keeps
  // this from recomputing on every unrelated position the engine finishes.
  const version = useEngineStore((state) => state.analysisVersion)
  const engineEnabled = useEngineStore((state) => state.enabled)
  // Ready, not merely enabled: `enabled` is on by default, so asking before the
  // worker exists starts a search against nothing.
  const engineReady = useEngineStore((state) => state.isReady)

  useEffect(() => {
    if (!active || !engineEnabled || !engineReady || !fen) return
    // Only if nothing is cached: the crawl and the board fill this same cache,
    // so a position already searched costs nothing here.
    if (pickTopLine(fen)) return
    void useEngineStore.getState().analyzePosition(fen, { priority: 'normal' })
  }, [active, engineEnabled, engineReady, fen])

  const continuation: Continuation | null = useMemo(() => {
    if (!active || !fen) return null
    return buildContinuation({ rootFen: fen, line: pickTopLine(fen), maxPlies: CONTINUATION_PLIES })
    // `version` is the reactivity gate; `pickTopLine` reads the store directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fen, version])

  if (!active) return null

  return (
    <div className="drill-continuation">
      <div className="drill-continuation__heading">
        <span>What follows</span>
        {continuation ? (
          <span className="drill-continuation__eval mono">
            {formatContinuationScore(continuation)} · depth {continuation.depth}
          </span>
        ) : null}
      </div>
      {/* Reserved height: the line arrives when the search does, and the panel
          must not grow under the reader when it lands. */}
      <div className="drill-continuation__body">
        {continuation ? (
          <ol className="drill-continuation__line">
            {continuation.moves.map((move, index) => (
              <li key={`${move.uci}-${index}`}>
                {/* Safe only because the attempt is already resolved: the submit
                    effect ignores anything but 'solving'/'follow-up', and
                    `loadPosition` roots the tree at a node with no parent, which
                    that effect also requires. Exploring cannot re-grade the card. */}
                <button
                  aria-current={currentFen === move.fen ? 'true' : undefined}
                  aria-label={`Show the position after ${move.san}`}
                  className={`drill-continuation__ply drill-continuation__ply--${move.side}${
                    currentFen === move.fen ? ' drill-continuation__ply--current' : ''
                  }`}
                  onClick={() => loadPosition(move.fen, move.uci)}
                  type="button"
                >
                  {move.san}
                </button>
              </li>
            ))}
          </ol>
        ) : engineEnabled ? (
          <PanelSkeleton label="Searching the continuation" rowHeight={18} rows={1} />
        ) : (
          <p className="muted">Turn the engine on to see what follows.</p>
        )}
      </div>
    </div>
  )
}
