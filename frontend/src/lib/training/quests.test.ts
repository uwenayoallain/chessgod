import { describe, expect, it } from 'vite-plus/test'

import { newQuestRewards, questSummary } from './quests'
import type { Quest, QuestBoard } from './types'

function quest(key: string, extra: Partial<Quest> = {}): Quest {
  return {
    key,
    title: key,
    section: 'threats',
    target: 3,
    progress: 0,
    done: false,
    claimed: false,
    xp: 10,
    ...extra,
  }
}

function board(items: Quest[], extra: Partial<QuestBoard> = {}): QuestBoard {
  return {
    date: '2026-09-30',
    items,
    all_done: items.every((item) => item.done),
    chest_xp: 20,
    chest_opened: false,
    ...extra,
  }
}

describe('quests', () => {
  it('says what is left and what the chest is worth', () => {
    expect(questSummary(board([quest('a'), quest('b'), quest('c')]))).toBe(
      'Clear all three for a +20 XP chest.',
    )
    expect(questSummary(board([quest('a', { done: true }), quest('b'), quest('c')]))).toBe(
      '2 to go for the +20 XP chest.',
    )
    const cleared = [
      quest('a', { done: true }),
      quest('b', { done: true }),
      quest('c', { done: true }),
    ]
    expect(questSummary(board(cleared))).toBe('All 3 done. New quests tomorrow.')
  })

  it('celebrates only what the last write paid, and nothing across midnight', () => {
    const before = board([quest('a', { done: true, claimed: true }), quest('b'), quest('c')])
    const after = board(
      [
        quest('a', { done: true, claimed: true }),
        quest('b', { done: true, claimed: true }),
        quest('c', { done: true, claimed: true }),
      ],
      { chest_opened: true },
    )
    const rewards = newQuestRewards(before, after)
    expect(rewards.quests.map((item) => item.key)).toEqual(['b', 'c'])
    expect(rewards.chest).toBe(true)
    expect(newQuestRewards(undefined, after)).toEqual({ quests: [], chest: false })
    expect(newQuestRewards({ ...before, date: '2026-09-29' }, after)).toEqual({
      quests: [],
      chest: false,
    })
  })
})
