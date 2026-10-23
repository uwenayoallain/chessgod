import { describe, expect, it } from 'vite-plus/test'

import { formatImportProgressDetail, formatImportProgressLabel } from './import-progress'
import type { ImportProgress } from '@/store/app-store'

function progress(over: Partial<ImportProgress> = {}): ImportProgress {
  return {
    currentArchive: '2026/08',
    archiveIndex: 2,
    totalArchives: 35,
    gamesInArchive: 105,
    currentGameIndex: 80,
    currentGameLabel: 'Reading',
    newGames: 4,
    skippedGames: 80,
    archiveNewGames: 0,
    archiveSkippedGames: 80,
    cached: false,
    complete: false,
    cachedArchives: 0,
    ...over,
  }
}

describe('formatImportProgressLabel', () => {
  it('counts archives while running', () => {
    expect(formatImportProgressLabel(progress(), 'running')).toBe(
      'Month 2 of 35 · 4 new games found',
    )
  })

  it('reports the haul when finished', () => {
    expect(formatImportProgressLabel(progress({ newGames: 4 }), 'complete')).toBe(
      'Import complete · 4 new games',
    )
  })

  it('uses the singular for a single game', () => {
    expect(formatImportProgressLabel(progress({ newGames: 1 }), 'complete')).toBe(
      'Import complete · 1 new game',
    )
  })

  it('is honest when a finished import found nothing', () => {
    expect(formatImportProgressLabel(progress({ newGames: 0 }), 'complete')).toBe(
      'Import complete · 0 new games',
    )
  })
})

describe('formatImportProgressDetail', () => {
  it('shows progress through the archive', () => {
    expect(formatImportProgressDetail(progress())).toBe(
      '2026/08 · 80/105 games · 0 new · 80 already stored',
    )
  })

  it('does not print a fraction before the archive size is known', () => {
    // This used to read "0/? games".
    expect(formatImportProgressDetail(progress({ gamesInArchive: 0, currentGameIndex: 0 }))).toBe(
      '2026/08 · reading games · 0 new · 80 already stored',
    )
  })

  it('says how many months were checked, never a library size', () => {
    // "99 games already in your library" read as a library of 99 games.
    const done = progress({
      currentGameLabel: 'Import complete',
      totalArchives: 2,
      skippedGames: 99,
    })
    expect(formatImportProgressDetail(done)).toBe('Checked 2 months of games on Chess.com')
    expect(formatImportProgressDetail({ ...done, totalArchives: 0 })).toBe(
      'Your library is up to date',
    )
  })

  it('says when an archive came from cache', () => {
    expect(formatImportProgressDetail(progress({ cached: true }))).toMatch(/unchanged/)
  })
})
