import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Crown,
  ExternalLink,
  GraduationCap,
  ListTree,
  Microscope,
  Play,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
} from 'lucide-react'

import { SpeakButton } from '@/components/training/speak-button'
import { StudyCourseTrainer, type StudyNextStep } from '@/components/training/study-course-trainer'
import { Button } from '@/components/ui/button'
import { revealSection } from '@/components/ui/collapsible-section'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { useStartSparring } from '@/hooks/use-sparring'
import {
  studyCourseQueryKey,
  useImportStudyCourse,
  useStudyCourse,
  useStudyCourses,
  useStudyGuide,
} from '@/hooks/use-study-guide'
import { api } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-errors'
import { OPEN_EXPLORE_EVENT } from '@/lib/explore-position'
import { capSpeechText, prefetchSpeech, stopSpeech } from '@/lib/speech'
import type {
  ConcreteOpeningFix,
  MasterPlaybook,
  StudyCourseColor,
  StudyCourseDetail,
  StudyCourseLine,
  StudyCourseSummary,
  StudyLineStatus,
  StudyRecommendation,
  StudyTrainMode,
} from '@/lib/training/study-types'
import { useAppStore } from '@/store/app-store'

const CATEGORY_LABELS: Record<MasterPlaybook['category'], string> = {
  opening: 'Opening',
  middlegame: 'Middlegame',
  tactics: 'Tactics',
  defense: 'Defense',
  endgame: 'Endgame',
  habits: 'Habits',
}

const STATUS_LABELS: Record<StudyLineStatus, string> = {
  new: 'New',
  learning: 'Learning',
  due: 'Review due',
  mastered: 'Mastered',
}

type PlayOut = (position: { fen: string; lastUci: string | null; origin?: string }) => void

/** What a lesson button asks for: the lines to play, in order, and how. */
type LessonPick = (course: StudyCourseDetail) => { queue: StudyCourseLine[]; mode: StudyTrainMode }

type Lesson = {
  courseId: number
  courseTitle: string
  color: StudyCourseColor
  queue: StudyCourseLine[]
  at: number
  mode: StudyTrainMode
  /** Bumped to replay the same line in the same mode. */
  run: number
}

type CourseLink = {
  /** The player's copy of the playbook's course, once it has been added. */
  summary: StudyCourseSummary | undefined
  /** Set while this playbook's course is being added or loaded. */
  busy: boolean
  error: string | null
  onLesson: (pick: LessonPick) => void
  /** Adds the course without starting anything, so its chapters can be read. */
  onEnsure: () => void
}

type BoardHandlers = {
  onLoadBoard: (fen: string, color: MasterPlaybook['color'], lastUci?: string | null) => void
  onPlayOut: (fen: string, title: string, lastUci?: string | null) => void
  courseFor: (playbook: MasterPlaybook) => CourseLink | null
  /** Which playbooks have their chapters open; kept here so a lesson can come back to them. */
  browsing: ReadonlySet<string>
  onBrowse: (playbookId: string, open: boolean) => void
  username: string
}

/** A study FEN may stop after the en-passant field; the board wants all six. */
export function fullFen(fen: string) {
  return fen.trim().split(/\s+/).length >= 6 ? fen.trim() : `${fen.trim()} 0 1`
}

function courseLines(course: StudyCourseDetail): StudyCourseLine[] {
  return course.chapters.flatMap((chapter) => chapter.lines)
}

/**
 * The line "Start learning" opens: the first one never learned, else the first
 * with moves due, else the first still being learned, else the first.
 */
export function firstLessonLine(lines: StudyCourseLine[]): StudyCourseLine | undefined {
  return (
    lines.find((line) => line.status === 'new') ??
    lines.find((line) => line.due_moves > 0) ??
    lines.find((line) => line.status !== 'mastered') ??
    lines[0]
  )
}

/** What "Practice" plays: every line with moves due, else every line already learned. */
export function practiceQueue(lines: StudyCourseLine[]): StudyCourseLine[] {
  const due = lines.filter((line) => line.due_moves > 0)
  if (due.length > 0) return due
  const learned = lines.filter((line) => line.status !== 'new')
  if (learned.length > 0) return learned
  return lines.slice(0, 1)
}

const pickLearn: LessonPick = (course) => {
  const first = firstLessonLine(courseLines(course))
  return { queue: first ? [first] : [], mode: 'learn' }
}

const pickPractice: LessonPick = (course) => ({
  queue: practiceQueue(courseLines(course)),
  mode: 'practice',
})

function percent(known: number, total: number) {
  return total > 0 ? Math.round((known / total) * 100) : 0
}

function DueBadge({ summary }: { summary: StudyCourseSummary | undefined }) {
  if (!summary || summary.due_moves === 0) return null
  return (
    <span className="study-course-due">
      <Clock aria-hidden="true" size={11} />
      {summary.due_moves.toLocaleString()} due
    </span>
  )
}

function CourseProgress({ title, summary }: { title: string; summary: StudyCourseSummary }) {
  const value = percent(summary.known_moves, summary.your_moves)
  return (
    <>
      <div
        aria-label={`${title}: ${summary.known_moves} of ${summary.your_moves} moves known`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        className="study-course-meter"
        role="progressbar"
      >
        <span className="study-course-meter__fill" style={{ width: `${value}%` }} />
      </div>
      <span className="muted study-course__meta">
        {summary.known_moves.toLocaleString()} / {summary.your_moves.toLocaleString()} moves known,{' '}
        {summary.line_count.toLocaleString()} lines
        {summary.due_moves > 0 ? `, ${summary.due_moves.toLocaleString()} due` : ''}
      </span>
    </>
  )
}

/** Every chapter and line of the playbook's course, each one a lesson to start. */
function ChapterBrowser({ username, link }: { username: string; link: CourseLink }) {
  const detail = useStudyCourse(username, link.summary?.id ?? null)
  const [openChapter, setOpenChapter] = useState<number | null>(null)

  if (!link.summary || (detail.isLoading && !detail.data)) return <PanelSkeleton rows={3} />
  if (detail.error || !detail.data) {
    return (
      <PanelError
        error={detail.error ?? new Error('Course unavailable')}
        onRetry={() => void detail.refetch()}
        what="the chapters"
      />
    )
  }
  const course = detail.data
  const shown = openChapter ?? course.chapters[0]?.id ?? null
  if (course.chapters.length === 0) {
    return <p className="muted">This course has no lines to train yet.</p>
  }
  return (
    <div className="study-chapters">
      {course.chapters.map((chapter) => {
        const open = shown === chapter.id
        const chapterDue = chapter.lines.reduce((sum, line) => sum + line.due_moves, 0)
        return (
          <article className={`study-card${open ? ' study-card--open' : ''}`} key={chapter.id}>
            <button
              aria-expanded={open}
              className="study-card__toggle"
              onClick={() => setOpenChapter(open ? -1 : chapter.id)}
              type="button"
            >
              <span className="study-card__rank">{chapter.position}</span>
              <div className="study-card__head">
                <strong>{chapter.title}</strong>
                <span className="muted study-card__evidence">
                  {chapter.lines.length.toLocaleString()}{' '}
                  {chapter.lines.length === 1 ? 'line' : 'lines'}
                  {chapterDue > 0 ? `, ${chapterDue.toLocaleString()} moves due` : ''}
                </span>
              </div>
              <span aria-hidden="true" className="study-card__chevron">
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </span>
            </button>
            {open ? (
              <div className="study-card__body">
                <ul className="study-lines">
                  {chapter.lines.map((line) => (
                    <li className="study-line" key={line.id}>
                      <div className="study-line__text">
                        <span className="study-line__title">{line.title}</span>
                        <span className="study-line__meta">
                          <span className="study-line-status" data-status={line.status}>
                            {STATUS_LABELS[line.status]}
                          </span>
                          <span className="muted">
                            {line.known_moves.toLocaleString()} / {line.your_moves.toLocaleString()}{' '}
                            moves
                          </span>
                        </span>
                      </div>
                      <div className="study-line__actions">
                        <Button
                          aria-label={`Learn ${line.title}`}
                          disabled={link.busy}
                          onClick={() => link.onLesson(() => ({ queue: [line], mode: 'learn' }))}
                          type="button"
                          variant={line.status === 'new' ? 'primary' : 'default'}
                        >
                          <GraduationCap aria-hidden="true" size={14} /> Learn
                        </Button>
                        <Button
                          aria-label={`Practice ${line.title}`}
                          disabled={link.busy}
                          onClick={() => link.onLesson(() => ({ queue: [line], mode: 'practice' }))}
                          type="button"
                          variant={line.status === 'new' ? 'default' : 'primary'}
                        >
                          <Play aria-hidden="true" size={14} /> Practice
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

/** What the playbook's Listen button reads: its summary, then its core ideas, cut to fit one clip. */
export function playbookSpeech(playbook: MasterPlaybook): string {
  const ideas = playbook.core_ideas.length
    ? ` Core ideas. ${playbook.core_ideas.map((idea) => idea.trim().replace(/([^.!?])$/, '$1.')).join(' ')}`
    : ''
  return capSpeechText(`${playbook.title}. ${playbook.summary}${ideas}`)
}

function PlaybookReader({
  playbook,
  concreteFixes,
  onLoadBoard,
  onPlayOut,
  courseFor,
  browsing: browsingIds,
  onBrowse,
  username,
}: BoardHandlers & {
  playbook: MasterPlaybook
  concreteFixes?: ConcreteOpeningFix[]
}) {
  const link = courseFor(playbook)
  const browsing = browsingIds.has(playbook.id)
  const due = link?.summary?.due_moves ?? 0
  const speech = playbookSpeech(playbook)
  const side = playbook.color === 'both' ? undefined : playbook.color

  // The card is open: fetch its voice now, so Listen starts at once.
  useEffect(() => {
    void prefetchSpeech(speech, side ? { side } : undefined)
  }, [speech, side])

  return (
    <div className="study-playbook">
      <div className="study-playbook__lead">
        <p className="study-playbook__summary">{playbook.summary}</p>
        <SpeakButton id={`playbook:${playbook.id}`} label="Listen" side={side} text={speech} />
      </div>

      <div className="study-playbook__meta">
        <span className="study-chip">{playbook.structure_name}</span>
        <span className="study-chip">{playbook.level}</span>
        {playbook.color !== 'both' ? (
          <span className="study-chip">{playbook.color === 'white' ? 'As White' : 'As Black'}</span>
        ) : null}
      </div>

      {link?.summary ? <CourseProgress summary={link.summary} title={playbook.title} /> : null}

      {link || playbook.tabiya_fen ? (
        <div className="study-playbook__actions">
          {link ? (
            <>
              <Button
                disabled={link.busy}
                onClick={() => link.onLesson(pickLearn)}
                type="button"
                variant="primary"
              >
                <GraduationCap aria-hidden="true" size={14} />
                {link.busy ? 'Setting up...' : 'Start learning'}
              </Button>
              <Button
                disabled={link.busy}
                onClick={() => link.onLesson(pickPractice)}
                type="button"
              >
                <Play aria-hidden="true" size={14} />
                {due > 0 ? `Review due (${due.toLocaleString()})` : 'Practice'}
              </Button>
            </>
          ) : null}
          {playbook.tabiya_fen ? (
            <>
              <Button
                onClick={() => onPlayOut(playbook.tabiya_fen!, playbook.title)}
                type="button"
                variant={link ? 'default' : 'primary'}
              >
                <Swords aria-hidden="true" size={14} />
                Play it out vs Stockfish
              </Button>
              <Button
                onClick={() => onLoadBoard(playbook.tabiya_fen!, playbook.color)}
                type="button"
                variant="ghost"
              >
                <Microscope aria-hidden="true" size={14} />
                Analyze position
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {link?.error ? (
        <p className="study-trainer__error" role="alert">
          {link.error}
        </p>
      ) : null}

      {link ? (
        <div className="study-block">
          <button
            aria-expanded={browsing}
            className="study-block__title study-block__toggle"
            onClick={() => {
              if (!browsing && !link.summary) link.onEnsure()
              onBrowse(playbook.id, !browsing)
            }}
            type="button"
          >
            <ListTree aria-hidden="true" size={14} />
            Browse chapters &amp; lines
            {browsing ? (
              <ChevronDown aria-hidden="true" size={14} />
            ) : (
              <ChevronRight aria-hidden="true" size={14} />
            )}
          </button>
          {browsing ? <ChapterBrowser link={link} username={username} /> : null}
        </div>
      ) : null}
      {playbook.tabiya_label ? (
        <p className="muted study-playbook__tabiya">{playbook.tabiya_label}</p>
      ) : null}

      {concreteFixes && concreteFixes.length > 0 ? (
        <div className="study-block study-block--fixes">
          <h4 className="study-block__title">
            <Target aria-hidden="true" size={14} />
            Repeated mistakes from your games
          </h4>
          <ul className="study-list">
            {concreteFixes.map((fix) => (
              <li className="study-fix-row" key={`${fix.fen}-${fix.played_san}`}>
                <span>
                  <strong>{fix.opening_name || 'Your line'}:</strong> played{' '}
                  <code>{fix.played_san}</code> {fix.occurrences}x (avg -{fix.average_loss_cp} cp).
                  Switch to <code>{fix.best_san}</code>.
                </span>
                <Button
                  onClick={() => onLoadBoard(fix.fen, playbook.color, fix.last_move_uci)}
                  type="button"
                  variant="ghost"
                >
                  Inspect
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="study-block">
        <h4 className="study-block__title">
          <Sparkles aria-hidden="true" size={14} />
          Grandmaster core ideas
        </h4>
        <ul className="study-list">
          {playbook.core_ideas.map((idea) => (
            <li key={idea}>{idea}</li>
          ))}
        </ul>
      </div>

      {playbook.white_plans.length > 0 || playbook.black_plans.length > 0 ? (
        <div className="study-plans-grid">
          {playbook.white_plans.length > 0 ? (
            <div className="study-block">
              <h4 className="study-block__title">White&apos;s plans</h4>
              <ul className="study-list">
                {playbook.white_plans.map((plan) => (
                  <li key={plan}>{plan}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {playbook.black_plans.length > 0 ? (
            <div className="study-block">
              <h4 className="study-block__title">Black&apos;s plans</h4>
              <ul className="study-list">
                {playbook.black_plans.map((plan) => (
                  <li key={plan}>{plan}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {playbook.key_breaks.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">Key pawn breaks</h4>
          <ul className="study-list">
            {playbook.key_breaks.map((brk) => (
              <li key={brk}>{brk}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {playbook.piece_guide.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">Piece placement &amp; trades</h4>
          <ul className="study-list">
            {playbook.piece_guide.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {playbook.checklist.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">
            <CheckCircle2 aria-hidden="true" size={14} />
            Over-the-board checklist
          </h4>
          <ul className="study-list">
            {playbook.checklist.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {playbook.common_traps.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">
            <ShieldAlert aria-hidden="true" size={14} />
            Common pitfalls to avoid
          </h4>
          <ul className="study-list">
            {playbook.common_traps.map((trap) => (
              <li key={trap}>{trap}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {playbook.courses.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">
            <GraduationCap aria-hidden="true" size={14} />
            Recommended courses (Chess.com Premium &amp; free)
          </h4>
          <div className="study-resources">
            {playbook.courses.map((course) => {
              const isInternal = course.url.startsWith('#')
              return (
                <div className="study-resource" key={`${course.platform}-${course.title}`}>
                  <div className="study-resource__head">
                    <strong>{course.title}</strong>
                    <span
                      className={`study-badge ${
                        course.source === 'chesscom_premium'
                          ? 'study-badge--premium'
                          : 'study-badge--free'
                      }`}
                    >
                      {course.source === 'chesscom_premium' ? (
                        <Crown aria-hidden="true" size={11} />
                      ) : null}
                      {course.platform}
                    </span>
                  </div>
                  <span className="muted study-resource__meta">
                    {course.author} ({course.level})
                  </span>
                  <p className="study-resource__why">{course.why}</p>
                  {isInternal ? (
                    <button
                      className="study-resource__link"
                      onClick={() => revealSection(course.url.slice(1))}
                      type="button"
                    >
                      Open in ChessGod
                    </button>
                  ) : (
                    <a
                      className="study-resource__link"
                      href={course.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open resource
                      <ExternalLink aria-hidden="true" size={12} />
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {playbook.books.length > 0 ? (
        <div className="study-block">
          <h4 className="study-block__title">
            <BookOpen aria-hidden="true" size={14} />
            Master books for deeper study
          </h4>
          <ul className="study-books">
            {playbook.books.map((book) => (
              <li key={book.title}>
                <strong>{book.title}</strong> <span className="muted">by {book.author}</span>
                <p className="muted">{book.focus}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function PlaybookCard({
  playbook,
  expanded,
  onToggle,
  rank,
  recommendation,
  handlers,
}: {
  playbook: MasterPlaybook
  expanded: boolean
  onToggle: () => void
  rank?: number
  recommendation?: StudyRecommendation
  handlers: BoardHandlers
}) {
  const link = handlers.courseFor(playbook)
  return (
    <article className={`study-card${expanded ? ' study-card--open' : ''}`}>
      <button
        aria-expanded={expanded}
        className="study-card__toggle"
        onClick={onToggle}
        type="button"
      >
        {rank != null ? <span className="study-card__rank">#{rank}</span> : null}
        <div className="study-card__head">
          <div className="study-card__title-row">
            <strong>{playbook.title}</strong>
            <span className="study-chip">{CATEGORY_LABELS[playbook.category]}</span>
            <DueBadge summary={link?.summary} />
          </div>
          {recommendation ? (
            <>
              <span className="study-card__reason">{recommendation.reason}</span>
              <span className="muted study-card__evidence">{recommendation.evidence}</span>
              <div className="study-card__metrics">
                <span>
                  {recommendation.metric_label}: <strong>{recommendation.current_value}</strong>
                </span>
                <span className="muted">Target: {recommendation.target_value}</span>
              </div>
            </>
          ) : (
            <span className="muted study-card__evidence">{playbook.subtitle}</span>
          )}
        </div>
        <span aria-hidden="true" className="study-card__chevron">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {expanded ? (
        <div className="study-card__body">
          <PlaybookReader
            {...handlers}
            concreteFixes={recommendation?.concrete_fixes}
            playbook={playbook}
          />
        </div>
      ) : null}
    </article>
  )
}

type GuideView = 'recommended' | 'library'

/**
 * Playbooks: every playbook matched to the player's weaknesses, and the whole
 * library, each one a guide to read and, when it has one, a course to train
 * move by move on the board without leaving the card.
 */
export function StudyGuide({
  username,
  timeClass,
  onBeginDrill,
  onPlayOut,
  onOpenExplore,
}: {
  username: string
  timeClass: string | null
  /** Clears a loaded game or opening before a lesson or a position takes the board. */
  onBeginDrill?: () => void
  onPlayOut?: PlayOut
  onOpenExplore?: (section: string) => void
}) {
  const { data, isLoading, error, refetch } = useStudyGuide({ username, timeClass })
  const courses = useStudyCourses(username)
  const importer = useImportStudyCourse(username)
  const queryClient = useQueryClient()
  const [view, setView] = useState<GuideView>('recommended')
  const [categoryFilter, setCategoryFilter] = useState<'all' | MasterPlaybook['category']>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [browsing, setBrowsing] = useState<ReadonlySet<string>>(() => new Set())
  const [busyPreset, setBusyPreset] = useState<string | null>(null)
  const [courseError, setCourseError] = useState<{ presetId: string; message: string } | null>(null)
  const { playOut } = useStartSparring(username, () => {})
  const lessonDetail = useStudyCourse(username, lesson?.courseId ?? null)

  // Nothing read from a playbook carries on past a change of tab or leaving Playbooks.
  useEffect(() => stopSpeech, [])
  useEffect(() => {
    stopSpeech()
  }, [view, categoryFilter])

  const byPreset = useMemo(() => {
    const found = new Map<string, StudyCourseSummary>()
    for (const course of courses.data?.courses ?? []) {
      if (course.source_type === 'builtin' && course.source_ref) {
        found.set(course.source_ref, course)
      }
    }
    return found
  }, [courses.data])

  function openExplore(section: string) {
    if (onOpenExplore) onOpenExplore(section)
    else window.dispatchEvent(new CustomEvent(OPEN_EXPLORE_EVENT, { detail: { section } }))
  }

  function handleLoadBoard(
    fen: string,
    color: MasterPlaybook['color'],
    lastUci: string | null = null,
  ) {
    onBeginDrill?.()
    const app = useAppStore.getState()
    app.loadPosition(fullFen(fen), lastUci)
    if (color === 'white' || color === 'black') {
      app.alignBoardToUserColor(color)
    }
    openExplore('explore-engine')
  }

  function handlePlayOut(fen: string, title: string, lastUci: string | null = null) {
    sendPlayOut({ fen: fullFen(fen), lastUci, origin: `Playbook: ${title}` })
  }

  function sendPlayOut(position: { fen: string; lastUci: string | null; origin?: string }) {
    if (onPlayOut) {
      onPlayOut(position)
    } else {
      playOut(position)
      openExplore('explore-sparring')
    }
  }

  /** The player's copy of a built-in course, added first when they have none. */
  async function ensureCourse(presetId: string): Promise<StudyCourseDetail> {
    const owned = byPreset.get(presetId)
    if (!owned) return importer.mutateAsync({ preset_id: presetId })
    return queryClient.fetchQuery({
      queryKey: studyCourseQueryKey(username, owned.id),
      queryFn: async ({ signal }) => {
        const { data: course } = await api.get<StudyCourseDetail>(
          `/api/study/courses/${owned.id}`,
          { params: { username }, signal },
        )
        return course
      },
      staleTime: 60 * 1000,
    })
  }

  async function prepare(presetId: string, pick?: LessonPick) {
    if (busyPreset) return
    setBusyPreset(presetId)
    setCourseError(null)
    try {
      const course = await ensureCourse(presetId)
      if (!pick) return
      const { queue, mode } = pick(course)
      if (queue.length === 0) {
        setCourseError({ presetId, message: 'This course has no lines to train yet.' })
        return
      }
      onBeginDrill?.()
      setLesson({
        courseId: course.id,
        courseTitle: course.title,
        color: course.color,
        queue,
        at: 0,
        mode,
        run: 0,
      })
    } catch (failure) {
      setCourseError({
        presetId,
        message: getApiErrorMessage(failure, 'The course could not be opened.'),
      })
    } finally {
      setBusyPreset(null)
    }
  }

  function courseFor(playbook: MasterPlaybook): CourseLink | null {
    const presetId = playbook.course_preset_id
    if (!presetId) return null
    return {
      summary: byPreset.get(presetId),
      busy: busyPreset === presetId,
      error: courseError?.presetId === presetId ? courseError.message : null,
      onLesson: (pick) => void prepare(presetId, pick),
      onEnsure: () => void prepare(presetId),
    }
  }

  function nextStep(current: Lesson): StudyNextStep | null {
    const line = current.queue[current.at]
    if (current.at + 1 < current.queue.length) {
      return {
        label: current.mode === 'practice' ? 'Next due line' : 'Next line',
        onSelect: () => setLesson({ ...current, at: current.at + 1, run: current.run + 1 }),
      }
    }
    const lines = lessonDetail.data ? courseLines(lessonDetail.data) : current.queue
    const due = lines.find((other) => other.due_moves > 0 && other.id !== line.id)
    if (due) {
      return {
        label: 'Next due line',
        onSelect: () =>
          setLesson({ ...current, queue: [due], at: 0, mode: 'practice', run: current.run + 1 }),
      }
    }
    const position = lines.findIndex((other) => other.id === line.id)
    const following = position >= 0 ? lines[position + 1] : undefined
    if (!following) return null
    return {
      label: 'Next line',
      onSelect: () =>
        setLesson({
          ...current,
          queue: [following],
          at: 0,
          mode: following.status === 'new' ? 'learn' : 'practice',
          run: current.run + 1,
        }),
    }
  }

  if (lesson) {
    const line = lesson.queue[lesson.at]
    return (
      <div className="study-guide">
        <StudyCourseTrainer
          backLabel="Back to Playbooks"
          color={lesson.color}
          courseId={lesson.courseId}
          courseTitle={lesson.courseTitle}
          key={`${line.id}:${lesson.mode}:${lesson.run}`}
          line={line}
          mode={lesson.mode}
          next={nextStep(lesson)}
          onClose={() => setLesson(null)}
          onPlayOut={sendPlayOut}
          onPracticeAgain={() => setLesson({ ...lesson, mode: 'practice', run: lesson.run + 1 })}
          username={username}
        />
      </div>
    )
  }

  if (isLoading && !data) {
    return <PanelSkeleton rows={5} />
  }

  if (error || !data) {
    return (
      <PanelError
        error={error ?? new Error('Study Guide data unavailable')}
        onRetry={() => void refetch()}
        what="your Study Guide"
      />
    )
  }

  const handlers: BoardHandlers = {
    onLoadBoard: handleLoadBoard,
    onPlayOut: handlePlayOut,
    courseFor,
    browsing,
    onBrowse: (playbookId, open) =>
      setBrowsing((current) => {
        const next = new Set(current)
        if (open) next.add(playbookId)
        else next.delete(playbookId)
        return next
      }),
    username,
  }
  const activeExpanded = expandedId ?? data.recommended[0]?.playbook_id ?? null
  const filteredCatalog =
    categoryFilter === 'all'
      ? data.catalog
      : data.catalog.filter((pb) => pb.category === categoryFilter)

  return (
    <div className="study-guide">
      <div className="study-guide__intro">
        <div className="study-guide__headline">
          <strong>Master Playbooks Matched to Your Weaknesses</strong>
          <span className="muted">
            {data.player_snapshot.latest_rating
              ? `Rated ${data.player_snapshot.latest_rating}`
              : 'Your library'}
            {data.player_snapshot.analyzed_decisions > 0
              ? ` - ${data.player_snapshot.analyzed_decisions.toLocaleString()} analyzed decisions`
              : ''}
            {data.player_snapshot.biggest_phase && data.player_snapshot.biggest_phase_share != null
              ? ` - ${Math.round(data.player_snapshot.biggest_phase_share * 100)}% of loss in ${data.player_snapshot.biggest_phase}`
              : ''}
          </span>
          <span className="muted">
            Start learning steps through each lesson on the board with arrows and explanations, then
            Practice tests you from memory.
          </span>
        </div>

        <div aria-label="Study Guide view" className="study-tabs" role="group">
          <button
            aria-pressed={view === 'recommended'}
            className={`study-tabs__btn${view === 'recommended' ? ' study-tabs__btn--active' : ''}`}
            onClick={() => setView('recommended')}
            type="button"
          >
            For your weaknesses ({data.recommended.length})
          </button>
          <button
            aria-pressed={view === 'library'}
            className={`study-tabs__btn${view === 'library' ? ' study-tabs__btn--active' : ''}`}
            onClick={() => setView('library')}
            type="button"
          >
            All Playbooks ({data.catalog.length})
          </button>
        </div>
      </div>

      {view === 'recommended' ? (
        data.recommended.length > 0 ? (
          <div className="study-cards">
            {data.recommended.map((item, idx) => (
              <PlaybookCard
                expanded={activeExpanded === item.playbook_id}
                handlers={handlers}
                key={item.playbook_id}
                onToggle={() =>
                  setExpandedId((current) =>
                    (current ?? data.recommended[0]?.playbook_id) === item.playbook_id
                      ? ''
                      : item.playbook_id,
                  )
                }
                playbook={item.playbook}
                rank={idx + 1}
                recommendation={item}
              />
            ))}
          </div>
        ) : (
          <p className="muted">
            Import and analyze more games to unlock weakness-matched recommendations, or browse All
            Playbooks above.
          </p>
        )
      ) : (
        <div className="study-library">
          <div aria-label="Playbook category" className="study-filters" role="group">
            {(
              ['all', 'opening', 'middlegame', 'tactics', 'defense', 'endgame', 'habits'] as const
            ).map((cat) => (
              <button
                aria-pressed={categoryFilter === cat}
                className={`study-chip-btn${categoryFilter === cat ? ' study-chip-btn--active' : ''}`}
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                type="button"
              >
                {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
          <div className="study-cards">
            {filteredCatalog.map((pb) => (
              <PlaybookCard
                expanded={expandedId === pb.id}
                handlers={handlers}
                key={pb.id}
                onToggle={() => setExpandedId((cur) => (cur === pb.id ? '' : pb.id))}
                playbook={pb}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
