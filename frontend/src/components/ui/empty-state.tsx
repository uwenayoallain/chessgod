import type { ReactNode } from 'react'

import { Emblem } from '@/components/training/trophies'

/** Says what is missing and what fills it, in one line each. */
export function EmptyState({
  glyph = <Emblem name="pawn" size={34} />,
  title,
  message,
  hint,
  action,
}: {
  glyph?: ReactNode
  title: string
  message: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {glyph}
      </div>
      <div className="empty-state__title">{title}</div>
      <div className="empty-state__message">{message}</div>
      {hint ? <div className="empty-state__hint">{hint}</div> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  )
}
