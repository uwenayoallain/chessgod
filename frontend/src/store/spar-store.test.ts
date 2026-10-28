// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  clockRemaining,
  readSparStrength,
  resolveSparElo,
  useSparStore,
  writeSparStrength,
} from './spar-store'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'

beforeEach(() => {
  window.localStorage.clear()
  useSparStore.setState({
    status: 'idle',
    outcome: null,
    eloChange: 0,
    override: null,
    timeControlSeconds: null,
  })
})

describe('sparring strength', () => {
  it('starts at the player’s rating and then remembers where they left off', () => {
    expect(resolveSparElo('saint_uwe', { rapid: 1669, blitz: 1422 })).toBe(1669)
    writeSparStrength('saint_uwe', { elo: 1709, games: 1 })
    expect(resolveSparElo('Saint_Uwe', { rapid: 1669 })).toBe(1709)
  })

  it('never treats a hand-picked strength as the calibration', () => {
    // An earlier build saved − / + choices permanently, with no games behind them.
    writeSparStrength('saint_uwe', { elo: 1800, games: 0 })
    expect(readSparStrength('saint_uwe')).toBeNull()
    expect(resolveSparElo('saint_uwe', { rapid: 1669 })).toBe(1669)

    // A choice now lives in memory only and writes nothing.
    useSparStore.getState().setOverride(1600)
    expect(useSparStore.getState().override).toBe(1600)
    expect(window.localStorage.getItem('chessgod.sparringStrength.v2.saint_uwe')).toContain(
      '"games":0',
    )
    useSparStore.getState().setOverride(null)
    expect(useSparStore.getState().override).toBeNull()
  })

  it('moves the opponent after a rated game only', () => {
    const { start, finish } = useSparStore.getState()
    start({ userColor: 'white', elo: 1669, rated: true, epoch: 3, fen: START })
    finish({ result: 'win', reason: 'checkmate' }, 'saint_uwe')
    expect(useSparStore.getState()).toMatchObject({ status: 'over', eloChange: 40 })
    expect(readSparStrength('saint_uwe')).toEqual({ elo: 1709, games: 1 })

    start({ userColor: 'black', elo: 1709, rated: false, epoch: 4, fen: START })
    finish({ result: 'loss', reason: 'resignation' }, 'saint_uwe')
    expect(useSparStore.getState().eloChange).toBe(0)
    expect(readSparStrength('saint_uwe')).toEqual({ elo: 1709, games: 1 })
  })

  it('records a game once, however many times the ending is reported', () => {
    const { start, finish } = useSparStore.getState()
    start({ userColor: 'white', elo: 1669, rated: true, epoch: 1, fen: START })
    finish({ result: 'loss', reason: 'checkmate' }, 'saint_uwe')
    finish({ result: 'loss', reason: 'checkmate' }, 'saint_uwe')
    expect(readSparStrength('saint_uwe')).toEqual({ elo: 1629, games: 1 })
  })

  it('a takeback makes the game unrated', () => {
    const { start, markUnrated, finish } = useSparStore.getState()
    start({ userColor: 'white', elo: 1669, rated: true, epoch: 1, fen: START })
    markUnrated()
    finish({ result: 'win', reason: 'checkmate' }, 'saint_uwe')
    expect(readSparStrength('saint_uwe')).toBeNull()
  })
})

describe('reviewing a finished game', () => {
  it('remembers which side the player had, for the line it was played on', () => {
    const { start, finish, close } = useSparStore.getState()
    start({ userColor: 'black', elo: 1320, rated: true, epoch: 7, fen: START })
    finish({ result: 'loss', reason: 'checkmate' }, 'saint_uwe')
    close({ review: true })
    expect(useSparStore.getState()).toMatchObject({
      status: 'idle',
      reviewing: { userColor: 'black', epoch: 7 },
    })
    // Leaving without a review, or starting another game, forgets it.
    close()
    expect(useSparStore.getState().reviewing).toBeNull()
  })
})

describe('clocks', () => {
  it('runs no clock in an untimed game', () => {
    useSparStore
      .getState()
      .start({ userColor: 'white', elo: 1669, rated: true, epoch: 1, fen: START })
    expect(useSparStore.getState().clocks).toBeNull()
    expect(clockRemaining(useSparStore.getState(), 'white', Date.now())).toBeNull()
  })

  it('charges each side for its own thinking time', () => {
    const store = useSparStore.getState()
    store.setTimeControl(300)
    store.start({ userColor: 'white', elo: 1669, rated: true, epoch: 1, fen: START })
    const started = useSparStore.getState().turnStartedAt!
    expect(useSparStore.getState().clockSide).toBe('white')
    expect(clockRemaining(useSparStore.getState(), 'white', started + 4_000)).toBe(296_000)
    expect(clockRemaining(useSparStore.getState(), 'black', started + 4_000)).toBe(300_000)

    useSparStore.getState().chargeMove('white', started + 4_000, AFTER_E4)
    expect(useSparStore.getState()).toMatchObject({
      clocks: { white: 296_000, black: 300_000 },
      clockSide: 'black',
      clockFen: AFTER_E4,
    })
    // The finished game keeps its clocks, stopped.
    useSparStore.getState().finish({ result: 'win', reason: 'resignation' }, null)
    expect(useSparStore.getState().clockSide).toBeNull()
    expect(useSparStore.getState().clocks!.white).toBe(296_000)
    // The choice outlives the session.
    expect(window.localStorage.getItem('chessgod.sparringTimeControl')).toBe('300')
  })
})
