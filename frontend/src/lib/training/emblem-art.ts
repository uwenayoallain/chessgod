/**
 * The training layer's art, drawn as one set in the board's own piece style:
 * the 45×45 grid of the Cburnett pieces, a white body with a 1.5 dark outline
 * and round joins, and at most one gold accent. Where a piece says it, the
 * emblem *is* the piece (a pawn for a first solve, a toppled king for beating
 * the boss). Colours are literal on purpose: like the board, the art does not
 * change with the theme.
 *
 * Everything here is a static, trusted string, so it can be both rendered by
 * React and rasterised by a script to look at without a browser.
 */

const INK = '#312e2b'
const WHITE = '#ffffff'
const GOLD = '#f7d16b'
const GOLD_DEEP = '#c9a13f'
const BOARD_DARK = '#739552'
const BOARD_DEEP = '#4f6b37'

function body(join = 'round', cap = 'round') {
  return `fill="${WHITE}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="${join}" stroke-linecap="${cap}"`
}
const BODY = body()
const ACCENT = `fill="${GOLD}" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"`
const LINE = `fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`

/** A thick stroked shape outlined like a piece: dark underneath, white on top. */
function tube(d: string, width = 3.4) {
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${width + 3}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${WHITE}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
}

// The Cburnett pieces, white, as react-chessboard draws them.
const PAWN = `<path ${body('miter')} d="m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z"/>`

const KNIGHT = `<g ${BODY}><path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"/><path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"/><circle cx="9" cy="25.5" r="0.6" fill="${INK}"/><ellipse cx="14.5" cy="15.5" rx="0.5" ry="1.5" transform="rotate(30 14.5 15.5)" fill="${INK}"/></g>`

const BISHOP = `<g ${body('round', 'butt')}><path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z"/><path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z"/><circle cx="22.5" cy="8" r="2.5"/></g><path ${LINE} d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18"/>`

const ROOK = `<g ${body('round', 'butt')}><path d="M 9,39 L 36,39 L 36,36 L 9,36 z"/><path d="M 12,36 L 12,32 L 33,32 L 33,36 z"/><path d="M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14"/><path d="M 34,14 L 31,17 L 14,17 L 11,14"/><path d="M 31,17 L 31,29.5 L 14,29.5 L 14,17"/><path d="M 31,29.5 L 32.5,32 L 12.5,32 L 14,29.5"/></g><path ${LINE} d="M 11,14 L 34,14"/>`

const QUEEN = `<g ${BODY}><path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z"/><path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z"/><circle cx="6" cy="12" r="2" fill="${GOLD}"/><circle cx="14" cy="9" r="2" fill="${GOLD}"/><circle cx="22.5" cy="8" r="2" fill="${GOLD}"/><circle cx="31" cy="9" r="2" fill="${GOLD}"/><circle cx="39" cy="12" r="2" fill="${GOLD}"/></g><path ${LINE} d="M 11.5,30 C 15,29 30,29 33.5,30 M 12,33.5 C 18,32.5 27,32.5 33,33.5"/>`

const KING = `<path ${LINE} d="M 22.5,11.63 L 22.5,6 M 20,8 L 25,8"/><path ${BODY} d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25"/><path ${BODY} d="M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37"/><path ${LINE} d="M 12.5,30 C 18,27 27,27 32.5,30 M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5 M 12.5,37 C 18,34 27,34 32.5,37"/>`

// The set's own drawings, in the same hand.
const BOOK = `<path ${BODY} d="M22.5 13 C18 10.4 12.2 10.3 6.5 12 V34 C12.2 32.3 18 32.4 22.5 35 Z"/><path ${BODY} d="M22.5 13 C27 10.4 32.8 10.3 38.5 12 V34 C32.8 32.3 27 32.4 22.5 35 Z"/><path ${LINE} d="M10 17.3 C13.5 16.3 17.2 16.5 19.8 17.6 M10 21.8 C13.5 20.8 17.2 21 19.8 22.1 M10 26.3 C13.5 25.3 17.2 25.5 19.8 26.6 M25.2 17.6 C27.8 16.5 31.5 16.3 35 17.3 M25.2 22.1 C27.8 21 31.5 20.8 35 21.8"/><path ${ACCENT} d="M29.5 11 V21.5 L31.7 19.6 L33.9 21.5 V10.9 C32.4 10.8 30.9 10.8 29.5 11 Z"/>`

const SHIELD = `<path ${BODY} d="M22.5 6.5 L36.5 11.5 V21.5 C36.5 30 30.5 36 22.5 39 C14.5 36 8.5 30 8.5 21.5 V11.5 Z"/><path ${ACCENT} d="M22.5 10.5 L32.5 14 V21.5 C32.5 27.6 28.4 32.2 22.5 34.7 Z"/><path fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M15.5 22 L20.5 27 L29.5 16.5"/>`

const CROSSHAIR = `<circle ${BODY} cx="22.5" cy="22.5" r="12.5"/><circle ${ACCENT} cx="22.5" cy="22.5" r="6.5"/><circle fill="${INK}" cx="22.5" cy="22.5" r="1.6"/><path fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round" d="M22.5 5.5 V13 M22.5 32 V39.5 M5.5 22.5 H13 M32 22.5 H39.5"/>`

const FLAME = `<path ${BODY} d="M22.5 5 C24.8 11.5 33 15.5 33 25.5 C33 33 28.3 39 22.5 39 C16.7 39 12 33.2 12 26.5 C12 21.3 14.8 18.2 16.6 15.6 C17.2 19.2 18.8 21.3 20.9 21.9 C19.8 16.2 20.3 10.2 22.5 5 Z"/><path ${ACCENT} d="M22.5 22.5 C24.6 25.6 27.8 27.6 27.8 31.6 C27.8 35 25.4 37.2 22.5 37.2 C19.6 37.2 17.2 35 17.2 32 C17.2 28.9 20.4 26.9 22.5 22.5 Z"/>`

const SWORDS = `<path ${BODY} d="M36.5 7.5 L32.3 7.9 L13 27.2 L16.8 31 L36.1 11.7 Z"/><path ${BODY} d="M20.4 33.6 L11.4 24.6 L9.2 26.8 L18.2 35.8 Z"/>${tube('M13.3 33.3 L8.2 38.4', 2.6)}<circle ${ACCENT} cx="7.2" cy="39.2" r="2"/><path ${BODY} d="M8.5 7.5 L12.7 7.9 L32 27.2 L28.2 31 L8.9 11.7 Z"/><path ${BODY} d="M24.6 33.6 L33.6 24.6 L35.8 26.8 L26.8 35.8 Z"/>${tube('M31.7 33.3 L36.8 38.4', 2.6)}<circle ${ACCENT} cx="37.8" cy="39.2" r="2"/>`

const GEM = `<path ${BODY} d="M13 10.5 H32 L39.5 19 L22.5 38.5 L5.5 19 Z"/><path ${ACCENT} d="M17 19 L22.5 10.5 L28 19 Z"/><path ${LINE} d="M5.5 19 H39.5 M13 10.5 L17 19 L22.5 38.5 L28 19 L32 10.5"/>`

const BOLT = `<path ${ACCENT} d="M26.5 5 L10 25.5 H20.5 L17 40 L35 17.5 H24 Z"/><path fill="none" stroke="${WHITE}" stroke-opacity="0.7" stroke-width="1.4" stroke-linecap="round" d="M24.2 10.5 L14.8 22.6"/>`

const PODIUM = `<path ${BODY} d="M7.5 38.5 V30 H16.5 V24.5 H28.5 V33 H37.5 V38.5 Z"/><path ${LINE} d="M16.5 30 V38.5 M28.5 33 V38.5"/><path ${ACCENT} d="M22.5 5.5 L30.5 13.5 H25.8 V20.5 H19.2 V13.5 H14.5 Z"/>`

const EYE = `<path ${BODY} d="M4.5 22.5 C9.5 13.5 15.8 10.5 22.5 10.5 C29.2 10.5 35.5 13.5 40.5 22.5 C35.5 31.5 29.2 34.5 22.5 34.5 C15.8 34.5 9.5 31.5 4.5 22.5 Z"/><circle ${ACCENT} cx="22.5" cy="22.5" r="7.5"/><circle fill="${INK}" cx="22.5" cy="22.5" r="3.4"/><circle fill="${WHITE}" cx="24.6" cy="20.4" r="1.3"/>`

const SCROLL = `<path ${BODY} d="M14 9 H33.5 C35.3 9 36.5 10.3 36.5 12 C36.5 13.7 35.3 15 33.5 15 H33 V33 C33 35.6 31.4 37.5 29 37.5 H11.5 C9.6 37.5 8.5 36.2 8.5 34.5 C8.5 32.8 9.6 31.5 11.5 31.5 H14 Z"/><path ${LINE} d="M14 9 C12 9 11 10.3 11 12 C11 13.7 12 15 14 15 M14 31.5 V35 M18 18 H29 M18 22.5 H29 M18 27 H25"/><circle ${ACCENT} cx="28.8" cy="31.2" r="3.3"/>`

const BOARD = `<rect ${BODY} x="7.5" y="7.5" width="30" height="30" rx="1.5"/><path fill="${BOARD_DARK}" d="M17.5 7.5 H27.5 V17.5 H17.5 Z M7.5 17.5 H17.5 V27.5 H7.5 Z M27.5 17.5 H37.5 V27.5 H27.5 Z M17.5 27.5 H27.5 V37.5 H17.5 Z"/><rect fill="none" stroke="${INK}" stroke-width="1.5" x="7.5" y="7.5" width="30" height="30" rx="1.5"/><circle ${ACCENT} cx="22.5" cy="22.5" r="3.4"/>`

const RETRY = `${tube('M33.2 26.5 A11 11 0 1 1 29.6 13.8', 3.6)}<path ${ACCENT} d="M26.4 17.5 L33.2 10.2 L35.3 19 Z"/>`

const MAGNIFIER = `${tube('M28 28 L37.5 37.5', 4)}<circle ${BODY} cx="19.5" cy="19.5" r="11.5"/><circle ${ACCENT} cx="19.5" cy="19.5" r="7.2"/><path fill="none" stroke="${WHITE}" stroke-width="1.6" stroke-linecap="round" d="M15.2 17.2 A5 5 0 0 1 18.6 14.5"/>`

const QUESTION = `<path ${BODY} d="M9.5 9.5 H35.5 C37.2 9.5 38.5 10.8 38.5 12.5 V28 C38.5 29.7 37.2 31 35.5 31 H21 L13.5 37.5 V31 H9.5 C7.8 31 6.5 29.7 6.5 28 V12.5 C6.5 10.8 7.8 9.5 9.5 9.5 Z"/><path fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M18.5 16.6 C18.5 13.4 26.5 13.2 26.5 17.4 C26.5 20.4 22.5 20.6 22.5 23.2"/><circle fill="${GOLD_DEEP}" stroke="${INK}" stroke-width="1" cx="22.5" cy="27" r="1.7"/>`

const CHEST = `<path ${BODY} d="M7.5 20 H37.5 V36.5 H7.5 Z"/><path ${BODY} d="M7.5 20 V16.5 C7.5 11.5 11.5 9 16 9 H29 C33.5 9 37.5 11.5 37.5 16.5 V20 Z"/><path ${LINE} d="M14.5 9.4 V36.5 M30.5 9.4 V36.5"/><rect ${ACCENT} x="19" y="16.5" width="7" height="9" rx="1.4"/><circle fill="${INK}" cx="22.5" cy="20.4" r="1.1"/>`

// The chest once all three quests are done: lid thrown back, gold showing.
const CHEST_OPEN = `<path ${BODY} d="M8.5 13 L13.5 4.5 H32.5 L37.5 13 Z"/><path ${LINE} d="M15.2 5 L12.8 12.8 M29.8 5 L32.2 12.8"/><path ${ACCENT} d="M9.5 21 C12 15.5 16 13.5 22.5 13.5 C29 13.5 33 15.5 35.5 21 Z"/><circle ${ACCENT} cx="17" cy="17.6" r="2.2"/><circle ${ACCENT} cx="27.6" cy="17" r="2.6"/><circle ${ACCENT} cx="22.5" cy="15.6" r="2"/><path ${BODY} d="M7.5 20 H37.5 V36.5 H7.5 Z"/><path ${LINE} d="M14.5 20 V36.5 M30.5 20 V36.5"/><rect ${ACCENT} x="19" y="22.5" width="7" height="7" rx="1.4"/>`

const SNOWFLAKE = `${tube('M22.5 6 V39 M8.2 14.25 L36.8 30.75 M8.2 30.75 L36.8 14.25 M18.5 8.5 L22.5 12 L26.5 8.5 M18.5 36.5 L22.5 33 L26.5 36.5', 2.4)}<circle ${ACCENT} cx="22.5" cy="22.5" r="3.4"/>`

const CUP = `<path ${LINE} d="M13 11 C6 11 6.5 21.5 14.5 22 M32 11 C39 11 38.5 21.5 30.5 22"/><path ${BODY} d="M12.5 7.5 H32.5 V15 C32.5 22.5 28.2 27.5 22.5 27.5 C16.8 27.5 12.5 22.5 12.5 15 Z"/><path ${BODY} d="M20 27.5 H25 V31.5 H20 Z"/><path ${BODY} d="M14 31.5 H31 V37.5 H14 Z"/><path ${ACCENT} d="M17.5 33.3 H27.5 V35.7 H17.5 Z"/>`

const HOURGLASS = `<path ${BODY} d="M13.5 10.5 H31.5 C31.5 17 25.2 20 24 22.5 C25.2 25 31.5 28 31.5 34.5 H13.5 C13.5 28 19.8 25 21 22.5 C19.8 20 13.5 17 13.5 10.5 Z"/><path ${ACCENT} d="M16.7 34.5 C17.6 30.7 21 29.1 22.5 27.4 C24 29.1 27.4 30.7 28.3 34.5 Z"/><path ${ACCENT} d="M17.6 14 H27.4 C26.4 16.8 24 18.3 22.5 19.8 C21 18.3 18.6 16.8 17.6 14 Z"/><rect ${BODY} x="10.5" y="7" width="24" height="3.5" rx="1"/><rect ${BODY} x="10.5" y="34.5" width="24" height="3.5" rx="1"/>`

const CROWN = `<path ${BODY} d="M9.5 31 L6.5 14 L15.5 21.5 L22.5 9.5 L29.5 21.5 L38.5 14 L35.5 31 Z"/><rect ${BODY} x="9" y="31" width="27" height="5.5" rx="1"/><circle ${ACCENT} cx="6.5" cy="13" r="2.3"/><circle ${ACCENT} cx="22.5" cy="8.6" r="2.3"/><circle ${ACCENT} cx="38.5" cy="13" r="2.3"/><circle ${ACCENT} cx="22.5" cy="33.7" r="1.6"/><circle ${ACCENT} cx="15" cy="33.7" r="1.2"/><circle ${ACCENT} cx="30" cy="33.7" r="1.2"/>`

/** Every emblem, keyed by what it stands for. */
export const EMBLEMS = {
  pawn: PAWN,
  knight: KNIGHT,
  bishop: BISHOP,
  rook: ROOK,
  queen: QUEEN,
  king: KING,
  crown: CROWN,
  book: BOOK,
  shield: SHIELD,
  crosshair: CROSSHAIR,
  flame: FLAME,
  swords: SWORDS,
  gem: GEM,
  bolt: BOLT,
  podium: PODIUM,
  eye: EYE,
  scroll: SCROLL,
  board: BOARD,
  retry: RETRY,
  magnifier: MAGNIFIER,
  question: QUESTION,
  chest: CHEST,
  chestOpen: CHEST_OPEN,
  snowflake: SNOWFLAKE,
  cup: CUP,
  hourglass: HOURGLASS,
} as const

export type EmblemName = keyof typeof EMBLEMS

/** Achievements: the emblem and how many tier pips its rim carries. */
export const BADGE_ART: Record<string, { emblem: EmblemName; tier?: number }> = {
  first_drill: { emblem: 'pawn' },
  drills_50: { emblem: 'knight' },
  drills_250: { emblem: 'queen' },
  first_line: { emblem: 'book' },
  lines_10: { emblem: 'rook' },
  leak_plugged: { emblem: 'shield' },
  trap_setter: { emblem: 'crosshair' },
  recall_100: { emblem: 'bishop' },
  streak_3: { emblem: 'flame', tier: 1 },
  streak_7: { emblem: 'flame', tier: 2 },
  streak_30: { emblem: 'flame', tier: 3 },
  sparring_5: { emblem: 'swords' },
  xp_1000: { emblem: 'gem' },
  rush_10: { emblem: 'bolt', tier: 1 },
  rush_25: { emblem: 'bolt', tier: 2 },
  boss_slayer: { emblem: 'crown' },
  rival_beaten: { emblem: 'podium' },
  hawk_eye: { emblem: 'eye' },
  quest_master: { emblem: 'scroll' },
  board_challenge: { emblem: 'board' },
  second_chance: { emblem: 'retry' },
}

/** A bare emblem, for inline use (quests, the chest, the streak). */
export function emblemSvg(name: EmblemName): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" aria-hidden="true">${EMBLEMS[name]}</svg>`
}

/**
 * A medal: gold rim and a dark-square face when earned, pewter when locked
 * (with the emblem dimmed and an arc for how close it is), and gold pips on
 * the rim for tiers.
 */
export function medalSvg(
  name: EmblemName,
  { earned, tier = 0, progress = 0 }: { earned: boolean; tier?: number; progress?: number },
): string {
  const rimTop = earned ? '#fbe7a6' : '#8b8783'
  const rimBottom = earned ? GOLD_DEEP : '#4a4643'
  const faceTop = earned ? BOARD_DARK : '#5c5955'
  const faceBottom = earned ? BOARD_DEEP : '#35322f'
  const id = earned ? 'e' : 'l'
  const share = Math.max(0, Math.min(1, progress))
  const arcLength = 2 * Math.PI * 30.5
  const arc =
    !earned && share > 0
      ? `<circle cx="32" cy="32" r="30.5" fill="none" stroke="${GOLD}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${(arcLength * share).toFixed(1)} ${arcLength.toFixed(1)}" transform="rotate(-90 32 32)"/>`
      : ''
  const pips = Array.from({ length: tier }, (_, index) => {
    const x = 32 + (index - (tier - 1) / 2) * 7
    return `<path d="M${x} 55.5 L${x + 2.6} 58.1 L${x} 60.7 L${x - 2.6} 58.1 Z" fill="${GOLD}" stroke="${INK}" stroke-width="1"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="tr-rim-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rimTop}"/><stop offset="1" stop-color="${rimBottom}"/></linearGradient><radialGradient id="tr-face-${id}" cx="0.4" cy="0.32" r="0.75"><stop offset="0" stop-color="${faceTop}"/><stop offset="1" stop-color="${faceBottom}"/></radialGradient></defs><circle cx="32" cy="32" r="29" fill="url(#tr-rim-${id})" stroke="${INK}" stroke-width="1.5"/><circle cx="32" cy="32" r="23.5" fill="url(#tr-face-${id})" stroke="${INK}" stroke-width="1.2"/><path d="M14 24 A19 19 0 0 1 40 13.5" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2.2" stroke-linecap="round"/><g transform="translate(13.1 12.6) scale(0.84)"${earned ? '' : ' opacity="0.55"'}>${EMBLEMS[name]}</g>${pips}${arc}</svg>`
}

const TITLE_EMBLEMS: Record<string, EmblemName> = {
  Pawn: 'pawn',
  Knight: 'knight',
  Bishop: 'bishop',
  Rook: 'rook',
  Queen: 'queen',
  King: 'king',
}

/**
 * The level crest, in the medal's frame: the title's piece on the dark-square
 * face, and progress to the next level filling the rim in gold.
 */
export function crestSvg(title: string, progress: number): string {
  const share = Math.max(0, Math.min(1, progress))
  const length = 2 * Math.PI * 27
  const emblem = EMBLEMS[TITLE_EMBLEMS[title] ?? 'pawn']
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="tr-crest-face" cx="0.4" cy="0.32" r="0.75"><stop offset="0" stop-color="${BOARD_DARK}"/><stop offset="1" stop-color="${BOARD_DEEP}"/></radialGradient></defs><circle cx="32" cy="32" r="30" fill="#403d39" stroke="${INK}" stroke-width="1.5"/><circle cx="32" cy="32" r="27" fill="none" stroke="#5c5955" stroke-width="4.5"/><circle cx="32" cy="32" r="27" fill="none" stroke="${GOLD}" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="${(length * share).toFixed(1)} ${length.toFixed(1)}" transform="rotate(-90 32 32)"/><circle cx="32" cy="32" r="23.5" fill="url(#tr-crest-face)" stroke="${INK}" stroke-width="1.2"/><path d="M14 24 A19 19 0 0 1 40 13.5" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2.2" stroke-linecap="round"/><g transform="translate(13.1 12.6) scale(0.84)">${emblem}</g></svg>`
}
