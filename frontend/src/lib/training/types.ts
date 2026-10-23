export type StepBase = {
  ply: number
  /** The position the move is played from (four-field FEN). */
  fen: string
  uci: string
  san: string
}

export type YourStep = StepBase & {
  side: 'you'
  /** keep: you already play it · change: play this instead · new: never reached it */
  status: 'keep' | 'change' | 'new'
  reason: 'usual' | 'marked' | 'masters' | 'engine' | 'unchecked'
  /** Chosen from a MultiPV search, rather than the engine's single best move. */
  checked: boolean
  eval_cp: number | null
  best_eval_cp: number | null
  idea_san: string | null
  master_games: number
  master_share: number | null
  usual_uci: string | null
  usual_san: string | null
  usual_games: number
  usual_score: number | null
  usual_loss_cp: number | null
  usual_last_played: string | null
  games: number
  level: number | null
  due: boolean
  due_at: string | null
}

export type OpponentStep = StepBase & {
  side: 'opponent'
  source: 'games' | 'masters'
  games: number
  share: number | null
  /** How much the reply gives away, when it is a mistake worth punishing. */
  trap_cp: number | null
}

export type RepertoireStep = YourStep | OpponentStep

export type LineStatus = 'new' | 'learning' | 'due' | 'mastered'

export type RepertoireLine = {
  id: string
  name: string | null
  first_move: string
  moves: RepertoireStep[]
  games: number
  changes: number
  traps: number
  unchecked: number
  your_moves: number
  known_moves: number
  /** Moves in the line not taught yet; the line stays "new" until this is 0. */
  new_moves: number
  due_moves: number
  status: LineStatus
}

export type Repertoire = {
  username: string
  color: 'white' | 'black'
  time_class: string
  min_user_rating: number
  lines: RepertoireLine[]
  needs_engine: string[]
  multipv: number
}

export type Achievement = {
  key: string
  title: string
  description: string
  target: number
  progress: number
  unlocked_at: string | null
}

export type TrainingProfile = {
  username: string
  xp: number
  level: number
  title: string
  level_floor_xp: number
  next_level_xp: number
  daily_goal: number
  today_xp: number
  goal_met_today: boolean
  streak: number
  best_streak: number
  /** Streak freezes held: a missed day inside a streak spends one. */
  freezes: number
  freeze_every_xp: number
  week: { date: string; xp: number; frozen: boolean }[]
  /** This week so far against last week at the same point. */
  rival: { this_week: number; last_week_so_far: number; last_week: number }
  rush_best: number
  threats_spotted: number
  threats_seen: number
  punish_found?: number
  punish_seen?: number
  due_repertoire_moves: number
  due_drills: number
  /** Today's three quests, and the chest for clearing all of them. */
  quests: QuestBoard
  achievements: Achievement[]
}

export type QuestSection = 'threats' | 'openings' | 'drills' | 'review' | 'quiz' | 'play'

export type Quest = {
  key: string
  title: string
  section: QuestSection
  target: number
  progress: number
  done: boolean
  /** The quest's XP has been paid. */
  claimed: boolean
  xp: number
}

export type QuestBoard = {
  date: string
  items: Quest[]
  all_done: boolean
  chest_xp: number
  chest_opened: boolean
}

/** What any XP-earning write returns, so the page can celebrate it. */
export type TrainingReward = {
  xp_gained: number
  leveled_up?: boolean
  goal_just_met?: boolean
  unlocked?: Achievement[]
  profile?: TrainingProfile
}

export type LineReviewResponse = TrainingReward & {
  results: { fen: string; uci: string; correct: boolean; level: number; due_at: string }[]
  misses: number
}

export type RushQuestion = {
  fen: string
  last_move_uci: string | null
  side_to_move: 'white' | 'black'
  color: 'white' | 'black'
  ply: number
  line_name: string | null
  answer_uci: string
  answer_san: string
  changed: boolean
}

export type RushSet = { questions: RushQuestion[]; lives: number; seconds: number }

export type RushResult = TrainingReward & {
  score: number
  best: number
  new_best: boolean
  requeued: number
}

export type RepertoireDeviation = {
  game_id: number
  url: string
  played_at: string
  result: string
  color: 'white' | 'black'
  fen: string
  ply: number
  played_san: string
  expected_san: string
  expected_uci: string
  line_id: string
  line_name: string | null
}

export type RepertoireCheck = {
  games_checked: number
  games_followed: number
  deviations: RepertoireDeviation[]
  requeued: number
}

export type ThreatQuestion = {
  position_id: number
  /** The position after the player's mistake: the opponent is to move. */
  fen: string
  player_color: 'white' | 'black'
  ply: number
  your_move_uci: string
  your_move_san: string
  better_san: string
  kind: 'capture' | 'check' | 'mate'
  loss_cp: number
  game_url: string
  played_at: string
  /** Missed before and due again: a second look at a scan that failed. */
  again?: boolean
}

export type PunishQuestion = {
  position_id: number
  /** The position after the opponent's mistake: the player is to move. */
  fen: string
  player_color: 'white' | 'black'
  /** The player's own move in the game, the one that handed the gift back. */
  ply: number
  their_move_uci: string
  their_move_san: string
  your_move_san: string
  kind: 'capture' | 'check' | 'mate'
  gift_cp: number
  game_url: string
  played_at: string
  again?: boolean
}

export type PunishAnswer = TrainingReward & {
  correct: boolean
  answer_uci: string
  answer_san: string
  your_move_san: string
}

export type ThreatAnswer = TrainingReward & {
  correct: boolean
  reply_uci: string
  reply_san: string
  better_san: string
}

export type ProgressGame = {
  game_id: number
  played_at: string
  url: string
  color: 'white' | 'black'
  result: string
  rating: number | null
  moves: number
  analysed: number
  big_errors: number
  forcing_errors: number
  cp10: number | null
}

export type ProgressSummary = {
  games: number
  big_errors: number
  forcing_errors: number
  score: number
  worse_after_opening: Partial<Record<'white' | 'black', number>>
  rating_from: number | null
  rating_to: number | null
}

export type TrainingProgress = {
  username: string
  checked_games: number
  /** Newest first. */
  games: ProgressGame[]
  recent: ProgressSummary | null
  previous: ProgressSummary | null
  training_since: string | null
  since_training: ProgressSummary | null
  before_training: ProgressSummary | null
}

export type ClockReport = {
  username: string
  verdict: 'unused' | 'time_trouble' | 'balanced' | 'insufficient'
  time_control?: string
  time_class?: string
  initial_seconds?: number
  increment?: number
  games: number
  losses?: number
  left_in_losses?: number | null
  left_in_wins?: number | null
  think_after_opening?: number | null
  moves?: number
  mistakes: number
  mistake_think?: number | null
  mistake_left?: number | null
  mistakes_with_half_clock?: number
  hasty_mistakes?: number
  mistakes_in_time_trouble?: number
  by_finish?: { label: string; games: number; score: number | null }[]
  by_think?: { label: string; moves: number; mistakes: number }[]
}

export type HabitKey = 'second_mistake' | 'missed_punishment' | 'long_session' | 'tilt'

export type Habit = {
  key: HabitKey
  shows: boolean
  /** Moves (or games, for tilt) the rate is measured over. */
  events?: number
  rate?: number | null
  baseline?: number | null
  handed_back?: number
  recent_rate?: number | null
  recent_events?: number
  earlier_rate?: number | null
  stop_after?: number | null
  early?: number
  late?: number
  drop?: number
  late_games?: number
  games?: number
  after_loss?: number | null
  otherwise?: number | null
}

export type HabitMoment = {
  kind: 'second_mistake' | 'missed_punishment'
  ply: number
  move_number: number
  san: string | null
  better_san: string | null
  opponent_san: string | null
  think_seconds: number | null
  /** The position the move was played from. */
  fen: string | null
}

export type HabitsReport = {
  username: string
  games: number
  recent_games?: number
  habits: Habit[]
  last_game: {
    game_id: number
    played_at: string
    opponent: string
    user_color: 'white' | 'black'
    user_result: 'win' | 'loss' | 'draw'
    game_url: string
    session_place: number
    big_mistakes: number
    moments: HabitMoment[]
  } | null
  pending_games?: number
  sitting: { active: boolean; games: number; results: string[]; last_game_at?: string }
}

export type Challenge = {
  key: string
  title: string
  description: string
  target: number
  progress: number
  done: boolean
  claimed: boolean
  xp: number
  games: { url: string; played_at: string; result: string }[]
}

export type ChallengeBoard = TrainingReward & {
  week: string
  ends: string
  games_this_week: number
  latest_game: string | null
  items: Challenge[]
  paid: string[]
}

export type RatingGoal = {
  time_class: 'rapid' | 'blitz'
  goal: number
  current: number | null
  change_30d?: number
  peak?: number
  peak_at?: string
  pace_per_month?: number | null
  pace_games?: number
  eta?: string | null
  vs_goal?: { games: number; score: number | null }
  vs_level?: { games: number; score: number | null }
  band?: number
  points: { date: string; rating: number }[]
}

export type ScoresheetLine = {
  game_id: number
  url: string
  played_at: string
  color: 'white' | 'black'
  time_class: string
  result: 'win' | 'loss' | 'draw'
  notation: string
  opponent: string
  opponent_rating: number | null
  rating: number | null
  opening: string | null
  in_book: boolean | null
  used_clock: boolean | null
}

export type WeekScoresheet = {
  week: string
  ends: string
  games: ScoresheetLine[]
  played: number
  wins: number
  draws: number
  losses: number
  score: number | null
  ratings: Record<string, { from: number; to: number }>
  best_win: ScoresheetLine | null
  in_book: number
  book_games: number
  clock_used: number
  xp: number
}
