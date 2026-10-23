import { useCallback } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { browserTimeZone, readDailyGoal } from '@/lib/training/progress'
import { newQuestRewards } from '@/lib/training/quests'
import type { Repertoire, TrainingProfile, TrainingReward } from '@/lib/training/types'
import { useTrainingStore } from '@/store/training-store'

export function profileQueryKey(username: string | null) {
  return ['training-profile', username] as const
}

/**
 * Queries that read the player's training state, besides the profile: what
 * is due, what to learn next, the week's XP, the drill themes, the checks.
 * Each key starts with its name and then the username.
 */
const TRAINING_QUERY_NAMES = new Set([
  'training-repertoire',
  'repertoire-check',
  'training-challenges',
  'improvement-plan',
  'week-scoresheet',
])

/**
 * Mark every training query for the player stale, so whatever is on screen
 * refetches now and any page opened next reads the state after the action,
 * never a recommendation that was just acted on. The profile itself arrives
 * with the reward and is set directly.
 */
export function refreshTrainingQueries(queryClient: QueryClient, username: string | null) {
  if (!username) return
  void queryClient.invalidateQueries({
    predicate: (query) =>
      TRAINING_QUERY_NAMES.has(String(query.queryKey[0])) && query.queryKey[1] === username,
  })
}

export function useTrainingProfile(username: string | null) {
  return useQuery({
    enabled: Boolean(username),
    queryKey: profileQueryKey(username),
    queryFn: async ({ signal }) =>
      (
        await api.get<TrainingProfile>('/api/training/profile', {
          params: { username, tz: browserTimeZone(), goal: readDailyGoal() },
          signal,
        })
      ).data,
    staleTime: 60 * 1000,
  })
}

export function repertoireQueryKey(username: string, color: 'white' | 'black') {
  return ['training-repertoire', username, color] as const
}

export function useRepertoire(username: string, color: 'white' | 'black', enabled = true) {
  return useQuery({
    enabled: enabled && Boolean(username),
    queryKey: repertoireQueryKey(username, color),
    queryFn: async ({ signal }) =>
      (
        await api.get<Repertoire>('/api/training/repertoire', {
          params: { username, color },
          signal,
        })
      ).data,
    staleTime: 5 * 60 * 1000,
  })
}

/** What changed between two profiles: the moments worth celebrating. */
export function diffProfiles(
  previous: TrainingProfile | undefined,
  next: TrainingProfile,
): Pick<TrainingReward, 'leveled_up' | 'goal_just_met' | 'unlocked'> {
  if (!previous) return {}
  const before = new Set(previous.achievements.filter((a) => a.unlocked_at).map((a) => a.key))
  return {
    leveled_up: next.level > previous.level,
    goal_just_met: next.goal_met_today && !previous.goal_met_today,
    unlocked: next.achievements.filter((a) => a.unlocked_at && !before.has(a.key)),
  }
}

/**
 * Apply what an XP-earning write returned: the new profile, and the moments
 * worth celebrating — the XP itself, a level, a met goal, a badge.
 */
export function useApplyReward(username: string | null) {
  const queryClient = useQueryClient()
  const celebrate = useTrainingStore((state) => state.celebrate)
  const unlocked = useTrainingStore((state) => state.unlocked)
  const promote = useTrainingStore((state) => state.promote)
  return useCallback(
    async (given: TrainingReward | null | undefined, label?: string) => {
      if (!given) return
      let reward = given
      const previous = queryClient.getQueryData<TrainingProfile>(profileQueryKey(username))
      if (!reward.profile && reward.xp_gained > 0 && username) {
        // Rewards recorded elsewhere (a drill answer) come without the new
        // profile: fetch it and diff it against what is on screen.
        try {
          const next = (
            await api.get<TrainingProfile>('/api/training/profile', {
              params: { username, tz: browserTimeZone(), goal: readDailyGoal() },
            })
          ).data
          reward = { ...reward, profile: next, ...diffProfiles(previous, next) }
        } catch {
          // The XP is recorded either way; only the celebration is lost.
        }
      }
      if (reward.profile) queryClient.setQueryData(profileQueryKey(username), reward.profile)
      // Anything the action changed beyond the profile: due moves, the next
      // fix, the drill themes, this week's XP.
      refreshTrainingQueries(queryClient, username)
      if (reward.xp_gained > 0) {
        celebrate({ kind: 'xp', title: `+${reward.xp_gained} XP`, detail: label })
      }
      if (reward.goal_just_met && reward.profile) {
        celebrate({
          kind: 'goal',
          title: 'Daily goal met',
          detail:
            reward.profile.streak > 1
              ? `${reward.profile.streak}-day streak`
              : 'Your streak starts today',
          visual: { kind: 'icon', name: 'flame' },
        })
      }
      if (reward.leveled_up && reward.profile) {
        const { level, title } = reward.profile
        if (previous && previous.title !== title) {
          // A new title is a promotion, like a pawn reaching the last rank: its own moment.
          promote({ from: previous.title, to: title, level })
        } else {
          celebrate({
            kind: 'level',
            title: `Level ${level}`,
            detail: `${(reward.profile.next_level_xp - reward.profile.xp).toLocaleString()} XP to level ${level + 1}`,
            visual: { kind: 'crest', title, level },
          })
        }
      }
      if (reward.profile?.quests) {
        const paid = newQuestRewards(previous?.quests, reward.profile.quests)
        for (const quest of paid.quests) {
          celebrate({
            kind: 'quest',
            title: 'Quest complete',
            detail: `${quest.title} · +${quest.xp} XP`,
            visual: { kind: 'icon', name: 'scroll' },
          })
        }
        if (paid.chest) {
          celebrate({
            kind: 'quest',
            title: 'All three quests done',
            detail: `Chest opened · +${reward.profile.quests.chest_xp} XP`,
            visual: { kind: 'icon', name: 'chest' },
          })
        }
      }
      for (const achievement of reward.unlocked ?? []) {
        unlocked(achievement)
      }
    },
    [celebrate, promote, queryClient, unlocked, username],
  )
}

/** Report training the server did not see: a quiz answer, a finished game review. */
export async function postTrainingEvent(
  username: string,
  kind: 'quiz_correct' | 'quiz_answer' | 'game_reviewed' | 'retry_found' | 'retry_missed',
  requestId: string,
  detail?: Record<string, unknown>,
): Promise<TrainingReward | null> {
  try {
    return (
      await api.post<TrainingReward>('/api/training/events', {
        username,
        kind,
        request_id: requestId,
        detail,
        tz: browserTimeZone(),
        goal: readDailyGoal(),
      })
    ).data
  } catch {
    // XP is a bonus on top of the training; losing one must never break it.
    return null
  }
}
