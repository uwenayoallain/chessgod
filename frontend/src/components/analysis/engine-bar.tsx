import { useEngine } from '@/hooks/use-engine'
import { getEngineBarView, scoreToWhitePerspective } from '@/lib/stockfish/eval'
import { useAppStore } from '@/store/app-store'

export function EngineBar() {
  const currentFen = useAppStore((state) => state.currentFen)
  const { currentDepth, enabled, isAnalyzing, lines } = useEngine({
    autoAnalyze: false,
  })

  const topLine = lines[0] ?? null
  const score = topLine ? scoreToWhitePerspective(topLine.score, currentFen) : null

  if (!enabled) {
    return null
  }

  const { label, whitePercent } = getEngineBarView(score)

  return (
    <div className="engine-bar" aria-live="polite">
      <div className="engine-bar__identity">
        <span
          className={`engine-bar__signal${isAnalyzing ? ' engine-bar__signal--active' : ''}`}
          aria-hidden="true"
        />
        <strong>{isAnalyzing ? 'Analyzing' : 'Engine'}</strong>
      </div>
      <div className="engine-bar__meta">
        <div className="mono engine-bar__score" aria-label={`Evaluation ${label}`}>
          {label}
        </div>
        <div className={`engine-bar__depth${currentDepth > 0 ? '' : ' engine-bar__depth--empty'}`}>
          <span className="mono">{currentDepth > 0 ? `depth ${currentDepth}` : 'depth --'}</span>
        </div>
      </div>
      <div
        className="engine-bar__stack"
        aria-label={`White evaluation share ${Math.round(whitePercent)} percent`}
        style={{ '--black-percent': `${100 - whitePercent}%` } as React.CSSProperties}
      >
        <div className="engine-bar__black" />
        <div className="engine-bar__white" />
      </div>
    </div>
  )
}
