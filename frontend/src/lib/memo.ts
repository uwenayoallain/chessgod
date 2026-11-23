/**
 * A bounded memo for pure functions of strings. The board helpers here load a
 * chess.js board per call (a few milliseconds each) and were called again for
 * the same position on every render and every engine info line.
 */
export function memoize<Args extends string[], Result>(
  fn: (...args: Args) => Result,
  limit = 1_024,
): (...args: Args) => Result {
  const cache = new Map<string, Result>()
  return (...args: Args) => {
    const key = args.join('\u0000')
    if (cache.has(key)) return cache.get(key)!
    const result = fn(...args)
    if (cache.size >= limit) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
    return result
  }
}
