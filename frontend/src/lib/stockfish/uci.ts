export type EngineScore = {
  type: 'cp' | 'mate'
  value: number
}

export type UCIInfo = {
  depth: number
  seldepth: number | null
  multipv: number
  score: EngineScore
  nodes: number | null
  nps: number | null
  time: number | null
  pv: string[]
}

function matchInt(line: string, key: string): number | null {
  const re = new RegExp(`\\b${key} (\\d+)`)
  const m = line.match(re)
  return m ? Number.parseInt(m[1], 10) : null
}

export function parseUCIInfoLine(line: string): UCIInfo | null {
  const depthMatch = line.match(/\bdepth (\d+)/)
  const multipvMatch = line.match(/\bmultipv (\d+)/)
  const cpMatch = line.match(/\bscore cp (-?\d+)/)
  const mateMatch = line.match(/\bscore mate (-?\d+)/)
  const pvIndex = line.indexOf(' pv ')

  // Aspiration-search bounds are not exact evaluations. Publishing them as
  // scores can invent blunders and poison persisted training evidence.
  if (
    !depthMatch ||
    pvIndex === -1 ||
    (!cpMatch && !mateMatch) ||
    /\b(?:lowerbound|upperbound)\b/.test(line)
  ) {
    return null
  }

  const pv = line
    .slice(pvIndex + 4)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!pv.length) {
    return null
  }

  return {
    depth: Number.parseInt(depthMatch[1], 10),
    seldepth: matchInt(line, 'seldepth'),
    multipv: multipvMatch ? Number.parseInt(multipvMatch[1], 10) : 1,
    score: mateMatch
      ? { type: 'mate', value: Number.parseInt(mateMatch[1], 10) }
      : { type: 'cp', value: cpMatch ? Number.parseInt(cpMatch[1], 10) : 0 },
    nodes: matchInt(line, 'nodes'),
    nps: matchInt(line, 'nps'),
    time: matchInt(line, 'time'),
    pv,
  }
}
