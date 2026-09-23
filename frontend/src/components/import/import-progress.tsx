import { Check, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Progress } from '@/components/ui/progress'
import { formatImportProgressDetail, formatImportProgressLabel } from '@/lib/import-progress'
import { useAppStore } from '@/store/app-store'

/** How long a finished import keeps its result on screen before clearing. */
const COMPLETE_VISIBLE_MS = 8000

export function ImportProgress() {
  const progress = useAppStore((state) => state.importProgress)
  const status = useAppStore((state) => state.importStatus)
  const [dismissed, setDismissed] = useState(false)

  // An import that simply vanishes leaves the user unsure whether it worked.
  // Hold the result briefly, then clear it.
  useEffect(() => {
    if (status !== 'complete') {
      setDismissed(false)
      return
    }
    const id = window.setTimeout(() => setDismissed(true), COMPLETE_VISIBLE_MS)
    return () => window.clearTimeout(id)
  }, [status])

  const percentage = progress
    ? (((progress.archiveIndex - 1) * 1 +
        (progress.gamesInArchive > 0 ? progress.currentGameIndex / progress.gamesInArchive : 0)) /
        Math.max(progress.totalArchives, 1)) *
      100
    : 0

  const isComplete = status === 'complete'
  if (status !== 'running' && !(isComplete && progress)) {
    return null
  }
  if (isComplete && dismissed) {
    return null
  }

  const label = formatImportProgressLabel(progress, status)
  const detail = formatImportProgressDetail(progress)

  return (
    <div className={`import-bar${isComplete ? ' import-bar--complete' : ''}`} role="status">
      <div className="import-bar__info">
        {status === 'running' ? <Loader2 size={12} className="spin" /> : null}
        {isComplete ? <Check size={13} className="import-bar__done" /> : null}
        <span className="import-bar__label">{label}</span>
      </div>
      <div className="import-bar__detail">{detail}</div>
      {status === 'running' ? <Progress value={percentage} /> : null}
    </div>
  )
}
