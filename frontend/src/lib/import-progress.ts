import type { ImportProgress } from '@/store/app-store'

export type ImportEvent = {
  type: string
  archive?: string
  index?: number
  total_archives?: number
  games_in_archive?: number
  game_index?: number
  current_game?: string
  new_games?: number
  skipped_games?: number
  total_new_games?: number
  total_skipped?: number
  cached_archives?: number
  cached?: boolean
  message?: string
}

function currentArchiveBaseline(current: ImportProgress) {
  return {
    newGames: Math.max(0, current.newGames - current.archiveNewGames),
    skippedGames: Math.max(0, current.skippedGames - current.archiveSkippedGames),
  }
}

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function importCount(count: number, label: string) {
  return `${count} ${label}`
}

export function reduceImportProgress(
  current: ImportProgress | null,
  payload: ImportEvent,
): ImportProgress | null {
  if (payload.type === 'archive_start') {
    return {
      currentArchive: String(payload.archive ?? ''),
      archiveIndex: Number(payload.index ?? 0),
      totalArchives: Number(payload.total_archives ?? current?.totalArchives ?? 0),
      gamesInArchive: 0,
      currentGameIndex: 0,
      currentGameLabel: 'Reading this month…',
      newGames: current?.newGames ?? 0,
      skippedGames: current?.skippedGames ?? 0,
      archiveNewGames: 0,
      archiveSkippedGames: 0,
      cached: false,
      complete: false,
      cachedArchives: current?.cachedArchives ?? 0,
    }
  }

  if (payload.type === 'complete') {
    return {
      currentArchive: current?.currentArchive ?? '',
      archiveIndex: current?.archiveIndex ?? 0,
      totalArchives: current?.totalArchives ?? 0,
      gamesInArchive: current?.gamesInArchive ?? 0,
      currentGameIndex: current?.currentGameIndex ?? 0,
      currentGameLabel: 'Import complete',
      newGames: Number(payload.total_new_games ?? current?.newGames ?? 0),
      skippedGames: Number(payload.total_skipped ?? current?.skippedGames ?? 0),
      archiveNewGames: current?.archiveNewGames ?? 0,
      archiveSkippedGames: current?.archiveSkippedGames ?? 0,
      cached: current?.cached ?? false,
      complete: true,
      cachedArchives: Number(payload.cached_archives ?? current?.cachedArchives ?? 0),
    }
  }

  if (!current) {
    return current
  }

  if (payload.type === 'game_progress') {
    const baseline = currentArchiveBaseline(current)
    const archiveNewGames = Number(payload.new_games ?? current.archiveNewGames)
    const archiveSkippedGames = Number(payload.skipped_games ?? current.archiveSkippedGames)

    return {
      ...current,
      currentArchive: String(payload.archive ?? current.currentArchive),
      gamesInArchive: Number(payload.games_in_archive ?? current.gamesInArchive),
      currentGameIndex: Number(payload.game_index ?? current.currentGameIndex),
      currentGameLabel: String(payload.current_game ?? current.currentGameLabel),
      newGames: baseline.newGames + archiveNewGames,
      skippedGames: baseline.skippedGames + archiveSkippedGames,
      archiveNewGames,
      archiveSkippedGames,
      cached: false,
      complete: false,
    }
  }

  if (payload.type === 'archive_complete') {
    const gamesInArchive = Number(payload.games_in_archive ?? current.gamesInArchive)
    const baseline = currentArchiveBaseline(current)
    const archiveNewGames = Number(payload.new_games ?? current.archiveNewGames)
    const archiveSkippedGames = Number(payload.skipped_games ?? current.archiveSkippedGames)
    return {
      ...current,
      currentArchive: String(payload.archive ?? current.currentArchive),
      gamesInArchive,
      currentGameIndex: gamesInArchive,
      currentGameLabel: payload.cached ? 'Month unchanged' : 'Month complete',
      newGames: baseline.newGames + archiveNewGames,
      skippedGames: baseline.skippedGames + archiveSkippedGames,
      archiveNewGames,
      archiveSkippedGames,
      cached: Boolean(payload.cached),
      complete: true,
      cachedArchives: current.cachedArchives + (payload.cached ? 1 : 0),
    }
  }

  return current
}

export function formatImportProgressLabel(progress: ImportProgress | null, status: string) {
  if (!progress) {
    return status === 'complete' ? 'Import complete' : 'Starting import…'
  }

  if (status === 'complete' || progress.currentGameLabel === 'Import complete') {
    return `Import complete · ${pluralize(progress.newGames, 'new game')}`
  }

  const cacheLabel = progress.cached
    ? 'no new games'
    : `${pluralize(progress.newGames, 'new game')} found`
  return `Month ${progress.archiveIndex} of ${progress.totalArchives} · ${cacheLabel}`
}

export function formatImportProgressDetail(progress: ImportProgress | null) {
  if (!progress) return 'Contacting Chess.com…'

  if (progress.currentGameLabel === 'Import complete') {
    // The skipped count is only the months re-read, never the library; "99
    // games already in your library" read as a library of 99 games.
    return progress.totalArchives > 0
      ? `Checked ${pluralize(progress.totalArchives, 'month')} of games on Chess.com`
      : 'Your library is up to date'
  }

  if (progress.cached) {
    return `${progress.currentArchive} unchanged · ${pluralize(progress.archiveSkippedGames, 'game')} already stored`
  }

  // Before the archive reports its size there is no denominator to show, and
  // "0/? games" is worse than saying nothing about the total.
  const counted =
    progress.gamesInArchive > 0
      ? `${progress.currentGameIndex}/${progress.gamesInArchive} games`
      : 'reading games'
  return `${progress.currentArchive} · ${counted} · ${importCount(progress.archiveNewGames, 'new')} · ${importCount(progress.archiveSkippedGames, 'already stored')}`
}
