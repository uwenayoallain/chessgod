import { useState } from 'react'

import { ColorBreakdown } from '@/components/dashboard/color-breakdown'
import { StatsOverview } from '@/components/dashboard/stats-overview'
import { TimeClassChart } from '@/components/dashboard/time-class-chart'
import { TopOpenings } from '@/components/dashboard/top-openings'
import { ImprovementTrainer } from '@/components/improvement/improvement-trainer'
import { OpeningQuiz } from '@/components/openings/opening-quiz'
import { DeviationTable } from '@/components/theory/deviation-table'
import { EngineAnalyzeBatch } from '@/components/theory/engine-analyze-batch'
import { FamilyBrowser } from '@/components/theory/family-browser'
import { FamilyDetail } from '@/components/theory/family-detail'
import { MistakeReview } from '@/components/theory/mistake-review'
import { RepertoireTree } from '@/components/theory/repertoire-tree'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { CollapsibleSection } from '@/components/ui/collapsible-section'
import type { FamilySummary } from '@/hooks/use-families'
import { useGameStats } from '@/hooks/use-game-stats'
import { useMistakes } from '@/hooks/use-mistakes'
import { useRepertoire } from '@/hooks/use-repertoire'
import { useTheoryDeviations } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'

type ReviewScope = {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
}

function NeedsWorkSection({ username, color, timeClass }: ReviewScope) {
  const mistakes = useMistakes({ username, color, timeClass, enabled: true })
  return (
    <MistakeReview
      error={mistakes.error}
      isLoading={mistakes.isLoading}
      isRefreshing={mistakes.isRefreshing}
      mistakes={mistakes.data}
      title="Repeat mistakes"
      emptyHint="Run the engine over your games under Analysis Coverage first."
    />
  )
}

function OpeningsHealthSection({ username, color, timeClass }: ReviewScope) {
  const [selectedFamilyId, setSelectedFamilyId] = useState<number | null>(null)
  const pushPosition = useAppStore((state) => state.pushPosition)

  function selectFamily(family: FamilySummary) {
    setSelectedFamilyId(family.id)
    pushPosition(family.root_fen)
  }

  return (
    <div className="theory-browse-grid">
      <FamilyBrowser
        color={color}
        onSelect={selectFamily}
        selectedFamilyId={selectedFamilyId}
        timeClass={timeClass}
        username={username}
      />
      <FamilyDetail
        color={color}
        familyId={selectedFamilyId}
        onSelectFamily={selectFamily}
        timeClass={timeClass}
        username={username}
      />
    </div>
  )
}

function RepertoireSection({ username, color }: ReviewScope) {
  const theoryColor = color === 'black' ? 'black' : 'white'
  const repertoire = useRepertoire(username, theoryColor)
  return (
    <Card>
      <CardHeader>
        <h2>Repertoire</h2>
        <div className="panel-header__meta">
          {repertoire.isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <span className="muted">{theoryColor}</span>
        </div>
      </CardHeader>
      <CardBody>
        {repertoire.error && !repertoire.data ? (
          <PanelError error={repertoire.error} what="your repertoire" />
        ) : repertoire.data ? (
          <RepertoireTree color={theoryColor} root={repertoire.data.root} username={username} />
        ) : (
          <PanelSkeleton label="Loading your repertoire" rows={10} />
        )}
      </CardBody>
    </Card>
  )
}

function DeviationScanSection({ color }: ReviewScope) {
  const theoryColor = color === 'black' ? 'black' : 'white'
  const deviations = useTheoryDeviations(theoryColor)
  return (
    <DeviationTable
      deviations={deviations.data}
      error={deviations.error}
      isLoading={deviations.isLoading}
      isRefreshing={deviations.isRefreshing}
    />
  )
}

function StatsSection({
  username,
  importStatus,
  timeClass,
}: {
  username: string
  importStatus: string
  timeClass: string | null
}) {
  const {
    data: stats,
    isRefreshing,
    error,
    refetch,
  } = useGameStats(username, importStatus, timeClass)
  if (error && !stats) {
    return <PanelError error={error} onRetry={() => void refetch()} what="your stats" />
  }
  if (!stats) return <PanelSkeleton label="Loading your stats" rowHeight={90} rows={4} />
  return (
    <div className="stats-layout">
      {isRefreshing ? <div className="refresh-badge">Updating</div> : null}
      <StatsOverview stats={stats} />
      <div className="stats-panel-grid">
        <ColorBreakdown stats={stats} />
        <TimeClassChart byTimeClass={stats.by_time_class} />
        <TopOpenings openings={stats.by_opening} />
      </div>
    </div>
  )
}

/**
 * "Review" tab: account-level insight — recurring mistakes, analysis coverage,
 * opening-family health, repertoire, master-deviation scan, and stats. Each
 * section mounts (and therefore fetches) only while open.
 */
export function ReviewPanel({
  username,
  color,
  timeClass,
  importStatus,
  onBeginDrill,
  onPlayOut,
}: ReviewScope & {
  importStatus: string
  onBeginDrill?: () => void
  onPlayOut?: (position: { fen: string; lastUci: string | null }) => void
}) {
  const scope = { username, color, timeClass }

  return (
    <div className="theory-stack">
      <ImprovementTrainer
        color={color}
        onBeginDrill={onBeginDrill}
        onPlayOut={onPlayOut}
        timeClass={timeClass}
        username={username}
      />

      <CollapsibleSection
        defaultOpen={false}
        description="Your own opening positions, asked against the master book"
        id="review-opening-quiz"
        title="Opening Quiz"
      >
        <OpeningQuiz
          color={color}
          onBegin={onBeginDrill}
          timeClass={timeClass}
          username={username}
        />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="Mistakes you have made more than once, grouped by opening"
        id="review-needs-work"
        title="Needs Work"
      >
        <NeedsWorkSection {...scope} />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="How much of your library the engine has judged, and how to add more"
        id="review-coverage"
        title="Analysis Coverage"
      >
        <EngineAnalyzeBatch color={color} timeClass={timeClass} username={username} />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="Every opening family you play, and how it scores"
        id="review-openings"
        title="Openings Health"
      >
        <OpeningsHealthSection {...scope} />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="Your main lines, and the moves you mean to play"
        id="review-repertoire"
        title="Repertoire"
      >
        <RepertoireSection {...scope} />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="Where your choices part company with master practice"
        id="review-deviations"
        title="Theory Deviations"
      >
        <DeviationScanSection {...scope} />
      </CollapsibleSection>

      <CollapsibleSection
        defaultOpen={false}
        description="Results by color, time control and opening"
        id="review-stats"
        title="Stats"
      >
        <StatsSection importStatus={importStatus} timeClass={timeClass} username={username} />
      </CollapsibleSection>
    </div>
  )
}
