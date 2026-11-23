import { describe, expect, it } from 'vite-plus/test'

import { variationRowClass } from './variation-tree'

describe('variationRowClass', () => {
  it('emphasizes main lines and dims branches', () => {
    expect(variationRowClass({ is_main_line: true })).toContain('move-row--main-line')
    expect(variationRowClass({ is_main_line: false })).toContain('muted')
  })
})
