import { Search, X } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { useOpeningGroups } from '@/hooks/use-workspace-data'
import type { OpeningSelection } from '@/hooks/use-board-workspace'
import { formatGameDate } from '@/lib/format-date'

export const OpeningGroupsPanel = memo(function OpeningGroupsPanel({
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
  const [filterQuery, setFilterQuery] = useState('')

  useEffect(() => {
    setPage(1)
    setFilterQuery('')
  }, [username, color, timeClass])

  const { data, isLoading, isRefreshing, error } = useOpeningGroups(
    username,
    color,
    timeClass,
    page,
    20,
    Boolean(username),
  )
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.per_page ?? 20)))
  const selectedKey = selectedOpening
    ? `${selectedOpening.eco ?? ''}:${selectedOpening.openingName}`
    : null

  const filteredOpenings = useMemo(() => {
    const list = data?.openings ?? []
    if (!filterQuery.trim()) return list
    const q = filterQuery.toLowerCase().trim()
    return list.filter(
      (op) =>
        op.opening_name.toLowerCase().includes(q) || (op.eco && op.eco.toLowerCase().includes(q)),
    )
  }, [data?.openings, filterQuery])

  return (
    <Card>
      <CardHeader>
        <h2>Your openings</h2>
        <div className="panel-header__meta">
          {isRefreshing || isLoadingPreview ? (
            <span className="refresh-badge">Updating</span>
          ) : null}
          <span className="muted">{(data?.total ?? 0).toLocaleString()} openings</span>
        </div>
      </CardHeader>
      <CardBody className="column">
        {previewError ? <div className="form-error">{previewError}</div> : null}
        {error ? <div className="form-error">{error}</div> : null}

        {!isLoading && (data?.openings.length ?? 0) > 0 ? (
          <div className="workspace-filter-box">
            <Search size={13} className="muted" />
            <input
              aria-label="Filter openings"
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter by name or ECO (e.g. Italian, C47)..."
              type="text"
              value={filterQuery}
            />
            {filterQuery ? (
              <button
                aria-label="Clear filter"
                onClick={() => setFilterQuery('')}
                style={{
                  padding: 2,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                }}
                type="button"
              >
                <X size={12} className="muted" />
              </button>
            ) : null}
          </div>
        ) : null}

        {isLoading ? <PanelSkeleton label="Loading your openings" rowHeight={52} rows={8} /> : null}
        {!isLoading && !error && !data?.openings.length ? (
          <div className="rail-empty">
            <strong>No openings</strong>
            <span>Nothing matches these filters.</span>
          </div>
        ) : null}

        {!isLoading && !error && data?.openings.length && !filteredOpenings.length ? (
          <div className="rail-empty">
            <strong>No matching openings</strong>
            <span>No openings match &ldquo;{filterQuery}&rdquo;.</span>
          </div>
        ) : null}

        {filteredOpenings.map((opening) => {
          const key = `${opening.eco ?? ''}:${opening.opening_name}`
          const totalGames = opening.game_count || 1
          const winRate = Math.round((opening.wins / totalGames) * 100)
          const winPct = (opening.wins / totalGames) * 100
          const drawPct = (opening.draws / totalGames) * 100
          const lossPct = (opening.losses / totalGames) * 100

          return (
            <button
              key={key}
              className={`move-row move-row--button${selectedKey === key ? ' move-row--active' : ''}`}
              onClick={() =>
                onSelectOpening({ eco: opening.eco, openingName: opening.opening_name })
              }
              type="button"
            >
              <div className="workspace-list__title">
                <strong>{opening.opening_name}</strong>
                {opening.eco ? <span className="badge">{opening.eco}</span> : null}
              </div>
              <div className="workspace-list__meta">
                <span>{opening.game_count.toLocaleString()} games</span>
                <span
                  className={`opening-winrate-badge ${winRate >= 50 ? 'opening-winrate-badge--positive' : ''}`}
                >
                  {winRate}% win ({opening.wins}W·{opening.draws}D·{opening.losses}L)
                </span>
                <span>{formatGameDate(opening.latest_played_at)}</span>
              </div>
              <div
                className="score-distribution-bar"
                title={`${opening.wins}W · ${opening.draws}D · ${opening.losses}L`}
              >
                <div
                  className="score-distribution-bar__segment score-distribution-bar__segment--win"
                  style={{ width: `${winPct}%` }}
                />
                <div
                  className="score-distribution-bar__segment score-distribution-bar__segment--draw"
                  style={{ width: `${drawPct}%` }}
                />
                <div
                  className="score-distribution-bar__segment score-distribution-bar__segment--loss"
                  style={{ width: `${lossPct}%` }}
                />
              </div>
            </button>
          )
        })}

        <div className="workspace-pagination">
          <Button
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
            type="button"
            variant="ghost"
          >
            Previous
          </Button>
          <span className="muted">
            Page {page} of {totalPages}
          </span>
          <Button
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
            type="button"
            variant="ghost"
          >
            Next
          </Button>
        </div>
      </CardBody>
    </Card>
  )
})
