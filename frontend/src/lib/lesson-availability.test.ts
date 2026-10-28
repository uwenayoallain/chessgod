import { describe, expect, it } from 'vite-plus/test'

import { getLessonAvailability, readyCountInView } from './lesson-availability'

describe('getLessonAvailability', () => {
  it('is ready whenever there are cards', () => {
    expect(
      getLessonAvailability({
        drillCount: 3,
        selectedPattern: 'fork',
        selectedDue: 3,
        totalDue: 7,
      }),
    ).toEqual({ kind: 'ready' })
  })

  it('says a finished theme is clear rather than claiming nothing exists', () => {
    // The bug: selecting a drilled-out theme showed "No lessons yet" and told
    // the user to analyse more games, while seven lessons waited elsewhere.
    expect(
      getLessonAvailability({
        drillCount: 0,
        selectedPattern: 'advantage_conversion',
        selectedDue: 0,
        totalDue: 7,
      }),
    ).toEqual({ kind: 'theme-clear', elsewhere: 7 })
  })

  it('counts only the lessons outside the selected theme', () => {
    expect(
      getLessonAvailability({
        drillCount: 0,
        selectedPattern: 'fork',
        selectedDue: 2,
        totalDue: 7,
      }),
    ).toEqual({ kind: 'theme-clear', elsewhere: 5 })
  })

  it('reports nothing anywhere when the whole library is empty', () => {
    expect(
      getLessonAvailability({
        drillCount: 0,
        selectedPattern: 'fork',
        selectedDue: 0,
        totalDue: 0,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('reports nothing anywhere when no theme is selected and there are no cards', () => {
    expect(
      getLessonAvailability({
        drillCount: 0,
        selectedPattern: null,
        selectedDue: null,
        totalDue: 0,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('never reports a negative number of lessons elsewhere', () => {
    expect(
      getLessonAvailability({
        drillCount: 0,
        selectedPattern: 'fork',
        selectedDue: 9,
        totalDue: 7,
      }),
    ).toEqual({ kind: 'none' })
  })
})

describe('readyCountInView', () => {
  it('shows the whole library when no theme is selected', () => {
    expect(readyCountInView({ selectedPattern: null, selectedDue: null, totalDue: 7 })).toBe(7)
  })

  it('shows the selected theme so the badge matches what is listed', () => {
    expect(
      readyCountInView({ selectedPattern: 'advantage_conversion', selectedDue: 0, totalDue: 7 }),
    ).toBe(0)
  })

  it('treats an unknown theme as empty rather than showing the global count', () => {
    expect(readyCountInView({ selectedPattern: 'gone', selectedDue: null, totalDue: 7 })).toBe(0)
  })
})
