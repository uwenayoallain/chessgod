export type EngineActivity = {
  newest_evaluation: string | null
  minutes_since: number | null
  stored_last_hour: number
  stored_last_24h: number
}

export type ActivityLine = { tone: 'good' | 'neutral' | 'bad'; text: string }

/** A crawl that stored something this recently is running, not paused. */
const WORKING_MINUTES = 15
/** Past this, a pause is no longer the crawler yielding the machine. */
const STOPPED_MINUTES = 24 * 60

function ago(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * Whether the background engine is working, in a few words. A pause of hours
 * is normal (the crawler yields while the machine is busy or hot) and is said
 * plainly; a crawl that stopped for a day, or never ran, says nothing here —
 * that is the operator's problem (`make system-audit` reports it), not a line
 * for the player to read under their coverage meter.
 */
export function describeEngineActivity(activity: EngineActivity): ActivityLine | null {
  const { minutes_since: minutes, stored_last_hour: hour } = activity
  if (minutes == null || minutes >= STOPPED_MINUTES) return null
  if (minutes < WORKING_MINUTES) {
    return { tone: 'good', text: `Engine working: ${hour.toLocaleString()} positions this hour.` }
  }
  return { tone: 'neutral', text: `Engine idle since ${ago(minutes)}.` }
}
