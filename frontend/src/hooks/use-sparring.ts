import { useCallback, useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { useQuery } from '@tanstack/react-query'

import { useImportSummary } from '@/hooks/use-import-summary'
import { useTrainingStore } from '@/store/training-store'
import { useAnalyzeLine } from '@/hooks/use-analyze-line'
import { theoryQuery } from '@/hooks/use-theory'
import type { ActiveReplayLine } from '@/lib/analysis/active-line'
import type { ReplayMoveAnnotation } from '@/lib/analysis/replay-annotations'
import { QUICK_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { api } from '@/lib/api'
import { collectSparringMistakes } from '@/lib/sparring/sparring-mistakes'
import { queryClient } from '@/lib/query-client'
import {
  applyUciMove,
  chooseBookMove,
  chooseSparMove,
  SPAR_BOOK_PLIES,
  sideToMove,
  sparSearchParams,
  sparMoveTimeMs,
  sparOutcome,
  timeoutOutcome,
  type SparColor,
} from '@/lib/sparring/sparring'
import { revealSection } from '@/components/ui/collapsible-section'
import { useAppStore, type ReplayMove } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { clockRemaining, resolveSparElo, useSparStore } from '@/store/spar-store'
import { useApplyReward } from '@/hooks/use-training'
import { browserTimeZone } from '@/lib/training/progress'

/** Give up on a move after this many searches came back empty. */
const MAX_EMPTY_SEARCHES = 3

/**
 * Drives a sparring game: ends it when the board says it is over or the line
 * is replaced, and plays the opponent's reply whenever it is the opponent's
 * turn at the end of the line.
 *
 * "At the end of the line" is what makes takebacks work without special
 * cases. Stepping back leaves the current node with children, so the opponent
 * waits; playing a different move there makes a new leaf, and it answers that.
 */
export function useSparringController() {
  const status = useSparStore((state) => state.status)
  const userColor = useSparStore((state) => state.userColor)
  const elo = useSparStore((state) => state.elo)
  const epoch = useSparStore((state) => state.epoch)
  const finish = useSparStore((state) => state.finish)
  const close = useSparStore((state) => state.close)

  const treeEpoch = useAppStore((state) => state.treeEpoch)
  const currentNodeId = useAppStore((state) => state.currentNodeId)
  const nodes = useAppStore((state) => state.nodes)
  const currentFen = useAppStore((state) => state.currentFen)
  const fenHistory = useAppStore((state) => state.fenHistory)
  const username = useAppStore((state) => state.username)
  const enabled = useEngineStore((state) => state.enabled)

  const playing = status === 'playing'
  const isLeaf = (nodes[currentNodeId]?.children.length ?? 0) === 0
  const timed = useSparStore((state) => state.clocks !== null)
  const chargeMove = useSparStore((state) => state.chargeMove)
  const chargedAt = useRef<{ epoch: number; nodeId: string } | null>(null)

  // A move that lands at the end of the line switches the clocks. Stepping
  // back and forward to the same leaf is not a move; playing a different
  // move after a takeback is, and it is charged to whoever made it.
  useEffect(() => {
    if (!playing || !timed || treeEpoch !== epoch || !isLeaf) return
    const previous = chargedAt.current
    chargedAt.current = { epoch, nodeId: currentNodeId }
    if (!previous || previous.epoch !== epoch || previous.nodeId === currentNodeId) return
    chargeMove(sideToMove(currentFen) === 'white' ? 'black' : 'white', Date.now(), currentFen)
  }, [chargeMove, currentFen, currentNodeId, epoch, isLeaf, playing, timed, treeEpoch])

  // The flag: whoever's clock reaches zero loses, unless the other side
  // cannot mate. One timer set for the moment the running clock would reach
  // zero, re-set whenever the clocks change, instead of a check every 100ms.
  useEffect(() => {
    if (!playing || !timed) return
    let timer: number | undefined
    const arm = () => {
      window.clearTimeout(timer)
      const state = useSparStore.getState()
      const side = state.clockSide
      if (state.status !== 'playing' || !side) return
      const left = clockRemaining(state, side, Date.now()) ?? 1
      if (left > 0) {
        timer = window.setTimeout(arm, left + 10)
        return
      }
      finish(timeoutOutcome(state.clockFen ?? currentFen, side, userColor), username)
    }
    arm()
    const unsubscribe = useSparStore.subscribe((next, previous) => {
      if (
        next.clockSide !== previous.clockSide ||
        next.turnStartedAt !== previous.turnStartedAt ||
        next.clocks !== previous.clocks
      )
        arm()
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [currentFen, finish, playing, timed, userColor, username])

  // A game, a drill or an opening loaded over the sparring line ends the game.
  useEffect(() => {
    if (status !== 'idle' && treeEpoch !== epoch) close()
  }, [close, epoch, status, treeEpoch])

  useEffect(() => {
    if (!playing || treeEpoch !== epoch || !isLeaf) return
    const outcome = sparOutcome(fenHistory, userColor)
    if (outcome) finish(outcome, username)
  }, [epoch, fenHistory, finish, isLeaf, playing, treeEpoch, userColor, username])

  useEffect(() => {
    if (!playing || treeEpoch !== epoch || !isLeaf || !enabled) return
    if (sideToMove(currentFen) === userColor) return
    if (sparOutcome(fenHistory, userColor)) return

    let cancelled = false
    const nodeId = currentNodeId
    const stillOurTurn = () =>
      !cancelled &&
      useSparStore.getState().status === 'playing' &&
      useAppStore.getState().currentNodeId === nodeId &&
      useAppStore.getState().treeEpoch === epoch

    async function play(uci: string, thinkUntil: number) {
      const move = applyUciMove(currentFen, uci)
      if (!move) return false
      const wait = thinkUntil - Date.now()
      if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait))
      if (!stillOurTurn()) return true
      useAppStore.getState().pushPosition(move.fen, move.san, move.uci)
      return true
    }

    async function reply() {
      const search = sparSearchParams(elo)
      // A reply that lands instantly reads as a machine; a person takes a
      // moment. The shallow search is quick, so the rest of the time is waited.
      const thinkUntil = Date.now() + sparMoveTimeMs()
      if (fenHistory.length <= SPAR_BOOK_PLIES) {
        try {
          const theory = await queryClient.fetchQuery(theoryQuery(currentFen))
          if (!stillOurTurn()) return
          const book = chooseBookMove(currentFen, theory.master_moves)
          if (book && (await play(book, thinkUntil))) return
        } catch {
          // No book to hand: the engine chooser plays the opening instead.
        }
      }
      for (let attempt = 0; attempt < MAX_EMPTY_SEARCHES; attempt += 1) {
        const lines = await useEngineStore.getState().playMove(currentFen, search)
        if (!stillOurTurn()) return
        const uci = lines ? chooseSparMove(lines, search.temperature) : null
        if (uci && (await play(uci, thinkUntil))) return
      }
    }
    void reply()

    return () => {
      cancelled = true
    }
  }, [
    currentFen,
    currentNodeId,
    elo,
    enabled,
    epoch,
    fenHistory,
    isLeaf,
    playing,
    treeEpoch,
    userColor,
  ])
}

/** Hand the one engine to the opponent: nothing else may be searching. */
function prepareEngine() {
  const engine = useEngineStore.getState()
  engine.stop()
  if (!engine.enabled) useEngineStore.setState({ enabled: true, error: null })
}

/**
 * The opponent strength on offer and the two ways to start a game against it.
 * Shared by the Play panel and the drill result, so both start games the same
 * way.
 */
export function useStartSparring(username: string, onBeforeNewGame: () => void) {
  const importStatus = useAppStore((state) => state.importStatus)
  const { data: summary } = useImportSummary(username, importStatus)
  const override = useSparStore((state) => state.override)
  const start = useSparStore((state) => state.start)
  const calibratedElo = resolveSparElo(username, summary?.current_ratings)
  const offeredElo = override ?? calibratedElo

  /** A game from the starting position. Rated unless the strength was hand-picked. */
  function startGame(color: SparColor) {
    prepareEngine()
    onBeforeNewGame()
    useAppStore.getState().alignBoardToUserColor(color)
    start({
      userColor: color,
      elo: offeredElo,
      // Only the calibrated strength learns from results.
      rated: override == null,
      epoch: useAppStore.getState().treeEpoch,
      fen: useAppStore.getState().currentFen,
    })
  }

  /**
   * Play a given position out, the side to move being the player's. Always
   * unrated: a position handed over mid-game is already won or lost.
   */
  function playOut({
    fen,
    lastUci = null,
    origin = null,
  }: {
    fen: string
    lastUci?: string | null
    origin?: string | null
  }) {
    const color = sideToMove(fen)
    prepareEngine()
    onBeforeNewGame()
    useAppStore.getState().loadPosition(fen, lastUci)
    useAppStore.getState().alignBoardToUserColor(color)
    start({
      userColor: color,
      elo: offeredElo,
      rated: false,
      epoch: useAppStore.getState().treeEpoch,
      fen,
      origin,
    })
  }

  return {
    calibratedElo,
    offeredElo,
    override,
    rapidRating: summary?.current_ratings?.rapid ?? null,
    startGame,
    playOut,
  }
}

export type SparringHistory = {
  summary: {
    played: number
    wins: number
    draws: number
    losses: number
    rated_played: number
    first_rating: number | null
    latest_rating: number | null
  }
  games: Array<{
    id: number
    user_color: SparColor
    engine_rating: number
    rated: boolean
    result: 'win' | 'loss' | 'draw'
    reason: string
    moves: number
    mistakes: number
    time_control_seconds: number | null
    played_at: string
    start_fen: string
    moves_uci: string[]
  }>
}

export function sparringHistoryKey(username: string | null) {
  return ['sparring-history', username] as const
}

/** Games against the engine so far: the record, and the strength it has walked to. */
export function useSparringHistory(username: string | null) {
  return useQuery({
    enabled: Boolean(username),
    queryKey: sparringHistoryKey(username),
    queryFn: async ({ signal }) =>
      (
        await api.get<SparringHistory>('/api/sparring/games', {
          params: { username, limit: 8 },
          signal,
        })
      ).data,
    staleTime: 60_000,
  })
}

/**
 * Keeps a finished game: saves it, reviews it at once, and sends the review's
 * mistakes to the drill pipeline — so a game against the engine ends up in
 * the Review tab next to the mistakes from imported games.
 */
export function useSparringRecorder(annotations: ReplayMoveAnnotation[], line: ActiveReplayLine) {
  const status = useSparStore((state) => state.status)
  const outcome = useSparStore((state) => state.outcome)
  const epoch = useSparStore((state) => state.epoch)
  const userColor = useSparStore((state) => state.userColor)
  const elo = useSparStore((state) => state.elo)
  const rated = useSparStore((state) => state.rated)
  const origin = useSparStore((state) => state.origin)
  const timeControl = useSparStore((state) => state.timeControlSeconds)
  const savedGameId = useSparStore((state) => state.savedGameId)
  const mistakesPosted = useSparStore((state) => state.mistakesPosted)
  const reviewing = useSparStore((state) => state.reviewing)
  const recordSaved = useSparStore((state) => state.recordSaved)
  const recordMistakes = useSparStore((state) => state.recordMistakes)
  const settleReview = useSparStore((state) => state.settleReview)
  const username = useAppStore((state) => state.username)
  const applyReward = useApplyReward(username)
  const treeEpoch = useAppStore((state) => state.treeEpoch)
  const reviewActive = useEngineStore((state) => state.replayQueueActive)
  const { analyzeLine } = useAnalyzeLine()
  const savedFor = useRef<number | null>(null)
  const postedFor = useRef<number | null>(null)
  const reviewSeen = useRef<'waiting' | 'running' | 'done'>('waiting')
  const [reviewSettled, setReviewSettled] = useState(false)

  // The pool review is fire-and-forget, so its end is read off the store:
  // it counts as finished once it has been seen running and then stopped,
  // or when it never started because every position was already searched.
  useEffect(() => {
    if (reviewActive) reviewSeen.current = 'running'
    else if (reviewSeen.current === 'running') {
      reviewSeen.current = 'done'
      setReviewSettled(true)
    }
  }, [reviewActive])
  useEffect(() => {
    if (!savedGameId || reviewSeen.current !== 'waiting') return
    const timer = window.setTimeout(() => {
      if (!useEngineStore.getState().replayQueueActive) setReviewSettled(true)
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [savedGameId])
  // The panel reads it from the store: "Reviewing…" must end when the review does,
  // whether or not the drill post behind it succeeds.
  useEffect(() => {
    if (reviewSettled) settleReview()
  }, [reviewSettled, settleReview])

  useEffect(() => {
    if (status !== 'over' || !outcome || !username || savedFor.current === epoch) return
    savedFor.current = epoch
    reviewSeen.current = 'waiting'
    setReviewSettled(false)
    void analyzeLine({ depth: QUICK_REVIEW_DEPTH })
    void api
      .post<{ id: number; xp_gained?: number }>('/api/sparring/games', {
        username,
        user_color: userColor,
        engine_rating: elo,
        rated,
        result: outcome.result,
        reason: outcome.reason,
        start_fen: line.fenHistory[0],
        moves_uci: line.replayMoves.map((move) => move.uci),
        time_control_seconds: timeControl,
        origin: origin ?? undefined,
        tz: browserTimeZone(),
      })
      .then((response) => {
        recordSaved(response.data.id)
        // A game earns XP on the server; a boss fight earns more.
        void applyReward(
          { xp_gained: response.data.xp_gained ?? 0 },
          origin?.startsWith('boss:') ? 'Boss fight' : 'Game vs the engine',
        )
        // Holding a line's end against the engine is the course's final exam.
        if (origin?.startsWith('boss:') && outcome.result !== 'loss') {
          useTrainingStore.getState().celebrate({
            kind: 'achievement',
            title: outcome.result === 'win' ? 'Boss beaten' : 'Boss held to a draw',
            detail: 'You carried the line past the opening against the engine.',
            visual: { kind: 'icon', name: 'crown' },
          })
        }
        void queryClient.invalidateQueries({ queryKey: sparringHistoryKey(username) })
      })
      .catch(() => {
        // An unsaved practice game costs only its drills; the game itself was played.
      })
  }, [
    analyzeLine,
    applyReward,
    elo,
    epoch,
    line,
    origin,
    outcome,
    rated,
    recordSaved,
    status,
    timeControl,
    userColor,
    username,
  ])

  useEffect(() => {
    if (!savedGameId || mistakesPosted !== null || postedFor.current === savedGameId) return
    if (!reviewing || reviewing.epoch !== treeEpoch || !annotations.length) return
    const complete = annotations.every((annotation) => annotation.cpLoss != null)
    // Every move judged, or the review has finished with what it could judge.
    if (!complete && !reviewSettled) return
    postedFor.current = savedGameId
    const mistakes = collectSparringMistakes({
      annotations,
      analysisByFen: useEngineStore.getState().analysisByFen,
      fenHistory: line.fenHistory,
      userColor: reviewing.userColor,
    })
    void api
      .post(`/api/sparring/games/${savedGameId}/mistakes`, { mistakes })
      .then(() => {
        recordMistakes(mistakes.length)
        void queryClient.invalidateQueries({ queryKey: ['improvement-plan'] })
        void queryClient.invalidateQueries({ queryKey: sparringHistoryKey(username) })
      })
      // The game is saved and reviewed either way; only the drills are missing,
      // and the panel says so rather than reading "Reviewing…" forever.
      .catch(() => recordMistakes('failed'))
  }, [
    annotations,
    line,
    mistakesPosted,
    recordMistakes,
    reviewSettled,
    reviewing,
    savedGameId,
    treeEpoch,
    username,
  ])
}

/** The moves of a saved game replayed from its start position, as the board loads them. */
export function replayOfSparringGame(startFen: string, movesUci: string[]): ReplayMove[] {
  const board = new Chess(startFen.split(' ').length >= 6 ? startFen : `${startFen} 0 1`)
  const moves: ReplayMove[] = []
  for (const [index, uci] of movesUci.entries()) {
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4) || undefined,
    })
    moves.push({ ply: index + 1, san: move.san, uci, fen: board.fen() })
  }
  return moves
}

/**
 * Put a saved game against the engine back on the board and open its review:
 * the player's side at the bottom, labelled You / Stockfish, the review at the
 * quick depth. Nothing is saved again; the game is already in the record.
 */
export function useOpenSparringGame(onBeforeOpen: () => void) {
  const { analyzeLine } = useAnalyzeLine()
  return useCallback(
    (
      game: Pick<SparringHistory['games'][number], 'id' | 'start_fen' | 'moves_uci' | 'user_color'>,
    ) => {
      onBeforeOpen()
      const app = useAppStore.getState()
      app.loadReplay(replayOfSparringGame(game.start_fen, game.moves_uci))
      app.alignBoardToUserColor(game.user_color)
      useSparStore
        .getState()
        .reviewSaved(game.user_color, useAppStore.getState().treeEpoch, game.id)
      revealSection('explore-game-review')
      void analyzeLine({ depth: QUICK_REVIEW_DEPTH })
    },
    [analyzeLine, onBeforeOpen],
  )
}
