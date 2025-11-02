'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export function useAnonAuth() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string|undefined>()

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        let { data: { session } } = await supabase.auth.getSession()
        if (!session) {
          const { data, error } = await supabase.auth.signInAnonymously()
          if (error) throw error
          // ensure session available after sign-in
          session = data.session ?? (await supabase.auth.getSession()).data.session ?? null
        }
        if (!session) throw new Error('anonymous auth failed')
        if (mounted) setReady(true)
      } catch (e:any) {
        if (mounted) setError(e.message || 'auth error')
      }
    })()
    return () => { mounted = false }
  }, [])

  return ready
}
