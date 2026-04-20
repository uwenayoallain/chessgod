import { useEngine } from '@/hooks/use-engine'
import { getEngineBarView, scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { useAppStore } from '@/store/app-store'

export function EngineBar() {
  const currentFen = useAppStore((state) => state.currentFen)
  const { currentDepth, enabled, lines } = useEngine()

  const topLine = lines[0] ?? null
  const score = topLine ? scoreToWhitePerspective(topLine.score, currentFen) : null

  if (!enabled) {
    return null
  }

  const { label, whitePercent } = getEngineBarView(score)

  return (
    <div className="engine-bar">
      <div className="engine-bar__meta">
        <div className="mono engine-bar__score">
          {label}
        </div>
        <div className={`engine-bar__depth${currentDepth > 0 ? '' : ' engine-bar__depth--empty'}`}>
          <span className="mono">{currentDepth > 0 ? `d${currentDepth}` : 'd--'}</span>
        </div>
      </div>
      <div className="engine-bar__stack" style={{ '--black-percent': `${100 - whitePercent}%` } as React.CSSProperties}>
        <div className="engine-bar__black" />
        <div className="engine-bar__white" />
      </div>
    </div>
  )
}
