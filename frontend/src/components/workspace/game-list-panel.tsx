import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { PanelSkeleton } from '@/components/ui/panel-skeleton'
import { usePaginatedGames, type WorkspaceGame } from '@/hooks/use-workspace-data'
import { STARTING_FEN } from '@/store/app-store'
import { formatGameDate } from '@/lib/format-date'

function resultLabel(result: string): { text: string; cls: string } {
  if (result === 'win') return { text: 'W', cls: 'game-result--win' }
  if (result === 'loss') return { text: 'L', cls: 'game-result--loss' }
  return { text: 'D', cls: 'game-result--draw' }
}

const TERMINATION_LABELS: Record<string, string> = {
  checkmated: 'Checkmate',
  resigned: 'Resignation',
  timeout: 'Time',
  abandoned: 'Abandoned',
  agreed: 'Agreement',
  stalemate: 'Stalemate',
  repetition: 'Repetition',
  insufficient: 'Insufficient',
  '50move': '50-move',
  timevsinsufficient: 'Time vs Insuf.',
}

function terminationLabel(termination: string | null): string | null {
  if (!termination) return null
  return TERMINATION_LABELS[termination] ?? termination
}

export function GameListPanel({
  username,
  color,
  timeClass,
  currentFen,
  openingName,
  eco,
  selectedGameId,
  onSelectGame,
}: {
  username: string | null
  color: 'white' | 'black' | 'both'
  timeClass: string | null
  currentFen: string
  openingName: string | null
  eco: string | null
  selectedGameId: number | null
  onSelectGame: (game: WorkspaceGame) => void
}) {
  const [page, setPage] = useState(1)
  const [filterQuery, setFilterQuery] = useState('')
  const [resultFilter, setResultFilter] = useState<'all' | 'win' | 'loss' | 'draw'>('all')

  const effectiveFen = openingName ? null : currentFen !== STARTING_FEN ? currentFen : null
  const title = useMemo(() => {
    if (openingName) return `Games in ${openingName}`
    if (effectiveFen) return 'Games Through This Position'
    return 'Recent Games'
  }, [effectiveFen, openingName])

  useEffect(() => {
    setPage(1)
    setFilterQuery('')
    setResultFilter('all')
  }, [effectiveFen, eco, openingName, timeClass, username, color])

  const { data, isLoading, isRefreshing, error } = usePaginatedGames({
    username,
    color,
    timeClass,
    openingName,
    eco,
    fen: effectiveFen,
    page,
    perPage: 20,
    enabled: Boolean(username),
  })

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.per_page ?? 20)))

  const counts = useMemo(() => {
    const all = data?.games ?? []
    return {
      all: all.length,
      win: all.filter((g) => g.user_result === 'win').length,
      loss: all.filter((g) => g.user_result === 'loss').length,
      draw: all.filter((g) => g.user_result === 'draw').length,
    }
  }, [data?.games])

  const filteredGames = useMemo(() => {
    let list = data?.games ?? []
    if (resultFilter !== 'all') {
      list = list.filter((g) => g.user_result === resultFilter)
    }
    if (filterQuery.trim()) {
      const q = filterQuery.toLowerCase().trim()
      list = list.filter((g) => {
        const opp =
          g.white_username?.toLowerCase() === username?.toLowerCase()
            ? g.black_username
            : g.white_username
        return (
          opp?.toLowerCase().includes(q) ||
          g.opening_name?.toLowerCase().includes(q) ||
          (g.eco && g.eco.toLowerCase().includes(q))
        )
      })
    }
    return list
  }, [data?.games, resultFilter, filterQuery, username])

  return (
    <Card>
      <CardHeader>
        <h2>{title}</h2>
        <div className="panel-header__meta">
          {isRefreshing ? <span className="refresh-badge">Updating</span> : null}
          <span className="muted">{(data?.total ?? 0).toLocaleString()} games</span>
        </div>
      </CardHeader>
      <CardBody className="column">
        {error ? <div className="form-error">{error}</div> : null}

        {!isLoading && (data?.games.length ?? 0) > 0 ? (
          <>
            <div className="workspace-filter-box">
              <Search size={13} className="muted" />
              <input
                aria-label="Filter games"
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter opponent, opening, ECO..."
                type="text"
                value={filterQuery}
              />
              {filterQuery ? (
                <button
                  aria-label="Clear filter"
                  onClick={() => setFilterQuery('')}
                  style={{
                    padding: 2,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                  }}
                  type="button"
                >
                  <X size={12} className="muted" />
                </button>
              ) : null}
            </div>

            <div className="game-result-filter-pills">
              {(['all', 'win', 'loss', 'draw'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`game-result-pill ${resultFilter === key ? 'game-result-pill--active' : ''}`}
                  onClick={() => setResultFilter(key)}
                >
                  {key === 'all'
                    ? 'All'
                    : key === 'win'
                      ? 'Wins'
                      : key === 'loss'
                        ? 'Losses'
                        : 'Draws'}
                  <span className="game-result-pill__count">({counts[key]})</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {isLoading ? <PanelSkeleton label="Loading your games" rowHeight={72} rows={6} /> : null}
        {!isLoading && !error && !data?.games.length ? (
          <div className="rail-empty">
            <strong>No games</strong>
            <span>Nothing matches this position and these filters.</span>
          </div>
        ) : null}

        {!isLoading && !error && data?.games.length && !filteredGames.length ? (
          <div className="rail-empty">
            <strong>No matching games</strong>
            <span>No games match this filter.</span>
          </div>
        ) : null}

        {filteredGames.map((game) => {
          const res = resultLabel(game.user_result)
          const term = terminationLabel(game.termination)
          return (
            <button
              key={game.id}
              className={`game-card${selectedGameId === game.id ? ' game-card--active' : ''}`}
              onClick={() => onSelectGame(game)}
              type="button"
            >
              <div className="game-card__players">
                <span className="game-card__player">
                  <span className="game-card__color game-card__color--white" />
                  {game.white_username}
                  {game.white_rating ? (
                    <span className="game-card__rating">({game.white_rating})</span>
                  ) : null}
                </span>
                <span className="game-card__vs">vs</span>
                <span className="game-card__player">
                  <span className="game-card__color game-card__color--black" />
                  {game.black_username}
                  {game.black_rating ? (
                    <span className="game-card__rating">({game.black_rating})</span>
                  ) : null}
                </span>
              </div>
              <div className="game-card__meta">
                <span className={`game-card__result ${res.cls}`}>{res.text}</span>
                {term ? <span className="badge">{term}</span> : null}
                <span className="badge">{game.time_class}</span>
                {game.eco ? <span className="badge">{game.eco}</span> : null}
                {game.has_analysis ? <span className="badge">Analyzed</span> : null}
                {game.num_moves ? (
                  <span className="game-card__moves">{game.num_moves}m</span>
                ) : null}
                <span className="game-card__date">{formatGameDate(game.played_at)}</span>
              </div>
              {game.opening_name ? (
                <div className="game-card__opening">{game.opening_name}</div>
              ) : null}
            </button>
          )
        })}

        <div className="workspace-pagination">
          <Button
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
            type="button"
            variant="ghost"
          >
            Previous
          </Button>
          <span className="muted">
            Page {page} of {totalPages}
          </span>
          <Button
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
            type="button"
            variant="ghost"
          >
            Next
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
