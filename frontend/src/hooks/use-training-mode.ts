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
  const jumpToIndex = useAppStore((state) => state.jumpToIndex)
  const boardOrientation = useAppStore((state) => state.boardOrientation)
  const setDrillSolving = useAppStore((state) => state.setDrillSolving)
  const autoPlayTimer = useRef<number | null>(null)
  const statusTimer = useRef<number | null>(null)
  const wasActive = useRef(false)

  function clearTimers() {
    if (autoPlayTimer.current !== null) {
      clearTimeout(autoPlayTimer.current)
      autoPlayTimer.current = null
    }
    if (statusTimer.current !== null) {
      clearTimeout(statusTimer.current)
      statusTimer.current = null
    }
  }

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
    clearTimers()
    const side = boardOrientation === 'black' ? 'black' : 'white'
    setUserSide(side)
    setStepIndex(0)
    setStatus('waiting')
    wasActive.current = true
    setActive(true)
    setDrillSolving(true)
    jumpToIndex(0)
  }

  function stop() {
    clearTimers()
    if (wasActive.current) {
      wasActive.current = false
      setDrillSolving(false)
    }
    setActive(false)
    setStatus('idle')
    setStepIndex(0)
  }

  function retry() {
    clearTimers()
    jumpToIndex(stepIndex)
    setStatus('waiting')
  }

  useEffect(() => {
    if (active) {
      wasActive.current = true
      setDrillSolving(true)
    } else if (wasActive.current) {
      wasActive.current = false
      setDrillSolving(false)
    }
  }, [active, setDrillSolving])

  useEffect(
    () => () => {
      clearTimers()
      if (wasActive.current) {
        wasActive.current = false
        useAppStore.getState().setDrillSolving(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!active || !expectedMove) return

    if (!isUserTurn(expectedMove.ply)) {
      autoPlayTimer.current = window.setTimeout(() => {
        autoPlayTimer.current = null
        if (statusTimer.current !== null) {
          clearTimeout(statusTimer.current)
          statusTimer.current = null
        }
        const next = stepIndex + 1
        jumpToIndex(next)
        setStepIndex(next)
        if (next >= totalMoves) {
          setStatus('complete')
        } else {
          setStatus('waiting')
        }
      }, 400)

      return () => {
        if (autoPlayTimer.current !== null) {
          clearTimeout(autoPlayTimer.current)
          autoPlayTimer.current = null
        }
      }
    }
  }, [active, expectedMove, isUserTurn, stepIndex, totalMoves, jumpToIndex])

  useEffect(() => {
    if (!active || status !== 'waiting' || !expectedMove) return
    if (!isUserTurn(expectedMove.ply)) return

    if (currentFen === expectedMove.fen) {
      const next = stepIndex + 1
      setStepIndex(next)
      if (next >= totalMoves) {
        if (statusTimer.current !== null) {
          clearTimeout(statusTimer.current)
          statusTimer.current = null
        }
        setStatus('complete')
      } else {
        setStatus('correct')
        if (statusTimer.current !== null) {
          clearTimeout(statusTimer.current)
        }
        statusTimer.current = window.setTimeout(() => {
          statusTimer.current = null
          setStatus('waiting')
        }, 600)
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
