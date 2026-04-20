import { Loader2 } from 'lucide-react'

import { Progress } from '@/components/ui/progress'
import { formatImportProgressDetail, formatImportProgressLabel } from '@/lib/import-progress'
import { useAppStore } from '@/store/app-store'

export function ImportProgress() {
  const progress = useAppStore((state) => state.importProgress)
  const status = useAppStore((state) => state.importStatus)

  const percentage = progress
    ? ((((progress.archiveIndex - 1) * 1) + (progress.gamesInArchive > 0 ? progress.currentGameIndex / progress.gamesInArchive : 0)) /
        Math.max(progress.totalArchives, 1)) *
      100
    : 0

  if (status !== 'running' && !progress) {
    return null
  }

  const label = formatImportProgressLabel(progress, status)
  const detail = formatImportProgressDetail(progress)

  return (
    <div className="import-bar">
      <div className="import-bar__info">
        {status === 'running' ? <Loader2 size={12} className="spin" /> : null}
        <span className="import-bar__label">{label}</span>
      </div>
      <div className="import-bar__detail">{detail}</div>
      {status === 'running' ? <Progress value={percentage} /> : null}
    </div>
  )
}
