import type { Quest, QuestBoard, QuestSection } from './types'

/** Where each quest's "Go" takes the player. */
export const QUEST_TARGETS: Record<
  QuestSection,
  { tab: 'review' | 'explore'; section: string; label: string }
> = {
  threats: { tab: 'review', section: 'review-threats', label: 'Blunder Check' },
  openings: { tab: 'review', section: 'review-rush', label: 'Opening Rush' },
  drills: { tab: 'review', section: 'review-drills', label: 'Drills' },
  quiz: { tab: 'review', section: 'review-opening-quiz', label: 'Opening quiz' },
  review: { tab: 'explore', section: 'explore-library', label: 'Pick a game' },
  play: { tab: 'explore', section: 'explore-sparring', label: 'Play' },
}

export function questsDone(board: QuestBoard): number {
  return board.items.filter((item) => item.done).length
}

/** One line under the list: what is left, and what the chest is worth. */
export function questSummary(board: QuestBoard): string {
  const done = questsDone(board)
  const left = board.items.length - done
  if (board.all_done) return `All ${board.items.length} done. New quests tomorrow.`
  if (!done) return `Clear all three for a +${board.chest_xp} XP chest.`
  return `${left} to go for the +${board.chest_xp} XP chest.`
}

/** Quests paid between two profiles, and whether the chest opened: the moments to celebrate. */
export function newQuestRewards(
  previous: QuestBoard | undefined,
  next: QuestBoard,
): { quests: Quest[]; chest: boolean } {
  // A new day is a new board: nothing on it was just finished by the last write.
  if (!previous || previous.date !== next.date) return { quests: [], chest: false }
  const paid = new Set(previous.items.filter((item) => item.claimed).map((item) => item.key))
  return {
    quests: next.items.filter((item) => item.claimed && !paid.has(item.key)),
    chest: next.chest_opened && !previous.chest_opened,
  }
}
