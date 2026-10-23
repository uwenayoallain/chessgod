import { create } from 'zustand'

import { play } from '@/lib/sound'
import type { Achievement } from '@/lib/training/types'

export type TrainingSession = {
  color: 'white' | 'black'
  mode: 'learn' | 'practice'
  /** The lines to go through, in order; a review session queues every due one. */
  lineIds: string[]
  index: number
  label: string
}

/** What a celebration shows beside its words: the level crest, a badge, or an icon. */
export type CelebrationVisual =
  | { kind: 'crest'; title: string; level: number }
  | { kind: 'badge'; key: string }
  | { kind: 'icon'; name: 'flame' | 'scroll' | 'chest' | 'trophy' | 'bolt' | 'crown' }

export type Celebration = {
  id: number
  kind: 'xp' | 'level' | 'achievement' | 'goal' | 'quest'
  title: string
  detail?: string
  visual?: CelebrationVisual
}

/** A new title: played as its own moment, not a toast. */
export type Promotion = { from: string; to: string; level: number; preview?: boolean }

type TrainingState = {
  /** Set to open the course on a colour from elsewhere on the page. */
  courseColor: 'white' | 'black' | null
  showCourse: (color: 'white' | 'black') => void
  session: TrainingSession | null
  startSession: (session: Omit<TrainingSession, 'index'>) => void
  advanceSession: () => void
  switchMode: (mode: TrainingSession['mode']) => void
  endSession: () => void
  celebrations: Celebration[]
  celebrate: (celebration: Omit<Celebration, 'id'>) => void
  dismiss: (id: number) => void
  unlocked: (achievement: Achievement) => void
  /** Counts XP landings: the header chip bumps each time it changes. */
  bump: number
  landed: () => void
  promotion: Promotion | null
  promote: (promotion: Promotion) => void
  clearPromotion: () => void
}

let nextId = 1

export const useTrainingStore = create<TrainingState>((set, get) => ({
  courseColor: null,
  showCourse: (color) => set({ courseColor: color }),
  session: null,
  startSession: (session) => set({ session: { ...session, index: 0 } }),
  advanceSession: () => {
    const session = get().session
    if (!session) return
    if (session.index >= session.lineIds.length - 1) set({ session: null })
    else set({ session: { ...session, index: session.index + 1 } })
  },
  switchMode: (mode) => {
    const session = get().session
    if (session) set({ session: { ...session, mode } })
  },
  endSession: () => set({ session: null }),
  celebrations: [],
  celebrate: (celebration) => {
    play(celebration.kind === 'xp' ? 'xp' : 'reward')
    set((state) => ({
      // A handful at most: a burst of rewards should read as one moment.
      celebrations: [...state.celebrations, { ...celebration, id: nextId++ }].slice(-4),
    }))
  },
  dismiss: (id) =>
    set((state) => ({ celebrations: state.celebrations.filter((item) => item.id !== id) })),
  bump: 0,
  landed: () => set((state) => ({ bump: state.bump + 1 })),
  promotion: null,
  promote: (promotion) => {
    play('promotion')
    set({ promotion })
  },
  clearPromotion: () => set({ promotion: null }),
  unlocked: (achievement) =>
    get().celebrate({
      kind: 'achievement',
      title: `Achievement: ${achievement.title}`,
      detail: achievement.description,
      visual: { kind: 'badge', key: achievement.key },
    }),
}))
