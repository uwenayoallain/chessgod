import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { PanelError } from '@/components/ui/panel-error'
import { useFamilies, type FamilySummary } from '@/hooks/use-families'

function byPopularity(a: FamilySummary, b: FamilySummary) {
  return (
    b.user_game_count - a.user_game_count ||
    Number(b.is_main_line) - Number(a.is_main_line) ||
    a.display_name.localeCompare(b.display_name)
  )
}

function FamilyBranch({
  color,
  family,
  onSelect,
  selectedFamilyId,
  timeClass,
  username,
}: {
  color: 'white' | 'black' | 'both'
  family: FamilySummary
  onSelect: (family: FamilySummary) => void
  selectedFamilyId?: number | null
  timeClass: string | null
  username: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const children = useFamilies({
    username,
    color,
    timeClass,
    parentId: family.id,
    enabled: expanded,
  })
  const sortedChildren = [...children.data].sort(byPopularity)
  const selected = selectedFamilyId === family.id
  const showInitialChildLoading = children.isLoading && sortedChildren.length === 0

  return (
    <div className="family-branch">
      <div className={`family-row${selected ? ' family-row--active' : ''}`}>
        <button
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${family.display_name}`}
          aria-expanded={family.child_count ? expanded : undefined}
          className="family-row__chevron"
          disabled={!family.child_count}
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <ChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} />
        </button>
        <button className="family-row__main" onClick={() => onSelect(family)} type="button">
          <div className="family-row__title">
            <strong>{family.display_name}</strong>
            {family.eco ? <span className="badge">{family.eco}</span> : null}
          </div>
          <div className="family-row__meta">
            <span>{family.child_count} branches</span>
            <span>{family.user_game_count.toLocaleString()} games</span>
          </div>
        </button>
      </div>
      {expanded ? (
        <div className="family-branch__children">
          {showInitialChildLoading ? (
            <div className="family-row family-row--loading">Loading branches…</div>
          ) : null}
          {sortedChildren.map((child) => (
            <FamilyBranch
              color={color}
              family={child}
              key={child.id}
              onSelect={onSelect}
              selectedFamilyId={selectedFamilyId}
              timeClass={timeClass}
              username={username}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FamilyBrowser({
  color,
  onSelect,
  selectedFamilyId,
  timeClass,
  username,
}: {
  color: 'white' | 'black' | 'both'
  onSelect: (family: FamilySummary) => void
  selectedFamilyId?: number | null
  timeClass: string | null
  username: string | null
}) {
  const families = useFamilies({ username, color, timeClass })
  const sortedFamilies = [...families.data].sort(byPopularity)
  const showInitialLoading = families.isLoading && sortedFamilies.length === 0

  return (
    <Card className="family-browser">
      <CardHeader>
        <h2>Opening Families</h2>
        <div className="panel-header__meta">
          {families.isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <span className="muted">
            {showInitialLoading ? 'Loading' : `${families.data.length} roots`}
          </span>
        </div>
      </CardHeader>
      <CardBody className="family-browser__body">
        {showInitialLoading ? (
          <PanelSkeleton label="Loading opening families" rowHeight={52} rows={8} />
        ) : null}
        {families.error && !families.data.length && !families.isLoading ? (
          <PanelError error={families.error} what="your opening families" />
        ) : null}
        {!families.isLoading && !families.error && !families.data.length ? (
          <div className="rail-empty">
            <strong>No families</strong>
            <span>Nothing matches these filters.</span>
          </div>
        ) : null}
        {sortedFamilies.map((family) => (
          <FamilyBranch
            color={color}
            family={family}
            key={family.id}
            onSelect={onSelect}
            selectedFamilyId={selectedFamilyId}
            timeClass={timeClass}
            username={username}
          />
        ))}
      </CardBody>
    </Card>
  )
}
