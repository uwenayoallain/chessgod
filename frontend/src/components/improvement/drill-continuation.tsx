import { useEffect, useMemo, useState } from 'react'

import {
  buildContinuation,
  formatContinuationScore,
  type Continuation,
} from '@/lib/analysis/continuation'
import { hydrateEvaluationsForFens } from '@/lib/analysis/hydrate-evaluations'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { GAME_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import type { UCIInfo } from '@/lib/stockfish/uci'

/** Plies to show: enough to answer "and then what?", short enough to read. */
const CONTINUATION_PLIES = 6

/**
 * A live search line is shown from this depth on. Shallower lines change
 * every few milliseconds and would flicker; by depth 8 the first moves have
 * usually settled, and the line keeps deepening in place.
 */
const MIN_LIVE_DEPTH = 8

/** One pill per ply while the search runs, sized like "1.Nf3", "Bxf7+", "e5". */
const SKELETON_WIDTHS = ['3.2em', '2.4em', '3.6em', '2.6em', '3.1em', '2.3em']

function topOf(lines: UCIInfo[] | null | undefined) {
  if (!lines?.length) return null
  return lines.find((line) => line.multipv === 1) ?? lines[0]
}

function pickCachedLine(fen: string) {
  const line = topOf(useEngineStore.getState().analysisByFen[fen]?.lines)
  return line?.pv?.length ? line : null
}

/**
 * The best line known for `fen`: a finished or stored search first, else the
 * one streaming from a search of this position that is still running.
 */
export function pickTopLine(fen: string) {
  const cached = pickCachedLine(fen)
  if (cached) return cached
  const state = useEngineStore.getState()
  if (state.analyzedFen !== fen) return null
  const live = topOf(state.lines)
  return live && live.pv?.length && live.depth >= MIN_LIVE_DEPTH ? live : null
}

/**
 * What the engine says happens after the drill position.
 *
 * A finished drill says which move was right and why, then stops, leaving the
 * question the position actually raises unanswered. This answers it from the
 * engine rather than from the card's stored text, so it holds for the lines
 * the card never wrote down.
 *
 * Every drill and Blunder Check position was searched by the crawler before it
 * became a question, and the trainers hydrate those rows as soon as a set
 * loads (`hydrateEvaluationsForFens`), so the line is normally already cached
 * and shows at once. Otherwise the stored row is asked for here, and only a
 * position the server has nothing for starts a browser search.
 */
export function DrillContinuation({ fen, active }: { fen: string; active: boolean }) {
  const loadPosition = useAppStore((state) => state.loadPosition)
  const currentFen = useAppStore((state) => state.currentFen)
  // Subscribing to the version counter rather than to `analysisByFen` keeps
  // this from recomputing on every unrelated position the engine finishes.
  const version = useEngineStore((state) => state.analysisVersion)
  // Live lines only for this position, so other searches redraw nothing here.
  const liveLines = useEngineStore((state) => (state.analyzedFen === fen ? state.lines : null))
  const engineEnabled = useEngineStore((state) => state.enabled)
  // Ready, not merely enabled: `enabled` is on by default, so asking before the
  // worker exists starts a search against nothing.
  const engineReady = useEngineStore((state) => state.isReady)
  // The position whose stored row has been asked for and answered (or not).
  const [serverChecked, setServerChecked] = useState<string | null>(null)

  // Stored evaluations first: a request, not an engine start.
  useEffect(() => {
    if (!active || !fen) return
    if (pickCachedLine(fen)) return
    const controller = new AbortController()
    void hydrateEvaluationsForFens([fen], controller.signal).finally(() => {
      if (!controller.signal.aborted) setServerChecked(fen)
    })
    return () => controller.abort()
  }, [active, fen])

  // Only a position the server has nothing for is searched in the browser.
  useEffect(() => {
    if (!active || !engineEnabled || !fen || serverChecked !== fen) return
    // The crawl, the board and the hydration fill this same cache, so a
    // position already searched costs nothing here.
    if (pickCachedLine(fen)) return
    // The engine starts on demand and is released when idle; start it, and
    // this runs again once it is ready.
    if (!engineReady) {
      void useEngineStore.getState().init()
      return
    }
    // Review depth, not the board's 30: this is a line under a finished drill,
    // and a depth-30 row would also make the crawler deepen its partner to 30.
    void useEngineStore
      .getState()
      .analyzePosition(fen, { priority: 'normal', depth: GAME_REVIEW_DEPTH })
  }, [active, engineEnabled, engineReady, fen, serverChecked])

  const continuation: Continuation | null = useMemo(() => {
    if (!active || !fen) return null
    return buildContinuation({ rootFen: fen, line: pickTopLine(fen), maxPlies: CONTINUATION_PLIES })
    // `version` and `liveLines` are the reactivity gates; `pickTopLine` reads
    // the store directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fen, version, liveLines])

  // Still waiting on the stored row counts as loading even with the engine off.
  const loading = engineEnabled || serverChecked !== fen

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
        ) : loading ? (
          // Shaped like the line it stands in for: six move-sized pills, so the
          // reader sees that moves are coming, where, and roughly how many.
          <ol
            aria-busy="true"
            aria-label="Searching the continuation"
            className="drill-continuation__line drill-continuation__line--loading"
            role="status"
          >
            {SKELETON_WIDTHS.map((width, index) => (
              <li key={index}>
                <span className="skeleton drill-continuation__ply-skeleton" style={{ width }} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Turn the engine on to see what follows.</p>
        )}
      </div>
    </div>
  )
}
