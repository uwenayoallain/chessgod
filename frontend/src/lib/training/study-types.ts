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
