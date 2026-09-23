import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getApiErrorMessage } from '@/lib/api-errors'

/**
 * A panel whose request failed. Distinct from `EmptyState`, which means the
 * request succeeded and there was nothing in it — reporting a failure as
 * "nothing found" tells the user a fact about their chess that is not true.
 */
export function PanelError({
  error,
  what,
  onRetry,
}: {
  error: unknown
  /** What could not be loaded, as a noun phrase: "your repertoire". */
  what: string
  onRetry?: () => void
}) {
  const detail = getApiErrorMessage(error, '')

  return (
    <div className="panel-error" role="alert">
      <AlertTriangle aria-hidden="true" size={15} />
      <div>
        <strong>Could not load {what}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      {onRetry ? (
        <Button onClick={onRetry} type="button">
          Try again
        </Button>
      ) : null}
    </div>
  )
}
