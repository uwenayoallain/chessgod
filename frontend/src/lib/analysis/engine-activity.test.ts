import { describe, expect, it } from 'vite-plus/test'

import { describeEngineActivity } from './engine-activity'

const base = { newest_evaluation: '2026-10-07T00:00:00Z', stored_last_hour: 0, stored_last_24h: 0 }

describe('describeEngineActivity', () => {
  it('says the engine is working when it stored something minutes ago', () => {
    const line = describeEngineActivity({ ...base, minutes_since: 3, stored_last_hour: 19 })
    expect(line?.tone).toBe('good')
    expect(line?.text).toBe('Engine working: 19 positions this hour.')
  })

  it('calls an hours-long gap idle, not a failure', () => {
    // The crawler stands down while the machine is busy or hot; that is normal.
    const line = describeEngineActivity({ ...base, minutes_since: 180, stored_last_24h: 23 })
    expect(line?.tone).toBe('neutral')
    expect(line?.text).toBe('Engine idle since 3 hours ago.')
  })

  it('says nothing about a crawl that stopped days ago or never ran', () => {
    // An operator's problem, reported by the system audit, not a line under
    // the player's coverage meter.
    expect(describeEngineActivity({ ...base, minutes_since: 3 * 24 * 60 })).toBeNull()
    expect(
      describeEngineActivity({ ...base, newest_evaluation: null, minutes_since: null }),
    ).toBeNull()
  })
})
