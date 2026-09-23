import { describe, expect, test } from 'vite-plus/test'

import {
  formatImportProgressDetail,
  formatImportProgressLabel,
  reduceImportProgress,
} from '../src/lib/import-progress'

describe('reduceImportProgress', () => {
  test('tracks per-game progress inside an archive', () => {
    const started = reduceImportProgress(null, {
      type: 'archive_start',
      archive: '2024/03',
      index: 2,
      total_archives: 4,
    })

    const progressed = reduceImportProgress(started, {
      type: 'game_progress',
      archive: '2024/03',
      game_index: 7,
      games_in_archive: 18,
      current_game: 'alpha vs beta',
      new_games: 3,
      skipped_games: 2,
    })

    expect(progressed).toEqual({
      currentArchive: '2024/03',
      archiveIndex: 2,
      totalArchives: 4,
      gamesInArchive: 18,
      currentGameIndex: 7,
      currentGameLabel: 'alpha vs beta',
      newGames: 3,
      skippedGames: 2,
      archiveNewGames: 3,
      archiveSkippedGames: 2,
      cached: false,
      complete: false,
      cachedArchives: 0,
    })
  })

  test('keeps cumulative totals when a later archive has no new games yet', () => {
    const firstArchive = reduceImportProgress(null, {
      type: 'archive_start',
      archive: '2024/02',
      index: 1,
      total_archives: 3,
    })
    const firstComplete = reduceImportProgress(firstArchive, {
      type: 'archive_complete',
      archive: '2024/02',
      games_in_archive: 4,
      new_games: 2,
      skipped_games: 2,
      cached: false,
    })
    const secondArchive = reduceImportProgress(firstComplete, {
      type: 'archive_start',
      archive: '2024/03',
      index: 2,
      total_archives: 3,
    })
    const secondProgress = reduceImportProgress(secondArchive, {
      type: 'game_progress',
      archive: '2024/03',
      game_index: 1,
      games_in_archive: 10,
      current_game: 'gamma vs delta',
      new_games: 0,
      skipped_games: 1,
    })

    expect(secondProgress?.newGames).toBe(2)
    expect(secondProgress?.archiveNewGames).toBe(0)
    expect(formatImportProgressLabel(secondProgress, 'running')).toBe(
      'Archive 2/3 · 2 new games found',
    )
    expect(formatImportProgressDetail(secondProgress)).toBe(
      '2024/03 · 1/10 games · 0 new here · 1 existing here',
    )
  })

  test('marks archive complete and cached when archive is reused', () => {
    const started = reduceImportProgress(null, {
      type: 'archive_start',
      archive: '2024/02',
      index: 1,
      total_archives: 3,
    })

    const completed = reduceImportProgress(started, {
      type: 'archive_complete',
      archive: '2024/02',
      games_in_archive: 32,
      new_games: 0,
      skipped_games: 32,
      cached: true,
    })

    expect(completed?.cached).toBe(true)
    expect(completed?.complete).toBe(true)
    expect(completed?.currentGameIndex).toBe(32)
    expect(completed?.gamesInArchive).toBe(32)
    expect(completed?.cachedArchives).toBe(1)
  })

  test('uses final import totals from the complete event', () => {
    const started = reduceImportProgress(null, {
      type: 'archive_start',
      archive: '2024/02',
      index: 1,
      total_archives: 1,
    })

    const completed = reduceImportProgress(started, {
      type: 'complete',
      total_new_games: 12,
      total_skipped: 48,
      cached_archives: 3,
    })

    expect(completed?.newGames).toBe(12)
    expect(completed?.skippedGames).toBe(48)
    expect(formatImportProgressLabel(completed, 'complete')).toBe('Import complete · 12 new games')
    expect(formatImportProgressDetail(completed)).toBe(
      '48 existing games skipped · 3 cached archives',
    )
  })

  test('keeps a visible final state when complete is the first event', () => {
    const completed = reduceImportProgress(null, {
      type: 'complete',
      total_new_games: 0,
      total_skipped: 0,
      cached_archives: 0,
    })

    expect(completed?.complete).toBe(true)
    expect(formatImportProgressLabel(completed, 'complete')).toBe('Import complete · 0 new games')
  })
})
