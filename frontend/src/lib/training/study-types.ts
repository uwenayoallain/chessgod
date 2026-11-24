import type { TrainingReward } from '@/lib/training/types'

export type StudyCourseResource = {
  title: string
  author: string
  platform: string
  source: 'chesscom_premium' | 'free_modern'
  why: string
  url: string
  level: string
}

export type StudyBookReference = {
  title: string
  author: string
  focus: string
  level: string
}

export type MasterPlaybook = {
  id: string
  category: 'opening' | 'middlegame' | 'tactics' | 'defense' | 'endgame' | 'habits'
  title: string
  subtitle: string
  color: 'white' | 'black' | 'both'
  structure_name: string
  level: string
  tabiya_fen: string | null
  tabiya_label: string | null
  summary: string
  core_ideas: string[]
  white_plans: string[]
  black_plans: string[]
  key_breaks: string[]
  piece_guide: string[]
  checklist: string[]
  common_traps: string[]
  eco_prefixes: string[]
  opening_keywords: string[]
  books: StudyBookReference[]
  courses: StudyCourseResource[]
  /** The built-in interactive course that trains this playbook, when there is one. */
  course_preset_id?: string | null
}

export type ConcreteOpeningFix = {
  fen: string
  last_move_uci: string | null
  opening_name: string | null
  played_san: string
  best_san: string
  occurrences: number
  average_loss_cp: number
}

export type StudyRecommendation = {
  playbook_id: string
  priority_score: number
  reason: string
  evidence: string
  metric_label: string
  current_value: string
  target_value: string
  trend: 'improving' | 'steady' | 'worsening'
  concrete_fixes: ConcreteOpeningFix[]
  playbook: MasterPlaybook
}

export type StudyPlayerSnapshot = {
  latest_rating: number | null
  analyzed_decisions: number
  total_decisions: number
  biggest_phase: string | null
  biggest_phase_share: number | null
  top_focus: string
}

export type StudyGuideResponse = {
  username: string
  time_class: string
  player_snapshot: StudyPlayerSnapshot
  recommended: StudyRecommendation[]
  catalog: MasterPlaybook[]
}

// Imported study courses: Lichess studies, annotated PGN and built-in packs,
// trained move by move on the board.

export type StudyCourseColor = 'white' | 'black'
export type StudyMarkColor = 'green' | 'red' | 'blue' | 'yellow'
export type StudyLineStatus = 'new' | 'learning' | 'due' | 'mastered'
export type StudyTrainMode = 'learn' | 'practice'

export type StudyCoursePreset = {
  id: string
  title: string
  color: StudyCourseColor
  description: string
  chapter_count: number
  tags: string[]
}

export type StudyCourseSummary = {
  id: number
  title: string
  color: StudyCourseColor
  source_type: 'lichess' | 'pgn' | 'builtin'
  source_ref: string | null
  description: string | null
  chapter_count: number
  line_count: number
  your_moves: number
  known_moves: number
  due_moves: number
  created_at: string
}

export type StudyCoursesListResponse = {
  courses: StudyCourseSummary[]
  presets: StudyCoursePreset[]
}

export type StudyMoveArrow = { from: string; to: string; color: StudyMarkColor }
export type StudyMoveHighlight = { square: string; color: StudyMarkColor }

export type StudyCourseMove = {
  ply: number
  /** The position before the move, as a 4-field FEN. */
  fen: string
  san: string
  uci: string
  side: 'you' | 'opponent'
  comment: string | null
  arrows: StudyMoveArrow[]
  highlights: StudyMoveHighlight[]
  level?: number
  due?: boolean
  seen?: boolean
  next_review_at?: string | null
}

export type StudyCourseLine = {
  id: string
  title: string
  start_fen: string
  moves: StudyCourseMove[]
  your_moves: number
  known_moves: number
  due_moves: number
  status: StudyLineStatus
}

export type StudyCourseChapter = {
  id: number
  position: number
  title: string
  start_fen: string
  lines: StudyCourseLine[]
}

export type StudyCourseDetail = StudyCourseSummary & {
  chapters: StudyCourseChapter[]
}

export type StudyCourseImportRequest = {
  username: string
  title?: string
  color?: StudyCourseColor | 'auto'
  lichess_url?: string
  pgn?: string
  preset_id?: string
}

export type StudyCourseReviewMove = {
  fen: string
  expected_uci: string
  played_uci: string
  hinted: boolean
}

export type StudyCourseReviewRequest = {
  username: string
  line_id: string
  mode: StudyTrainMode
  moves: StudyCourseReviewMove[]
  request_id?: string
  /** The player's time zone, so the streak and the daily goal count their day. */
  tz?: string
  daily_goal?: number
}

export type StudyCourseReviewResponse = {
  line_id: string
  recalled: number
  missed: number
  total: number
  known_moves: number
  due_moves: number
  status: StudyLineStatus
  /** XP, level, streak and badges earned by this pass, when the server awards any. */
  reward?: TrainingReward
}

export type StudyCourseDeleteResponse = { deleted: boolean; id: number }
