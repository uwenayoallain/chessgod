import { Lightbulb } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import type { HintState } from '@/hooks/use-hint'

/**
 * One hint control for every trainer: a small button that gives a graded
 * hint — the kind of move, then the piece to look at — and the line it
 * produced. The line reserves its height so taking a hint never moves the
 * board or the buttons under it. `lineFirst` puts the line above the button
 * row for cards where the hint is the headline; `children` are buttons that
 * sit in the row beside it (a card's "Show solution").
 */
export function HintControl({
  hints,
  disabled,
  lineFirst = false,
  children,
}: {
  hints: HintState
  disabled?: boolean
  lineFirst?: boolean
  children?: ReactNode
}) {
  return (
    <div className={lineFirst ? 'hint-control hint-control--line-first' : 'hint-control'}>
      <div className="hint-control__row">
        <Button
          disabled={disabled || hints.pending || !hints.more}
          onClick={hints.ask}
          type="button"
          variant="ghost"
        >
          <Lightbulb size={14} />
          {hints.level === 0 ? 'Hint' : hints.more ? 'Another hint' : 'No more hints'}
        </Button>
        {children}
      </div>
      <p aria-live="polite" className="hint-control__line" data-level={hints.hint?.level}>
        {hints.hint?.text ?? (lineFirst ? 'Stuck? Take a hint.' : '\u00a0')}
      </p>
    </div>
  )
}
