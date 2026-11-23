/**
 * The training layer's sounds, synthesised with Web Audio so there is nothing
 * to download: a wooden tock for a right move, a dull thud for a wrong one, a
 * two-note chime for XP, a brighter one for a quest or badge, and a short
 * rising fanfare for a promotion. Quiet by design, and one switch mutes them.
 */

export type Cue = 'right' | 'wrong' | 'xp' | 'reward' | 'promotion'

const MUTE_KEY = 'chessgod.soundMuted'
const VOLUME = 0.18

let context: AudioContext | null = null

export function isMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function setMuted(muted: boolean) {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    // A private window: the choice lasts for this visit.
  }
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  context ??= new Ctor()
  if (context.state === 'suspended') void context.resume()
  return context
}

/** A pitched note with a quick attack and an exponential tail. */
function note(
  ctx: AudioContext,
  frequency: number,
  start: number,
  length: number,
  gain: number,
  type: OscillatorType = 'sine',
) {
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, start)
  amp.gain.setValueAtTime(0, start)
  amp.gain.linearRampToValueAtTime(gain, start + 0.008)
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length)
  osc.connect(amp).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + length + 0.02)
}

/** A short filtered noise burst: the knock of a piece on a wooden board. */
function knock(ctx: AudioContext, start: number, centre: number, gain: number, length = 0.07) {
  const frames = Math.floor(ctx.sampleRate * length)
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = centre
  filter.Q.value = 4
  const amp = ctx.createGain()
  amp.gain.value = gain
  source.connect(filter).connect(amp).connect(ctx.destination)
  source.start(start)
}

export function play(cue: Cue) {
  if (isMuted()) return
  const ctx = audio()
  if (!ctx) return
  const now = ctx.currentTime + 0.01
  switch (cue) {
    case 'right':
      knock(ctx, now, 1900, VOLUME * 5)
      note(ctx, 660, now, 0.09, VOLUME * 0.5)
      break
    case 'wrong':
      knock(ctx, now, 420, VOLUME * 5, 0.11)
      note(ctx, 150, now, 0.16, VOLUME * 0.7, 'triangle')
      break
    case 'xp':
      note(ctx, 1318.5, now, 0.18, VOLUME * 0.45)
      note(ctx, 1975.5, now + 0.07, 0.24, VOLUME * 0.35)
      break
    case 'reward':
      note(ctx, 987.8, now, 0.2, VOLUME * 0.5)
      note(ctx, 1318.5, now + 0.09, 0.22, VOLUME * 0.45)
      note(ctx, 1975.5, now + 0.18, 0.4, VOLUME * 0.4)
      break
    case 'promotion':
      // A pawn walking up the file, then the new piece landing.
      ;[0, 1, 2, 3, 4, 5].forEach((step) =>
        knock(ctx, now + 0.3 + step * 0.17, 1500 + step * 120, VOLUME * 3),
      )
      note(ctx, 523.3, now + 1.4, 0.5, VOLUME * 0.5)
      note(ctx, 659.3, now + 1.48, 0.5, VOLUME * 0.45)
      note(ctx, 784, now + 1.56, 0.6, VOLUME * 0.45)
      note(ctx, 1046.5, now + 1.64, 0.9, VOLUME * 0.5)
      break
  }
}
