import type { EngineScore } from './uci'

export function scoreToWhitePerspective(score: EngineScore, fen: string): EngineScore {
  const activeColor = fen.split(' ')[1]

  if (activeColor === 'b') {
    return {
      type: score.type,
      value: score.value * -1,
    }
  }

  return score
}

export function getEngineBarView(score: EngineScore | null) {
  if (!score) {
    return {
      label: '--',
      whitePercent: 50,
    }
  }

  const clamped = Math.max(
    -1000,
    Math.min(1000, score.type === 'mate' ? 1000 * Math.sign(score.value || 1) : score.value),
  )

  return {
    label: score.type === 'mate' ? `M${score.value}` : (score.value / 100).toFixed(2),
    whitePercent: ((clamped + 1000) / 2000) * 100,
  }
}
