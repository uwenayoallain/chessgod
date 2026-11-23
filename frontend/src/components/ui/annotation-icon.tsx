import type { CSSProperties, ReactNode } from 'react'

type AnnotationIconName = 'book' | 'check' | 'minus' | 'star' | 'thumbs-up'
type AnnotationGlyphKey = AnnotationIconName | '!!' | '?!' | '?' | '??'

type AnnotationAppearance = {
  icon?: AnnotationIconName
  symbol?: string
  title: string
  tone: string
}

const ANNOTATION_META: Record<string, AnnotationAppearance> = {
  Brilliant: {
    symbol: '!!',
    title: 'Brilliant: a sacrifice that is also the best move',
    tone: '#1baca6',
  },
  Best: {
    icon: 'star',
    title: 'Best: the engine’s top choice',
    tone: '#95bb4b',
  },
  Excellent: {
    icon: 'thumbs-up',
    title: 'Excellent: almost as good as the best move',
    tone: '#96bc4b',
  },
  Good: {
    icon: 'check',
    title: 'Good: gives up very little',
    tone: '#96af8b',
  },
  Book: {
    icon: 'book',
    title: 'Book: an opening move masters play',
    tone: '#a88865',
  },
  Inaccuracy: {
    symbol: '?!',
    title: 'Inaccuracy: loses up to a pawn',
    tone: '#f7c631',
  },
  Mistake: {
    symbol: '?',
    title: 'Mistake: loses up to two pawns',
    tone: '#ffa459',
  },
  Blunder: {
    symbol: '??',
    title: 'Blunder: loses more than two pawns',
    tone: '#fa412d',
  },
  'Missed Win': {
    icon: 'minus',
    title: 'Missed win: a winning move was there and this wasn’t it',
    tone: '#dbac16',
  },
}

/**
 * Custom bold 24x24 chess annotation glyphs designed to stay crisp and
 * optically centered from 14px move-list badges up to board corner markers.
 */
const GLYPHS: Record<AnnotationGlyphKey, ReactNode> = {
  star: (
    <path
      d="M12 3.2l2.48 5.12 5.62.74-4.11 3.9 1.03 5.58L12 15.84l-5.02 2.7 1.03-5.58-4.11-3.9 5.62-.74L12 3.2z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.2"
    />
  ),
  'thumbs-up': (
    <>
      <rect height="8.6" rx="1.3" width="3.6" x="4" y="10.4" />
      <path d="M9.1 10.6V19h7.05c1.06 0 1.97-.73 2.21-1.76l1.14-4.88c.31-1.32-.69-2.56-2.04-2.56H14.1l.65-2.96c.22-1-.38-2-1.36-2.27-.66-.19-1.37.06-1.78.62L9.1 10.6z" />
    </>
  ),
  check: (
    <path
      d="M5.4 12.6l4.2 4.3 9-9.2"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3.5"
    />
  ),
  book: (
    <path d="M11.35 6.8C9.5 5.6 7.1 5.25 4.55 5.75c-.62.12-1.05.65-1.05 1.28v9.92c0 .76.67 1.33 1.42 1.18 2.2-.42 4.34-.08 6.08 1.04.22.14.35-.02.35-.26V6.8zm1.3 0c1.85-1.2 4.25-1.55 6.8-1.05.62.12 1.05.65 1.05 1.28v9.92c0 .76-.67 1.33-1.42 1.18-2.2-.42-4.34-.08-6.08 1.04-.22.14-.35-.02-.35-.26V6.8z" />
  ),
  minus: (
    <path
      d="M7.3 7.3l9.4 9.4M16.7 7.3l-9.4 9.4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="3.5"
    />
  ),
  '!!': (
    <>
      <path d="M6.5 5.2c0-.66.54-1.2 1.2-1.2h1.4c.66 0 1.2.54 1.2 1.2l-.52 8.2c-.04.6-.54 1.06-1.15 1.06h-.46c-.61 0-1.11-.46-1.15-1.06L6.5 5.2z" />
      <circle cx="8.4" cy="18.1" r="1.9" />
      <path d="M13.7 5.2c0-.66.54-1.2 1.2-1.2h1.4c.66 0 1.2.54 1.2 1.2l-.52 8.2c-.04.6-.54 1.06-1.15 1.06h-.46c-.61 0-1.11-.46-1.15-1.06L13.7 5.2z" />
      <circle cx="15.6" cy="18.1" r="1.9" />
    </>
  ),
  '?': (
    <>
      <path
        d="M8.5 8.6C8.7 6.3 10.2 5 12.2 5c2.2 0 3.7 1.3 3.7 3.2 0 1.5-.8 2.4-2.1 3.2-1 .6-1.4 1.1-1.4 2.2v.4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.3"
      />
      <circle cx="12.2" cy="18.2" r="1.95" />
    </>
  ),
  '?!': (
    <>
      <path
        d="M5.1 8.7c.2-2 1.5-3.2 3.3-3.2 1.9 0 3.2 1.1 3.2 2.8 0 1.3-.7 2.1-1.8 2.8-.8.5-1.2 1-1.2 1.9v.3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.8"
      />
      <circle cx="8.6" cy="17.8" r="1.65" />
      <path d="M15.1 5.5c0-.6.5-1.1 1.1-1.1h.9c.6 0 1.1.5 1.1 1.1l-.42 7.7c-.03.55-.48.95-1.02.95h-.22c-.54 0-.99-.4-1.02-.95l-.42-7.7z" />
      <circle cx="16.65" cy="17.8" r="1.65" />
    </>
  ),
  '??': (
    <>
      <path
        d="M4.2 8.7c.2-2 1.4-3.2 3.2-3.2 1.8 0 3.1 1.1 3.1 2.8 0 1.3-.7 2.1-1.7 2.8-.8.5-1.2 1-1.2 1.9v.3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.7"
      />
      <circle cx="7.6" cy="17.8" r="1.6" />
      <path
        d="M13.2 8.7c.2-2 1.4-3.2 3.2-3.2 1.8 0 3.1 1.1 3.1 2.8 0 1.3-.7 2.1-1.7 2.8-.8.5-1.2 1-1.2 1.9v.3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.7"
      />
      <circle cx="16.6" cy="17.8" r="1.6" />
    </>
  ),
}

export function getAnnotationAppearance(label: string): AnnotationAppearance | null {
  return ANNOTATION_META[label] ?? null
}

export function annotationTitle(label: string): string {
  return ANNOTATION_META[label]?.title ?? label
}

export function AnnotationIcon({
  label,
  size = 14,
  fluid = false,
}: {
  label: string
  size?: number
  fluid?: boolean
}) {
  const meta = ANNOTATION_META[label]
  if (!meta) return null

  const glyphKey = (meta.icon ?? meta.symbol) as AnnotationGlyphKey
  const glyph = GLYPHS[glyphKey]
  const className = ['annotation-badge', fluid ? 'annotation-badge--fluid' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={className}
      style={
        fluid
          ? ({ '--annotation-color': meta.tone } as CSSProperties)
          : ({
              '--annotation-color': meta.tone,
              width: size,
              height: size,
            } as CSSProperties)
      }
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        {glyph}
      </svg>
    </span>
  )
}
