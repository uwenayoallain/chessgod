import { describe, expect, it } from 'vite-plus/test'

import { QUEST_TARGETS } from '@/lib/training/quests'
import { SECTION_VIEWS } from './review-panel'

describe('review views', () => {
  it('gives every linked review section a home view, so "Go" can switch to it', () => {
    // Quest "Go" buttons, the Today card's week teaser and the points card's
    // course link all reach sections through revealSection; a section with no
    // view assigned would be unreachable from another view.
    const linked = [
      ...Object.values(QUEST_TARGETS)
        .filter((target) => target.tab === 'review')
        .map((target) => target.section),
      'review-week',
      'review-course',
      'review-threats',
    ]
    for (const section of linked) {
      expect(SECTION_VIEWS[section], section).toBeDefined()
    }
  })
})
