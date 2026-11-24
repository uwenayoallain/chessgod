// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  capSpeechText,
  chessNotationForFallback,
  clearSpeechCache,
  getSpeechState,
  pickFemaleVoice,
  prefetchSpeech,
  readAutoRead,
  restartSpeak,
  speak,
  squaresAtWord,
  stopSpeech,
  toggleSpeak,
  writeAutoRead,
  type SpeechCue,
} from '@/lib/speech'
import { useAppStore } from '@/store/app-store'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { post } }))

/** A stand-in for HTMLAudioElement: play resolves unless told otherwise. */
class FakeAudio {
  static instances: FakeAudio[] = []
  static failPlay = false
  src: string
  paused = true
  currentTime = 0
  plays = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  constructor(src: string) {
    this.src = src
    FakeAudio.instances.push(this)
  }
  play() {
    if (FakeAudio.failPlay) return Promise.reject(new Error('NotAllowedError'))
    this.paused = false
    this.plays += 1
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  /** Move the clip to `seconds` and tell the page, as a playing clip does. */
  at(seconds: number) {
    this.currentTime = seconds
    this.ontimeupdate?.()
  }
}

class FakeUtterance {
  text: string
  voice: { name: string; lang: string } | null = null
  lang = ''
  rate = 1
  pitch = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  onboundary: ((event: { charIndex: number; name?: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

const voices = [
  { name: 'Google US English Male', lang: 'en-US' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Anna', lang: 'de-DE' },
]
const synth = {
  speak: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getVoices: vi.fn(() => voices),
}

const cues: SpeechCue[] = [
  { start_ms: 0, end_ms: 400, squares: ['e4'], arrows: [], color: 'gold' },
  {
    start_ms: 900,
    end_ms: 1600,
    squares: ['f5'],
    arrows: [{ from: 'd4', to: 'f5', color: 'blue' }],
    color: 'blue',
  },
]

function narrated(extra: Partial<{ cues: SpeechCue[] }> = {}) {
  return {
    data: {
      audio_base64: btoa('mp3'),
      mime_type: 'audio/mpeg',
      voice: 'en-US-AvaNeural',
      spoken_text: 'e4 pawn. Knight to f5.',
      cues,
      ...extra,
    },
  }
}

let urls = 0
const createObjectURL = vi.fn((_blob: Blob) => `blob:clip-${++urls}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  urls = 0
  FakeAudio.instances = []
  FakeAudio.failPlay = false
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  // The frame loop is driven by hand through `timeupdate` here.
  vi.stubGlobal('requestAnimationFrame', undefined)
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  post.mockResolvedValue(narrated())
})

afterEach(() => {
  stopSpeech()
  clearSpeechCache()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  window.localStorage.clear()
})

function board() {
  const { speechHighlights, speechArrows } = useAppStore.getState()
  return { speechHighlights, speechArrows }
}

describe('speak', () => {
  it('fetches the narrated clip with its cues, decodes it and plays it', async () => {
    const pending = speak('a', 'Play Nf3.', { side: 'black' })
    expect(getSpeechState()).toMatchObject({ activeId: 'a', status: 'loading' })
    await pending

    expect(post).toHaveBeenCalledWith(
      '/api/study/tts/narrate',
      { text: 'Play Nf3.', side: 'black' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('audio/mpeg')
    expect(await blob.text()).toBe('mp3')
    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0].src).toBe('blob:clip-1')
    expect(getSpeechState()).toMatchObject({ activeId: 'a', status: 'playing' })

    FakeAudio.instances[0].onended?.()
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
  })

  it('sends no side when none is given', async () => {
    await speak('a', 'Take the centre.')
    expect(post.mock.calls[0][1]).toEqual({ text: 'Take the centre.' })
  })

  it('lights the squares and arrows she names, as she names them', async () => {
    await speak('a', 'e4 pawn. Knight to f5.')
    const clip = FakeAudio.instances[0]
    expect(board().speechHighlights).toEqual([{ square: 'e4', color: 'rgba(245, 184, 46, 0.92)' }])
    expect(getSpeechState().activeCues).toEqual([cues[0]])

    // Between cues the board is clear; then the knight's square lights slightly
    // ahead of the word (start_ms = 900ms lights at 700ms with the 260ms lead).
    clip.at(0.6)
    expect(board()).toEqual({ speechHighlights: [], speechArrows: [] })
    clip.at(0.7)
    expect(board().speechHighlights).toEqual([{ square: 'f5', color: 'rgba(56, 152, 236, 0.88)' }])
    expect(board().speechArrows).toEqual([
      { startSquare: 'd4', endSquare: 'f5', color: 'rgba(56, 152, 236, 0.88)' },
    ])

    // The same cue on the next tick writes nothing to the board.
    const before = useAppStore.getState().speechHighlights
    clip.at(1.2)
    expect(useAppStore.getState().speechHighlights).toBe(before)

    clip.onended?.()
    expect(board()).toEqual({ speechHighlights: [], speechArrows: [] })
  })

  it('replays the same text from its cached clip without asking again', async () => {
    await speak('a', 'Take the centre.')
    await speak('b', 'Take the centre.')
    expect(post).toHaveBeenCalledTimes(1)
    expect(FakeAudio.instances.map((clip) => clip.src)).toEqual(['blob:clip-1', 'blob:clip-1'])
  })

  it('caches a clip per side', async () => {
    await speak('a', 'Castle.', { side: 'white' })
    await speak('a', 'Castle.', { side: 'black' })
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('keeps at most 80 clips and revokes the oldest one', async () => {
    for (let at = 0; at < 81; at += 1) await speak('a', `Line ${at}.`)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:clip-1')
  })

  it('stops at once and aborts a clip still on its way', async () => {
    let signal: AbortSignal | undefined
    post.mockImplementation(
      (_url: string, _body: unknown, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = config.signal
          config.signal.addEventListener('abort', () => reject(new Error('canceled')))
        }),
    )
    const pending = speak('a', 'Slow clip.')
    stopSpeech()
    await pending

    expect(signal?.aborted).toBe(true)
    expect(FakeAudio.instances).toHaveLength(0)
    expect(synth.speak).not.toHaveBeenCalled()
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
  })

  it('stops the clip before it when a new one starts', async () => {
    await speak('a', 'First.')
    const first = FakeAudio.instances[0]
    await toggleSpeak('b', 'Second.')
    expect(first.paused).toBe(true)
    expect(getSpeechState().activeId).toBe('b')
  })

  it('cancels a clip still loading when its button is pressed again', async () => {
    post.mockImplementation(
      (_url: string, _body: unknown, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          config.signal.addEventListener('abort', () => reject(new Error('canceled')))
        }),
    )
    const pending = toggleSpeak('a', 'Slow clip.')
    await toggleSpeak('a', 'Slow clip.')
    await pending
    expect(getSpeechState().status).toBe('idle')
  })

  it('pauses where she is and resumes from that word, without asking again', async () => {
    await speak('a', 'e4 pawn. Knight to f5.')
    const clip = FakeAudio.instances[0]
    clip.at(1.2)

    await toggleSpeak('a', 'e4 pawn. Knight to f5.')
    expect(clip.paused).toBe(true)
    expect(clip.currentTime).toBe(1.2)
    expect(getSpeechState().status).toBe('paused')
    // What she was pointing at stays on the board, softer.
    expect(board().speechHighlights).toEqual([{ square: 'f5', color: 'rgba(56, 152, 236, 0.48)' }])

    await toggleSpeak('a', 'e4 pawn. Knight to f5.')
    expect(clip.paused).toBe(false)
    expect(clip.plays).toBe(2)
    expect(clip.currentTime).toBe(1.2)
    expect(post).toHaveBeenCalledTimes(1)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(getSpeechState().status).toBe('playing')
    expect(board().speechHighlights).toEqual([{ square: 'f5', color: 'rgba(56, 152, 236, 0.88)' }])
  })

  it('starts over from the first word on Restart', async () => {
    await speak('a', 'e4 pawn. Knight to f5.')
    const clip = FakeAudio.instances[0]
    clip.at(1.2)
    await toggleSpeak('a', 'e4 pawn. Knight to f5.')

    await restartSpeak('a', 'e4 pawn. Knight to f5.')
    expect(clip.currentTime).toBe(0)
    expect(clip.paused).toBe(false)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(getSpeechState().status).toBe('playing')
    expect(board().speechHighlights).toEqual([{ square: 'e4', color: 'rgba(245, 184, 46, 0.92)' }])
  })

  it('clears the board and rewinds when stopped', async () => {
    await speak('a', 'e4 pawn. Knight to f5.')
    const clip = FakeAudio.instances[0]
    clip.at(1.2)
    stopSpeech()
    expect(clip.paused).toBe(true)
    expect(clip.currentTime).toBe(0)
    expect(board()).toEqual({ speechHighlights: [], speechArrows: [] })
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
  })

  it('falls back to a female browser voice when the server answers 503', async () => {
    post.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 }))
    await speak('a', 'Answer 5.Qxd4 with 5...Qf6 and then O-O.')

    expect(synth.speak).toHaveBeenCalledTimes(1)
    const utterance = synth.speak.mock.calls[0][0] as FakeUtterance
    expect(utterance.voice?.name).toMatch(/Zira/)
    expect(utterance.rate).toBe(0.98)
    expect(utterance.pitch).toBe(1.04)
    expect(utterance.text).toBe(
      'Answer 5. queen takes d4 with 5, queen f6 and then castles kingside.',
    )
    expect(getSpeechState()).toMatchObject({ activeId: 'a', status: 'playing' })

    utterance.onend?.()
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })
  })

  it('pauses, resumes and lights named squares with the browser voice', async () => {
    post.mockRejectedValue(new Error('offline'))
    await speak('a', 'Push e4. Then Nf3 here.')
    const utterance = synth.speak.mock.calls[0][0] as FakeUtterance
    expect(utterance.text).toBe('Push e4. Then knight f3 here.')

    utterance.onboundary?.({ charIndex: 5, name: 'word' })
    expect(board().speechHighlights).toEqual([{ square: 'e4', color: 'rgba(245, 184, 46, 0.92)' }])
    // The sentence ended on "e4.", so the next plain word clears it.
    utterance.onboundary?.({ charIndex: 9, name: 'word' })
    expect(board().speechHighlights).toEqual([])
    utterance.onboundary?.({ charIndex: 21, name: 'word' })
    expect(board().speechHighlights).toEqual([{ square: 'f3', color: 'rgba(245, 184, 46, 0.92)' }])

    await toggleSpeak('a', 'Push e4. Then Nf3 here.')
    expect(synth.pause).toHaveBeenCalledTimes(1)
    expect(getSpeechState().status).toBe('paused')
    await toggleSpeak('a', 'Push e4. Then Nf3 here.')
    expect(synth.resume).toHaveBeenCalledTimes(1)
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(getSpeechState().status).toBe('playing')

    utterance.onend?.()
    expect(board()).toEqual({ speechHighlights: [], speechArrows: [] })
  })

  it('falls back to the browser voice when the clip will not play', async () => {
    FakeAudio.failPlay = true
    await speak('a', 'Blocked autoplay.')
    expect(synth.speak).toHaveBeenCalledTimes(1)
  })
})

describe('prefetchSpeech', () => {
  it('fills the cache so Play starts from memory without asking again', async () => {
    await prefetchSpeech('Knight to f5.', { side: 'white' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(getSpeechState()).toEqual({ activeId: null, status: 'idle', activeCues: [] })

    await toggleSpeak('a', 'Knight to f5.', { side: 'white' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(getSpeechState()).toMatchObject({ activeId: 'a', status: 'playing' })
  })

  it('asks once while a prefetch is still on its way, and swallows failures', async () => {
    let answer: (value: unknown) => void = () => {}
    post.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const first = prefetchSpeech('Slow.')
    const second = prefetchSpeech('Slow.')
    const playing = speak('a', 'Slow.')
    answer(narrated())
    await Promise.all([first, second, playing])
    expect(post).toHaveBeenCalledTimes(1)
    expect(getSpeechState().status).toBe('playing')

    post.mockRejectedValueOnce(new Error('offline'))
    await expect(prefetchSpeech('Other.')).resolves.toBeUndefined()
  })
})

describe('squares at a word', () => {
  it('reads the squares named in one word', () => {
    expect(squaresAtWord('Push e4. Then', 5)).toEqual(['e4'])
    expect(squaresAtWord('Push e4. Then', 0)).toEqual([])
  })
})

describe('chess notation for the browser voice', () => {
  it('reads moves as words', () => {
    expect(chessNotationForFallback('Nf3')).toBe('knight f3')
    expect(chessNotationForFallback('Bxc6+')).toBe('bishop takes c6, check')
    expect(chessNotationForFallback('O-O-O')).toBe('castles queenside')
    expect(chessNotationForFallback('O-O')).toBe('castles kingside')
    expect(chessNotationForFallback('exd5 and e8=Q#')).toBe(
      'e takes d5 and e8 promotes to queen, checkmate',
    )
    expect(chessNotationForFallback('Take the centre with e4.')).toBe('Take the centre with e4.')
  })
})

describe('helpers', () => {
  it('prefers a named English female voice', () => {
    expect(pickFemaleVoice(voices as SpeechSynthesisVoice[])?.name).toMatch(/Zira/)
    expect(pickFemaleVoice([voices[0]] as SpeechSynthesisVoice[])?.name).toBe(
      'Google US English Male',
    )
  })

  it('caps long text at a sentence end', () => {
    const text = `${'A short sentence here. '.repeat(80)}`
    const capped = capSpeechText(text)
    expect(capped.length).toBeLessThanOrEqual(1150)
    expect(capped.endsWith('.')).toBe(true)
  })

  it('remembers auto-read, off by default', () => {
    expect(readAutoRead()).toBe(false)
    writeAutoRead(true)
    expect(readAutoRead()).toBe(true)
    writeAutoRead(false)
    expect(readAutoRead()).toBe(false)
  })
})
