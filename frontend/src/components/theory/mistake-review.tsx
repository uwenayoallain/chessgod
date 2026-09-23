import { useMemo, useState } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import type { Mistake } from '@/hooks/use-family-detail'
import { useAppStore } from '@/store/app-store'

type SortMode = 'severity' | 'occurrences'

const severityRank: Record<string, number> = { blunder: 3, mistake: 2, inaccuracy: 1 }

type Group = {
  key: string
  name: string
  mistakes: Mistake[]
  blunders: number
  mistakesCount: number
  inaccuracies: number
  occurrences: number
  score: number
}

function groupByOpening(mistakes: Mistake[]): Group[] {
  const map = new Map<string, Group>()
  for (const m of mistakes) {
    const name = m.family_name ?? 'Unclassified'
    const key = m.family_id != null ? `f:${m.family_id}` : `n:${name}`
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        name,
        mistakes: [],
        blunders: 0,
        mistakesCount: 0,
        inaccuracies: 0,
        occurrences: 0,
        score: 0,
      }
      map.set(key, g)
    }
    g.mistakes.push(m)
    if (m.severity === 'blunder') g.blunders += 1
    else if (m.severity === 'mistake') g.mistakesCount += 1
    else g.inaccuracies += 1
    g.occurrences += m.occurrences
  }
  for (const g of map.values()) {
    g.score = g.blunders * 3 + g.mistakesCount * 2 + g.inaccuracies
    g.mistakes.sort(
      (a, b) =>
        (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) ||
        b.eval_drop_cp - a.eval_drop_cp,
    )
  }
  return Array.from(map.values()).sort((a, b) => b.score - a.score)
}

/**
 * Single recurring-mistake surface: opening-grouped triage (the old "Needs Work"
 * lens) that expands to the exact positions + moves (the old Theory→Mistakes
 * lens), backed by /api/theory/mistakes (engine cp-loss + master deviation).
 */
export function MistakeReview({
  error,
  isRefreshing = false,
  isLoading = false,
  mistakes,
  title = 'Mistakes',
  emptyHint = 'No recurring engine mistakes for this scope yet. Import games and run analysis.',
}: {
  error?: unknown
  isRefreshing?: boolean
  isLoading?: boolean
  mistakes: Mistake[]
  title?: string
  emptyHint?: string
}) {
  const [sortMode, setSortMode] = useState<SortMode>('severity')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const pushPosition = useAppStore((state) => state.pushPosition)

  const groups = useMemo(() => {
    const g = groupByOpening(mistakes)
    if (sortMode === 'occurrences') {
      return [...g].sort((a, b) => b.occurrences - a.occurrences)
    }
    return g
  }, [mistakes, sortMode])

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Card className="mistake-review">
      <CardHeader>
        <h2>{title}</h2>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          {mistakes.length ? <span className="muted">{mistakes.length} found</span> : null}
          <select
            aria-label="Sort mistakes"
            className="select"
            onChange={(event) => setSortMode(event.target.value as SortMode)}
            value={sortMode}
          >
            <option value="severity">Severity</option>
            <option value="occurrences">Occurrences</option>
          </select>
        </div>
      </CardHeader>
      <CardBody className="column">
        {error && !groups.length ? (
          <PanelError error={error} what="your repeat mistakes" />
        ) : !groups.length ? (
          isLoading ? (
            <PanelSkeleton label="Loading your repeat mistakes" rows={6} />
          ) : (
            <div className="rail-empty">
              <strong>No repeat mistakes</strong>
              <span>{emptyHint}</span>
            </div>
          )
        ) : null}
        {groups.map((group) => {
          // Auto-open when there's only one group so the user isn't staring at a
          // single collapsed "Unclassified (80)" row.
          const isOpen = expanded.has(group.key) || groups.length === 1
          return (
            <div className="column" key={group.key} style={{ gap: 4 }}>
              <button
                aria-expanded={isOpen}
                className="move-row move-row--button"
                onClick={() => toggle(group.key)}
                type="button"
              >
                <div className="workspace-list__title">
                  <strong>
                    {isOpen ? '▾ ' : '▸ '}
                    {group.name}
                  </strong>
                  <span className="badge">{group.mistakes.length}</span>
                </div>
                <div className="workspace-list__meta">
                  {group.blunders > 0 ? (
                    <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                      {group.blunders} blunder
                    </span>
                  ) : null}
                  {group.mistakesCount > 0 ? (
                    <span style={{ color: 'var(--warning)' }}>{group.mistakesCount} mistake</span>
                  ) : null}
                  {group.inaccuracies > 0 ? <span>{group.inaccuracies} inacc.</span> : null}
                  <span>{group.occurrences}x total</span>
                </div>
              </button>
              {isOpen
                ? group.mistakes.map((mistake) => (
                    <button
                      className="move-row move-row--button"
                      key={`${mistake.parent_fen}:${mistake.user_move.uci}`}
                      onClick={() => pushPosition(mistake.parent_fen)}
                      style={{ marginLeft: 16 }}
                      type="button"
                    >
                      <div className="workspace-list__title">
                        <strong>{mistake.user_move.san}</strong>
                        <span className="badge">{mistake.severity}</span>
                      </div>
                      <div className="workspace-list__meta">
                        <span>{mistake.eval_drop_cp}cp drop</span>
                        <span>{mistake.occurrences}x</span>
                        <span>best {mistake.best_move.san}</span>
                      </div>
                    </button>
                  ))
                : null}
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}
