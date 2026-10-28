import { useMemo, useRef } from 'react'
import { Chess } from 'chess.js'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { getPvPrefixToMove } from '@/lib/analysis/pv-actions'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { useEngineView } from '@/hooks/use-engine'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'

type SanMove = {
  san: string
  uci: string
  fen: string
}

function toFullFen(fen: string): string {
  const parts = fen.split(' ')
  while (parts.length < 6) parts.push(parts.length === 4 ? '0' : '1')
  return parts.join(' ')
}

function pvToSan(currentFen: string, pv: string[]): SanMove[] {
  const result: SanMove[] = []
  try {
    const chess = new Chess(toFullFen(currentFen))
    for (const uci of pv) {
      const from = uci.slice(0, 2)
      const to = uci.slice(2, 4)
      const promotion = uci.length > 4 ? uci[4] : undefined
      const move = chess.move({ from, to, promotion })
      if (!move) break
      result.push({
        san: move.san,
        uci,
        fen: chess.fen().split(' ').slice(0, 4).join(' '),
      })
    }
  } catch {
    // partial conversion is fine
  }
  return result
}

function formatNodes(n: number | null): string | null {
  if (n == null) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function scoreColor(cp: number): string {
  if (cp > 50) return 'var(--success)'
  if (cp < -50) return 'var(--danger)'
  return 'var(--text-muted)'
}

function scoreLabel(score: UCIInfo['score'], fen: string): { text: string; whiteCp: number } {
  const white = scoreToWhitePerspective(score, fen)
  if (white.type === 'mate') {
    return { text: `M${white.value}`, whiteCp: white.value > 0 ? 999 : -999 }
  }
  return { text: (white.value / 100).toFixed(2), whiteCp: white.value }
}

export function EngineLines({
  hidden = false,
  hiddenReason = 'Hidden until the game ends.',
}: {
  hidden?: boolean
  /** Why the lines are hidden, said where they would be. */
  hiddenReason?: string
}) {
  // Read here rather than passed down: every line the engine reports changes
  // these, and the workspace that used to hold them redrew with each one.
  const { isAnalyzing, lines } = useEngineView()
  const currentFen = useAppStore((state) => state.currentFen)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const pushPosition = useAppStore((state) => state.pushPosition)
  const enabled = useEngineStore((state) => state.enabled)
  const highPerformance = useEngineStore((state) => state.highPerformance)
  const setHighPerformance = useEngineStore((state) => state.setHighPerformance)

  // Cache pvToSan results keyed by fen+pv — avoids recreating Chess instances
  // on every depth update. Scoped to this component instance, GC'd on unmount.
  const pvCache = useRef<Map<string, SanMove[]>>(new Map())

  const parsed = useMemo(() => {
    const currentPly = nodes[currentNodeId]?.ply ?? 0
    return lines
      .map((line) => {
        const cacheKey = `${currentFen}|${line.pv.join(' ')}`
        let moves = pvCache.current.get(cacheKey)
        if (!moves) {
          moves = pvToSan(currentFen, line.pv)
          pvCache.current.set(cacheKey, moves)
        }
        return { line, moves, score: scoreLabel(line.score, currentFen), startPly: currentPly }
      })
      .filter((entry) => entry.moves.length > 0)
  }, [currentFen, currentNodeId, lines, nodes])

  return (
    <Card>
      <CardHeader>
        <div className="engine-lines__title">
          <h2>Best lines</h2>
        </div>
        <label
          className="engine-lines__performance"
          title="Give the engine more memory. Analysis in progress starts over."
        >
          <input
            type="checkbox"
            checked={highPerformance}
            onChange={(event) => void setHighPerformance(event.target.checked)}
          />
          <span>Deeper search</span>
        </label>
      </CardHeader>
      <CardBody className="column" style={{ minHeight: 120 }}>
        {hidden ? (
          <div className="muted engine-lines__empty">{hiddenReason}</div>
        ) : !parsed.length ? (
          <div className="muted engine-lines__empty">
            {isAnalyzing
              ? 'Analyzing…'
              : enabled
                ? 'Play a move or load a game to see the best lines for that position.'
                : 'Turn the engine on to see its best lines.'}
          </div>
        ) : null}
        {(hidden ? [] : parsed).map(({ line, moves, score, startPly }) => (
          <div className="engine-line" key={`${line.multipv}-${line.depth}`}>
            <div className="engine-line__header">
              <div className="engine-line__eval" style={{ color: scoreColor(score.whiteCp) }}>
                <span
                  className="engine-line__eval-bar"
                  style={{ background: scoreColor(score.whiteCp) }}
                />
                <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>
                  {score.text}
                </span>
              </div>
              <div className="engine-line__meta">
                <span className="engine-line__badge">d{line.depth}</span>
                {formatNodes(line.nodes) ? (
                  <span className="engine-line__badge">{formatNodes(line.nodes)} nodes</span>
                ) : null}
              </div>
            </div>
            <div className="engine-line__moves">
              {moves.map((m, i) => {
                const ply = startPly + i
                const moveNumber = Math.floor(ply / 2) + 1
                const isWhite = ply % 2 === 0
                return (
                  <span key={`${m.uci}-${i}`}>
                    {isWhite ? (
                      <span className="engine-line__move-num">{moveNumber}.</span>
                    ) : i === 0 ? (
                      <span className="engine-line__move-num">{moveNumber}…</span>
                    ) : null}
                    <button
                      className="engine-line__move-btn"
                      onClick={() => {
                        for (const move of getPvPrefixToMove(moves, i)) {
                          pushPosition(move.fen, move.san, move.uci)
                        }
                      }}
                      type="button"
                    >
                      {m.san}
                    </button>
                  </span>
                )
              })}
            </div>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}
