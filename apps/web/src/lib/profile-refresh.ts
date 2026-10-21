import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toStaffUser, useSession, type ProfileJson } from '@/store/session'

/**
 * Keeps an open tab in step with the employee's profile: a new role, desk or dashboard set by
 * the manager reaches the menu, the home page and the queues within a minute; a deactivated
 * account is signed out at once instead of leaving a blank page.
 */
export function useProfileRefresh() {
  const user = useSession((s) => s.user)
  const { data, error } = useQuery({
    queryKey: ['session-profile', user?.id ?? ''],
    enabled: !!supabase && !!user,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: async (): Promise<ProfileJson> => {
      const { data, error } = await supabase!.rpc('my_session_profile')
      if (error) throw new Error(error.message)
      return data as ProfileJson
    },
  })
  useEffect(() => {
    if (!data || !user || data.id !== user.id) return
    const next = toStaffUser(data)
    const changed = (
      [
        'role',
        'station',
        'dashboard',
        'headOf',
        'mustChangePin',
        'email',
        'name',
        'dbRole',
      ] as const
    ).some((k) => (next[k] ?? null) !== (user[k] ?? null))
    if (changed) useSession.setState({ user: { ...user, ...next } })
  }, [data, user])
  useEffect(() => {
    if (error && /deactivated/i.test(error.message)) {
      void useSession
        .getState()
        .signOut()
        .then(() => window.location.replace('/#signin'))
    }
  }, [error])
}
