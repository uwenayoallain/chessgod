import { useState } from 'react'
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Crown,
  ExternalLink,
  GraduationCap,
  Play,
  ShieldAlert,
  Sparkles,
  Swords,
  Target,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { revealSection } from '@/components/ui/collapsible-section'
import { PanelError } from '@/components/ui/panel-error'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { useStartSparring } from '@/hooks/use-sparring'
import { useStudyGuide } from '@/hooks/use-study-guide'
import { OPEN_EXPLORE_EVENT } from '@/lib/explore-position'
import type {
  ConcreteOpeningFix,
  MasterPlaybook,
  StudyRecommendation,
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

function PlaybookReader({
  playbook,
  concreteFixes,
  onLoadBoard,
  onPlayOut,
}: {
  playbook: MasterPlaybook
  concreteFixes?: ConcreteOpeningFix[]
  onLoadBoard: (fen: string, color: MasterPlaybook['color'], lastUci?: string | null) => void
  onPlayOut: (fen: string, title: string, lastUci?: string | null) => void
}) {
  return (
    <div className="study-playbook">
      <p className="study-playbook__summary">{playbook.summary}</p>

      <div className="study-playbook__meta">
        <span className="study-chip">{playbook.structure_name}</span>
        <span className="study-chip">{playbook.level}</span>
        {playbook.color !== 'both' ? (
          <span className="study-chip">{playbook.color === 'white' ? 'As White' : 'As Black'}</span>
        ) : null}
      </div>

      {playbook.tabiya_fen ? (
        <div className="study-playbook__actions">
          <Button
            onClick={() => onLoadBoard(playbook.tabiya_fen!, playbook.color)}
            type="button"
            variant="default"
          >
            <Play aria-hidden="true" size={14} />
            Load structure on board
          </Button>
          <Button
            onClick={() => onPlayOut(playbook.tabiya_fen!, playbook.title)}
            type="button"
            variant="primary"
          >
            <Swords aria-hidden="true" size={14} />
            Play it out vs Stockfish
          </Button>
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

function RecommendationCard({
  item,
  rank,
  expanded,
  onToggle,
  onLoadBoard,
  onPlayOut,
}: {
  item: StudyRecommendation
  rank: number
  expanded: boolean
  onToggle: () => void
  onLoadBoard: (fen: string, color: MasterPlaybook['color'], lastUci?: string | null) => void
  onPlayOut: (fen: string, title: string, lastUci?: string | null) => void
}) {
  const { playbook } = item
  return (
    <article className={`study-card${expanded ? ' study-card--open' : ''}`}>
      <button
        aria-expanded={expanded}
        className="study-card__toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="study-card__rank">#{rank}</span>
        <div className="study-card__head">
          <div className="study-card__title-row">
            <strong>{playbook.title}</strong>
            <span className="study-chip">{CATEGORY_LABELS[playbook.category]}</span>
          </div>
          <span className="study-card__reason">{item.reason}</span>
          <span className="muted study-card__evidence">{item.evidence}</span>
          <div className="study-card__metrics">
            <span>
              {item.metric_label}: <strong>{item.current_value}</strong>
            </span>
            <span className="muted">Target: {item.target_value}</span>
          </div>
        </div>
        <span aria-hidden="true" className="study-card__chevron">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {expanded ? (
        <div className="study-card__body">
          <PlaybookReader
            concreteFixes={item.concrete_fixes}
            onLoadBoard={onLoadBoard}
            onPlayOut={onPlayOut}
            playbook={playbook}
          />
        </div>
      ) : null}
    </article>
  )
}

export function StudyGuide({
  username,
  timeClass,
  onPlayOut,
  onOpenExplore,
}: {
  username: string
  timeClass: string | null
  onPlayOut?: (position: { fen: string; lastUci: string | null; origin?: string }) => void
  onOpenExplore?: (section: string) => void
}) {
  const { data, isLoading, error, refetch } = useStudyGuide({ username, timeClass })
  const [view, setView] = useState<'recommended' | 'library'>('recommended')
  const [categoryFilter, setCategoryFilter] = useState<'all' | MasterPlaybook['category']>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { playOut } = useStartSparring(username, () => {})

  function handleLoadBoard(
    fen: string,
    color: MasterPlaybook['color'],
    lastUci: string | null = null,
  ) {
    const app = useAppStore.getState()
    app.loadPosition(fen, lastUci)
    if (color === 'white' || color === 'black') {
      app.alignBoardToUserColor(color)
    }
    if (onOpenExplore) {
      onOpenExplore('explore-engine')
    } else {
      window.dispatchEvent(new CustomEvent(OPEN_EXPLORE_EVENT, { detail: 'explore-engine' }))
    }
  }

  function handlePlayOut(fen: string, title: string, lastUci: string | null = null) {
    const payload = { fen, lastUci, origin: `Playbook: ${title}` }
    if (onPlayOut) {
      onPlayOut(payload)
    } else {
      playOut(payload)
      window.dispatchEvent(new CustomEvent(OPEN_EXPLORE_EVENT, { detail: 'explore-sparring' }))
    }
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

  const activeExpanded = expandedId ?? data.recommended[0]?.playbook_id ?? null
  const filteredCatalog =
    categoryFilter === 'all'
      ? data.catalog
      : data.catalog.filter((pb) => pb.category === categoryFilter)

  return (
    <div className="study-guide">
      <div className="study-guide__intro">
        <div className="study-guide__headline">
          <strong>Master Playbooks &amp; Courses Matched to Your Weaknesses</strong>
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
            All Master Playbooks ({data.catalog.length})
          </button>
        </div>
      </div>

      {view === 'recommended' ? (
        data.recommended.length > 0 ? (
          <div className="study-cards">
            {data.recommended.map((item, idx) => (
              <RecommendationCard
                expanded={activeExpanded === item.playbook_id}
                item={item}
                key={item.playbook_id}
                onLoadBoard={handleLoadBoard}
                onPlayOut={handlePlayOut}
                onToggle={() =>
                  setExpandedId((current) =>
                    (current ?? data.recommended[0]?.playbook_id) === item.playbook_id
                      ? ''
                      : item.playbook_id,
                  )
                }
                rank={idx + 1}
              />
            ))}
          </div>
        ) : (
          <p className="muted">
            Import and analyze more games to unlock weakness-matched recommendations, or browse All
            Master Playbooks above.
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
            {filteredCatalog.map((pb) => {
              const isOpen = expandedId === pb.id
              return (
                <article className={`study-card${isOpen ? ' study-card--open' : ''}`} key={pb.id}>
                  <button
                    aria-expanded={isOpen}
                    className="study-card__toggle"
                    onClick={() => setExpandedId((cur) => (cur === pb.id ? '' : pb.id))}
                    type="button"
                  >
                    <div className="study-card__head">
                      <div className="study-card__title-row">
                        <strong>{pb.title}</strong>
                        <span className="study-chip">{CATEGORY_LABELS[pb.category]}</span>
                      </div>
                      <span className="muted study-card__evidence">{pb.subtitle}</span>
                    </div>
                    <span aria-hidden="true" className="study-card__chevron">
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="study-card__body">
                      <PlaybookReader
                        onLoadBoard={handleLoadBoard}
                        onPlayOut={handlePlayOut}
                        playbook={pb}
                      />
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
