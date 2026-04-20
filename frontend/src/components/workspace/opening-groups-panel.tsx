import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useOpeningGroups } from '@/hooks/use-workspace-data'
import type { OpeningSelection } from '@/hooks/use-board-workspace'

function formatGameDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function OpeningGroupsPanel({
  username,
  color,
  timeClass,
  selectedOpening,
  isLoadingPreview,
  previewError,
  onSelectOpening,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  selectedOpening: OpeningSelection | null
  isLoadingPreview: boolean
  previewError: string | null
  onSelectOpening: (opening: OpeningSelection) => void
}) {
  const [page, setPage] = useState(1)

  useEffect(() => {
    setPage(1)
  }, [username, color, timeClass])

  const { data, isLoading, error } = useOpeningGroups(username, color, timeClass, page, 20, Boolean(username))
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.per_page ?? 20)))
  const selectedKey = selectedOpening ? `${selectedOpening.eco ?? ''}:${selectedOpening.openingName}` : null

  return (
    <Card>
      <CardHeader>
        <h2>Cached Openings</h2>
        <span className="muted">{data?.total ?? 0} openings</span>
      </CardHeader>
      <CardBody className="column">
        {previewError ? <div className="empty-state__message">{previewError}</div> : null}
        {isLoadingPreview ? <div className="muted">Loading opening preview…</div> : null}
        {error ? <div className="empty-state__message">{error}</div> : null}
        {isLoading ? <div className="muted">Loading openings…</div> : null}
        {!isLoading && !error && !data?.openings.length ? <div className="muted">No opening groups found for the current filters.</div> : null}

        {data?.openings.map((opening) => {
          const key = `${opening.eco ?? ''}:${opening.opening_name}`
          return (
            <button
              key={key}
              className={`move-row move-row--button${selectedKey === key ? ' move-row--active' : ''}`}
              onClick={() => onSelectOpening({ eco: opening.eco, openingName: opening.opening_name })}
              type="button"
            >
              <div className="workspace-list__title">
                <strong>{opening.opening_name}</strong>
                {opening.eco ? <span className="badge">{opening.eco}</span> : null}
              </div>
              <div className="workspace-list__meta">
                <span>{opening.game_count} games</span>
                <span>{formatGameDate(opening.latest_played_at)}</span>
              </div>
            </button>
          )
        })}

        <div className="workspace-pagination">
          <Button disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button" variant="ghost">
            Previous
          </Button>
          <span className="muted">Page {page} of {totalPages}</span>
          <Button disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)} type="button" variant="ghost">
            Next
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
