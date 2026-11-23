import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'

import { PanelError } from '@/components/ui/panel-error'
import { Emblem } from '@/components/training/trophies'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { getTrainingTimeClass } from '@/hooks/use-improvement'
import { api } from '@/lib/api'
import {
  FORCING_KINDS,
  PHASE_LABELS,
  describeAfterOpening,
  describeFix,
  describeOpeningAdvice,
  describeOpeningVerdict,
  describeOutOfOpening,
  percent,
  shortOpeningName,
  type OpeningFix,
  type PointsLost,
} from '@/lib/analysis/points-lost'
import { Button } from '@/components/ui/button'
import { revealSection } from '@/components/ui/collapsible-section'
import { BEST_MOVE_ARROW_COLOR, THREAT_ARROW_COLOR } from '@/lib/analysis/board-guidance'
import { useAppStore } from '@/store/app-store'
import { useTrainingStore } from '@/store/training-store'

function usePointsLost(username: string, color: string, timeClass: string | null) {
  const scope = getTrainingTimeClass(timeClass)
  return useQuery({
    queryKey: ['where-points-go', username, color, scope],
    queryFn: async ({ signal }) =>
      (
        await api.get<PointsLost>('/api/improvement/where-points-go', {
          params: { username, color, time_class: scope },
          signal,
        })
      ).data,
    staleTime: 10 * 60 * 1000,
  })
}

const TIME_CLASS_WORDS: Record<string, string> = {
  rapid_blitz: 'rapid and blitz',
  rapid: 'rapid',
  blitz: 'blitz',
}

function ShareBar({ share, strong = false }: { share: number; strong?: boolean }) {
  return (
    <span aria-hidden="true" className="points-lost__bar" data-strong={strong || undefined}>
      <span style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
    </span>
  )
}

/**
 * Where the player's games are actually lost, for someone with no time to
 * study everything: whether openings deserve any of that time, the few opening
 * moves worth fixing if so, and the one habit that catches most of the rest.
 */
export function WherePointsGo({
  username,
  color,
  timeClass,
  onShowPosition,
}: {
  username: string
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  onShowPosition?: () => void
}) {
  const points = usePointsLost(username, color, timeClass)
  const loadPosition = useAppStore((state) => state.loadPosition)
  const alignBoardToUserColor = useAppStore((state) => state.alignBoardToUserColor)
  const setTrainerArrows = useAppStore((state) => state.setTrainerArrows)
  const showCourse = useTrainingStore((state) => state.showCourse)

  if (points.isLoading)
    return <PanelSkeleton label="Measuring where your games are lost" rows={6} />
  if (points.error || !points.data) {
    return (
      <PanelError
        error={points.error}
        onRetry={() => void points.refetch()}
        what="where your points go"
      />
    )
  }

  const data = points.data
  const verdict = describeOpeningVerdict(data)
  const advice = describeOpeningAdvice(data)
  const measured = data.opening_verdict !== 'insufficient'
  const after = describeAfterOpening(data)
  const delivered = describeOutOfOpening(data)

  function show(fix: OpeningFix) {
    onShowPosition?.()
    loadPosition(fix.fen, fix.last_move_uci)
    alignBoardToUserColor(fix.side_to_move)
    // The slip and its fix, on the board: played in red, better in best-move
    // amber. Scoped to this position so stepping away clears them.
    setTrainerArrows(
      [
        {
          startSquare: fix.played_uci.slice(0, 2),
          endSquare: fix.played_uci.slice(2, 4),
          color: THREAT_ARROW_COLOR,
        },
        {
          startSquare: fix.best_uci.slice(0, 2),
          endSquare: fix.best_uci.slice(2, 4),
          color: BEST_MOVE_ARROW_COLOR,
        },
      ],
      fix.fen,
    )
  }

  return (
    <div className="points-lost train-card">
      <p
        className="train-card__headline train-card__headline--icon"
        data-verdict={data.opening_verdict}
      >
        <Emblem name="magnifier" size={24} /> <span>{delivered.headline ?? verdict.headline}</span>
      </p>
      {delivered.rows.length ? (
        <ul aria-label="How you come out of the opening" className="points-lost__delivered">
          {delivered.rows.map((row) => (
            <li data-leaking={row.leaking || undefined} key={row.color}>
              {row.text}
            </li>
          ))}
        </ul>
      ) : null}
      {delivered.leaking ? (
        <Button
          onClick={() => {
            showCourse(delivered.leaking!)
            revealSection('review-course')
          }}
          type="button"
          variant="primary"
        >
          Fix your {delivered.leaking === 'white' ? 'White' : 'Black'} openings in the course
        </Button>
      ) : null}
      <p className="muted points-lost__text">{verdict.detail}</p>

      {measured ? (
        <ul aria-label="Winning chances lost by phase" className="points-lost__rows">
          {data.phases.map((phase) => (
            <li key={phase.phase}>
              <span>{PHASE_LABELS[phase.phase]}</span>
              <strong>{percent(phase.share_of_loss)}</strong>
              <ShareBar share={phase.share_of_loss} strong={phase.phase !== 'opening'} />
            </li>
          ))}
        </ul>
      ) : null}

      {advice ? <p className="points-lost__text">{advice}</p> : null}
      {data.opening_fixes.length ? (
        <ul aria-label="Opening moves to stop playing" className="points-lost__fixes">
          {data.opening_fixes.map((fix) => (
            <li key={`${fix.position_id}:${fix.played_uci}`}>
              <button className="points-lost__fix" onClick={() => show(fix)} type="button">
                <span className="points-lost__fix-head">
                  {/* The sentence below says the same in words. */}
                  <span aria-hidden="true" className="points-lost__fix-moves">
                    <s>{fix.played_san}</s>
                    <ChevronRight size={13} />
                    <strong>{fix.best_san}</strong>
                  </span>
                  <span className="points-lost__fix-show">Show on board</span>
                </span>
                <span className="points-lost__fix-text">
                  {shortOpeningName(fix.opening_name) ? (
                    <strong>{shortOpeningName(fix.opening_name)}. </strong>
                  ) : null}
                  {describeFix(fix)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {measured ? (
        <>
          <h3 className="points-lost__subhead">After the opening</h3>
          {after.bigErrors ? <p className="points-lost__text">{after.bigErrors}</p> : null}
          <ul
            aria-label="Winning chances lost after the opening, by kind of move"
            className="points-lost__rows"
          >
            {data.kinds.map((kind) => (
              <li key={kind.key}>
                <span>{kind.label}</span>
                <strong>{percent(kind.share_of_loss)}</strong>
                <ShareBar share={kind.share_of_loss} strong={FORCING_KINDS.has(kind.key)} />
              </li>
            ))}
          </ul>
          <p className="points-lost__habit">{after.habit}</p>
        </>
      ) : null}

      <p className="muted points-lost__note">
        Measured in winning chances over {data.analyzed_decisions.toLocaleString()} analyzed moves
        from your {TIME_CLASS_WORDS[data.time_class] ?? data.time_class} games at{' '}
        {data.min_user_rating.toLocaleString()}+. A pawn dropped in a level position counts. One
        dropped in a won game barely does.
      </p>
    </div>
  )
}
