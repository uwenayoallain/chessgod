import { FlipVertical, GraduationCap, RotateCcw, Search, StepBack, StepForward, X } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'

import { MoveList } from '@/components/board/move-list'
import { Button } from '@/components/ui/button'
import { useActiveReplayLine } from '@/hooks/use-active-replay-line'
import { useEngine } from '@/hooks/use-engine'
import { useTrainingMode } from '@/hooks/use-training-mode'
import { prefetchBookPlies } from '@/lib/analysis/book-moves'
import { api } from '@/lib/api'
import { useAppStore } from '@/store/app-store'

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
  const setBookPlies = useAppStore((state) => state.setBookPlies)

  const training = useTrainingMode()
  const { analyze, queueReplayAnalysis, enabled } = useEngine()
  const { fenHistory, replayMoves: activeReplayMoves } = useActiveReplayLine()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (training.active) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); goBack() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goForward() }
      else if (e.key === 'Home') { e.preventDefault(); resetToStart() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [goBack, goForward, resetToStart, training.active])

  return (
    <aside className="workspace-rail">
      <div className="workspace-rail__section">
        <div className="workspace-rail__label">Board</div>
        <div className="workspace-rail__buttons">
          <Button disabled={!nodes[currentNodeId]?.parentId || training.active} onClick={goBack} type="button">
            <StepBack size={16} />
          </Button>
          <Button disabled={!(nodes[currentNodeId]?.children.length) || training.active} onClick={goForward} type="button">
            <StepForward size={16} />
          </Button>
          <Button disabled={training.active} onClick={resetToStart} type="button">
            <RotateCcw size={16} />
          </Button>
          <Button onClick={flipBoard} type="button">
            <FlipVertical size={16} />
          </Button>
          {loadedContextLabel && onClearLoadedContext ? (
            <Button disabled={training.active} onClick={onClearLoadedContext} type="button" variant="ghost">
              <X size={16} />
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
          <span>Always keep me on bottom</span>
        </label>
      </div>

      <div className="workspace-rail__section">
        <div className="workspace-rail__label">Analysis</div>
        <div className="workspace-rail__stack">
          <Button
            onClick={() => {
              const requestFenHistory = [...fenHistory]
              const requestReplayMoves = [...activeReplayMoves]

              void (async () => {
                setAnalysisRequested(true)
                let didWarmStartEngine = false

                if (!enabled) {
                  await analyze()
                  didWarmStartEngine = true
                }

                if (requestFenHistory.length > 1) {
                  await queueReplayAnalysis(requestFenHistory)
                } else if (!didWarmStartEngine) {
                  await analyze()
                }

                if (!requestReplayMoves.length) {
                  setBookPlies([])
                  return
                }

                void prefetchBookPlies({
                  fenHistory: requestFenHistory,
                  fetchTheoryCompare: async (fen) => {
                    try {
                      const response = await api.get<{ master_moves: Array<{ san: string; uci?: string | null }> }>('/api/theory/compare', {
                        params: { fen },
                      })
                      return response.data
                    } catch {
                      return null
                    }
                  },
                  replayMoves: requestReplayMoves,
                }).then((result) => {
                  setBookPlies(result.plies)
                  if (result.hadErrors) {
                    console.warn('[chessgod] Book moves partially loaded — theory API returned errors for some positions.')
                  }
                }).catch((err) => {
                  console.warn('[chessgod] Failed to load book moves:', err)
                })
              })()
            }}
            type="button"
            variant={analysisRequested ? 'primary' : 'default'}
          >
            <Search size={14} />
            <span style={{ marginLeft: 6 }}>Request Evaluation</span>
          </Button>
        </div>
      </div>

      {loadedReplayMoves.length > 0 ? (
        <div className="workspace-rail__section">
          <div className="workspace-rail__label">Training</div>
          <div className="workspace-rail__stack">
            {!training.active ? (
              <Button onClick={training.start} type="button" variant="primary">
                <GraduationCap size={14} />
                <span style={{ marginLeft: 6 }}>Train on this line</span>
              </Button>
            ) : (
              <>
                {training.status === 'waiting' ? (
                  <div className="training-status training-status--waiting">
                    Your turn — play move {training.stepIndex + 1} of {training.totalMoves}
                  </div>
                ) : null}
                {training.status === 'correct' ? (
                  <div className="training-status training-status--correct">Correct!</div>
                ) : null}
                {training.status === 'incorrect' ? (
                  <div className="training-status training-status--incorrect">
                    Wrong move. Expected: <strong>{training.expectedMove?.san}</strong>
                  </div>
                ) : null}
                {training.status === 'complete' ? (
                  <div className="training-status training-status--correct">Line complete!</div>
                ) : null}
                <div className="workspace-rail__buttons">
                  {training.status === 'incorrect' ? (
                    <Button onClick={training.retry} type="button">Retry</Button>
                  ) : null}
                  <Button onClick={training.stop} type="button" variant="ghost">Stop Training</Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {actions ? (
        <div className="workspace-rail__section">
          <div className="workspace-rail__label">Actions</div>
          <div className="workspace-rail__stack">{actions}</div>
        </div>
      ) : null}

      {showColorFilter || showTimeClassFilter ? (
        <div className="workspace-rail__section">
          <div className="workspace-rail__label">Filters</div>
          <div className="workspace-rail__stack">
            {showColorFilter ? (
              <select
                className="select"
                onChange={(event) => setColorFilter(event.target.value as 'white' | 'black' | 'both')}
                value={colorFilter}
              >
                <option value="both">Both colors</option>
                <option value="white">White only</option>
                <option value="black">Black only</option>
              </select>
            ) : null}
            {showTimeClassFilter ? (
              <select className="select" onChange={(event) => setTimeClassFilter(event.target.value || null)} value={timeClassFilter ?? ''}>
                <option value="">All time classes</option>
                <option value="bullet">Bullet</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
                <option value="daily">Daily</option>
              </select>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="workspace-rail__section workspace-rail__section--fill">
        <div className="workspace-rail__label">Move List</div>
        <div className="workspace-rail__moves">
          <MoveList showHeader={false} />
        </div>
      </div>
    </aside>
  )
}
