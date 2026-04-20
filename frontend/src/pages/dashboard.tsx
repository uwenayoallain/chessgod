import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BoardRail } from '@/components/board/board-rail'
import { ChessBoard } from '@/components/board/chess-board'
import { WorkspaceTabs } from '@/components/board/workspace-tabs'
import { DeviationList } from '@/components/analysis/deviation-list'
import { EngineLines } from '@/components/analysis/engine-lines'
import { ColorBreakdown } from '@/components/dashboard/color-breakdown'
import { StatsOverview } from '@/components/dashboard/stats-overview'
import { TimeClassChart } from '@/components/dashboard/time-class-chart'
import { TopOpenings } from '@/components/dashboard/top-openings'
import { OpeningRecommendations } from '@/components/explorer/opening-recommendations'
import { ImportProgress } from '@/components/import/import-progress'
import { UsernameForm } from '@/components/import/username-form'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { DeviationTable } from '@/components/theory/deviation-table'
import { TheoryComparison } from '@/components/theory/theory-comparison'
import { MoveTreePanel } from '@/components/tree/move-tree-panel'
import { OpeningGroupsPanel } from '@/components/workspace/opening-groups-panel'
import { GameListPanel } from '@/components/workspace/game-list-panel'
import { useBoardWorkspace } from '@/hooks/use-board-workspace'
import { useEngine } from '@/hooks/use-engine'
import { useGameStats } from '@/hooks/use-game-stats'
import { useImportSummary } from '@/hooks/use-import-summary'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { useTheory, useTheoryDeviations } from '@/hooks/use-theory'
import { getAppAccessState } from '@/lib/app-access'
import { getDashboardLayoutStorage, readDashboardLayout, writeDashboardLayout } from '@/lib/dashboard-layout'
import { useAppStore } from '@/store/app-store'

export default function Dashboard() {
  const username = useAppStore((state) => state.username)
  const status = useAppStore((state) => state.importStatus)
  const { data: summary, isLoading: isSummaryLoading } = useImportSummary(username, status)
  const access = getAppAccessState({
    username,
    isLoading: isSummaryLoading && !summary,
    totalGames: summary?.total_games ?? null,
  })

  if (access.state !== 'ready') {
    return (
      <div className="page landing-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
        <div style={{ maxWidth: '480px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <Card>
            <CardHeader>
              <h2>{access.state === 'loading' ? 'Loading Your Chess Library' : 'Build Your Local Chess Library'}</h2>
            </CardHeader>
            <CardBody className="column">
              <div className="muted" style={{ lineHeight: 1.6 }}>
                {access.state === 'loading'
                  ? 'Checking local stats so your dashboard can render without flashing empty state.'
                  : 'Start with a Chess.com username. Games are written to the database while the import runs, so you can stop and resume without losing what already landed.'}
              </div>
            </CardBody>
          </Card>
          {access.state === 'loading' ? null : (
            <div className="column" style={{ gap: '16px' }}>
              <UsernameForm />
              <ImportProgress />
            </div>
          )}
        </div>
      </div>
    )
  }

  return <Workspace username={username!} />
}

function Workspace({ username }: { username: string }) {
  const currentFen = useAppStore((state) => state.currentFen)
  const colorFilter = useAppStore((state) => state.colorFilter)
  const timeClassFilter = useAppStore((state) => state.timeClassFilter)
  const status = useAppStore((state) => state.importStatus)

  const workspace = useBoardWorkspace({ username, color: colorFilter, timeClass: timeClassFilter })
  const { isAnalyzing, lines, statusMessage } = useEngine()
  const annotations = useMoveAnnotations()
  const { data: theoryData } = useTheory(currentFen)
  const theoryColor = colorFilter === 'black' ? 'black' as const : 'white' as const
  const { data: deviations, isLoading: isDeviationsLoading } = useTheoryDeviations(theoryColor)
  const { data: stats } = useGameStats(username, status)

  const [initialLayout] = useState(() => readDashboardLayout(getDashboardLayoutStorage()))
  const [activeTab, setActiveTab] = useState(initialLayout.activeTab)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialLayout.sidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(initialLayout.sidebarWidth)
  const [railWidth, setRailWidth] = useState(initialLayout.railWidth)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const isResizing = useRef(false)

  useEffect(() => {
    writeDashboardLayout(getDashboardLayoutStorage(), {
      activeTab,
      railWidth,
      sidebarCollapsed,
      sidebarWidth,
    })
  }, [activeTab, railWidth, sidebarCollapsed, sidebarWidth])

  const handleRailResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    let lastX = e.clientX

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      setRailWidth((prev) => Math.min(400, Math.max(160, prev - delta)))
    }

    function onMouseUp() {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    let lastX = e.clientX

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      setSidebarWidth((prev) => Math.min(800, Math.max(260, prev - delta)))
    }

    function onMouseUp() {
      isResizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const deviationRows = useMemo(
    () =>
      annotations
        .filter((a) => a.cpLoss != null && a.label != null)
        .filter(
          (a) =>
            a.label === 'Inaccuracy' ||
            a.label === 'Mistake' ||
            a.label === 'Blunder',
        )
        .map((a) => ({
          fen: a.fen,
          userMove: a.san,
          bestMove: a.bestMove ?? 'Unknown',
          cpLoss: a.cpLoss ?? 0,
        })),
    [annotations],
  )

  const hasTheoryContent = Boolean(
    theoryData?.user_moves.length || theoryData?.master_moves.length || deviations.length || isDeviationsLoading,
  )

  const loadedContextLabel = workspace.activeGame
    ? 'Clear Game'
    : workspace.selectedOpening
      ? 'Clear Opening'
      : null

  const effectiveSidebarWidth = sidebarCollapsed ? '120px' : `${sidebarWidth}px`

  return (
    <div className="page">
      <div
        className="workspace"
        ref={workspaceRef}
        style={{
          '--sidebar-width': effectiveSidebarWidth,
          '--rail-width': `${railWidth}px`,
        } as React.CSSProperties}
      >
        <div className="workspace__board-shell">
          <div className="workspace__board-panel">
            <ChessBoard
              activeGame={workspace.activeGame}
              selectedOpening={workspace.selectedOpening}
              onClearContext={workspace.clearLoadedContext}
              username={username}
            />
          </div>
          <div className="resize-handle" onMouseDown={handleRailResizeStart} />
          <BoardRail
            loadedContextLabel={loadedContextLabel}
            onClearLoadedContext={workspace.clearLoadedContext}
            showColorFilter
            showTimeClassFilter
          />
        </div>
        <div className="resize-handle" onMouseDown={handleSidebarResizeStart} />
        <WorkspaceTabs
          activeTab={activeTab}
          collapsed={sidebarCollapsed}
          onChange={setActiveTab}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          tabs={[
            {
              id: 'openings',
              label: 'Openings',
              content: (
                <OpeningGroupsPanel
                  color={colorFilter}
                  isLoadingPreview={workspace.trainingLine.isLoading}
                  onSelectOpening={workspace.loadOpening}
                  previewError={workspace.trainingLine.error}
                  selectedOpening={workspace.selectedOpening}
                  timeClass={timeClassFilter}
                  username={username}
                />
              ),
            },
            {
              id: 'games',
              label: 'Games',
              content: (
                <GameListPanel
                  color={colorFilter}
                  currentFen={workspace.currentFen}
                  eco={workspace.gameFilters.eco}
                  onSelectGame={workspace.loadGame}
                  openingName={workspace.gameFilters.openingName}
                  selectedGameId={workspace.selectedGameId}
                  timeClass={timeClassFilter}
                  username={username}
                />
              ),
            },
            {
              id: 'tree',
              label: 'Tree',
              content: <MoveTreePanel />,
            },
            {
              id: 'theory',
              label: 'Theory',
              content: hasTheoryContent ? (
                <div className="column" style={{ gap: 16 }}>
                  <TheoryComparison data={theoryData} />
                  <DeviationTable deviations={deviations} isLoading={isDeviationsLoading} />
                </div>
              ) : (
                <Card>
                  <CardHeader>
                    <h2>Theory</h2>
                  </CardHeader>
                  <CardBody>
                    <div className="muted">Load a game or opening line to compare your moves with master theory.</div>
                  </CardBody>
                </Card>
              ),
            },
            {
              id: 'recommendations',
              label: 'Needs Work',
              content: (
                <OpeningRecommendations
                  onSelectOpening={workspace.loadOpening}
                />
              ),
            },
            {
              id: 'engine',
              label: 'Engine',
              content: (
                <div className="column" style={{ gap: 16 }}>
                  <EngineLines isAnalyzing={isAnalyzing} lines={lines} statusMessage={statusMessage} />
                  <DeviationList rows={deviationRows} />
                </div>
              ),
            },
            {
              id: 'stats',
              label: 'Stats',
              content: stats ? (
                <div className="stats-layout">
                  <StatsOverview stats={stats} />
                  <div className="stats-panel-grid">
                    <ColorBreakdown stats={stats} />
                    <TimeClassChart byTimeClass={stats.by_time_class} />
                    <TopOpenings openings={stats.by_opening} />
                  </div>
                </div>
              ) : (
                <div className="muted">Loading stats...</div>
              ),
            },
          ]}
        />
      </div>
      {status === 'running' ? <ImportProgress /> : null}
    </div>
  )
}
