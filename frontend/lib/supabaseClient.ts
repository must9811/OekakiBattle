'use client'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

export const supabase = createClient(env.supabaseUrl, env.supabaseAnon, {
  auth: { persistSession: true, autoRefreshToken: true },
})
