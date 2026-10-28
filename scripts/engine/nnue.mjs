import { createHash } from 'node:crypto'

export const PINNED_NNUE = 'nn-1a298aa575a0.nnue'

/** Match the browser's filename/hash integrity contract without a download. */
export function verifyNnueBytes(filename, bytes) {
  const expected = /^nn-([a-f0-9]{12})\.nnue$/.exec(filename)?.[1]
  if (!expected) throw new Error('Invalid NNUE filename')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (!actual.startsWith(expected)) throw new Error(`NNUE integrity check failed for ${filename}`)
  return bytes
}
