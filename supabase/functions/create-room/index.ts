// Supabase Edge Function: create-room
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const { name, password, username, maxPlayers, roundsTotal, roundTimeSec } = await req.json()
    if (!name || !password || !username) {
      return new Response(JSON.stringify({ error: 'missing_params' }), { status: 400, headers: corsHeaders })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!
    const client = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } }
    })

    const { data, error } = await client.rpc('create_room', {
      p_name: name,
      p_password: password,
      p_username: username,
      p_max: maxPlayers ?? 10,
      p_rounds: roundsTotal ?? 3,
      p_time: roundTimeSec ?? 60
    })

    if (error) {
      const msg = String(error.message || '')
      const isDup = msg.includes('rooms_name_key') || msg.includes('duplicate key') || msg.includes('room_name_taken')
      const body = { error: isDup ? 'room_name_taken' : msg }
      const status = isDup ? 409 : 400
      return new Response(JSON.stringify(body), { status, headers: corsHeaders })
    }

    const room = Array.isArray(data) ? (data[0] ?? null) : (data ?? null)
    return new Response(JSON.stringify(room ? { room } : {}), {
      headers: { ...corsHeaders, 'content-type': 'application/json' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: 'bad_request', detail: String(e) }), { status: 400, headers: corsHeaders })
  }
})