import { useEffect } from 'react'
import { Loader2, Pause, Play, RotateCcw } from 'lucide-react'

import {
  getSpeechState,
  restartSpeak,
  stopSpeech,
  toggleSpeak,
  useSpeechState,
  type SpeechSide,
} from '@/lib/speech'

/**
 * Play / Pause for one explanation. Paused, the button continues from the
 * word she stopped on, and a small Start over button beside it reads it again
 * from the top. The voice belongs to the button: when the button goes (a card
 * closes, the lesson moves on) or starts reading something else, what it was
 * reading stops with it.
 */
export function SpeakButton({
  id,
  text,
  label,
  compact = false,
  side,
}: {
  id: string
  text: string
  label?: string
  compact?: boolean
  /** The side the text is told from, so the voice reads "castles" for the right king. */
  side?: SpeechSide
}) {
  const { activeId, status } = useSpeechState()
  const active = activeId === id
  const loading = active && status === 'loading'
  const playing = active && status === 'playing'
  const paused = active && status === 'paused'

  useEffect(
    () => () => {
      if (getSpeechState().activeId === id) stopSpeech()
    },
    [id],
  )

  const name = loading
    ? 'Stop voice'
    : playing
      ? 'Pause voice'
      : paused
        ? 'Resume voice'
        : 'Listen to explanation'
  const title = loading ? 'Stop' : playing ? 'Pause' : paused ? 'Resume' : 'Listen'
  const size = compact ? 12 : 14
  const options = side ? { side } : undefined
  const sizeClass = compact ? ' speak-btn--compact' : ''

  return (
    <span className="speak-group">
      <button
        aria-label={name}
        aria-pressed={active}
        className={`speak-btn${sizeClass}`}
        data-state={active ? status : 'idle'}
        disabled={!text.trim()}
        onClick={(event) => {
          event.stopPropagation()
          void toggleSpeak(id, text, options)
        }}
        title={title}
        type="button"
      >
        {loading ? (
          <Loader2 aria-hidden="true" className="spin" size={size} />
        ) : playing ? (
          <Pause aria-hidden="true" size={size} />
        ) : (
          <Play aria-hidden="true" size={size} />
        )}
        {label ? <span>{active ? title : label}</span> : null}
      </button>
      {paused ? (
        <button
          aria-label="Restart voice"
          className="speak-btn speak-btn--compact"
          onClick={(event) => {
            event.stopPropagation()
            void restartSpeak(id, text, options)
          }}
          title="Start over"
          type="button"
        >
          <RotateCcw aria-hidden="true" size={12} />
        </button>
      ) : null}
    </span>
  )
}
