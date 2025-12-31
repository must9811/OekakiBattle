// Supabase Edge Function: sign-up
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' }
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'bad_request' }, 400)

  try {
    const { email, username, password } = await req.json()
    if (!email || !username || !password) {
      return jsonResponse({ error: 'missing_params' }, 400)
    }
    const trimmedUsername = String(username).trim()
    if (trimmedUsername.length < 1 || trimmedUsername.length > 20) {
      return jsonResponse({ error: 'invalid_username' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    const { data: existingProfile, error: lookupError } = await admin
      .from('profiles')
      .select('user_id')
      .eq('username', trimmedUsername)
      .maybeSingle()
    if (lookupError) return jsonResponse({ error: 'lookup_failed' }, 400)
    if (existingProfile?.user_id) return jsonResponse({ error: 'duplicate_username' }, 409)

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: String(email),
      password: String(password),
      email_confirm: true
    })
    if (createError) {
      const msg = (createError.message || '').toLowerCase()
      if (msg.includes('email') && (msg.includes('invalid') || msg.includes('format'))) {
        return jsonResponse({ error: 'invalid_email' }, 400)
      }
      if (msg.includes('password') || msg.includes('weak')) {
        return jsonResponse({ error: 'weak_password' }, 400)
      }
      if (msg.includes('registered') || msg.includes('exists')) {
        return jsonResponse({ error: 'email_taken' }, 409)
      }
      return jsonResponse({ error: 'signup_failed' }, 400)
    }

    const userId = created.user?.id
    if (!userId) return jsonResponse({ error: 'signup_failed' }, 400)

    const { error: profileError } = await admin.from('profiles').insert({
      user_id: userId,
      username: trimmedUsername
    })
    if (profileError) {
      await admin.auth.admin.deleteUser(userId)
      const msg = String(profileError.message || '')
      const dup = profileError.code === '23505' || msg.includes('duplicate') || msg.includes('unique')
      return jsonResponse({ error: dup ? 'duplicate_username' : 'profile_failed' }, dup ? 409 : 400)
    }

    return jsonResponse({ user_id: userId })
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: String(e) }, 400)
  }
})
