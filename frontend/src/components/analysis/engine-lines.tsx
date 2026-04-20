import { useMemo } from 'react'
import { Chess } from 'chess.js'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { getPvPrefixToMove } from '@/lib/analysis/pv-actions'
import { scoreToWhitePerspective } from '@/lib/stockfish/eval'
import type { UCIInfo } from '@/lib/stockfish/uci'
import { useAppStore } from '@/store/app-store'

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
  lines,
  isAnalyzing,
  statusMessage,
}: {
  lines: UCIInfo[]
  isAnalyzing?: boolean
  statusMessage?: string
}) {
  const currentFen = useAppStore((state) => state.currentFen)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const pushPosition = useAppStore((state) => state.pushPosition)

  const parsed = useMemo(() => {
    const currentPly = nodes[currentNodeId]?.ply ?? 0
    return lines
      .map((line) => ({
        line,
        moves: pvToSan(currentFen, line.pv),
        score: scoreLabel(line.score, currentFen),
        startPly: currentPly,
      }))
      .filter((entry) => entry.moves.length > 0)
  }, [currentFen, currentNodeId, lines, nodes])

  return (
    <Card>
      <CardHeader>
        <h2>Engine Lines</h2>
      </CardHeader>
      <CardBody className="column" style={{ minHeight: 120 }}>
        {!parsed.length ? (
          <div className="muted">
            {statusMessage ?? (isAnalyzing ? 'Analyzing…' : 'Start analysis to see principal variations.')}
          </div>
        ) : null}
        {parsed.length && isAnalyzing && statusMessage ? (
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{statusMessage}</div>
        ) : null}
        {parsed.map(({ line, moves, score, startPly }) => (
          <div className="engine-line" key={`${line.multipv}-${line.depth}`}>
            <div className="engine-line__header">
              <div className="engine-line__eval" style={{ color: scoreColor(score.whiteCp) }}>
                <span className="engine-line__eval-bar" style={{ background: scoreColor(score.whiteCp) }} />
                <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>{score.text}</span>
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
