// MultiPV alternatives for the positions the trainers ask about.
//
// The library crawl searches one line per position, which is all a grade
// needs. A trainer that asks "find the move" needs more: whether a second move
// is just as good, so an equal alternative is not marked wrong. Those positions
// are few (the drills, Blunder Check, the quiz), so when the main queue is
// empty the crawler spends its idle engines on them before it sleeps.
//
// Only ranks 2 and 3 are uploaded. Rank 1 is the answer the trainer already
// holds, at the depth its partner was searched to; a MultiPV search shares its
// time among the lines and can choose a different first move at the same
// depth, so storing its rank 1 could replace the expected answer under a drill
// the player is already learning.

/** The query for positions a trainer wants alternatives for. */
export function trainerFensUrl(api, username, limit = 6) {
  const url = new URL('/api/games/trainer-multipv-fens', api)
  url.searchParams.set('username', username)
  url.searchParams.set('limit', String(limit))
  return url
}

/**
 * Ask the backend for trainer positions. Null when there is nothing to do,
 * including a backend that does not serve the endpoint yet (404): the crawler
 * then idles exactly as it did before this existed.
 */
export async function fetchTrainerFens(request, url) {
  let answer
  try {
    answer = await request(url)
  } catch (error) {
    if (error?.status === 404) return null
    throw error
  }
  const fens = Array.isArray(answer?.fens) ? answer.fens.filter((fen) => typeof fen === 'string') : []
  if (!fens.length) return null
  const reviewDepth = Number.isInteger(answer.review_depth) && answer.review_depth > 0
    ? answer.review_depth
    : null
  return { fens, reviewDepth }
}

/** Upload rows for a MultiPV search's alternatives, never its rank-one line. */
export function alternativeItems(fen, result) {
  if (!result || result.terminal) return []
  return (result.lines ?? [])
    .filter((line) => line.multipv > 1 && line.bestMoveUci && line.pvUci)
    .map((line) => ({
      fen,
      depth: line.depth,
      eval_cp: line.evalCp,
      eval_mate: line.evalMate,
      best_move_uci: line.bestMoveUci,
      pv_uci: line.pvUci,
      multipv_rank: line.multipv,
      engine: 'stockfish-19',
      engine_version: '19',
    }))
}

/**
 * Search each trainer position at MultiPV 3 across `engines` and upload the
 * alternatives. A position is searched once per process (`done`), so a backend
 * that keeps offering it, because the search found no second move, cannot
 * keep the crawler from ever going idle. Resolves with how many positions were
 * searched and how many rows were uploaded.
 *
 * `liveLimit` is how many engines may take another position right now, read
 * before every position: the crawler's thermal, presence and pressure guards
 * lower it mid-batch. An engine past the limit finishes the search in hand
 * (an abandoned search does not stop the engine) and takes no more; what it
 * did not take is not marked done, so it is offered again on a later round,
 * and everything already searched is still uploaded. `restMs` is the pause
 * between one engine's positions, as in a library batch, so a MultiPV search
 * never holds a core without a breath.
 */
export async function enrichTrainerPositions({
  fens,
  depth,
  engines,
  upload,
  done,
  stopping = () => false,
  liveLimit = () => Infinity,
  restMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  multiPV = 3,
}) {
  const queue = fens.filter((fen) => !done.has(fen))
  const items = []
  let searched = 0
  await Promise.all(engines.map(async ({ analyse }, index) => {
    for (;;) {
      if (stopping()) return
      // Past the current cut: stand this engine down for the rest of the run.
      if (index >= liveLimit()) return
      const fen = queue.shift()
      if (fen === undefined) return
      done.add(fen)
      const searchFen = fen.trim().split(/\s+/).length === 6 ? fen : `${fen} 0 1`
      try {
        const result = await analyse(searchFen, depth, { multiPV })
        searched += 1
        items.push(...alternativeItems(fen, result))
      } catch (error) {
        if (error?.cancelled) return
        if (error?.fatal) throw error
        log(`trainer alternatives skipped a position: ${error.message}`)
      }
      if (restMs > 0) await sleep(restMs)
    }
  }))
  if (items.length) await upload(items)
  return { searched, uploaded: items.length }
}
