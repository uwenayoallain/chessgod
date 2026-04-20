import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore } from '@/store/app-store'

export type TrainingStatus = 'idle' | 'waiting' | 'correct' | 'incorrect' | 'complete'

export function useTrainingMode() {
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState<TrainingStatus>('idle')
  const [stepIndex, setStepIndex] = useState(0)
  const [userSide, setUserSide] = useState<'white' | 'black'>('white')

  const replayMoves = useAppStore((state) => state.replayMoves)
  const currentFen = useAppStore((state) => state.currentFen)
  const loadReplay = useAppStore((state) => state.loadReplay)
  const jumpToIndex = useAppStore((state) => state.jumpToIndex)
  const boardOrientation = useAppStore((state) => state.boardOrientation)
  const autoPlayTimer = useRef<number | null>(null)

  const totalMoves = replayMoves.length
  const expectedMove = replayMoves[stepIndex] ?? null

  const isUserTurn = useCallback(
    (ply: number) => {
      return (userSide === 'white' && ply % 2 === 1) || (userSide === 'black' && ply % 2 === 0)
    },
    [userSide],
  )

  function start() {
    if (!replayMoves.length) return
    const side = boardOrientation === 'black' ? 'black' : 'white'
    setUserSide(side)
    setStepIndex(0)
    setStatus('waiting')
    setActive(true)
    loadReplay(replayMoves)
    jumpToIndex(0)
  }

  function stop() {
    setActive(false)
    setStatus('idle')
    setStepIndex(0)
    if (autoPlayTimer.current) {
      clearTimeout(autoPlayTimer.current)
      autoPlayTimer.current = null
    }
  }

  function retry() {
    jumpToIndex(stepIndex)
    setStatus('waiting')
  }

  useEffect(() => {
    if (!active || !expectedMove) return

    if (!isUserTurn(expectedMove.ply)) {
      autoPlayTimer.current = window.setTimeout(() => {
        loadReplay(replayMoves, stepIndex + 1)
        const next = stepIndex + 1
        setStepIndex(next)
        if (next >= totalMoves) {
          setStatus('complete')
        } else {
          setStatus('waiting')
        }
      }, 400)

      return () => {
        if (autoPlayTimer.current) {
          clearTimeout(autoPlayTimer.current)
          autoPlayTimer.current = null
        }
      }
    }
  }, [active, expectedMove, isUserTurn, stepIndex, totalMoves, loadReplay, replayMoves])

  useEffect(() => {
    if (!active || status !== 'waiting' || !expectedMove) return
    if (!isUserTurn(expectedMove.ply)) return

    if (currentFen === expectedMove.fen) {
      const next = stepIndex + 1
      setStepIndex(next)
      if (next >= totalMoves) {
        setStatus('complete')
      } else {
        setStatus('correct')
        setTimeout(() => setStatus('waiting'), 600)
      }
    }
  }, [active, currentFen, expectedMove, isUserTurn, status, stepIndex, totalMoves])

  useEffect(() => {
    if (!active || status !== 'waiting' || !expectedMove) return
    if (!isUserTurn(expectedMove.ply)) return

    const historyIndex = useAppStore.getState().historyIndex
    if (historyIndex > stepIndex && currentFen !== expectedMove.fen) {
      setStatus('incorrect')
    }
  }, [active, currentFen, expectedMove, isUserTurn, status, stepIndex])

  return {
    active,
    status,
    stepIndex,
    totalMoves,
    expectedMove,
    userSide,
    start,
    stop,
    retry,
  }
}
