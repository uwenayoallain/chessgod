export function needsEngineAnalysis(
  cachedDepth: number | null,
  requestedDepth: number,
  force = false,
) {
  if (force) {
    return true
  }

  if (cachedDepth == null) {
    return true
  }

  return cachedDepth < requestedDepth
}
