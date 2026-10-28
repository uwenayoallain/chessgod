import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Dumbbell, Microscope, RefreshCw, Volume2, VolumeX, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LastWeekTeaser } from '@/components/training/week-scoresheet'
import { isMuted, play, setMuted } from '@/lib/sound'
import { revealSection } from '@/components/ui/collapsible-section'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { useImport } from '@/hooks/use-import'
import type { PaginatedGames, WorkspaceGame } from '@/hooks/use-workspace-data'
import {
  profileQueryKey,
  repertoireQueryKey,
  useApplyReward,
  useRepertoire,
  useTrainingProfile,
} from '@/hooks/use-training'
import { api } from '@/lib/api'
import { shortOpeningName } from '@/lib/analysis/points-lost'
import { StatTile } from '@/components/training/stat-tile'
import { formatGameDate } from '@/lib/format-date'
import { challengesStale } from '@/lib/training/challenges'
import {
  dueLines,
  lineTitle,
  mostRecentlyTouched,
  nextLineToLearn,
  nextLineToPractise,
} from '@/lib/training/course'
import {
  BadgeMedallion,
  Emblem,
  Medal,
  PieceCrest,
  TitlePiece,
} from '@/components/training/trophies'
import type { EmblemName } from '@/lib/training/emblem-art'
import {
  DAILY_GOALS,
  TITLE_LADDER,
  browserTimeZone,
  freezeMessage,
  goalProgress,
  levelProgress,
  closestAchievements,
  groupAchievements,
  nextTitle,
  raceTrack,
  readDailyGoal,
  rivalMessage,
  riskMessage,
  streakAtRisk,
  streakMessage,
  writeDailyGoal,
} from '@/lib/training/progress'
import { useHabits } from '@/components/training/habits-card'
import { describeSitting } from '@/lib/training/habits'
import { QUEST_TARGETS, questSummary, questsDone } from '@/lib/training/quests'
import { describeCheck, describeDeviation, deviationLineIds } from '@/lib/training/rush'
import type {
  Achievement,
  ChallengeBoard,
  QuestBoard,
  QuestSection,
  RepertoireCheck,
  TrainingProfile,
} from '@/lib/training/types'
import { useTrainingStore, type Celebration, type CelebrationVisual } from '@/store/training-store'

/** Streak, level and today's goal, always in view: the reason to come back. */
export function TrainingChip({ username }: { username: string }) {
  const profile = useTrainingProfile(username).data
  const bump = useTrainingStore((state) => state.bump)
  if (!profile) return null
  return (
    <button
      // Alternates so each landing restarts the bump animation.
      data-bump={bump ? bump % 2 : undefined}
      data-risk={streakAtRisk(profile) != null || undefined}
      className="training-chip"
      onClick={openToday}
      type="button"
      title={`${streakMessage(profile)} Level ${profile.level} ${profile.title}: ${profile.xp.toLocaleString()} XP.`}
    >
      <span
        aria-hidden="true"
        className="training-chip__streak"
        data-alive={profile.streak > 0 || undefined}
      >
        <Emblem name="flame" size={16} /> {profile.streak.toLocaleString()}
      </span>
      <span aria-hidden="true" className="training-chip__level">
        <PieceCrest
          level={profile.level}
          progress={levelProgress(profile)}
          showLevel={false}
          size={24}
          title={profile.title}
        />
        {profile.level}
      </span>
      <span
        aria-hidden="true"
        className="training-chip__bar"
        data-met={profile.goal_met_today || undefined}
      >
        <span style={{ width: `${goalProgress(profile) * 100}%` }} />
      </span>
      <span className="sr-only-inline">
        {profile.streak}-day streak, level {profile.level} {profile.title}, {profile.today_xp} of{' '}
        {profile.daily_goal} XP today. Open today's training.
      </span>
    </button>
  )
}

export const OPEN_TODAY_EVENT = 'chessgod:open-today'

/** The chip is a door: from anywhere in the app, straight to today's training. */
function openToday() {
  window.dispatchEvent(new CustomEvent(OPEN_TODAY_EVENT))
}

function GoalRing({ profile }: { profile: TrainingProfile }) {
  const radius = 30
  const circumference = 2 * Math.PI * radius
  const share = goalProgress(profile)
  return (
    <svg
      aria-label={`${profile.today_xp} of ${profile.daily_goal} XP today${profile.goal_met_today ? ', goal met' : ''}`}
      className="goal-ring"
      role="img"
      viewBox="0 0 76 76"
    >
      <circle className="goal-ring__track" cx="38" cy="38" r={radius} />
      <circle
        className="goal-ring__fill"
        cx="38"
        cy="38"
        data-met={profile.goal_met_today || undefined}
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
      />
      <text className="goal-ring__value" x="38" y="36">
        {profile.today_xp.toLocaleString()}
      </text>
      <text className="goal-ring__label" x="38" y="50">
        / {profile.daily_goal} XP
      </text>
    </svg>
  )
}

/**
 * This week against last week as a race on two ranks: your white pawn
 * advances with this week's XP, last week's black pawn stands where you were
 * at this point then, and the last square is last week's whole total — reach
 * it and the pawn promotes.
 */
function RivalRace({ profile }: { profile: TrainingProfile }) {
  const { this_week, last_week_so_far, last_week } = profile.rival
  const track = raceTrack(profile)
  const lane = (who: 'you' | 'rival', at: number, label: string, xp: string) => (
    <div className="race__lane" data-who={who}>
      <span className="race__label">
        {label}
        <strong>{xp}</strong>
      </span>
      <span aria-hidden="true" className="race__rank">
        {Array.from({ length: 8 }, (_, index) => (
          <span data-shade={(index + (who === 'you' ? 0 : 1)) % 2 ? 'dark' : 'light'} key={index} />
        ))}
        {who === 'you' ? (
          <span className="race__goal">
            <TitlePiece title="Queen" />
          </span>
        ) : null}
        <span className="race__piece" style={{ left: `${at * 87.5}%` }}>
          <TitlePiece
            side={who === 'you' ? 'w' : 'b'}
            title={who === 'you' && track.promoted ? 'Queen' : 'Pawn'}
          />
        </span>
      </span>
    </div>
  )
  return (
    <div
      className="race"
      data-promoted={track.promoted || undefined}
      role="group"
      aria-label={`This week ${this_week} XP against ${last_week_so_far} last week at this point; last week's total ${last_week}.`}
    >
      {lane('you', track.you, 'This week', `${this_week.toLocaleString()} XP`)}
      {track.rival != null
        ? lane('rival', track.rival, 'Last week, by now', `${last_week_so_far.toLocaleString()} XP`)
        : null}
      <p className="muted rival__message">{rivalMessage(profile)}</p>
    </div>
  )
}

/**
 * The latest games against the repertoire: where the player left it, and the
 * learned moves that sends back to review (the server requeues them).
 */
/**
 * The latest games against the repertoire. The server requeues learned moves
 * missed over the board, so the Today page runs this on landing even though
 * the card itself lives on the Course page; both share the one query.
 */
function useRepertoireCheck(username: string) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['repertoire-check', username],
    queryFn: async () => {
      const result = (
        await api.post<RepertoireCheck>('/api/training/repertoire/check', { username })
      ).data
      if (result.requeued) {
        void queryClient.invalidateQueries({ queryKey: profileQueryKey(username) })
        void queryClient.invalidateQueries({ queryKey: repertoireQueryKey(username, 'black') })
        void queryClient.invalidateQueries({ queryKey: repertoireQueryKey(username, 'white') })
      }
      return result
    },
    staleTime: 10 * 60 * 1000,
  })
}

export function RepertoireCheckCard({ username }: { username: string }) {
  const startSession = useTrainingStore((state) => state.startSession)
  const black = useRepertoire(username, 'black').data
  const white = useRepertoire(username, 'white').data
  const data = useRepertoireCheck(username).data
  if (!data || !data.games_checked) return null
  const summary = describeCheck(data)
  const color = data.deviations[0]?.color ?? 'black'
  const ids = deviationLineIds(data, color)
  const lines = (color === 'black' ? black : white)?.lines ?? []
  const anyNew = lines.some((line) => ids.includes(line.id) && line.status === 'new')
  return (
    <div className="repertoire-check" data-clean={!data.deviations.length || undefined}>
      <p className="repertoire-check__summary">
        <Emblem name="swords" size={18} /> <span>{summary}</span>
      </p>
      {data.deviations.length ? (
        <>
          <ul className="repertoire-check__list">
            {data.deviations.slice(0, 3).map((item) => (
              <li key={`${item.game_id}:${item.ply}`}>
                <a href={item.url} rel="noreferrer" target="_blank">
                  {describeDeviation(item)}
                </a>
              </li>
            ))}
          </ul>
          {ids.length ? (
            <Button
              onClick={() => {
                startSession({
                  color,
                  lineIds: ids,
                  mode: anyNew ? 'learn' : 'practice',
                  label: 'From your games',
                })
                // The session lives on the Course page; go where it shows.
                revealSection('review-course')
              }}
              type="button"
              variant="default"
            >
              <Dumbbell size={14} /> {anyNew ? 'Learn' : 'Review'}{' '}
              {ids.length === 1 ? 'that line' : `those ${ids.length} lines`}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

const QUEST_EMBLEMS: Record<QuestSection, EmblemName> = {
  threats: 'eye',
  openings: 'book',
  drills: 'crosshair',
  quiz: 'question',
  review: 'magnifier',
  play: 'swords',
}

/**
 * Today's three quests: Blunder Check every day (it is where most points go),
 * the openings, and one that rotates. Clearing all three opens a chest.
 */
function QuestList({
  board,
  onOpenExplore,
}: {
  board: QuestBoard
  onOpenExplore?: (section: string) => void
}) {
  const done = questsDone(board)
  function go(section: QuestSection) {
    const target = QUEST_TARGETS[section]
    if (target.tab === 'explore') onOpenExplore?.(target.section)
    else revealSection(target.section)
  }
  return (
    <div className="quests" data-cleared={board.all_done || undefined}>
      <div className="quests__head">
        <strong>Today's quests</strong>
        <span className="quests__chest" data-open={board.chest_opened || undefined}>
          <Emblem name={board.chest_opened ? 'chestOpen' : 'chest'} size={20} /> {done}/
          {board.items.length}
          <span className="sr-only-inline"> quests done</span>
        </span>
      </div>
      <ul className="quests__list">
        {board.items.map((quest) => {
          const emblem = QUEST_EMBLEMS[quest.section]
          return (
            <li className="quest" data-done={quest.done || undefined} key={quest.key}>
              <span aria-hidden="true" className="quest__icon">
                <Emblem name={emblem} size={22} />
              </span>
              <span className="quest__body">
                <span className="quest__title">{quest.title}</span>
                <span className="quest__bar" aria-hidden="true">
                  <span style={{ width: `${(quest.progress / quest.target) * 100}%` }} />
                </span>
              </span>
              <span className="quest__count muted">
                <span className="sr-only-inline">Progress </span>
                {quest.progress.toLocaleString()}/{quest.target.toLocaleString()}
              </span>
              {quest.done ? (
                <span className="quest__xp">+{quest.xp} XP</span>
              ) : (
                <Button
                  aria-label={`Go: ${QUEST_TARGETS[quest.section].label}, ${quest.title}`}
                  onClick={() => go(quest.section)}
                  type="button"
                  variant="ghost"
                >
                  Go
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      <p className="muted quests__summary">{questSummary(board)}</p>
    </div>
  )
}

/**
 * This week's challenges, scored from the imported games: the training has to
 * show up over the board. Checking pays any the games have finished.
 */
/**
 * The week's challenges, scored from imported games. Settling pays XP, so the
 * Today page runs this on landing even though the board itself lives on the
 * Your week page; both share the one query.
 */
function useChallengeBoard(username: string) {
  const applyReward = useApplyReward(username)
  const celebrate = useTrainingStore((state) => state.celebrate)
  return useQuery({
    queryKey: ['training-challenges', username],
    queryFn: async () => {
      const board = (
        await api.post<ChallengeBoard>('/api/training/challenges/check', {
          username,
          tz: browserTimeZone(),
          goal: readDailyGoal(),
        })
      ).data
      for (const key of board.paid ?? []) {
        const item = board.items.find((challenge) => challenge.key === key)
        if (item) {
          celebrate({
            kind: 'quest',
            title: 'Challenge complete',
            detail: `${item.title} · +${item.xp} XP`,
            visual: { kind: 'icon', name: 'trophy' },
          })
        }
      }
      // The challenge has its own toast; this applies the profile, a level and badges.
      if (board.xp_gained > 0) void applyReward({ ...board, xp_gained: 0 })
      return board
    },
    staleTime: 10 * 60 * 1000,
  })
}

export function ChallengeList({ username }: { username: string }) {
  const { status, startImport } = useImport(username)
  const board = useChallengeBoard(username).data
  if (!board) return null
  return (
    <div className="challenges">
      <div className="challenges__head">
        <strong>This week, over the board</strong>
        <span className="muted">until {formatGameDate(`${board.ends}T12:00:00`)}</span>
      </div>
      <ul className="quests__list">
        {board.items.map((challenge) => {
          const emblem: EmblemName = challenge.key === 'use_clock' ? 'hourglass' : 'book'
          return (
            <li
              className="quest quest--medal"
              data-done={challenge.done || undefined}
              key={challenge.key}
              title={challenge.games
                .map((game) => `${formatGameDate(game.played_at)} · ${game.result}`)
                .join('\n')}
            >
              <Medal
                earned={challenge.done}
                emblem={emblem}
                label={`${challenge.progress} of ${challenge.target} games`}
                progress={challenge.progress / challenge.target}
                size={34}
              />
              <span className="quest__body">
                <span className="quest__title">{challenge.title}</span>
                <span className="muted challenge__description">{challenge.description}</span>
                <span className="quest__bar" aria-hidden="true">
                  <span style={{ width: `${(challenge.progress / challenge.target) * 100}%` }} />
                </span>
              </span>
              <span className="quest__count muted">
                <span className="sr-only-inline">Progress </span>
                {challenge.progress.toLocaleString()}/{challenge.target.toLocaleString()}
              </span>
              <span className="quest__xp" data-pending={!challenge.done || undefined}>
                +{challenge.xp} XP
                <span className="sr-only-inline">{challenge.done ? ', earned' : ', to earn'}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {challengesStale(board, new Date()) ? (
        <p className="muted challenges__stale">
          {board.latest_game
            ? `Your newest imported game is from ${formatGameDate(board.latest_game)}. `
            : ''}
          <button
            className="link-button"
            disabled={status === 'running'}
            onClick={() => void startImport()}
            type="button"
          >
            <RefreshCw size={12} /> {status === 'running' ? 'Importing…' : 'Import new games'}
          </button>
        </p>
      ) : null}
    </div>
  )
}

const RESULT_WORDS: Record<string, string> = { win: 'Won', loss: 'Lost', draw: 'Drew' }

/**
 * The newest imported game, one press from a review: play, review, retry is
 * the habit that turns games into lessons, and the game is freshest now.
 */
function LatestGame({
  username,
  onOpenGame,
}: {
  username: string
  onOpenGame?: (game: WorkspaceGame) => void
}) {
  const query = useQuery({
    queryKey: ['latest-game', username],
    queryFn: async ({ signal }) =>
      (
        await api.get<PaginatedGames>('/api/games', {
          params: { username, page: 1, per_page: 1 },
          signal,
        })
      ).data.games[0] ?? null,
    staleTime: 5 * 60 * 1000,
  })
  const game = query.data
  if (!game || !onOpenGame) return null
  const white = game.user_color === 'white'
  const opponent = white ? game.black_username : game.white_username
  const rating = white ? game.black_rating : game.white_rating
  return (
    <div className="latest-game" data-result={game.user_result}>
      <div className="latest-game__text">
        <span className="muted">
          Your latest game · {formatGameDate(game.played_at)} · {game.time_class}
        </span>
        <strong>
          {RESULT_WORDS[game.user_result] ?? 'Played'} as {white ? 'White' : 'Black'} against{' '}
          {opponent}
          {rating ? ` (${rating})` : ''}
        </strong>
        {game.opening_name ? (
          <span className="muted">{shortOpeningName(game.opening_name)}</span>
        ) : null}
      </div>
      <Button onClick={() => onOpenGame(game)} type="button" variant="default">
        <Microscope size={14} /> Review it
      </Button>
    </div>
  )
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })
const LONG_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/**
 * What to do today, first in Review: the goal, the streak on the line, and
 * the few things that earn it — reviews due, the next fix to learn, drills.
 */
export function TodayCard({
  username,
  onOpenExplore,
  onOpenGame,
}: {
  username: string
  onOpenExplore?: (section: string) => void
  /** Load a game in Explore with its review open. */
  onOpenGame?: (game: WorkspaceGame) => void
}) {
  const profileQuery = useTrainingProfile(username)
  // Both settle on landing (challenge XP, repertoire requeues); their cards
  // live on the Your week and Course pages, which reuse these queries.
  useChallengeBoard(username)
  useRepertoireCheck(username)
  const black = useRepertoire(username, 'black')
  const white = useRepertoire(username, 'white')
  const startSession = useTrainingStore((state) => state.startSession)
  const queryClient = useQueryClient()
  const habits = useHabits(username)

  const profile = profileQuery.data
  if (!profile) return <PanelSkeleton label="Loading today's training" rows={3} rowHeight={48} />

  const blackLines = black.data?.lines ?? []
  const whiteLines = white.data?.lines ?? []
  const dueBlack = dueLines(blackLines)
  const dueWhite = dueLines(whiteLines)
  const dueColor = dueBlack.length >= dueWhite.length ? 'black' : 'white'
  const due = dueColor === 'black' ? dueBlack : dueWhite
  const nextFix = nextLineToLearn(blackLines, 'black') ?? nextLineToLearn(whiteLines, 'white')
  const nextColor = nextFix && blackLines.includes(nextFix) ? 'black' : 'white'
  // A line learned with the hints showing and never played from memory. It
  // comes before anything else: the player just did the work, and offering
  // another line to learn reads as if that session had not counted.
  const toPractise = mostRecentlyTouched([
    nextLineToPractise(blackLines, 'black'),
    nextLineToPractise(whiteLines, 'white'),
  ])
  const practiseColor = toPractise && blackLines.includes(toPractise) ? 'black' : 'white'
  const fixes = blackLines.filter((line) => line.changes > 0)
  const fixGames = fixes.reduce((n, line) => n + line.games, 0)
  const unlearnedFixes = fixes.filter((line) => line.status === 'new').length

  function changeGoal(xp: number) {
    writeDailyGoal(xp)
    void queryClient.invalidateQueries({ queryKey: profileQueryKey(username) })
  }

  const risk = streakAtRisk(profile)
  const sitting = habits.data ? describeSitting(habits.data) : null
  // The session renders inside the Opening course, which is its own page now,
  // so starting one must also take the player there — without the reveal the
  // button writes store state and nothing visible happens.
  const dueMoves = due.reduce((n, line) => n + line.due_moves, 0)
  // A Black fix still to learn is worth more than any review: the Black
  // openings are where the points leak. Reviews follow it.
  const fixFirst = nextFix != null && nextColor === 'black' && nextFix.changes > 0
  const learnStep = nextFix
    ? {
        label: `Learn ${lineTitle(nextFix)}`,
        note: dueMoves
          ? `+15 XP · about 2 minutes · ${dueMoves.toLocaleString()} moves to review after`
          : '+15 XP · about 2 minutes',
        icon: BookOpen,
        start: () => {
          startSession({
            color: nextColor,
            lineIds: [nextFix.id],
            mode: 'learn',
            label: 'Learn',
          })
          revealSection('review-course')
        },
      }
    : null
  const practiseStep = toPractise
    ? {
        label: `Practice ${lineTitle(toPractise)}`,
        note: 'Learned · play it from memory',
        icon: Dumbbell,
        start: () => {
          startSession({
            color: practiseColor,
            lineIds: [toPractise.id],
            mode: 'practice',
            label: 'Practice',
          })
          revealSection('review-course')
        },
      }
    : null
  const step = practiseStep
    ? practiseStep
    : fixFirst
      ? learnStep
      : due.length
        ? {
            label: `Review ${dueMoves.toLocaleString()} opening moves`,
            note: 'Due now · +3 XP each',
            icon: Dumbbell,
            start: () => {
              startSession({
                color: dueColor,
                lineIds: due.map((line) => line.id),
                mode: 'practice',
                label: 'Review',
              })
              revealSection('review-course')
            },
          }
        : learnStep

  return (
    <section aria-label="Today's training" className="today-card">
      <header className="today-card__top">
        <GoalRing profile={profile} />
        <div className="today-card__status">
          <p className="today-card__streak" data-alive={profile.streak > 0 || undefined}>
            <Emblem className="today-card__flame" name="flame" size={22} />
            {profile.streak ? `${profile.streak.toLocaleString()}-day streak` : 'No streak yet'}
            <span className="today-card__freezes" title={freezeMessage(profile)}>
              <Emblem name="snowflake" size={16} /> {profile.freezes}
              <span className="sr-only-inline"> streak freezes</span>
            </span>
          </p>
          {risk != null ? (
            <p className="today-card__message today-card__message--risk">
              {riskMessage(profile, risk)}
            </p>
          ) : (
            <p className="today-card__message">{streakMessage(profile)}</p>
          )}
        </div>
        <div className="today-card__rank" title={`${profile.xp.toLocaleString()} XP in all`}>
          <PieceCrest
            level={profile.level}
            progress={levelProgress(profile)}
            showLevel={false}
            size={52}
            title={profile.title}
          />
          <span className="today-card__rank-title">
            {profile.title} · {profile.level}
          </span>
          <span className="today-card__rank-next">
            {(profile.next_level_xp - profile.xp).toLocaleString()} XP to level {profile.level + 1}
          </span>
        </div>
      </header>

      {profile.xp === 0 ? (
        // Before any training, one clear place to begin instead of empty rings.
        <div className="first-step">
          <Medal
            earned={false}
            emblem="eye"
            label="Start with Blunder Check"
            progress={0}
            size={48}
          />
          <span className="first-step__text">
            <strong>Start with Blunder Check</strong>
            <span className="muted">
              10 positions from your own games. Find how your opponent punished each one. About 3
              minutes.
            </span>
          </span>
          <Button onClick={() => revealSection('review-threats')} type="button" variant="primary">
            Start
          </Button>
        </div>
      ) : null}

      {sitting ? (
        // Only while a sitting is going on: the one thing to know between games.
        <div className="train-callout" data-tone={sitting.stop ? 'warn' : undefined}>
          <p>{sitting.text}</p>
        </div>
      ) : null}

      <WeekRank profile={profile} />

      {profile.quests ? <QuestList board={profile.quests} onOpenExplore={onOpenExplore} /> : null}

      {step ? (
        <div className="today-card__step">
          <Button onClick={step.start} type="button" variant="primary">
            <step.icon size={14} /> {step.label}
          </Button>
          <span className="muted">{step.note}</span>
        </div>
      ) : null}

      <LastWeekTeaser username={username} />

      <LatestGame onOpenGame={onOpenGame} username={username} />

      {unlearnedFixes ? (
        <p className="train-callout today-card__stakes" data-tone="bad">
          <span>
            <Emblem name="crosshair" size={16} /> In {unlearnedFixes.toLocaleString()} of your Black
            openings the move you usually play loses ground; {fixGames.toLocaleString()} of your
            games reached those lines. The course has the better move for each.
          </span>
          <Button onClick={() => revealSection('review-course')} type="button" variant="ghost">
            Open the course
          </Button>
        </p>
      ) : null}

      <details className="today-card__more">
        <summary>Rival, goal and sound</summary>
        <RivalRace profile={profile} />
        <p className="muted today-card__freeze-note">{freezeMessage(profile)}</p>
        <div className="today-card__goal" role="group" aria-label="Daily goal">
          <span className="muted">Daily goal</span>
          {DAILY_GOALS.map((goal) => (
            <button
              aria-pressed={readDailyGoal() === goal.xp}
              className="today-card__goal-option"
              key={goal.xp}
              onClick={() => changeGoal(goal.xp)}
              type="button"
            >
              {goal.label} · {goal.xp} XP
            </button>
          ))}
        </div>
        <SoundSwitch />
      </details>
    </section>
  )
}

/** The days of a run that ends today, or yesterday while today is still open. */
function currentRun(profile: TrainingProfile): number {
  const met = profile.week.map((day) => day.xp >= profile.daily_goal || day.frozen)
  let index = met.length - 1
  if (!met[index]) index -= 1
  let run = 0
  while (index >= 0 && met[index]) {
    run += 1
    index -= 1
  }
  return run
}

/**
 * The week as a rank of the board, and the streak as a pawn marching up it:
 * a pawn on each day the goal was met, and a full rank of seven promotes it —
 * the newest square shows a queen. Chess's own rule, doing the streak's job.
 */
function WeekRank({ profile }: { profile: TrainingProfile }) {
  const run = currentRun(profile)
  // A frozen day holds the run, as it holds the streak; the queen still waits for today.
  const promoted = run >= profile.week.length
  const caption = promoted
    ? 'Seven days in a row: your pawn promoted. Keep the streak to keep the queen.'
    : run
      ? `${run} of 7 days in a row. Make it 7 and your pawn promotes.`
      : "Meet today's goal to put a pawn on the board."
  return (
    <figure className="week-rank-figure" data-promoted={promoted || undefined}>
      <ol aria-label="The last seven days" className="week-rank">
        {profile.week.map((day, index) => {
          const met = day.xp >= profile.daily_goal
          const today = index === profile.week.length - 1
          const queen = promoted && today
          return (
            <li
              data-frozen={day.frozen || undefined}
              data-met={met || undefined}
              data-shade={index % 2 ? 'dark' : 'light'}
              data-today={today || undefined}
              key={day.date}
              title={`${LONG_DAY.format(new Date(`${day.date}T12:00:00`))}: ${day.xp} XP${met ? ', goal met' : day.frozen ? ', kept by a freeze' : ''}`}
            >
              <span className="week-rank__square">
                {met ? (
                  <TitlePiece title={queen ? 'Queen' : 'Pawn'} />
                ) : day.frozen ? (
                  <Emblem name="snowflake" size={22} />
                ) : day.xp ? (
                  <span aria-hidden="true" className="week-rank__dot" />
                ) : null}
                {/* The weekday sits in the corner like a board coordinate. */}
                <span aria-hidden="true" className="week-rank__day">
                  {WEEKDAY.format(new Date(`${day.date}T12:00:00`))}
                </span>
                <span className="sr-only-inline">
                  {LONG_DAY.format(new Date(`${day.date}T12:00:00`))}
                  {met
                    ? ', goal met'
                    : day.frozen
                      ? ', kept by a freeze'
                      : day.xp
                        ? `, ${day.xp} XP`
                        : ', no training'}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
      <figcaption className="week-rank__caption">{caption}</figcaption>
    </figure>
  )
}

function AchievementCard({ achievement }: { achievement: Achievement }) {
  const earned = Boolean(achievement.unlocked_at)
  const share = Math.min(1, achievement.progress / achievement.target)
  return (
    <li className="achievement" data-featured data-unlocked={earned || undefined}>
      <BadgeMedallion badge={achievement.key} earned={earned} progress={share} size={52} />
      <strong>{achievement.title}</strong>
      <span className="muted achievement__text">{achievement.description}</span>
      <span className="achievement__count">
        <span
          aria-hidden="true"
          className="achievement__bar"
          style={{ '--share': `${Math.round(share * 100)}%` } as React.CSSProperties}
        />
        <span className="muted">
          {achievement.progress.toLocaleString()} / {achievement.target.toLocaleString()}
        </span>
      </span>
    </li>
  )
}

/** A badge in the case: the medal, its name, and the date or how far along. */
function TrophyTile({
  achievement,
  selected,
  onSelect,
}: {
  achievement: Achievement
  selected: boolean
  onSelect: () => void
}) {
  const earned = Boolean(achievement.unlocked_at)
  const share = Math.min(1, achievement.progress / achievement.target)
  return (
    <li>
      <button
        aria-expanded={selected}
        className="trophy-tile"
        data-unlocked={earned || undefined}
        onClick={onSelect}
        title={achievement.description}
        type="button"
      >
        <BadgeMedallion badge={achievement.key} earned={earned} progress={share} size={56} />
        <span className="trophy-tile__title">{achievement.title}</span>
        {earned ? (
          <span className="trophy-tile__earned">
            {formatGameDate(achievement.unlocked_at as string)}
          </span>
        ) : (
          <span className="trophy-tile__progress">
            <span
              aria-hidden="true"
              className="achievement__bar"
              style={{ '--share': `${Math.round(share * 100)}%` } as React.CSSProperties}
            />
            <span className="muted">
              {achievement.progress.toLocaleString()}/{achievement.target.toLocaleString()}
            </span>
          </span>
        )}
        <span className="sr-only-inline">
          {achievement.description}
          {earned ? ' Earned.' : ` ${achievement.progress} of ${achievement.target}.`}
        </span>
      </button>
    </li>
  )
}

/**
 * The trophy room: the crest and the title ladder first, then the few badges
 * closest to being earned, then every badge in its family as a case of
 * medals. Gold means earned; a locked medal carries its arc and a bar. A
 * tile opens its caption below the case, so a medal can be read without the
 * description crowding every tile.
 */
export function AchievementsGrid({ username }: { username: string }) {
  const profile = useTrainingProfile(username).data
  const [selected, setSelected] = useState<string | null>(null)
  if (!profile) return <PanelSkeleton label="Loading achievements" rows={3} />
  const unlocked = profile.achievements.filter((a) => a.unlocked_at).length
  const closest = closestAchievements(profile.achievements)
  const next = nextTitle(profile)
  const levelSpan = profile.next_level_xp - profile.level_floor_xp
  const levelShare = levelSpan > 0 ? (profile.xp - profile.level_floor_xp) / levelSpan : 1
  const titlesEarned = TITLE_LADDER.filter((step) => step.level <= profile.level).length
  return (
    <div className="achievements trophy-room">
      <header className="trophy-room__hero">
        <PieceCrest level={profile.level} progress={levelShare} size={78} title={profile.title} />
        <div className="trophy-room__hero-text">
          <span className="trophy-room__eyebrow">Your title</span>
          <strong className="trophy-room__title">{profile.title}</strong>
          <span className="muted">
            Level {profile.level.toLocaleString()} · {profile.xp.toLocaleString()} XP
            {next ? ` · ${(next.xp - profile.xp).toLocaleString()} to ${next.title}` : ''}
          </span>
        </div>
      </header>
      <TitleLadder profile={profile} />
      <div className="train-tiles achievements__tiles">
        <StatTile
          label="Badges"
          value={`${unlocked.toLocaleString()} / ${profile.achievements.length.toLocaleString()}`}
        />
        <StatTile label="Titles" value={`${titlesEarned} / ${TITLE_LADDER.length}`} />
        <StatTile
          label="Best streak"
          value={`${profile.best_streak.toLocaleString()} ${profile.best_streak === 1 ? 'day' : 'days'}`}
        />
      </div>
      {closest.length ? (
        <section aria-label="Closest to earning" className="achievements__family" data-next>
          <span className="achievements__family-title">Closest to earning</span>
          <ul className="achievements__grid">
            {closest.map((achievement) => (
              <AchievementCard achievement={achievement} key={achievement.key} />
            ))}
          </ul>
        </section>
      ) : null}
      {groupAchievements(profile.achievements).map((group) => {
        const earned = group.items.filter((a) => a.unlocked_at).length
        const open = group.items.find((a) => a.key === selected)
        return (
          <section aria-label={group.title} className="achievements__family" key={group.title}>
            <span className="achievements__family-title">
              {group.title}
              <span className="muted">
                {' '}
                {earned}/{group.items.length}
              </span>
              {/* The family as a rank of squares: one per badge, gold where earned. */}
              <span aria-hidden="true" className="trophy-case__rank">
                {group.items.map((a) => (
                  <span data-earned={a.unlocked_at ? true : undefined} key={a.key} />
                ))}
              </span>
            </span>
            <ul className="trophy-case">
              {group.items.map((achievement) => (
                <TrophyTile
                  achievement={achievement}
                  key={achievement.key}
                  onSelect={() =>
                    setSelected((current) => (current === achievement.key ? null : achievement.key))
                  }
                  selected={selected === achievement.key}
                />
              ))}
            </ul>
            <p
              aria-live="polite"
              className="trophy-case__caption"
              data-open={open ? true : undefined}
            >
              {open ? (
                <>
                  <strong>{open.title}.</strong> {open.description}{' '}
                  {open.unlocked_at
                    ? `Earned ${formatGameDate(open.unlocked_at)}.`
                    : `${open.progress.toLocaleString()} of ${open.target.toLocaleString()}.`}
                </>
              ) : (
                '\u00a0'
              )}
            </p>
          </section>
        )
      })}
    </div>
  )
}

const LIFETIME_MS: Record<Celebration['kind'], number> = {
  xp: 1800,
  goal: 4000,
  level: 5000,
  achievement: 5000,
  quest: 4000,
}

const CELEBRATION_EMBLEMS: Record<
  Extract<CelebrationVisual, { kind: 'icon' }>['name'],
  EmblemName
> = {
  flame: 'flame',
  scroll: 'scroll',
  chest: 'chestOpen',
  trophy: 'cup',
  bolt: 'bolt',
  crown: 'crown',
}

function CelebrationArt({ visual }: { visual: CelebrationVisual }) {
  if (visual.kind === 'crest') {
    return <PieceCrest level={visual.level} progress={1} size={48} title={visual.title} />
  }
  if (visual.kind === 'badge') return <BadgeMedallion badge={visual.key} earned size={44} />
  return (
    <span aria-hidden="true" className="celebration__icon">
      <Emblem name={CELEBRATION_EMBLEMS[visual.name]} size={30} />
    </span>
  )
}

/** Sounds on or off; the choice is kept in this browser. */
function SoundSwitch() {
  const [muted, setMutedState] = useState(isMuted)
  return (
    <button
      aria-pressed={!muted}
      className="today-card__goal-option sound-switch"
      onClick={() => {
        setMuted(!muted)
        setMutedState(!muted)
        if (muted) play('right')
      }}
      type="button"
    >
      {muted ? <VolumeX size={13} /> : <Volume2 size={13} />} Sounds {muted ? 'off' : 'on'}
    </button>
  )
}

const FLIGHT_MS = 700

/**
 * XP banked: a gold token leaves the toast and lands in the header chip,
 * which bumps as it arrives. Skipped under reduced motion or with no chip.
 */
function XpFlight({ from, xp }: { from: HTMLElement | null; xp: string }) {
  const landed = useTrainingStore((state) => state.landed)
  const [path, setPath] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null)
  useEffect(() => {
    const chip = document.querySelector('.training-chip')
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!from || !chip || still) return
    const start = from.getBoundingClientRect()
    const end = chip.getBoundingClientRect()
    const x = start.left + start.width / 2
    const y = start.top + start.height / 2
    setPath({ x, y, dx: end.left + end.width / 2 - x, dy: end.top + end.height / 2 - y })
    const timer = window.setTimeout(landed, FLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [from, landed])
  if (!path) return null
  // Through a portal: the toast animates with transforms, and a transformed
  // parent would make this fixed-position token move with it.
  return createPortal(
    <span
      aria-hidden="true"
      className="xp-flight"
      style={
        {
          left: path.x,
          top: path.y,
          '--dx': `${path.dx}px`,
          '--dy': `${path.dy}px`,
        } as CSSProperties
      }
    >
      {xp}
    </span>,
    document.body,
  )
}

const TOAST_EXIT_MS = 160

function Toast({ item }: { item: Celebration }) {
  const dismiss = useTrainingStore((state) => state.dismiss)
  const [leaving, setLeaving] = useState(false)
  const [self, setSelf] = useState<HTMLLIElement | null>(null)
  useEffect(() => {
    // Fade out briefly before leaving, so the stack does not jump.
    const fade = window.setTimeout(() => setLeaving(true), LIFETIME_MS[item.kind] - TOAST_EXIT_MS)
    const timer = window.setTimeout(() => dismiss(item.id), LIFETIME_MS[item.kind])
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(timer)
    }
  }, [dismiss, item.id, item.kind])
  return (
    <li
      className="celebration"
      data-kind={item.kind}
      data-leaving={leaving || undefined}
      ref={setSelf}
    >
      {item.kind === 'xp' ? <XpFlight from={self} xp={item.title} /> : null}
      {item.visual ? <CelebrationArt visual={item.visual} /> : null}
      <span className="celebration__text">
        <strong>{item.title}</strong>
        {item.detail ? <span>{item.detail}</span> : null}
      </span>
      {item.kind !== 'xp' ? (
        <button
          aria-label="Dismiss"
          className="celebration__close"
          onClick={() => dismiss(item.id)}
          type="button"
        >
          <X size={12} />
        </button>
      ) : null}
    </li>
  )
}

/** XP, levels, goals and badges, as they happen. Mounted once, beside the board. */
export function Celebrations() {
  const celebrations = useTrainingStore((state) => state.celebrations)
  return (
    <>
      <ol aria-live="polite" className="celebrations">
        {celebrations.map((item) => (
          <Toast item={item} key={item.id} />
        ))}
      </ol>
      <PromotionMoment />
    </>
  )
}

const PROMOTION_MS = 5200

/**
 * A new title, played as chess plays it: the old piece marches up a file of
 * the board and becomes the new one on the last rank. Closes itself, on a
 * click, or on Escape.
 */
function PromotionMoment() {
  const promotion = useTrainingStore((state) => state.promotion)
  const clear = useTrainingStore((state) => state.clearPromotion)
  useEffect(() => {
    if (!promotion) return
    const timer = window.setTimeout(clear, PROMOTION_MS)
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [clear, promotion])
  if (!promotion) return null
  const at = TITLE_LADDER.findIndex((step) => step.title === promotion.to)
  const after = at >= 0 ? TITLE_LADDER[at + 1] : undefined
  return (
    <div className="promotion" onClick={clear} role="presentation">
      <div
        aria-label={
          promotion.preview
            ? `Promotion ahead: ${promotion.to} at level ${promotion.level}`
            : `Promoted to ${promotion.to}, level ${promotion.level}`
        }
        className="promotion__stage"
        data-preview={promotion.preview || undefined}
        role="status"
      >
        {/* The board's own rule: a pawn that reaches the last rank becomes a
            piece. One file of the board, the old piece hopping a square at a
            time on the knocks of the promotion sound, the new piece arriving
            on the last rank in a burst of gold. */}
        <div aria-hidden="true" className="promotion__board">
          <span className="promotion__ranks">
            {Array.from({ length: 8 }, (_, index) => (
              <span key={index}>{8 - index}</span>
            ))}
          </span>
          <div className="promotion__file">
            {Array.from({ length: 8 }, (_, rank) => (
              <span data-shade={rank % 2 ? 'dark' : 'light'} key={rank} />
            ))}
            <span className="promotion__rays" />
            <span className="promotion__sparks">
              {Array.from({ length: 10 }, (_, index) => (
                <i key={index} style={{ '--a': `${index * 36}deg` } as React.CSSProperties} />
              ))}
            </span>
            <span className="promotion__from">
              <TitlePiece title={promotion.from} />
            </span>
            <span className="promotion__to">
              <TitlePiece title={promotion.to} />
            </span>
          </div>
        </div>
        <div className="promotion__words">
          <span className="promotion__eyebrow">
            {promotion.preview ? 'Promotion ahead' : 'Promotion'}
          </span>
          <strong className="promotion__title">{promotion.to}</strong>
          <span className="promotion__line">
            {promotion.preview
              ? `Reach level ${promotion.level} to earn it.`
              : `Level ${promotion.level}. You came up from ${promotion.from}.`}
          </span>
          <span className="muted promotion__next">
            {after
              ? `Next: ${after.title} at level ${after.level}, ${after.xp.toLocaleString()} XP.`
              : 'The top of the board.'}
          </span>
          <Button className="promotion__continue" onClick={clear} type="button" variant="primary">
            {promotion.preview ? 'Back' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The titles on one rank of the board, Pawn to King: earned pieces stand on
 * their squares, the next is outlined in gold with the XP it takes, the rest
 * wait as silhouettes.
 */
function TitleLadder({ profile }: { profile: TrainingProfile }) {
  const next = nextTitle(profile)
  const promote = useTrainingStore((state) => state.promote)
  return (
    <div className="title-ladder">
      <ol aria-label="Titles" className="title-ladder__rank">
        {TITLE_LADDER.map((step, index) => {
          const state =
            step.level <= profile.level
              ? step.title === profile.title
                ? 'current'
                : 'earned'
              : step.title === next?.title
                ? 'next'
                : 'locked'
          return (
            <li
              data-shade={index % 2 ? 'dark' : 'light'}
              data-state={state}
              key={step.title}
              title={`${step.title}: level ${step.level}, ${step.xp.toLocaleString()} XP`}
            >
              {index ? (
                // Any title after the first plays its promotion: earned ones as they
                // happened, the rest as a preview of what is ahead.
                <button
                  aria-label={`Play the promotion to ${step.title}`}
                  className="title-ladder__play"
                  onClick={() =>
                    promote({
                      from: TITLE_LADDER[index - 1].title,
                      to: step.title,
                      level: step.level,
                      preview: step.level > profile.level,
                    })
                  }
                  type="button"
                />
              ) : null}
              <TitlePiece title={step.title} />
              <span className="title-ladder__level">{step.level}</span>
              <span className="sr-only-inline">
                {step.title}, level {step.level}
                {state === 'current'
                  ? ', your title'
                  : state === 'locked' || state === 'next'
                    ? ', not yet'
                    : ''}
              </span>
            </li>
          )
        })}
      </ol>
      {next ? (
        <span
          aria-hidden="true"
          className="title-ladder__bar"
          style={
            { '--share': `${Math.round(titleShare(profile, next) * 100)}%` } as React.CSSProperties
          }
        />
      ) : null}
      <p className="title-ladder__caption">
        {next
          ? `${profile.title} now · ${(next.xp - profile.xp).toLocaleString()} XP to ${next.title} (level ${next.level})`
          : 'King, the top title.'}
      </p>
    </div>
  )
}

/** How far from the current title's XP to the next one's, 0-1. */
function titleShare(profile: TrainingProfile, next: { xp: number }) {
  const current = [...TITLE_LADDER].reverse().find((step) => step.level <= profile.level)
  const floor = current?.xp ?? 0
  if (next.xp <= floor) return 1
  return Math.max(0, Math.min(1, (profile.xp - floor) / (next.xp - floor)))
}
