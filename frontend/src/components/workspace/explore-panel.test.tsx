import { describe, expect, it } from 'vite-plus/test'

import { QUEST_TARGETS } from '@/lib/training/quests'
import { EXPLORE_PAGE_IDS } from './explore-panel'

describe('explore pages', () => {
  it('gives every link into Explore a page to land on', () => {
    // Quests ("Pick a game", "Play"), the Today card's "Review it" and the
    // drill trainer's "Play it out" all switch to an Explore page by id; an id
    // with no page would switch tabs and show nothing new.
    const linked = [
      ...Object.values(QUEST_TARGETS)
        .filter((target) => target.tab === 'explore')
        .map((target) => target.section),
      'explore-game-review',
    ]
    for (const id of linked) expect(EXPLORE_PAGE_IDS, id).toContain(id)
  })
})
