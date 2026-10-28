import { lazy, Suspense, useEffect, useState } from 'react'

import { OpeningCourse } from '@/components/training/opening-course'
import { BlunderCheck } from '@/components/training/blunder-check'
import { HabitsCard } from '@/components/training/habits-card'
import { WeekScoresheet } from '@/components/training/week-scoresheet'
import {
  AchievementsGrid,
  ChallengeList,
  OPEN_TODAY_EVENT,
  RepertoireCheckCard,
  TodayCard,
} from '@/components/training/training-widgets'
import { useTrainingStore } from '@/store/training-store'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { OPEN_SECTION_EVENT } from '@/components/ui/collapsible-section'
import type { FamilySummary } from '@/hooks/use-families'
import { parsePgnToReplay } from '@/lib/chess-utils'
import type { WorkspaceGame } from '@/hooks/use-workspace-data'
import { useGameStats } from '@/hooks/use-game-stats'
import { useMistakes } from '@/hooks/use-mistakes'
import { useRepertoire } from '@/hooks/use-repertoire'
import { useTheoryDeviations } from '@/hooks/use-theory'
import { useAppStore } from '@/store/app-store'

// Pages past Today load the first time they are opened: they were most of
// the main bundle, and a page that is never opened never needed them.
const ColorBreakdown = lazy(() =>
  import('@/components/dashboard/color-breakdown').then((m) => ({ default: m.ColorBreakdown })),
)
const StatsOverview = lazy(() =>
  import('@/components/dashboard/stats-overview').then((m) => ({ default: m.StatsOverview })),
)
const TimeClassChart = lazy(() =>
  import('@/components/dashboard/time-class-chart').then((m) => ({ default: m.TimeClassChart })),
)
const TopOpenings = lazy(() =>
  import('@/components/dashboard/top-openings').then((m) => ({ default: m.TopOpenings })),
)
const ImprovementTrainer = lazy(() =>
  import('@/components/improvement/improvement-trainer').then((m) => ({
    default: m.ImprovementTrainer,
  })),
)
const WherePointsGo = lazy(() =>
  import('@/components/improvement/where-points-go').then((m) => ({ default: m.WherePointsGo })),
)
const ClockCard = lazy(() =>
  import('@/components/training/clock-card').then((m) => ({ default: m.ClockCard })),
)
const OpeningRush = lazy(() =>
  import('@/components/training/opening-rush').then((m) => ({ default: m.OpeningRush })),
)
const ProgressCard = lazy(() =>
  import('@/components/training/progress-card').then((m) => ({ default: m.ProgressCard })),
)
const RatingGoalCard = lazy(() =>
  import('@/components/training/rating-goal-card').then((m) => ({ default: m.RatingGoalCard })),
)
const OpeningQuiz = lazy(() =>
  import('@/components/openings/opening-quiz').then((m) => ({ default: m.OpeningQuiz })),
)
const DeviationTable = lazy(() =>
  import('@/components/theory/deviation-table').then((m) => ({ default: m.DeviationTable })),
)
const EngineAnalyzeBatch = lazy(() =>
  import('@/components/theory/engine-analyze-batch').then((m) => ({
    default: m.EngineAnalyzeBatch,
  })),
)
const FamilyBrowser = lazy(() =>
  import('@/components/theory/family-browser').then((m) => ({ default: m.FamilyBrowser })),
)
const FamilyDetail = lazy(() =>
  import('@/components/theory/family-detail').then((m) => ({ default: m.FamilyDetail })),
)
const MistakeReview = lazy(() =>
  import('@/components/theory/mistake-review').then((m) => ({ default: m.MistakeReview })),
)
const RepertoireTree = lazy(() =>
  import('@/components/theory/repertoire-tree').then((m) => ({ default: m.RepertoireTree })),
)

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
      title={null}
      emptyHint="Run the engine over your games under Coverage first."
    />
  )
}

function OpeningsHealthSection({ username, color, timeClass }: ReviewScope) {
  const [selectedFamilyId, setSelectedFamilyId] = useState<number | null>(null)
  const loadPosition = useAppStore((state) => state.loadPosition)

  function selectFamily(family: FamilySummary) {
    setSelectedFamilyId(family.id)
    // The family's own PGN names the move that reaches it, so the board can
    // highlight it; a PGN that will not parse just loses the highlight.
    let lastUci: string | null = null
    try {
      lastUci = parsePgnToReplay(family.pgn).at(-1)?.uci ?? null
    } catch {
      lastUci = null
    }
    loadPosition(family.root_fen, lastUci)
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
      {/* The page chip already says "Repertoire"; the card names the color. */}
      <CardHeader>
        <h2>{theoryColor === 'white' ? 'As White' : 'As Black'}</h2>
        <div className="panel-header__meta">
          {repertoire.isRefreshing ? <span className="refresh-badge">Updating</span> : null}
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

type ReviewView = 'train' | 'progress' | 'reference'

const VIEW_STORAGE = 'chessgod.study-room.review-view'
const PAGE_STORAGE = 'chessgod.study-room.review-page.'

const VIEWS: { key: ReviewView; label: string }[] = [
  { key: 'train', label: 'Train' },
  { key: 'progress', label: 'Progress' },
  { key: 'reference', label: 'Reference' },
]

/**
 * Every page of the Review tab, one per screen. The id is the address links
 * use (`revealSection`), the label is the chip, and the description is the one
 * line under the chips saying what you are looking at.
 */
const PAGES: { id: string; view: ReviewView; label: string; description: string }[] = [
  {
    id: 'review-today',
    view: 'train',
    label: 'Today',
    description: 'Your streak, quests and next step',
  },
  {
    id: 'review-threats',
    view: 'train',
    label: 'Blunder Check',
    description: 'Punish a big mistake: yours, or one your opponent made',
  },
  {
    id: 'review-rush',
    view: 'train',
    label: 'Rush',
    description: 'Your repertoire against the clock',
  },
  {
    id: 'review-course',
    view: 'train',
    label: 'Course',
    description: 'Learn your repertoire, then drill it',
  },
  {
    id: 'review-drills',
    view: 'train',
    label: 'Drills',
    description: 'Lessons from your own mistakes',
  },
  {
    id: 'review-opening-quiz',
    view: 'train',
    label: 'Quiz',
    description: 'Your opening positions, checked against master games',
  },
  {
    id: 'review-habits',
    view: 'progress',
    label: 'Habits',
    description: 'What you do wrong over the board, and your last game',
  },
  {
    id: 'review-week',
    view: 'progress',
    label: 'Your week',
    description: "This week's challenges and every game you played",
  },
  {
    id: 'review-progress',
    view: 'progress',
    label: 'Improving?',
    description: 'Your recent games against the ones before',
  },
  {
    id: 'review-points-lost',
    view: 'progress',
    label: 'Points',
    description: 'How you leave the opening and where you lose points',
  },
  {
    id: 'review-clock',
    view: 'progress',
    label: 'Clock',
    description: 'How you use your clock and when the big mistakes come',
  },
  {
    id: 'review-rating-goal',
    view: 'progress',
    label: 'Rating goal',
    description: 'Your pace toward a target rating',
  },
  {
    id: 'review-achievements',
    view: 'progress',
    label: 'Achievements',
    description: "Badges you've earned and what the next one takes",
  },
  {
    id: 'review-needs-work',
    view: 'reference',
    label: 'Mistakes',
    description: 'The same mistake in more than one game, by opening',
  },
  {
    id: 'review-coverage',
    view: 'reference',
    label: 'Coverage',
    description: 'How much of your library the engine has checked',
  },
  {
    id: 'review-openings',
    view: 'reference',
    label: 'Openings',
    description: 'How each opening you play scores',
  },
  {
    id: 'review-repertoire',
    view: 'reference',
    label: 'Repertoire',
    description: 'Your main lines and the moves you mean to play',
  },
  {
    id: 'review-deviations',
    view: 'reference',
    label: 'Deviations',
    description: 'Where you leave master theory',
  },
  {
    id: 'review-stats',
    view: 'reference',
    label: 'Stats',
    description: "Win rates across everything you've played",
  },
]

/** Which view each page lives in, so a link to a page can switch to it. */
export const SECTION_VIEWS: Record<string, ReviewView> = Object.fromEntries(
  PAGES.map((page) => [page.id, page.view]),
)

function readStoredView(): ReviewView {
  if (typeof window === 'undefined') return 'train'
  const stored = window.localStorage.getItem(VIEW_STORAGE)
  return stored === 'progress' || stored === 'reference' ? stored : 'train'
}

function firstPageOf(view: ReviewView): string {
  return PAGES.find((page) => page.view === view)!.id
}

function readStoredPage(view: ReviewView): string {
  if (typeof window === 'undefined') return firstPageOf(view)
  const stored = window.localStorage.getItem(PAGE_STORAGE + view)
  return PAGES.some((page) => page.id === stored && page.view === view)
    ? (stored as string)
    : firstPageOf(view)
}

/**
 * "Review" tab: three views (Train / Progress / Reference), each a row of page
 * chips with exactly one page on screen. A stack of seventeen sections — even
 * grouped, even collapsed — read as a wall of sub-pages to open one by one;
 * now you pick what you are looking at and see only that. Nothing was removed.
 * A page mounts (and therefore fetches) only while it is the one showing, and
 * a link to a page (`revealSection`) switches view and page first.
 */
export function ReviewPanel({
  username,
  color,
  timeClass,
  importStatus,
  onBeginDrill,
  onPlayOut,
  onOpenExplore,
  onOpenGame,
}: ReviewScope & {
  importStatus: string
  onBeginDrill?: () => void
  /** Switch to Explore and open one of its sections, for a quest played there. */
  onOpenExplore?: (section: string) => void
  /** Switch to Explore with a game loaded and its review open. */
  onOpenGame?: (game: WorkspaceGame) => void
  onPlayOut?: (position: { fen: string; lastUci: string | null; origin?: string }) => void
}) {
  const scope = { username, color, timeClass }
  const courseSession = useTrainingStore((state) => state.session)
  const [view, setView] = useState<ReviewView>(readStoredView)
  const [pageByView, setPageByView] = useState<Record<ReviewView, string>>(() => ({
    train: readStoredPage('train'),
    progress: readStoredPage('progress'),
    reference: readStoredPage('reference'),
  }))

  function chooseView(next: ReviewView) {
    setView(next)
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE, next)
  }

  function choosePage(home: ReviewView, id: string) {
    setPageByView((previous) => ({ ...previous, [home]: id }))
    if (typeof window !== 'undefined') window.localStorage.setItem(PAGE_STORAGE + home, id)
  }

  // Links to a page ("Go" on a quest, "last week" on the Today card, the
  // header's training chip) land here: switch to its view and make it the page
  // on screen, wherever the player last was.
  useEffect(() => {
    function onReveal(event: Event) {
      const id = (event as CustomEvent<string>).detail
      const home = SECTION_VIEWS[id]
      if (!home) return
      chooseView(home)
      choosePage(home, id)
    }
    function onOpenToday() {
      chooseView('train')
      choosePage('train', 'review-today')
    }
    window.addEventListener(OPEN_SECTION_EVENT, onReveal)
    window.addEventListener(OPEN_TODAY_EVENT, onOpenToday)
    return () => {
      window.removeEventListener(OPEN_SECTION_EVENT, onReveal)
      window.removeEventListener(OPEN_TODAY_EVENT, onOpenToday)
    }
  }, [])

  const pages = PAGES.filter((page) => page.view === view)
  const active = pages.find((page) => page.id === pageByView[view]) ?? pages[0]

  return (
    <div className="theory-stack">
      <div className="review-views">
        <div aria-label="Review views" className="review-views__switch" role="group">
          {VIEWS.map((item) => (
            <button
              aria-pressed={view === item.key}
              className={`review-views__button${view === item.key ? ' review-views__button--active' : ''}`}
              key={item.key}
              onClick={() => chooseView(item.key)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div aria-label={`${view} pages`} className="review-pages" role="group">
        {pages.map((page) => (
          <button
            aria-pressed={page.id === active.id}
            className={`review-pages__chip${page.id === active.id ? ' review-pages__chip--active' : ''}`}
            key={page.id}
            onClick={() => choosePage(view, page.id)}
            type="button"
          >
            {page.label}
          </button>
        ))}
      </div>
      <span className="muted review-pages__caption">{active.description}</span>

      <div className="theory-stack" data-section-id={active.id} id={active.id}>
        {/* A page opened for the first time loads its code; the skeleton holds
            the space it will take so nothing below it jumps. */}
        <Suspense fallback={<PanelSkeleton label="Opening the page" rows={4} rowHeight={48} />}>
          {active.id === 'review-today' ? (
            <TodayCard onOpenExplore={onOpenExplore} onOpenGame={onOpenGame} username={username} />
          ) : active.id === 'review-threats' ? (
            <BlunderCheck onBegin={onBeginDrill} username={username} />
          ) : active.id === 'review-rush' ? (
            <OpeningRush onBegin={onBeginDrill} username={username} />
          ) : active.id === 'review-course' ? (
            <>
              {/* Where your recent games left the repertoire, above the course
                that fixes it; hidden while a session has the board. */}
              {courseSession ? null : <RepertoireCheckCard username={username} />}
              <OpeningCourse onBegin={onBeginDrill} onPlayOut={onPlayOut} username={username} />
            </>
          ) : active.id === 'review-drills' ? (
            <ImprovementTrainer
              color={color}
              onBeginDrill={onBeginDrill}
              onPlayOut={onPlayOut}
              timeClass={timeClass}
              username={username}
            />
          ) : active.id === 'review-opening-quiz' ? (
            <OpeningQuiz
              color={color}
              onBegin={onBeginDrill}
              timeClass={timeClass}
              username={username}
            />
          ) : active.id === 'review-habits' ? (
            <HabitsCard onOpenGame={onOpenGame} username={username} />
          ) : active.id === 'review-week' ? (
            <>
              <ChallengeList username={username} />
              <WeekScoresheet username={username} />
            </>
          ) : active.id === 'review-progress' ? (
            <ProgressCard username={username} />
          ) : active.id === 'review-points-lost' ? (
            <WherePointsGo
              color={color}
              onShowPosition={onBeginDrill}
              timeClass={timeClass}
              username={username}
            />
          ) : active.id === 'review-clock' ? (
            <ClockCard username={username} />
          ) : active.id === 'review-rating-goal' ? (
            <RatingGoalCard username={username} />
          ) : active.id === 'review-achievements' ? (
            <AchievementsGrid username={username} />
          ) : active.id === 'review-needs-work' ? (
            <NeedsWorkSection {...scope} />
          ) : active.id === 'review-coverage' ? (
            <EngineAnalyzeBatch color={color} timeClass={timeClass} username={username} />
          ) : active.id === 'review-openings' ? (
            <OpeningsHealthSection {...scope} />
          ) : active.id === 'review-repertoire' ? (
            <RepertoireSection {...scope} />
          ) : active.id === 'review-deviations' ? (
            <DeviationScanSection {...scope} />
          ) : (
            <StatsSection importStatus={importStatus} timeClass={timeClass} username={username} />
          )}
        </Suspense>
      </div>
    </div>
  )
}
