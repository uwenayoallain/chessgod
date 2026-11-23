import {
  Gauge,
  GraduationCap,
  FlipVertical,
  Eraser,
  RotateCcw,
  Search,
  StepBack,
  StepForward,
  Target,
} from 'lucide-react'
import { type ReactNode, useEffect } from 'react'

import { MoveList } from '@/components/board/move-list'
import { Button } from '@/components/ui/button'
import { useAnalyzeLine } from '@/hooks/use-analyze-line'
import { analyzeBoard } from '@/hooks/use-engine'
import { useEngineStore } from '@/store/engine-store'
import { useTrainingMode } from '@/hooks/use-training-mode'
import { useAppStore } from '@/store/app-store'
import { useIsSparring } from '@/store/spar-store'

export function BoardRail({
  actions,
  loadedContextLabel,
  onClearLoadedContext,
  showColorFilter = false,
  showTimeClassFilter = false,
}: {
  actions?: ReactNode
  loadedContextLabel?: string | null
  onClearLoadedContext?: () => void
  showColorFilter?: boolean
  showTimeClassFilter?: boolean
}) {
  const {
    goBack,
    goForward,
    resetToStart,
    flipBoard,
    keepUserOnBottom,
    setKeepUserOnBottom,
    colorFilter,
    setColorFilter,
    timeClassFilter,
    setTimeClassFilter,
    nodes,
    currentNodeId,
    replayMoves: loadedReplayMoves,
    analysisRequested,
    setAnalysisRequested,
  } = useAppStore()

  const training = useTrainingMode()
  const activeMode = useEngineStore((state) => state.activeMode)
  const analyze = analyzeBoard
  const { analyzeLine, canAnalyze } = useAnalyzeLine()
  // Mid-game against the engine an evaluation is the answer to the next move.
  const sparring = useIsSparring()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (training.active) return
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goBack()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goForward()
      } else if (e.key === 'Home') {
        e.preventDefault()
        resetToStart()
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        flipBoard()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [flipBoard, goBack, goForward, resetToStart, training.active])

  return (
    <aside className="workspace-rail">
      <div className="workspace-rail__section workspace-rail__section--board">
        <div className="workspace-rail__buttons">
          <Button
            aria-label="Previous move (←)"
            disabled={!nodes[currentNodeId]?.parentId || training.active}
            onClick={goBack}
            title="Previous move (←)"
            type="button"
          >
            <StepBack size={16} />
          </Button>
          <Button
            aria-label="Next move (→)"
            disabled={!nodes[currentNodeId]?.children.length || training.active}
            onClick={goForward}
            title="Next move (→)"
            type="button"
          >
            <StepForward size={16} />
          </Button>
          <Button
            aria-label="Reset to start (Home)"
            disabled={training.active}
            onClick={resetToStart}
            title="Reset to start (Home)"
            type="button"
          >
            <RotateCcw size={16} />
          </Button>
          <Button
            aria-label="Flip board (F)"
            onClick={flipBoard}
            title="Flip board (F)"
            type="button"
          >
            <FlipVertical size={16} />
          </Button>
          {loadedContextLabel && onClearLoadedContext ? (
            // Never disabled: this is the way out of every state — a drill, a
            // retry, a game against the engine, a line being learned.
            <Button
              aria-label={`${loadedContextLabel} and start again`}
              onClick={onClearLoadedContext}
              title="A fresh board at the start position"
              type="button"
              variant="ghost"
            >
              <Eraser size={16} />
              <span>{loadedContextLabel}</span>
            </Button>
          ) : null}
        </div>
        <label className="workspace-rail__toggle" htmlFor="keep-user-on-bottom">
          <input
            checked={keepUserOnBottom}
            id="keep-user-on-bottom"
            onChange={(event) => setKeepUserOnBottom(event.target.checked)}
            type="checkbox"
          />
          <span>Keep my pieces at the bottom</span>
        </label>
      </div>

      <div className="workspace-rail__section workspace-rail__section--analysis">
        <div className="workspace-rail__stack">
          <div className="workspace-rail__buttons">
            <Button
              disabled={sparring}
              onClick={() => {
                setAnalysisRequested(true)
                void analyze(undefined, true, { stable: false })
              }}
              title="A fast first answer on this position"
              type="button"
              variant={activeMode === 'quick' || activeMode === 'standard' ? 'primary' : 'default'}
            >
              <Gauge size={14} />
              <span>Quick</span>
            </Button>
            <Button
              disabled={sparring}
              onClick={() => {
                setAnalysisRequested(true)
                void analyze(undefined, true, { deep: true })
              }}
              title="A longer, deeper search of this position"
              type="button"
              variant={activeMode === 'deep' ? 'primary' : 'default'}
            >
              <Target size={14} />
              <span>Deep</span>
            </Button>
          </div>
          <Button
            disabled={!canAnalyze || sparring}
            onClick={() => void analyzeLine()}
            type="button"
            variant={analysisRequested ? 'primary' : 'default'}
          >
            <Search size={14} />
            <span>Analyze line</span>
          </Button>
        </div>
      </div>

      {loadedReplayMoves.length > 0 ? (
        <div className="workspace-rail__section workspace-rail__section--line-training">
          <div className="workspace-rail__label">Training</div>
          <div className="workspace-rail__stack">
            {!training.active ? (
              <Button onClick={training.start} type="button" variant="primary">
                <GraduationCap size={14} />
                <span>Train on this line</span>
              </Button>
            ) : (
              <>
                {training.status === 'waiting' ? (
                  <div className="training-status training-status--waiting">
                    Your turn. Play move {training.stepIndex + 1} of {training.totalMoves}.
                  </div>
                ) : null}
                {training.status === 'correct' ? (
                  <div className="training-status training-status--correct">Correct.</div>
                ) : null}
                {training.status === 'incorrect' ? (
                  <div className="training-status training-status--incorrect">
                    Wrong move. The line plays <strong>{training.expectedMove?.san}</strong>
                  </div>
                ) : null}
                {training.status === 'complete' ? (
                  <div className="training-status training-status--correct">Line done.</div>
                ) : null}
                <div className="workspace-rail__buttons">
                  {training.status === 'incorrect' ? (
                    <Button onClick={training.retry} type="button">
                      Retry
                    </Button>
                  ) : null}
                  <Button onClick={training.stop} type="button" variant="ghost">
                    Stop training
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {actions ? (
        <div className="workspace-rail__section workspace-rail__section--actions">
          <div className="workspace-rail__stack">{actions}</div>
        </div>
      ) : null}

      {showColorFilter || showTimeClassFilter ? (
        <div className="workspace-rail__section workspace-rail__section--filters">
          <div className="workspace-rail__label">Filters</div>
          <div className="workspace-rail__stack">
            {showColorFilter ? (
              <select
                aria-label="Filter by the color you played"
                className="select"
                onChange={(event) =>
                  setColorFilter(event.target.value as 'white' | 'black' | 'both')
                }
                value={colorFilter}
              >
                <option value="both">Both colors</option>
                <option value="white">White only</option>
                <option value="black">Black only</option>
              </select>
            ) : null}
            {showTimeClassFilter ? (
              <select
                aria-label="Filter by time control"
                className="select"
                onChange={(event) => setTimeClassFilter(event.target.value || null)}
                value={timeClassFilter ?? ''}
              >
                <option value="rapid_blitz">Rapid + Blitz</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
                <option value="">All time classes</option>
                <option value="bullet">Bullet</option>
                <option value="daily">Daily</option>
              </select>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="workspace-rail__section workspace-rail__section--fill workspace-rail__section--moves">
        <div className="workspace-rail__moves">
          <MoveList showHeader={false} />
        </div>
      </div>
    </aside>
  )
}
