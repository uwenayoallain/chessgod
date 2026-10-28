type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error'

type TelemetryEvent = {
  kind: string
  name: string
  severity?: TelemetrySeverity
  request_id?: string
  message?: string
  stack?: string
  url?: string
  duration_ms?: number
  status_code?: number
  created_at?: string
  meta?: Record<string, string | number | boolean | null | undefined>
}

const TELEMETRY_PATH = '/api/health/telemetry'
const MAX_QUEUE_SIZE = 200
const MAX_BATCH_SIZE = 20
const FLUSH_INTERVAL_MS = 2000
const LONG_TASK_THRESHOLD_MS = 200
let currentRequestId: string | null = null

const queue: TelemetryEvent[] = []
let flushTimer: number | null = null
let handlersInstalled = false

function nowIso() {
  return new Date().toISOString()
}

function getNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function getTelemetryNowMs() {
  return getNowMs()
}

export function setCurrentRequestId(requestId: string | null) {
  currentRequestId = requestId ? (sanitizeText(requestId, 128) ?? null) : null
}

export function getCurrentRequestId() {
  return currentRequestId
}

function getTelemetryUrl() {
  const baseUrl = import.meta.env.VITE_API_URL ?? ''
  return `${baseUrl}${TELEMETRY_PATH}`
}

function sanitizeText(value: string | undefined, maxLen: number) {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.slice(0, maxLen)
}

function normalizeEvent(event: TelemetryEvent): TelemetryEvent | null {
  const kind = sanitizeText(event.kind, 32)
  const name = sanitizeText(event.name, 128)
  if (!kind || !name) {
    return null
  }

  const normalized: TelemetryEvent = {
    kind,
    name,
    severity: event.severity ?? 'info',
    created_at: event.created_at ?? nowIso(),
  }

  const requestId = sanitizeText(event.request_id, 128) ?? currentRequestId ?? undefined
  if (requestId) {
    normalized.request_id = requestId
  }

  const message = sanitizeText(event.message, 1000)
  const stack = sanitizeText(event.stack, 4000)
  const url = sanitizeText(event.url, 2048)

  if (message) {
    normalized.message = message
  }
  if (stack) {
    normalized.stack = stack
  }
  if (url) {
    normalized.url = url
  }
  if (
    typeof event.duration_ms === 'number' &&
    Number.isFinite(event.duration_ms) &&
    event.duration_ms >= 0
  ) {
    normalized.duration_ms = Math.round(event.duration_ms * 100) / 100
  }
  if (typeof event.status_code === 'number') {
    normalized.status_code = event.status_code
  }
  if (event.meta && typeof event.meta === 'object') {
    normalized.meta = event.meta
  }

  return normalized
}

function scheduleFlush() {
  if (typeof window === 'undefined') {
    return
  }
  if (flushTimer !== null) {
    return
  }

  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flushEvents({ preferBeacon: false })
  }, FLUSH_INTERVAL_MS)
}

function takeBatch() {
  return queue.splice(0, Math.min(MAX_BATCH_SIZE, queue.length))
}

function requeueFront(events: TelemetryEvent[]) {
  if (!events.length) {
    return
  }
  queue.unshift(...events)
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(MAX_QUEUE_SIZE)
  }
}

function postBatch(events: TelemetryEvent[], preferBeacon: boolean) {
  if (!events.length) {
    return
  }

  const url = getTelemetryUrl()
  const payload = JSON.stringify({ events })

  if (
    preferBeacon &&
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
  ) {
    const blob = new Blob([payload], { type: 'application/json' })
    const accepted = navigator.sendBeacon(url, blob)
    if (accepted) {
      return
    }
  }

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    requeueFront(events)
    scheduleFlush()
  })
}

function flushEvents(options: { preferBeacon: boolean }) {
  const events = takeBatch()
  if (!events.length) {
    return
  }
  postBatch(events, options.preferBeacon)
  if (queue.length) {
    scheduleFlush()
  }
}

export function reportFrontendEvent(event: TelemetryEvent) {
  const normalized = normalizeEvent(event)
  if (!normalized) {
    return
  }
  queue.push(normalized)
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE)
  }

  if (queue.length >= MAX_BATCH_SIZE) {
    flushEvents({ preferBeacon: false })
    return
  }
  scheduleFlush()
}

function installLongTaskObserver() {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < LONG_TASK_THRESHOLD_MS) {
        continue
      }
      reportFrontendEvent({
        kind: 'performance',
        name: 'long_task',
        severity: 'warn',
        duration_ms: entry.duration,
        meta: {
          entry_type: entry.entryType,
          start_time_ms: Math.round(entry.startTime),
        },
      })
    }
  })

  try {
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    return
  }
}

export function installTelemetryHandlers() {
  if (handlersInstalled || typeof window === 'undefined') {
    return
  }
  handlersInstalled = true

  window.addEventListener('error', (event) => {
    reportFrontendEvent({
      kind: 'error',
      name: 'window_error',
      severity: 'error',
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      url: window.location.href,
      meta: {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    reportFrontendEvent({
      kind: 'error',
      name: 'unhandled_rejection',
      severity: 'error',
      message,
      stack,
      url: window.location.href,
    })
  })

  window.addEventListener('pagehide', () => {
    flushEvents({ preferBeacon: true })
  })

  installLongTaskObserver()
}
