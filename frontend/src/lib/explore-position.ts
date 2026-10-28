import { useAppStore } from '@/store/app-store'

/** Raised to open the Explore tab at a section; the dashboard owns the tab. */
export const OPEN_EXPLORE_EVENT = 'chessgod:open-explore'

/**
 * Leave whatever is being asked and carry on with the position on the board
 * as a plain analysis: the Engine page in Explore, lines and arrows showing.
 * Every trainer offers this with the same button, because every one of them
 * puts a position on the board that the player may want to think about
 * longer than the question lasts. The question's own rules — no annotations,
 * no engine, the hint square, trainer arrows — are dropped here; the trainer
 * itself unmounts with the Review tab and clears the rest.
 */
export function explorePosition(section = 'explore-engine') {
  const app = useAppStore.getState()
  app.setDrillSolving(false)
  app.setTrainerArrows([])
  app.setHintSquare(null)
  window.dispatchEvent(new CustomEvent(OPEN_EXPLORE_EVENT, { detail: { section } }))
}
