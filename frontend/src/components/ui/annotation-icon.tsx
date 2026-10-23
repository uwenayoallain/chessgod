import { BookOpen, Check, Minus, Star, ThumbsUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

type AnnotationIconName = 'book' | 'check' | 'minus' | 'star' | 'thumbs-up'

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

const ICONS: Record<AnnotationIconName, LucideIcon> = {
  book: BookOpen,
  check: Check,
  minus: Minus,
  star: Star,
  'thumbs-up': ThumbsUp,
}

export function getAnnotationAppearance(label: string): AnnotationAppearance | null {
  return ANNOTATION_META[label] ?? null
}

export function annotationTitle(label: string): string {
  return ANNOTATION_META[label]?.title ?? label
}

export function AnnotationIcon({ label, size = 14 }: { label: string; size?: number }) {
  const meta = ANNOTATION_META[label]
  if (!meta) return null

  const fontSize = meta.symbol && meta.symbol.length > 1 ? size * 0.5 : size * 0.58
  const Icon = meta.icon ? ICONS[meta.icon] : null

  return (
    <span
      className="annotation-badge"
      style={
        {
          '--annotation-color': meta.tone,
          width: size,
          height: size,
          fontSize,
          lineHeight: `${size}px`,
        } as CSSProperties
      }
    >
      {Icon ? <Icon aria-hidden="true" size={size * 0.62} strokeWidth={3} /> : meta.symbol}
    </span>
  )
}
