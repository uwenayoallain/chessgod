import { memo, useEffect, useRef, useState } from 'react'

import { GameReviewPanel } from '@/components/analysis/game-review-panel'
import { reviewCoverage } from '@/lib/analysis/game-review'
import { QUICK_REVIEW_DEPTH } from '@/lib/analysis/review-depth'
import { EngineLines } from '@/components/analysis/engine-lines'
import { SparringPanel } from '@/components/sparring/sparring-panel'
import { MoveTreePanel } from '@/components/tree/move-tree-panel'
import { TheoryComparison } from '@/components/theory/theory-comparison'
import { OPEN_SECTION_EVENT } from '@/components/ui/collapsible-section'
import { GameListPanel } from '@/components/workspace/game-list-panel'
import { OpeningGroupsPanel } from '@/components/workspace/opening-groups-panel'
import type { OpeningSelection } from '@/hooks/use-board-workspace'
import { useGameReview } from '@/hooks/use-game-line'
import { useTheory } from '@/hooks/use-theory'
import type { WorkspaceGame } from '@/hooks/use-workspace-data'
import { safeGetItem, safeSetItem } from '@/lib/storage'
import { useAppStore } from '@/store/app-store'
import { useIsSparring, useSparStore } from '@/store/spar-store'

function TheoryAtPosition() {
  const currentFen = useAppStore((state) => state.currentFen)
  const theory = useTheory(currentFen)
  return <TheoryComparison data={theory.data} isRefreshing={theory.isRefreshing} />
}

type ExplorePage =
  | 'explore-game-review'
  | 'explore-engine'
  | 'explore-sparring'
  | 'explore-library'
  | 'explore-position'

const PAGE_STORAGE = 'chessgod.study-room.explore-page'

/**
 * Every page of the Explore tab, one on screen at a time. The id is the
 * address links use (`revealSection`), so it must stay stable.
 */
const PAGES: { id: ExplorePage; label: string; description: string }[] = [
  {
    id: 'explore-game-review',
    label: 'Game review',
    description: 'Every move of the game on the board, graded',
  },
  { id: 'explore-engine', label: 'Engine', description: 'Live evaluation of the board position' },
  {
    id: 'explore-sparring',
    label: 'Play',
    description: 'A game against Stockfish at your strength',
  },
  {
    id: 'explore-library',
    label: 'Library',
    description: 'Your openings and games, ready to load',
  },
  {
    id: 'explore-position',
    label: 'Position',
    description: 'Your games and master games from the board position',
  },
]

/** Pages that read the board, where the engine searches each position. */
const ENGINE_PAGES = new Set<ExplorePage>([
  'explore-game-review',
  'explore-engine',
  'explore-position',
])

/** Every Explore page id; links from other tabs must name one of these. */
export const EXPLORE_PAGE_IDS: readonly string[] = PAGES.map((page) => page.id)

function isExplorePage(id: string | null): id is ExplorePage {
  return PAGES.some((page) => page.id === id)
}

function readStoredPage(): ExplorePage {
  const stored = safeGetItem(PAGE_STORAGE)
  return isExplorePage(stored) ? stored : 'explore-library'
}

/**
 * The line under the page chips. On the Game review page it counts graded
 * moves, which changes while a review runs, so it subscribes on its own and
 * the panel around it does not re-render with every position searched.
 */
function ReviewCaption({ fallback }: { fallback: string }) {
  const { annotations } = useGameReview()
  if (!annotations.length) return <>{fallback}</>
  const coverage = reviewCoverage(annotations)
  return (
    <>
      {coverage.judged} of {coverage.total} moves graded
    </>
  )
}

/**
 * The review of the game on the board. It reads the game's line and grades
 * here, where they are drawn, instead of receiving them from the workspace
 * root: read there, every graded position re-rendered the whole workspace.
 */
function GameReviewPage({ activeGame }: { activeGame: WorkspaceGame | null }) {
  const { line, annotations } = useGameReview()
  const sparReview = useSparStore((state) => state.reviewing)
  const sparGameId = useSparStore((state) => state.savedGameId)
  const treeEpoch = useAppStore((state) => state.treeEpoch)
  // A finished game against the engine, still on the board.
  const reviewingSparGame = sparReview !== null && sparReview.epoch === treeEpoch
  const userColor = activeGame?.user_color === 'black' ? 'black' : activeGame ? 'white' : null

  return (
    <GameReviewPanel
      annotations={annotations}
      fenHistory={line.fenHistory}
      gameId={reviewingSparGame ? null : (activeGame?.id ?? null)}
      opponentTitle={reviewingSparGame ? 'Stockfish' : 'Opponent'}
      reviewDepth={reviewingSparGame ? QUICK_REVIEW_DEPTH : undefined}
      sparringGameId={reviewingSparGame ? sparGameId : null}
      userColor={reviewingSparGame ? sparReview.userColor : userColor}
    />
  )
}

/**
 * The game list follows the board ("Games through this position"), so it reads
 * the position itself. Passed down from the workspace root, the position made
 * the root, and everything under it, re-render on every step through a game.
 */
function GamesAtPosition(props: Omit<Parameters<typeof GameListPanel>[0], 'currentFen'>) {
  const currentFen = useAppStore((state) => state.currentFen)
  return <GameListPanel {...props} currentFen={currentFen} />
}

/**
 * "Explore" tab: everything anchored to the board, one page at a time —
 * review the loaded game, read the engine, play it, load something from the
 * Library, or see what you and the masters played from here. Five stacked
 * sections (three open) read as clutter beside the board, the same complaint
 * that turned Review into pages. The engine searches on the pages that read
 * the board and rests while the Library is being browsed.
 */
export const ExplorePanel = memo(function ExplorePanel({
  username,
  color,
  timeClass,
  activeGame,
  selectedGameId,
  selectedOpening,
  previewLoading,
  previewError,
  onLoadGame,
  onLoadOpening,
  onClearContext,
  onEngineOpenChange,
}: {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  /** The imported game on the board, if there is one. */
  activeGame: WorkspaceGame | null
  selectedGameId: number | null
  selectedOpening: OpeningSelection | null
  previewLoading: boolean
  previewError: string | null
  // Handlers must keep their identity between renders (the dashboard passes
  // stable callbacks): the panel is memoised and the opening list under it too.
  onLoadGame: (game: WorkspaceGame) => void
  onLoadOpening: (opening: OpeningSelection) => void
  onClearContext: () => void
  onEngineOpenChange: (open: boolean) => void
}) {
  const [page, setPage] = useState<ExplorePage>(readStoredPage)
  const [libraryView, setLibraryView] = useState<'openings' | 'games'>('openings')
  const sparring = useIsSparring()
  // A retried mistake is being asked: the engine's lines are its answer.
  const drillSolving = useAppStore((state) => state.drillSolving)

  function choosePage(next: ExplorePage) {
    setPage(next)
    // A blocked store only loses the remembered page.
    safeSetItem(PAGE_STORAGE, next)
  }

  // The engine searches on every page that reads the board — trying "what if
  // I had played this?" off a reviewed game is the review's main use — and
  // stops while browsing the Library, where every click loads a new position
  // and nothing is being read. Play disables it on its own (the evaluation is
  // the answer). It also stops when the panel unmounts: a collapsed sidebar
  // keeps the tab "explore" with nothing of it visible.
  useEffect(() => {
    onEngineOpenChange(ENGINE_PAGES.has(page))
    return () => onEngineOpenChange(false)
  }, [onEngineOpenChange, page])

  // Links into a page ("Go" on a quest, "Review it" on the latest game) land
  // here and switch to it.
  useEffect(() => {
    function onReveal(event: Event) {
      const id = (event as CustomEvent<string>).detail
      if (isExplorePage(id)) choosePage(id)
    }
    window.addEventListener(OPEN_SECTION_EVENT, onReveal)
    return () => window.removeEventListener(OPEN_SECTION_EVENT, onReveal)
  }, [])

  // A game in progress takes the Play page — including a panel mounting into
  // a game already running ("Play it out" switches tab and starts the game in
  // one handler), hence the ref starting at idle. Only a game that actually
  // *ends* moves on to its review: a game closed because a drill, an opening
  // or another game replaced the line must leave the page alone.
  const sparStatus = useSparStore((state) => state.status)
  const previousStatus = useRef<typeof sparStatus>('idle')
  useEffect(() => {
    if (sparStatus === 'playing' && previousStatus.current !== 'playing') {
      choosePage('explore-sparring')
    }
    if (sparStatus === 'over' && previousStatus.current === 'playing') {
      choosePage('explore-game-review')
    }
    previousStatus.current = sparStatus
  }, [sparStatus])

  const active = PAGES.find((item) => item.id === page) ?? PAGES[0]

  return (
    <div className="theory-stack">
      <div aria-label="Explore pages" className="review-pages" role="group">
        {PAGES.map((item) => (
          <button
            aria-pressed={item.id === page}
            className={`review-pages__chip${item.id === page ? ' review-pages__chip--active' : ''}`}
            key={item.id}
            onClick={() => choosePage(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      <span className="muted review-pages__caption">
        {page === 'explore-game-review' ? (
          <ReviewCaption fallback={active.description} />
        ) : (
          active.description
        )}
      </span>

      <div className="theory-stack" data-section-id={page} id={page}>
        {page === 'explore-game-review' ? (
          sparring ? (
            <p className="muted sparring__note">The review opens when the game ends.</p>
          ) : (
            <GameReviewPage activeGame={activeGame} />
          )
        ) : page === 'explore-engine' ? (
          <EngineLines
            hidden={sparring || drillSolving}
            hiddenReason={sparring ? undefined : 'Hidden until you answer.'}
          />
        ) : page === 'explore-sparring' ? (
          <SparringPanel onBeforeNewGame={onClearContext} username={username} />
        ) : page === 'explore-library' ? (
          <>
            <div aria-label="Library view" className="workspace-tabs__list" role="group">
              {(['openings', 'games'] as const).map((view) => (
                <button
                  aria-pressed={libraryView === view}
                  className={`workspace-tabs__button${libraryView === view ? ' workspace-tabs__button--active' : ''}`}
                  key={view}
                  onClick={() => setLibraryView(view)}
                  type="button"
                >
                  {view === 'openings' ? 'Openings' : 'Games'}
                </button>
              ))}
            </div>
            {libraryView === 'openings' ? (
              <OpeningGroupsPanel
                color={color}
                isLoadingPreview={previewLoading}
                onSelectOpening={onLoadOpening}
                previewError={previewError}
                selectedOpening={selectedOpening}
                timeClass={timeClass}
                username={username}
              />
            ) : (
              <GamesAtPosition
                color={color}
                eco={null}
                onSelectGame={(game) => {
                  // A loaded game's payoff is its review, so that is where it
                  // lands, if there was a game to load.
                  if (!game.pgn) return
                  onLoadGame(game)
                  choosePage('explore-game-review')
                }}
                openingName={null}
                selectedGameId={selectedGameId}
                timeClass={timeClass}
                username={username}
              />
            )}
          </>
        ) : (
          <>
            <MoveTreePanel />
            <TheoryAtPosition />
          </>
        )}
      </div>
    </div>
  )
})
