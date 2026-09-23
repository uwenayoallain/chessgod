import { useEffect } from 'react'

import { useImportSummary } from '@/hooks/use-import-summary'
import { theoryQuery } from '@/hooks/use-theory'
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
  type SparColor,
} from '@/lib/sparring/sparring'
import { useAppStore } from '@/store/app-store'
import { useEngineStore } from '@/store/engine-store'
import { resolveSparElo, useSparStore } from '@/store/spar-store'

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
    })
  }

  /**
   * Play a given position out, the side to move being the player's. Always
   * unrated: a position handed over mid-game is already won or lost.
   */
  function playOut({ fen, lastUci = null }: { fen: string; lastUci?: string | null }) {
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
