import { expect, it, vi } from 'vite-plus/test'

import { memoize } from './memo'

it('computes once per distinct input and forgets the oldest past its limit', () => {
  const fn = vi.fn((a: string, b: string) => `${a}+${b}`)
  const memo = memoize(fn, 2)
  expect(memo('a', 'b')).toBe('a+b')
  expect(memo('a', 'b')).toBe('a+b')
  expect(fn).toHaveBeenCalledTimes(1)
  // Joined with a separator no FEN or move contains, so these do not collide.
  expect(memo('ab', '')).toBe('ab+')
  memo('c', 'd')
  memo('a', 'b')
  expect(fn).toHaveBeenCalledTimes(4)
})
