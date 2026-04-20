import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { usePaginatedGames, type WorkspaceGame } from '@/hooks/use-workspace-data'
import { STARTING_FEN } from '@/store/app-store'

function formatGameDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function resultLabel(result: string): { text: string; cls: string } {
  if (result === 'win') return { text: 'W', cls: 'game-result--win' }
  if (result === 'loss') return { text: 'L', cls: 'game-result--loss' }
  return { text: 'D', cls: 'game-result--draw' }
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
  const effectiveFen = openingName ? null : currentFen !== STARTING_FEN ? currentFen : null
  const title = useMemo(() => {
    if (openingName) return `Games in ${openingName}`
    if (effectiveFen) return 'Games Through This Position'
    return 'Recent Games'
  }, [effectiveFen, openingName])

  useEffect(() => {
    setPage(1)
  }, [effectiveFen, eco, openingName, timeClass, username, color])

  const { data, isLoading, error } = usePaginatedGames({
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

  return (
    <Card>
      <CardHeader>
        <h2>{title}</h2>
        <span className="muted">{data?.total ?? 0} games</span>
      </CardHeader>
      <CardBody className="column">
        {error ? <div className="empty-state__message">{error}</div> : null}
        {isLoading ? <div className="muted">Loading games…</div> : null}
        {!isLoading && !error && !data?.games.length ? <div className="muted">No games found for this context.</div> : null}

        {data?.games.map((game) => {
          const res = resultLabel(game.user_result)
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
                  {game.white_rating ? <span className="game-card__rating">({game.white_rating})</span> : null}
                </span>
                <span className="game-card__vs">vs</span>
                <span className="game-card__player">
                  <span className="game-card__color game-card__color--black" />
                  {game.black_username}
                  {game.black_rating ? <span className="game-card__rating">({game.black_rating})</span> : null}
                </span>
              </div>
              <div className="game-card__meta">
                <span className={`game-card__result ${res.cls}`}>{res.text}</span>
                <span className="badge">{game.time_class}</span>
                {game.eco ? <span className="badge">{game.eco}</span> : null}
                {game.num_moves ? <span className="game-card__moves">{game.num_moves}m</span> : null}
                <span className="game-card__date">{formatGameDate(game.played_at)}</span>
              </div>
              {game.opening_name ? (
                <div className="game-card__opening">{game.opening_name}</div>
              ) : null}
            </button>
          )
        })}

        <div className="workspace-pagination">
          <Button disabled={page <= 1} onClick={() => setPage((current) => current - 1)} type="button" variant="ghost">
            Previous
          </Button>
          <span className="muted">Page {page} of {totalPages}</span>
          <Button disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)} type="button" variant="ghost">
            Next
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
