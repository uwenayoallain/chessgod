import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, GraduationCap } from 'lucide-react'

import { BoardRail } from '@/components/board/board-rail'
import { ChessBoard } from '@/components/board/chess-board'
import { WorkspaceTabs } from '@/components/board/workspace-tabs'
import { EvaluationProgress } from '@/components/analysis/evaluation-progress'
import { ImportProgress } from '@/components/import/import-progress'
import { UsernameForm } from '@/components/import/username-form'
import { Button } from '@/components/ui/button'
import { readSectionOpen } from '@/components/ui/collapsible-section'
import { ExplorePanel } from '@/components/workspace/explore-panel'
import { ReviewPanel } from '@/components/workspace/review-panel'
import { useBoardWorkspace } from '@/hooks/use-board-workspace'
import { useEngine } from '@/hooks/use-engine'
import { useEngineEvalSync } from '@/hooks/use-engine-eval-sync'
import { useImportSummary } from '@/hooks/use-import-summary'
import { useGameLine } from '@/hooks/use-game-line'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { useSparringController, useSparringRecorder, useStartSparring } from '@/hooks/use-sparring'
import { isServerUnreachable } from '@/lib/api-errors'
import { getAppAccessState } from '@/lib/app-access'
import {
  getDashboardLayoutStorage,
  readDashboardLayout,
  writeDashboardLayout,
} from '@/lib/dashboard-layout'
import { useAppStore } from '@/store/app-store'
import { useIsSparring } from '@/store/spar-store'

export default function Dashboard() {
  const username = useAppStore((state) => state.username)
  const status = useAppStore((state) => state.importStatus)
  const {
    data: summary,
    isLoading: isSummaryLoading,
    error: summaryError,
    refetch,
    isRefetching,
  } = useImportSummary(username, status)
  // While an import is running or has just failed, the landing screen has to
  // keep showing the form, its progress and its error — flipping to "checking
  // your library" unmounts the form and loses the message the user needs.
  const isMidImport = status === 'running' || status === 'error'
  const access = getAppAccessState({
    username,
    isLoading: isSummaryLoading && !summary && !isMidImport,
    totalGames: summary?.total_games ?? null,
    unreachable: isServerUnreachable(summaryError),
  })

  if (access.state === 'unreachable') {
    return <Unreachable isRetrying={isRefetching} onRetry={() => void refetch()} />
  }

  if (access.state !== 'ready') {
    return <Landing isLoading={access.state === 'loading'} />
  }

  return <Workspace username={username!} />
}

/**
 * The API could not be reached. Deliberately not the import form: the games
 * are still stored, and offering to import them again reads as data loss.
 */
function Unreachable({ isRetrying, onRetry }: { isRetrying: boolean; onRetry: () => void }) {
  const clearUsername = useAppStore((state) => state.clearUsername)

  return (
    <div className="page landing">
      <div className="landing__inner">
        <img alt="ChessGod" className="landing__mark" height={512} src="/logo.png" width={512} />
        <p className="landing__lede">
          Can&rsquo;t reach the ChessGod server. Your games are still stored &mdash; nothing has
          been lost. Check the backend is running, then try again.
        </p>
        <div className="landing__actions">
          <Button disabled={isRetrying} onClick={onRetry} type="button" variant="primary">
            {isRetrying ? 'Trying\u2026' : 'Try again'}
          </Button>
          <Button onClick={clearUsername} type="button" variant="ghost">
            Use a different account
          </Button>
        </div>
      </div>
    </div>
  )
}

/** First screen. One job: get a Chess.com username into the box. */
function Landing({ isLoading }: { isLoading: boolean }) {
  const importStatus = useAppStore((state) => state.importStatus)

  return (
    <div className="page landing">
      <div className="landing__inner">
        <img alt="ChessGod" className="landing__mark" height={512} src="/logo.png" width={512} />

        {isLoading ? (
          <div className="landing__loading">Checking your library…</div>
        ) : (
          <>
            <p className="landing__lede">
              Import your Chess.com games, then drill the mistakes you keep repeating.
            </p>

            <UsernameForm />

            {importStatus === 'running' ? <ImportProgress /> : null}
          </>
        )}
      </div>
    </div>
  )
}

function Workspace({ username }: { username: string }) {
  const colorFilter = useAppStore((state) => state.colorFilter)
  const timeClassFilter = useAppStore((state) => state.timeClassFilter)
  const status = useAppStore((state) => state.importStatus)

  const workspace = useBoardWorkspace({ username, color: colorFilter, timeClass: timeClassFilter })
  const [initialLayout] = useState(() => readDashboardLayout(getDashboardLayoutStorage()))
  const [activeTab, setActiveTab] = useState(initialLayout.activeTab)
  const [engineOpen, setEngineOpen] = useState(() => readSectionOpen('explore-engine', true))
  // Auto-analysis only runs while the Engine section is visible — avoids burning
  // CPU on every FEN change when the user is looking at anything else.
  // Nor while a sparring game is in progress: the evaluation is the answer.
  const sparring = useIsSparring()
  const { isAnalyzing, lines } = useEngine({
    autoAnalyze: activeTab === 'explore' && engineOpen && !sparring,
  })
  // Persist browser engine evals no matter which section produced them.
  useEngineEvalSync()
  // Owned here, not by the panel, so a game keeps moving whichever tab or
  // section is showing.
  useSparringController()
  const { playOut } = useStartSparring(username, workspace.clearLoadedContext)
  // The review covers the whole loaded game, wherever the board happens to be.
  const gameLine = useGameLine()
  const gameAnnotations = useMoveAnnotations(gameLine)
  // Saves a finished engine game and sends its reviewed mistakes to drills.
  useSparringRecorder(gameAnnotations, gameLine)
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
      setRailWidth((prev) => Math.min(400, Math.max(190, prev - delta)))
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
      setSidebarWidth((prev) => Math.min(800, Math.max(320, prev - delta)))
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

  const loadedContextLabel = workspace.activeGame
    ? 'Clear Game'
    : workspace.selectedOpening
      ? 'Clear Opening'
      : null

  const effectiveSidebarWidth = sidebarCollapsed ? '108px' : `${Math.max(320, sidebarWidth)}px`
  const effectiveRailWidth = Math.max(190, railWidth)

  return (
    <div className="page">
      <div
        className="workspace"
        data-active-tab={activeTab}
        ref={workspaceRef}
        style={
          {
            '--sidebar-width': effectiveSidebarWidth,
            '--rail-width': `${effectiveRailWidth}px`,
          } as React.CSSProperties
        }
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
              id: 'explore',
              label: 'Explore',
              icon: <BookOpen size={15} />,
              content: (
                <ExplorePanel
                  color={colorFilter}
                  annotations={gameAnnotations}
                  fenHistory={gameLine.fenHistory}
                  userColor={
                    workspace.activeGame?.user_color === 'black'
                      ? 'black'
                      : workspace.activeGame
                        ? 'white'
                        : null
                  }
                  engineLines={lines}
                  engineOpen={engineOpen}
                  isAnalyzing={isAnalyzing}
                  onEngineOpenChange={setEngineOpen}
                  timeClass={timeClassFilter}
                  username={username}
                  workspace={workspace}
                />
              ),
            },
            {
              id: 'review',
              label: 'Review',
              icon: <GraduationCap size={16} />,
              content: (
                <ReviewPanel
                  color={colorFilter}
                  importStatus={status}
                  onBeginDrill={workspace.clearLoadedContext}
                  onPlayOut={(position) => {
                    // The game's controls and move list live on Explore.
                    setActiveTab('explore')
                    playOut(position)
                  }}
                  timeClass={timeClassFilter}
                  username={username}
                />
              ),
            },
          ]}
        />
      </div>
      <EvaluationProgress />
      <ImportProgress />
    </div>
  )
}
