export const AUTOPILOT_STORAGE_KEY = 'chessgod.analysisAutopilot'

// Analysis is the whole evidence base for every drill and every trend, and it can
// only come from this browser. Losing the opt-in on every reload is why a corpus of
// thousands of games can sit at a couple of percent analysed, so the choice is
// remembered. It still starts off: nothing pegs a CPU without being asked.
export function readAutopilotPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTOPILOT_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeAutopilotPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(AUTOPILOT_STORAGE_KEY, String(enabled))
  } catch {
    // A browser that refuses storage still analyses for this session.
  }
}
