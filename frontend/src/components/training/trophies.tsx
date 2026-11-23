import { defaultPieces } from 'react-chessboard'

import {
  BADGE_ART,
  crestSvg,
  emblemSvg,
  medalSvg,
  type EmblemName,
} from '@/lib/training/emblem-art'

/**
 * The training layer's own pieces: a level is a medallion holding the board's
 * own piece for the player's title, and a badge is a medallion with one icon.
 * Gold means earned (`--reward`); green still means "do this".
 */

const TITLE_PIECES: Record<string, keyof typeof defaultPieces> = {
  Pawn: 'wP',
  Knight: 'wN',
  Bishop: 'wB',
  Rook: 'wR',
  Queen: 'wQ',
  King: 'wK',
}

export function TitlePiece({ title, side = 'w' }: { title: string; side?: 'w' | 'b' }) {
  const key = `${side}${(TITLE_PIECES[title] ?? 'wP').slice(1)}` as keyof typeof defaultPieces
  const Piece = defaultPieces[key]
  return (
    <svg aria-hidden="true" className="title-piece" viewBox="0 0 45 45">
      <Piece fill={side === 'w' ? 'var(--piece-white)' : 'var(--piece-black)'} />
    </svg>
  )
}

/** A level: the medal frame with the title's piece, progress filling the rim. */
export function PieceCrest({
  title,
  level,
  progress,
  size = 56,
  showLevel = true,
}: {
  title: string
  level: number
  progress: number
  size?: number
  showLevel?: boolean
}) {
  return (
    <span
      aria-label={`Level ${level}, ${title}`}
      className="crest"
      role="img"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="crest__art"
        // Static art from emblem-art.ts, never user input.
        dangerouslySetInnerHTML={{ __html: crestSvg(title, progress) }}
      />
      {showLevel ? <span className="crest__level">{level}</span> : null}
    </span>
  )
}

/** One of the set's emblems, inline: quests, the chest, the streak, card icons. */
export function Emblem({
  name,
  size = 20,
  className,
}: {
  name: EmblemName
  size?: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={className ? `emblem ${className}` : 'emblem'}
      // Static art from emblem-art.ts, never user input.
      dangerouslySetInnerHTML={{ __html: emblemSvg(name) }}
      style={{ width: size, height: size }}
    />
  )
}

/**
 * A badge as a medal from the set: gold rim and a dark-square face when
 * earned, pewter with an arc for how close it is when locked, tier pips on
 * the rim.
 */
export function BadgeMedallion({
  badge,
  earned,
  progress = 0,
  size = 44,
}: {
  badge: string
  earned: boolean
  /** How far toward it, 0-1: a locked badge shows it as an arc. */
  progress?: number
  size?: number
}) {
  const art = BADGE_ART[badge] ?? { emblem: 'cup' as EmblemName }
  return (
    <span
      aria-hidden="true"
      className="medallion"
      data-earned={earned || undefined}
      dangerouslySetInnerHTML={{
        __html: medalSvg(art.emblem, { earned, tier: art.tier, progress }),
      }}
      style={{ width: size, height: size }}
    />
  )
}

/**
 * A medal for anything with progress: the emblem says what it is, the arc
 * how far along, and gold that it is done. Badges, course lines and the
 * course itself share it, so "learned" looks the same everywhere.
 */
export function Medal({
  emblem,
  earned,
  progress,
  size = 44,
  label,
}: {
  emblem: EmblemName
  earned: boolean
  progress: number
  size?: number
  /** Said to screen readers; the medal itself is a picture. */
  label: string
}) {
  return (
    <span
      aria-label={label}
      className="medallion"
      data-earned={earned || undefined}
      dangerouslySetInnerHTML={{ __html: medalSvg(emblem, { earned, progress }) }}
      role="img"
      style={{ width: size, height: size }}
    />
  )
}
