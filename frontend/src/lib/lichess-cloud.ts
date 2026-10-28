import { Chess } from 'chess.js'

const CLOUD_EVAL_URL = 'https://lichess.org/api/cloud-eval'
const DEFAULT_TIMEOUT_MS = 5_000
const MISS_TTL_MS = 6 * 60 * 60 * 1_000
const DEFAULT_RATE_LIMIT_MS = 60_000
const MAX_RATE_LIMIT_MS = 24 * 60 * 60 * 1_000
const DEFAULT_DAILY_REQUEST_LIMIT = 250
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 250
const MISS_STORAGE_PREFIX = 'chessgod.lichess-cloud-miss:'
const USAGE_STORAGE_KEY = 'chessgod.lichess-cloud-usage'

type RawCloudPv = {
  cp?: number
  mate?: number
  moves?: string
}

type RawCloudEvaluation = {
  depth?: number
  knodes?: number
  pvs?: RawCloudPv[]
}

export type LichessCloudLine = {
  evalCp: number | null
  evalMate: number | null
  moves: string[]
}

export type LichessCloudEvaluation = {
  depth: number
  knodes: number | null
  lines: LichessCloudLine[]
  source: 'lichess-cloud'
}

type FetchLike = typeof fetch

type LichessCloudClientOptions = {
  dailyRequestLimit?: number
  fetchFn?: FetchLike
  minRequestIntervalMs?: number
  now?: () => number
  timeoutMs?: number
}

type DailyUsage = {
  count: number
  date: string
}

function completeFen(fen: string): string {
  const fields = fen.trim().split(/\s+/)
  if (fields.length === 4) return `${fen} 0 1`
  return fen
}

function normalizeCastlingMove(uci: string): string {
  const castlingMoves: Record<string, string> = {
    e1h1: 'e1g1',
    e1a1: 'e1c1',
    e8h8: 'e8g8',
    e8a8: 'e8c8',
  }
  return castlingMoves[uci] ?? uci
}

/**
 * Lichess cloud PVs use UCI_Chess960 castling notation even for standard
 * chess. Convert that notation and replay the whole PV so callers never cache
 * an illegal or malformed engine line.
 */
export function normalizeLichessPv(fen: string, moves: string): string[] | null {
  try {
    const chess = new Chess(completeFen(fen))
    const normalized: string[] = []

    for (const rawMove of moves.split(/\s+/).filter(Boolean)) {
      const uci = normalizeCastlingMove(rawMove)
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci.length === 5 ? { promotion: uci[4] } : {}),
      })
      if (!move) return null
      normalized.push(uci)
    }

    return normalized.length ? normalized : null
  } catch {
    return null
  }
}

function readRetryAfter(response: Response, now: number): number {
  const value = response.headers.get('Retry-After')
  if (!value) return DEFAULT_RATE_LIMIT_MS

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(DEFAULT_RATE_LIMIT_MS, seconds * 1_000)

  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(DEFAULT_RATE_LIMIT_MS, date - now) : DEFAULT_RATE_LIMIT_MS
}

export class LichessCloudClient {
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly dailyRequestLimit: number
  private readonly minRequestIntervalMs: number
  private tail: Promise<void> = Promise.resolve()
  private lastRequestAt = 0
  private rateLimitedUntil = 0
  private rateLimitDelayMs = DEFAULT_RATE_LIMIT_MS
  private readonly misses = new Map<string, number>()
  private memoryUsage: DailyUsage = { count: 0, date: '' }

  constructor(options: LichessCloudClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.dailyRequestLimit = options.dailyRequestLimit ?? DEFAULT_DAILY_REQUEST_LIMIT
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS
  }

  evaluate(fen: string, multiPv = 1): Promise<LichessCloudEvaluation | null> {
    const requestedMultiPv = Math.max(1, Math.min(5, Math.trunc(multiPv)))
    const task = this.tail.then(() => this.fetchEvaluation(fen, requestedMultiPv))
    this.tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private missKey(fen: string, multiPv: number): string {
    return `${fen}|${multiPv}`
  }

  private getMissExpiry(key: string): number {
    const memoryExpiry = this.misses.get(key) ?? 0
    if (memoryExpiry) return memoryExpiry
    if (typeof sessionStorage === 'undefined') return 0
    try {
      const stored = Number(sessionStorage.getItem(`${MISS_STORAGE_PREFIX}${key}`))
      return Number.isFinite(stored) ? stored : 0
    } catch {
      return 0
    }
  }

  private rememberMiss(key: string): void {
    const expiry = this.now() + MISS_TTL_MS
    this.misses.set(key, expiry)
    if (typeof sessionStorage === 'undefined') return
    try {
      sessionStorage.setItem(`${MISS_STORAGE_PREFIX}${key}`, String(expiry))
    } catch {
      // Storage can be disabled; the in-memory cache is sufficient.
    }
  }

  private usageDate(now: number): string {
    return new Date(now).toISOString().slice(0, 10)
  }

  private claimDailyRequest(now: number): boolean {
    const date = this.usageDate(now)
    let usage = this.memoryUsage.date === date ? this.memoryUsage : { count: 0, date }

    if (typeof localStorage !== 'undefined') {
      try {
        const parsed = JSON.parse(
          localStorage.getItem(USAGE_STORAGE_KEY) ?? 'null',
        ) as DailyUsage | null
        if (parsed?.date === date && Number.isInteger(parsed.count)) usage = parsed
      } catch {
        // Use the in-memory counter when storage is disabled or malformed.
      }
    }

    if (usage.count >= this.dailyRequestLimit) return false
    this.memoryUsage = { count: usage.count + 1, date }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(this.memoryUsage))
      } catch {
        // The in-memory counter still bounds this tab's requests.
      }
    }
    return true
  }

  private async waitForRequestSlot(): Promise<void> {
    const waitMs = Math.max(0, this.lastRequestAt + this.minRequestIntervalMs - this.now())
    if (waitMs > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, waitMs))
    }
    this.lastRequestAt = this.now()
  }

  private async fetchEvaluation(
    fen: string,
    multiPv: number,
  ): Promise<LichessCloudEvaluation | null> {
    const now = this.now()
    if (now < this.rateLimitedUntil) return null

    const key = this.missKey(fen, multiPv)
    if (this.getMissExpiry(key) > now) return null
    if (!this.claimDailyRequest(now)) return null

    await this.waitForRequestSlot()

    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const url = new URL(CLOUD_EVAL_URL)
      url.searchParams.set('fen', fen)
      url.searchParams.set('multiPv', String(multiPv))
      const response = await this.fetchFn(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })

      if (response.status === 404) {
        this.rememberMiss(key)
        return null
      }
      if (response.status === 429) {
        const retryAfter = readRetryAfter(response, now)
        this.rateLimitDelayMs = Math.min(
          MAX_RATE_LIMIT_MS,
          Math.max(this.rateLimitDelayMs * 2, retryAfter),
        )
        this.rateLimitedUntil = now + this.rateLimitDelayMs
        return null
      }
      if (!response.ok) return null

      const raw = (await response.json()) as RawCloudEvaluation
      if (!Number.isInteger(raw.depth) || raw.depth! <= 0 || !Array.isArray(raw.pvs)) return null

      const lines = raw.pvs.slice(0, multiPv).flatMap((pv): LichessCloudLine[] => {
        if (typeof pv.moves !== 'string') return []
        const moves = normalizeLichessPv(fen, pv.moves)
        if (!moves || (typeof pv.cp !== 'number' && typeof pv.mate !== 'number')) return []
        return [
          {
            evalCp: typeof pv.cp === 'number' ? pv.cp : null,
            evalMate: typeof pv.mate === 'number' ? pv.mate : null,
            moves,
          },
        ]
      })
      if (!lines.length) return null

      this.rateLimitDelayMs = DEFAULT_RATE_LIMIT_MS
      return {
        depth: raw.depth!,
        knodes: typeof raw.knodes === 'number' ? raw.knodes : null,
        lines,
        source: 'lichess-cloud',
      }
    } catch {
      return null
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }
}

export const lichessCloudClient = new LichessCloudClient()
