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
      currentGameLabel: 'Preparing archive…',
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
      currentGameLabel: payload.cached ? 'Reused cached archive' : 'Archive complete',
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
    return status === 'complete' ? 'Import complete' : 'Starting import...'
  }

  if (status === 'complete' || progress.currentGameLabel === 'Import complete') {
    return `Import complete · ${pluralize(progress.newGames, 'new game')}`
  }

  const cacheLabel = progress.cached ? 'cached' : `${pluralize(progress.newGames, 'new game')} found`
  return `Archive ${progress.archiveIndex}/${progress.totalArchives} · ${cacheLabel}`
}

export function formatImportProgressDetail(progress: ImportProgress | null) {
  if (!progress) return 'Connecting to Chess.com archives'

  if (progress.currentGameLabel === 'Import complete') {
    const cached = progress.cachedArchives > 0 ? ` · ${pluralize(progress.cachedArchives, 'cached archive')}` : ''
    return `${pluralize(progress.skippedGames, 'existing game')} skipped${cached}`
  }

  if (progress.cached) {
    return `${progress.currentArchive} reused from cache · ${pluralize(progress.archiveSkippedGames, 'game')} already stored`
  }

  const archiveTotal = progress.gamesInArchive > 0 ? progress.gamesInArchive : '?'
  return `${progress.currentArchive} · ${progress.currentGameIndex}/${archiveTotal} games · ${importCount(progress.archiveNewGames, 'new here')} · ${importCount(progress.archiveSkippedGames, 'existing here')}`
}
