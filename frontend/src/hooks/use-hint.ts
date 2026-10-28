import { useCallback, useEffect, useRef, useState } from 'react'

import { describeHint, HINT_LEVELS, type Hint } from '@/lib/training/hints'
import { useAppStore } from '@/store/app-store'

/**
 * Where a trainer's hints come from: the answer itself, when the page holds
 * it (Rush, the line trainer, drills, Retry, the quiz), or a fetch for the
 * trainers whose answer stays on the server until the move is played
 * (Blunder Check, Punish it). Either way the page only ever sees the hint.
 */
export type HintSource =
  | { fen: string; uci: string }
  | { fen: string; fetch: (level: 1 | 2) => Promise<Hint | null> }

export type HintState = {
  hint: Hint | null
  /** How many hints have been taken for this question. */
  level: number
  pending: boolean
  /** Whether another hint is available. */
  more: boolean
  ask: () => void
}

function fullFen(fen: string) {
  return fen.split(' ').length >= 6 ? fen : `${fen} 0 1`
}

/**
 * Graded hints for the question `key` identifies. Changing the key resets the
 * hints, and the highlighted square is scoped to the question's position so it
 * can never follow the player onto another board. The source object may be
 * rebuilt on every render, so a fetched hint is matched to its question by
 * key, never by the object that asked for it.
 */
export function useHint(source: HintSource | null, key: string | number | null): HintState {
  const setHintSquare = useAppStore((state) => state.setHintSquare)
  const [state, setState] = useState<{ key: typeof key; level: number; hint: Hint | null }>({
    key,
    level: 0,
    hint: null,
  })
  const [pending, setPending] = useState(false)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const keyRef = useRef(key)
  keyRef.current = key
  const levelRef = useRef(0)

  // A new question starts with no hints taken.
  useEffect(() => {
    levelRef.current = 0
    setState({ key, level: 0, hint: null })
    setPending(false)
    setHintSquare(null)
  }, [key, setHintSquare])

  useEffect(() => () => setHintSquare(null), [setHintSquare])

  const ask = useCallback(() => {
    const current = sourceRef.current
    if (!current || pending) return
    const next = Math.min(HINT_LEVELS, levelRef.current + 1) as 1 | 2
    if (next === levelRef.current) return
    levelRef.current = next
    const asked = keyRef.current
    if ('uci' in current) {
      const hint = describeHint(current.fen, current.uci, next)
      setHintSquare(hint?.square ?? null, fullFen(current.fen))
      setState({ key: asked, level: next, hint })
      return
    }
    // The last hint stays readable while the next one is on its way.
    setState((previous) => ({ ...previous, key: asked, level: next }))
    setPending(true)
    void current
      .fetch(next)
      .then((hint) => {
        // Only for the question that asked.
        if (keyRef.current !== asked) return
        setHintSquare(hint?.square ?? null, fullFen(current.fen))
        setState({ key: asked, level: next, hint })
      })
      .catch(() => undefined)
      .finally(() => setPending(false))
  }, [pending, setHintSquare])

  const live = state.key === key ? state : { key, level: 0, hint: null }
  return { hint: live.hint, level: live.level, pending, more: live.level < HINT_LEVELS, ask }
}
