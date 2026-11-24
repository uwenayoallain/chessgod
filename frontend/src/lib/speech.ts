import { useSyncExternalStore } from 'react'

import { api } from '@/lib/api'
import type { BoardArrow } from '@/lib/analysis/board-guidance'
import { safeGetItem, safeSetItem } from '@/lib/storage'
import { useAppStore, type BoardHighlight } from '@/store/app-store'

/**
 * Reads a lesson's explanations aloud, one clip at a time, and lights up on
 * the board what the voice is talking about while she says it.
 *
 * The server's voice (`POST /api/study/tts/narrate`, an MP3 of a natural
 * female voice that already says "knight to f3" for Nf3) is tried first. It
 * comes with cues, the moments in the clip where a square, a file or a move is
 * named, and both are kept as an object URL plus cues so replaying a line
 * starts at once. While the clip plays, a frame loop reads the playback time
 * and hands the cues active at that moment to the board, only when they change.
 * Pausing keeps the clip where it is, so Play continues from that word.
 *
 * When the server cannot answer, or the browser refuses to play the clip, the
 * browser's own speech synthesis reads it instead, in the best English female
 * voice it has, and any square named at the current word is lit.
 * Starting a clip always stops the one before it.
 */

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'paused'

export type SpeechCueColor = 'gold' | 'blue' | 'green' | 'red'
export type SpeechCueArrow = { from: string; to: string; color: SpeechCueColor }
export type SpeechCue = {
  start_ms: number
  end_ms: number
  squares: string[]
  arrows: SpeechCueArrow[]
  color: SpeechCueColor
}
export type NarrateResponse = {
  audio_base64: string
  mime_type: string
  voice: string
  spoken_text: string
  cues: SpeechCue[]
}

export type SpeechSide = 'white' | 'black'
export type SpeechOptions = { side?: SpeechSide }

export type SpeechState = {
  activeId: string | null
  status: SpeechStatus
  /** The cues lit on the board right now. */
  activeCues: SpeechCue[]
}

/** What `POST /api/study/tts/narrate` accepts. */
export const TTS_MAX_CHARS = 1200
/** Kept under the limit so a text capped here always fits, with room for a title. */
export const SPEECH_TEXT_LIMIT = 1150
const CACHE_LIMIT = 80
const AUTO_READ_KEY = 'chessgod.study.autoRead'

const FEMALE_VOICE =
  /Ava|Jenny|Sonia|Aria|Emma|Samantha|Victoria|Karen|Moira|Serena|Allison|Zira|Google UK English Female|Female/i

/** Vivid while she says it; softer while paused, so the board shows where she stopped. */
const SPEECH_COLORS: Record<SpeechCueColor, { live: string; paused: string }> = {
  gold: { live: 'rgba(245, 184, 46, 0.92)', paused: 'rgba(245, 184, 46, 0.5)' },
  blue: { live: 'rgba(56, 152, 236, 0.88)', paused: 'rgba(56, 152, 236, 0.48)' },
  green: { live: 'rgba(76, 175, 80, 0.88)', paused: 'rgba(76, 175, 80, 0.48)' },
  red: { live: 'rgba(222, 64, 52, 0.88)', paused: 'rgba(222, 64, 52, 0.48)' },
}

const NO_CUES: SpeechCue[] = []
const IDLE: SpeechState = { activeId: null, status: 'idle', activeCues: NO_CUES }

type Clip = { url: string; cues: SpeechCue[] }

let state: SpeechState = IDLE
const listeners = new Set<() => void>()
/** Fetched clips, by side and text, oldest first. */
const clips = new Map<string, Clip>()
/** Clips on their way, so a prefetch and a Play never ask twice. */
const pending = new Map<string, Promise<Clip>>()
let audio: HTMLAudioElement | null = null
let audioCues: SpeechCue[] = NO_CUES
/** Which engine is speaking: the server's clip or the browser's own voice. */
let mode: 'audio' | 'browser' | null = null
let frame: number | null = null
/** The active cue set last handed to the board, so a frame with no change writes nothing. */
let cueKey = ''
let controller: AbortController | null = null
// Bumped by every start and stop, so a clip that arrives late knows it is no longer wanted.
let generation = 0

function setState(next: SpeechState) {
  if (
    next.activeId === state.activeId &&
    next.status === state.status &&
    next.activeCues === state.activeCues
  ) {
    return
  }
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSpeechState(): SpeechState {
  return state
}

/** Which explanation is being read, whether it is loading, playing or paused. */
export function useSpeechState(): SpeechState {
  return useSyncExternalStore(subscribe, getSpeechState, getSpeechState)
}

function cacheKey(text: string, options?: SpeechOptions): string {
  return `${options?.side ?? 'auto'}:${text}`
}

function remember(key: string, clip: Clip) {
  clips.set(key, clip)
  while (clips.size > CACHE_LIMIT) {
    const oldest = clips.keys().next().value as string
    const stale = clips.get(oldest)
    clips.delete(oldest)
    if (stale) URL.revokeObjectURL(stale.url)
  }
}

function recall(key: string): Clip | undefined {
  const clip = clips.get(key)
  if (clip) {
    // Most recently used goes to the back, so eviction drops the least used.
    clips.delete(key)
    clips.set(key, clip)
  }
  return clip
}

/** Forget every fetched clip. For tests, and for nothing else. */
export function clearSpeechCache() {
  for (const clip of clips.values()) URL.revokeObjectURL(clip.url)
  clips.clear()
  pending.clear()
}

/** The board's marks for a set of cues: squares lit and arrows drawn, each once. */
export function speechOverlay(
  cues: SpeechCue[],
  paused = false,
): { highlights: BoardHighlight[]; arrows: BoardArrow[] } {
  const tone = paused ? 'paused' : 'live'
  const highlights: BoardHighlight[] = []
  const arrows: BoardArrow[] = []
  const squares = new Set<string>()
  const lines = new Set<string>()
  for (const cue of cues) {
    const color = (SPEECH_COLORS[cue.color] ?? SPEECH_COLORS.gold)[tone]
    for (const square of cue.squares) {
      if (squares.has(square)) continue
      squares.add(square)
      highlights.push({ square, color })
    }
    for (const arrow of cue.arrows) {
      const key = `${arrow.from}-${arrow.to}`
      if (lines.has(key)) continue
      lines.add(key)
      arrows.push({
        startSquare: arrow.from,
        endSquare: arrow.to,
        color: (SPEECH_COLORS[arrow.color] ?? SPEECH_COLORS.gold)[tone],
      })
    }
  }
  return { highlights, arrows }
}

function showCues(cues: SpeechCue[], paused = false) {
  const { highlights, arrows } = speechOverlay(cues, paused)
  useAppStore.getState().setSpeechOverlay(highlights, arrows)
}

function clearOverlay() {
  cueKey = ''
  useAppStore.getState().setSpeechOverlay([], [])
}

/**
 * Light each cue slightly before its word is spoken so the eye is already on
 * the square when the voice names it, while still holding through `end_ms`.
 */
export const SPEECH_CUE_LEAD_MS = 260

/** Light the cues active at `ms`, writing to the board only when that set changes. */
function syncCues(ms: number) {
  const leadMs = ms + SPEECH_CUE_LEAD_MS
  const active: SpeechCue[] = []
  const at: number[] = []
  audioCues.forEach((cue, index) => {
    if (cue.start_ms <= leadMs && ms <= cue.end_ms) {
      active.push(cue)
      at.push(index)
    }
  })
  const key = at.join(',')
  if (key === cueKey) return
  cueKey = key
  showCues(active)
  setState({ ...state, activeCues: active.length ? active : NO_CUES })
}

function stopLoop() {
  if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  frame = null
}

function startLoop(token: number) {
  stopLoop()
  const clip = audio
  if (!clip) return
  syncCues(clip.currentTime * 1000)
  if (typeof requestAnimationFrame !== 'function') return
  const tick = () => {
    if (token !== generation || audio !== clip || clip.paused) {
      frame = null
      return
    }
    syncCues(clip.currentTime * 1000)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}

/** Cut `text` to `max` characters at the last sentence end, or failing that the last space. */
export function capSpeechText(text: string, max = SPEECH_TEXT_LIMIT): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (sentence > max / 2) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut).trim()
}

const PIECES: Record<string, string> = {
  K: 'king',
  Q: 'queen',
  R: 'rook',
  B: 'bishop',
  N: 'knight',
}

/**
 * Chess notation as words, for a browser voice that would otherwise read
 * "Nf3" as a word. The server does this itself; this is the fallback's copy.
 */
export function chessNotationForFallback(text: string): string {
  return text
    .replace(
      /(?<![\w-])[O0]-[O0]-[O0](?![\w-])([+#])?/g,
      (_, mark?: string) =>
        `castles queenside${mark === '#' ? ', checkmate' : mark === '+' ? ', check' : ''}`,
    )
    .replace(
      /(?<![\w-])[O0]-[O0](?![\w-])([+#])?/g,
      (_, mark?: string) =>
        `castles kingside${mark === '#' ? ', checkmate' : mark === '+' ? ', check' : ''}`,
    )
    .replace(/(\d+)\.\.\.\s*/g, '$1, ')
    .replace(/(\d+)\.(?=[KQRBNa-h])/g, '$1. ')
    .replace(
      /(?<![A-Za-z0-9])([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?([+#])?(?![A-Za-z0-9])/g,
      (
        match: string,
        piece: string | undefined,
        file: string | undefined,
        rank: string | undefined,
        capture: string | undefined,
        square: string,
        promotion: string | undefined,
        mark: string | undefined,
      ) => {
        // A bare square ("e4") already reads well.
        if (!piece && !file && !rank && !capture && !promotion && !mark) return match
        const words: string[] = []
        if (piece) words.push(PIECES[piece])
        if (file || rank) words.push(`${file ?? ''}${rank ?? ''}`)
        if (capture) words.push('takes')
        words.push(square)
        if (promotion) words.push(`promotes to ${PIECES[promotion]}`)
        let spoken = words.join(' ')
        if (mark === '+') spoken += ', check'
        if (mark === '#') spoken += ', checkmate'
        return spoken
      },
    )
}

/** The best English female voice the browser offers, or any English one. */
export function pickFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'))
  const pool = english.length > 0 ? english : voices
  return pool.find((voice) => FEMALE_VOICE.test(voice.name)) ?? english[0]
}

function synth(): SpeechSynthesis | null {
  try {
    if (typeof window === 'undefined') return null
    return window.speechSynthesis ?? null
  } catch {
    return null
  }
}

/** The squares named in the word that starts at `index` of `text`. */
export function squaresAtWord(text: string, index: number): string[] {
  const word = /^\S+/.exec(text.slice(index))?.[0] ?? ''
  return [...word.matchAll(/(?<![A-Za-z0-9])([a-h][1-8])(?![0-9])/g)].map((found) => found[1])
}

function speakInBrowser(id: string, text: string, token: number) {
  const engine = synth()
  if (!engine || typeof SpeechSynthesisUtterance === 'undefined') {
    setState(IDLE)
    return
  }
  const spoken = chessNotationForFallback(text)
  const utterance = new SpeechSynthesisUtterance(spoken)
  const voice = pickFemaleVoice(engine.getVoices?.() ?? [])
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  } else {
    utterance.lang = 'en-US'
  }
  utterance.rate = 0.98
  utterance.pitch = 1.04
  // A square stays lit until the voice names another one or the sentence ends.
  let sentenceOver = false
  utterance.onboundary = (event: SpeechSynthesisEvent) => {
    if (token !== generation || (event.name && event.name !== 'word')) return
    const squares = squaresAtWord(spoken, event.charIndex)
    const word = /^\S+/.exec(spoken.slice(event.charIndex))?.[0] ?? ''
    if (squares.length) {
      const cue: SpeechCue = {
        start_ms: 0,
        end_ms: 0,
        squares,
        arrows: [],
        color: 'gold',
      }
      cueKey = `word:${event.charIndex}`
      showCues([cue], state.status === 'paused')
      setState({ ...state, activeCues: [cue] })
    } else if (sentenceOver && cueKey) {
      clearOverlay()
      setState({ ...state, activeCues: NO_CUES })
    }
    sentenceOver = /[.!?]["')]*$/.test(word)
  }
  const finish = () => {
    if (token !== generation) return
    mode = null
    clearOverlay()
    setState(IDLE)
  }
  utterance.onend = finish
  utterance.onerror = finish
  engine.cancel()
  mode = 'browser'
  engine.speak(utterance)
  setState({ activeId: id, status: 'playing', activeCues: NO_CUES })
}

function decodeClip(data: NarrateResponse): Clip {
  const binary = atob(data.audio_base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  const blob = new Blob([bytes], { type: data.mime_type || 'audio/mpeg' })
  return { url: URL.createObjectURL(blob), cues: Array.isArray(data.cues) ? data.cues : [] }
}

/** Ask the server for a clip once, however many callers want it at the same time. */
function requestClip(
  key: string,
  text: string,
  options: SpeechOptions | undefined,
  signal?: AbortSignal,
): Promise<Clip> {
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const body: { text: string; side?: SpeechSide } = { text }
  if (options?.side) body.side = options.side
  const request = api
    .post<NarrateResponse>('/api/study/tts/narrate', body, signal ? { signal } : {})
    .then((response) => {
      const clip = decodeClip(response.data)
      remember(key, clip)
      return clip
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
  pending.set(key, request)
  return request
}

/** Settle with `promise`, or reject the moment `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('canceled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('canceled'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function fetchClip(
  key: string,
  text: string,
  options: SpeechOptions | undefined,
  signal: AbortSignal,
): Promise<Clip> {
  const cached = recall(key)
  if (cached) return cached
  const inFlight = pending.get(key)
  // A prefetch already asked: wait for it, but let Stop end the wait.
  if (inFlight) return untilAborted(inFlight, signal)
  return requestClip(key, text, options, signal)
}

/**
 * Fetch a clip ahead of time, so its Play starts from memory. Silent: it never
 * touches what is being read, and a failure only means Play asks again.
 */
export function prefetchSpeech(text: string, options?: SpeechOptions): Promise<void> {
  const spoken = capSpeechText(text, TTS_MAX_CHARS)
  if (!spoken) return Promise.resolve()
  const key = cacheKey(spoken, options)
  if (clips.has(key)) return Promise.resolve()
  return requestClip(key, spoken, options).then(
    () => undefined,
    () => undefined,
  )
}

/** Stop whatever is being read, at once, and drop any clip still on its way. */
export function stopSpeech() {
  generation += 1
  controller?.abort()
  controller = null
  stopLoop()
  if (audio) {
    audio.onended = null
    audio.onerror = null
    audio.ontimeupdate = null
    try {
      audio.pause()
      audio.currentTime = 0
    } catch {
      // A clip that never started has nothing to pause.
    }
    audio = null
  }
  audioCues = NO_CUES
  try {
    synth()?.cancel()
  } catch {
    // Nothing is being spoken.
  }
  mode = null
  clearOverlay()
  setState(IDLE)
}

/** Play the clip on the board from where it stands now, lighting cues as they come. */
async function playClip(id: string, clip: HTMLAudioElement, token: number) {
  await clip.play()
  if (token !== generation) return
  cueKey = ''
  setState({ activeId: id, status: 'playing', activeCues: state.activeCues })
  startLoop(token)
}

/** Read `text` aloud as `id` from the start, stopping anything read before it. */
export async function speak(id: string, text: string, options?: SpeechOptions): Promise<void> {
  stopSpeech()
  const spoken = capSpeechText(text, TTS_MAX_CHARS)
  if (!spoken) return
  const token = generation
  const abort = new AbortController()
  controller = abort
  setState({ activeId: id, status: 'loading', activeCues: NO_CUES })
  try {
    const fetched = await fetchClip(cacheKey(spoken, options), spoken, options, abort.signal)
    if (token !== generation) return
    controller = null
    const clip = new Audio(fetched.url)
    audio = clip
    audioCues = fetched.cues
    mode = 'audio'
    const end = () => {
      if (token !== generation) return
      stopLoop()
      audio = null
      audioCues = NO_CUES
      mode = null
      clearOverlay()
      setState(IDLE)
    }
    clip.onended = end
    clip.onerror = end
    // Backs up the frame loop, which a hidden tab stops running.
    clip.ontimeupdate = () => {
      if (token === generation && !clip.paused) syncCues(clip.currentTime * 1000)
    }
    await playClip(id, clip, token)
  } catch {
    // Stopped while loading: nothing more to do.
    if (token !== generation || abort.signal.aborted) return
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.ontimeupdate = null
      audio = null
    }
    audioCues = NO_CUES
    controller = null
    clearOverlay()
    speakInBrowser(id, spoken, token)
  }
}

/** Hold the voice where it is, keeping what she was pointing at softly lit. */
function pauseSpeech() {
  if (mode === 'audio' && audio) {
    stopLoop()
    try {
      audio.pause()
    } catch {
      // Nothing to pause.
    }
  } else if (mode === 'browser') {
    try {
      synth()?.pause()
    } catch {
      // The browser cannot pause; it keeps reading.
    }
  } else {
    return
  }
  if (state.activeCues.length) showCues(state.activeCues, true)
  setState({ ...state, status: 'paused' })
}

/** Carry on from exactly where the voice was paused. */
async function resumeSpeech(): Promise<void> {
  const id = state.activeId
  if (!id) return
  const token = generation
  if (mode === 'audio' && audio) {
    try {
      await playClip(id, audio, token)
    } catch {
      if (token === generation) stopSpeech()
    }
    return
  }
  if (mode === 'browser') {
    try {
      synth()?.resume()
    } catch {
      stopSpeech()
      return
    }
    if (state.activeCues.length) showCues(state.activeCues)
    setState({ ...state, status: 'playing' })
  }
}

/**
 * Play / Pause for one explanation: pause `id` while it plays, continue it
 * from the same word while paused, cancel it while it loads, and otherwise
 * read it from the start.
 */
export function toggleSpeak(id: string, text: string, options?: SpeechOptions): Promise<void> {
  if (state.activeId === id) {
    if (state.status === 'playing') {
      pauseSpeech()
      return Promise.resolve()
    }
    if (state.status === 'paused') return resumeSpeech()
    stopSpeech()
    return Promise.resolve()
  }
  return speak(id, text, options)
}

/** Read `id` again from its first word. */
export async function restartSpeak(
  id: string,
  text: string,
  options?: SpeechOptions,
): Promise<void> {
  if (state.activeId === id && mode === 'audio' && audio) {
    const token = generation
    const clip = audio
    stopLoop()
    try {
      clip.currentTime = 0
    } catch {
      // A clip with nothing loaded is already at its start.
    }
    cueKey = ''
    clearOverlay()
    setState({ ...state, activeCues: NO_CUES })
    try {
      await playClip(id, clip, token)
    } catch {
      if (token === generation) stopSpeech()
    }
    return
  }
  return speak(id, text, options)
}

/** Whether lessons read each new explanation aloud by themselves. Off unless chosen. */
export function readAutoRead(): boolean {
  return safeGetItem(AUTO_READ_KEY) === 'true'
}

export function writeAutoRead(enabled: boolean) {
  safeSetItem(AUTO_READ_KEY, enabled ? 'true' : 'false')
}
