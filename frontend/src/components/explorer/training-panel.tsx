import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import type { OpeningSelection } from '@/hooks/use-board-workspace'
import { useTrainingLine } from '@/hooks/use-workspace-data'
import { useAppStore } from '@/store/app-store'

export function TrainingPanel({
  username,
  selectedOpening,
  color,
  timeClass,
}: {
  username: string | null
  selectedOpening: OpeningSelection | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
}) {
  const currentFen = useAppStore((state) => state.currentFen)
  const historyIndex = useAppStore((state) => state.historyIndex)
  const loadReplay = useAppStore((state) => state.loadReplay)
  const jumpToIndex = useAppStore((state) => state.jumpToIndex)
  const [isActive, setIsActive] = useState(false)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [status, setStatus] = useState<'idle' | 'ready' | 'correct' | 'incorrect' | 'complete'>('idle')

  const { data, isLoading, error } = useTrainingLine(
    username,
    selectedOpening?.openingName ?? null,
    selectedOpening?.eco ?? null,
    color,
    timeClass,
    Boolean(selectedOpening),
  )

  useEffect(() => {
    setIsActive(false)
    setCurrentStepIndex(0)
    setRevealed(false)
    setStatus('idle')
  }, [data?.opening_name, selectedOpening?.eco, selectedOpening?.openingName])

  useEffect(() => {
    if (!isActive || !data || currentStepIndex >= data.moves.length) {
      return
    }

    const expected = data.moves[currentStepIndex]
    if (currentFen === expected.resulting_fen && historyIndex === currentStepIndex + 1) {
      const nextIndex = currentStepIndex + 1
      setCurrentStepIndex(nextIndex)
      setRevealed(false)
      setStatus(nextIndex >= data.moves.length ? 'complete' : 'correct')
      return
    }

    if (historyIndex > currentStepIndex && currentFen !== expected.resulting_fen) {
      setStatus('incorrect')
      return
    }

    if (currentFen === expected.fen && historyIndex === currentStepIndex) {
      setStatus('ready')
    }
  }, [currentFen, currentStepIndex, data, historyIndex, isActive])

  function startTraining() {
    setIsActive(true)
    setCurrentStepIndex(0)
    setRevealed(false)
    setStatus('ready')
    loadReplay([])
  }

  function resetTraining() {
    setCurrentStepIndex(0)
    setRevealed(false)
    setStatus('ready')
    loadReplay([])
  }

  function retryStep() {
    jumpToIndex(currentStepIndex)
    setRevealed(false)
    setStatus('ready')
  }

  function playRevealedMove() {
    if (!data) {
      return
    }
    const nextIndex = currentStepIndex + 1
    loadReplay(data.moves.slice(0, nextIndex), nextIndex)
    setCurrentStepIndex(nextIndex)
    setRevealed(false)
    setStatus(nextIndex >= data.moves.length ? 'complete' : 'correct')
  }

  const expectedMove = data?.moves[currentStepIndex]

  return (
    <Card>
      <CardHeader>
        <h2>Opening Training</h2>
        <span className="muted">Master theory</span>
      </CardHeader>
      <CardBody className="column">
        {!selectedOpening ? <div className="muted">Select an opening to start training from move 1.</div> : null}
        {isLoading ? <div className="muted">Loading training line…</div> : null}
        {error ? <div className="empty-state__message">{error}</div> : null}

        {selectedOpening && data ? (
          <>
            <div className="workspace-training__summary">
              <strong>{selectedOpening.openingName}</strong>
              <span className="muted">{data.moves.length} theory moves</span>
            </div>

            {!isActive ? (
              <Button onClick={startTraining} type="button" variant="primary">
                Start Training
              </Button>
            ) : null}

            {isActive && status !== 'complete' && expectedMove ? (
              <div className="workspace-training__card">
                <div className="workspace-training__summary">
                  <span className="muted">Expected move</span>
                  <strong>#{expectedMove.ply}</strong>
                </div>
                <div className="muted">
                  Play the master move on the board. Use reveal if you want to see the answer.
                </div>
                {revealed ? <div className="workspace-training__answer">{expectedMove.san}</div> : null}
                <div className="workspace-rail__buttons">
                  <Button onClick={() => setRevealed(true)} type="button" variant="ghost">
                    Reveal
                  </Button>
                  <Button disabled={!revealed} onClick={playRevealedMove} type="button">
                    Play Revealed
                  </Button>
                  <Button disabled={status !== 'incorrect'} onClick={retryStep} type="button">
                    Retry
                  </Button>
                  <Button onClick={resetTraining} type="button" variant="ghost">
                    Reset
                  </Button>
                </div>
                {status === 'correct' ? <div className="muted">Correct. Continue with the next move.</div> : null}
                {status === 'incorrect' ? <div className="empty-state__message">That move is off the master line. Retry from the current step.</div> : null}
              </div>
            ) : null}

            {status === 'complete' ? (
              <div className="workspace-training__card">
                <strong>Training line complete.</strong>
                <div className="muted">Reset to drill the opening again.</div>
                <Button onClick={resetTraining} type="button" variant="primary">
                  Train Again
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  )
}
