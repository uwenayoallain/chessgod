// Node clamps invalid/overflowing delays to 1ms. Fail before loading WASM
// instead of silently discarding every expensive analysis on a bad setting.
const MAX_TIMER_MS = 2 ** 31 - 1

export function engineTimeouts(env = process.env) {
  function read(name, fallback) {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
      throw new Error(`${name} must be a positive integer no greater than ${MAX_TIMER_MS} milliseconds`)
    }
    return value
  }
  const search = read('ENGINE_SEARCH_TIMEOUT_MS', 180_000)
  const grace = read('ENGINE_STOP_GRACE_MS', 15_000)
  if (search + grace > MAX_TIMER_MS) {
    throw new Error(`Combined engine search timeout and stop grace must not exceed ${MAX_TIMER_MS} milliseconds`)
  }
  return { search, grace }
}
