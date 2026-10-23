import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, GraduationCap } from 'lucide-react'

import { BoardRail } from '@/components/board/board-rail'
import { Medal } from '@/components/training/trophies'
import type { EmblemName } from '@/lib/training/emblem-art'
import { ChessBoard } from '@/components/board/chess-board'
import { WorkspaceTabs } from '@/components/board/workspace-tabs'
import { EvaluationProgress } from '@/components/analysis/evaluation-progress'
import { ImportProgress } from '@/components/import/import-progress'
import { UsernameForm } from '@/components/import/username-form'
import { Button } from '@/components/ui/button'
import { revealSection } from '@/components/ui/collapsible-section'
import { ExplorePanel } from '@/components/workspace/explore-panel'
import { ReviewPanel } from '@/components/workspace/review-panel'
import { useBoardWorkspace } from '@/hooks/use-board-workspace'
import { useAutoAnalysis } from '@/hooks/use-engine'
import { useEngineEvalSync } from '@/hooks/use-engine-eval-sync'
import { useImportSummary } from '@/hooks/use-import-summary'
import { useGameLine } from '@/hooks/use-game-line'
import { useMoveAnnotations } from '@/hooks/use-move-annotations'
import { useSparringController, useSparringRecorder, useStartSparring } from '@/hooks/use-sparring'
import { useSyncOnReturn } from '@/hooks/use-sync-on-return'
import { isServerUnreachable } from '@/lib/api-errors'
import { getAppAccessState } from '@/lib/app-access'
import {
  getDashboardLayoutStorage,
  readDashboardLayout,
  writeDashboardLayout,
  RAIL_MAX,
  RAIL_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from '@/lib/dashboard-layout'
import { useRetryStore } from '@/components/analysis/retry-mistakes'
import { useAppStore } from '@/store/app-store'
import { useIsSparring } from '@/store/spar-store'
import { Celebrations, OPEN_TODAY_EVENT } from '@/components/training/training-widgets'

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
        <img alt="ChessGod" className="landing__mark" height={512} src="/logo.webp" width={512} />
        <p className="landing__lede">
          Can&rsquo;t reach the ChessGod server. Your games are safe. Check the backend is running,
          then try again.
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

const LANDING_PROMISES: { emblem: EmblemName; title: string; detail: string }[] = [
  {
    emblem: 'eye',
    title: 'Spot your blunders',
    detail: 'Positions from your own games where one move cost you.',
  },
  {
    emblem: 'shield',
    title: 'Fix your openings',
    detail: 'A repertoire built from what you already play. Only the moves that cost you change.',
  },
  {
    emblem: 'crown',
    title: 'Pawn to King',
    detail: 'Quests, streaks and promotions for ten minutes a day.',
  },
]

/** First screen. One job: get a Chess.com username into the box. */
function Landing({ isLoading }: { isLoading: boolean }) {
  const importStatus = useAppStore((state) => state.importStatus)

  return (
    <div className="page landing">
      <div className="landing__inner">
        <img alt="ChessGod" className="landing__mark" height={512} src="/logo.webp" width={512} />

        {isLoading ? (
          <div className="landing__loading">Checking your library…</div>
        ) : (
          <>
            <p className="landing__lede">
              Import your Chess.com games. ChessGod turns your own mistakes into ten minutes of
              training a day.
            </p>

            <UsernameForm />

            {importStatus === 'running' ? <ImportProgress /> : null}

            {/* What the games become, in the training's own medals. */}
            <ul aria-label="What you get" className="landing__promise">
              {LANDING_PROMISES.map((item) => (
                <li key={item.emblem}>
                  <Medal earned emblem={item.emblem} label={item.title} progress={1} size={52} />
                  <strong>{item.title}</strong>
                  <span className="muted">{item.detail}</span>
                </li>
              ))}
            </ul>
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
  // Off until Explore reports which page is showing; only its Engine page turns it on.
  const [engineOpen, setEngineOpen] = useState(false)
  // The header's training chip opens Review at the Today card.
  useEffect(() => {
    function openToday() {
      setActiveTab('review')
      // The panel mounts on the next render, so the reveal goes out after it:
      // revealSection switches the Review view and page to Today and scrolls.
      // Scrolling for .today-card directly only worked when Review was already
      // open on the Today page.
      window.setTimeout(() => revealSection('review-today'), 60)
    }
    window.addEventListener(OPEN_TODAY_EVENT, openToday)
    return () => window.removeEventListener(OPEN_TODAY_EVENT, openToday)
  }, [])
  // Auto-analysis only runs while the Engine section is visible — avoids burning
  // CPU on every FEN change when the user is looking at anything else.
  // Nor while a sparring game is in progress: the evaluation is the answer.
  const sparring = useIsSparring()
  // Nor while a position is being asked (a retried mistake): the search is its answer.
  const drillSolving = useAppStore((state) => state.drillSolving)
  useAutoAnalysis(activeTab === 'explore' && engineOpen && !sparring && !drillSolving)
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
  // Games played on Chess.com since the last look arrive on coming back.
  useSyncOnReturn(username)
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
      setRailWidth((prev) => Math.min(RAIL_MAX, Math.max(RAIL_MIN, prev - delta)))
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
      setSidebarWidth((prev) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, prev - delta)))
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
    ? 'Clear game'
    : workspace.selectedOpening
      ? 'Clear opening'
      : 'Clear board'
  // One way out of any state: a fresh board at the start position. Clearing
  // the line bumps the tree epoch, which ends a game against the engine and
  // tells every trainer its line is gone; the retry, arrows and hint ring are
  // the pieces that live beside the tree, so they go here.
  const resetBoard = useCallback(() => {
    workspace.clearLoadedContext()
    useRetryStore.getState().end()
    const store = useAppStore.getState()
    store.setTrainerArrows([])
    store.setHintSquare(null)
  }, [workspace])

  const effectiveSidebarWidth = sidebarCollapsed
    ? '108px'
    : `${Math.max(SIDEBAR_MIN, sidebarWidth)}px`
  const effectiveRailWidth = Math.max(RAIL_MIN, railWidth)

  return (
    <div className="page">
      <Celebrations />
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
            onClearLoadedContext={resetBoard}
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
                  engineOpen={engineOpen}
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
                  onOpenGame={(game) => {
                    setActiveTab('explore')
                    workspace.loadGame(game)
                    window.setTimeout(() => revealSection('explore-game-review'), 60)
                  }}
                  onOpenExplore={(section) => {
                    setActiveTab('explore')
                    // The tab mounts its sections on the next render.
                    window.setTimeout(() => revealSection(section), 60)
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
