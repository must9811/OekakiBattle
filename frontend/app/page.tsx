"use client"
import { FormEvent, useMemo, useState } from "react"
import { supabase } from "@/lib/supabaseClient"
import { useAnonAuth } from "@/lib/useAnonAuth"

type FieldErrors = { name?: string; password?: string; username?: string }

export default function HomePage() {
  const ready = useAnonAuth()
  const [mode, setMode] = useState<"none" | "create" | "join">("none")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [username, setUsername] = useState("")
  const [rounds, setRounds] = useState(3)
  const [roundTime, setRoundTime] = useState(60)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [errors, setErrors] = useState<FieldErrors>({})

  const trimmed = useMemo(() => ({
    name: name.trim(),
    password: password.trim(),
    username: username.trim(),
  }), [name, password, username])

  function validateInputs(kind: "create" | "join"): FieldErrors {
    const e: FieldErrors = {}
    if (!trimmed.name) {
      e.name = "部屋名を入力してください。"
    } else if (trimmed.name.length < 2 || trimmed.name.length > 24) {
      e.name = "部屋名は2〜24文字で入力してください。"
    }
    if (!trimmed.password) {
      e.password = "パスワードを入力してください。"
    } else if (trimmed.password.length < 4 || trimmed.password.length > 16) {
      e.password = "パスワードは4〜16文字で入力してください。"
    }
    if (!trimmed.username) {
      e.username = "ユーザー名を入力してください。"
    } else if (trimmed.username.length > 16) {
      e.username = "ユーザー名は1〜16文字で入力してください。"
    }
    return e
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    const kind = mode === "create" ? "create" : "join"
    const efs = validateInputs(kind)
    setErrors(efs)
    if (Object.keys(efs).length > 0) return

    setLoading(true)
    try {
      const session = (await supabase.auth.getSession()).data.session
      if (!session?.access_token) throw new Error("auth not ready")
      const token = session.access_token

      const getCode = async (fnError: any, fnData: any): Promise<string | undefined> => {
        const known = ['room_name_taken','room_not_found','invalid_password','room_full','duplicate_username','room_not_joinable','forbidden','missing_params','bad_request'] as const
        const bodyErr = (fnData && typeof (fnData as any).error === 'string') ? (fnData as any).error : undefined
        if (bodyErr) return bodyErr
        const ctx = (fnError as any)?.context as any
        if (ctx && typeof ctx === 'object' && typeof ctx.text === 'function') {
          try {
            const res: Response = ctx
            const clone = res.clone()
            let parsed: any = undefined
            try { parsed = await clone.json() } catch {}
            if (parsed && typeof parsed.error === 'string') return parsed.error
            const raw = await res.text()
            if (raw) {
              if (raw.includes('uq_room_user') || raw.includes('unique constraint "uq_room_user"') || raw.includes('duplicate key')) return 'duplicate_username'
              for (const k of known) { if (raw.includes(k)) return k }
              try { const j = JSON.parse(raw); if (j?.error) return j.error } catch {}
            }
          } catch {}
        }
        const msg = typeof fnError?.message === 'string' ? fnError.message : ''
        if (msg.includes('uq_room_user') || msg.includes('unique constraint "uq_room_user"') || msg.includes('duplicate key')) return 'duplicate_username'
        for (const k of known) { if (msg.includes(k)) return k }
        try { const parsed = JSON.parse(msg); if (parsed && typeof parsed.error === 'string') return parsed.error } catch {}
        return undefined
      }
      const friendlyCreate = (code?: string) => {
        switch (code) {
          case "room_name_taken":
            return "その部屋名は既に使われています。別の名前にしてください。"
          default:
            return "部屋の作成に失敗しました。通信状況を確認して、しばらくしてから再試行してください。"
        }
      }
      const friendlyJoin = (code?: string) => {
        switch (code) {
          case "room_not_found":
            return "部屋が見つかりません。部屋名を確認してください。"
          case "invalid_password":
            return "パスワードが違います。もう一度入力してください。"
          case "room_full":
            return "この部屋は満員です。別の部屋をお試しください。"
          case "duplicate_username":
            return "そのユーザー名は既に使われています。別の名前にしてください。"
          case "forbidden":
            return "操作が許可されていません。ページを更新してから再度お試しください。"
          default:
            return "入室に失敗しました。部屋名・パスワード・定員をご確認のうえ、再試行してください。"
        }
      }

      if (mode === "create") {
        const { data, error } = await supabase.functions.invoke("create-room", {
          body: { name: trimmed.name, password: trimmed.password, username: trimmed.username, roundsTotal: rounds, roundTimeSec: roundTime },
          headers: { Authorization: `Bearer ${token}` },
        })
        if (error) {
          const code = await getCode(error, data)
          console.log('[create-room] error', { code, data, error })
          setError(friendlyCreate(code))
          return
        }
        if (!data?.room?.room_id) { setError("部屋の作成に失敗しました。もう一度お試しください。"); return }
      } else if (mode === "join") {
        const { data, error } = await supabase.functions.invoke("join-room", {
          body: { name: trimmed.name, password: trimmed.password, username: trimmed.username },
          headers: { Authorization: `Bearer ${token}` },
        })
        if (error) {
          const code = await getCode(error, data)
          console.log('[join-room] error', { code, data, error })
          setError(friendlyJoin(code))
          return
        }
      }
      window.location.href = `/room/${encodeURIComponent(trimmed.name)}`
    } catch (e: any) {
      // ネットワーク等の想定外エラー
      setError("通信エラーが発生しました。ネットワークを確認して再度お試しください。")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="homeBg">
      <div className="doodles" aria-hidden>
        <span className="doodle" style={{ top:'12%', left:'8%', ...( { ['--size']: '44px', ['--rot']: '-12deg', ['--float']: '13s' } as any) }}>✏️</span>
        <span className="doodle" style={{ top:'18%', left:'78%', ...( { ['--size']: '56px', ['--rot']: '8deg', ['--float']: '18s' } as any) }}>🖌️</span>
        <span className="doodle" style={{ top:'32%', left:'20%', ...( { ['--size']: '52px', ['--rot']: '0deg', ['--float']: '16s' } as any) }}>🎨</span>
        <span className="doodle" style={{ top:'28%', left:'60%', ...( { ['--size']: '42px', ['--rot']: '15deg', ['--float']: '15s' } as any) }}>📏</span>
        <span className="doodle" style={{ top:'40%', left:'86%', ...( { ['--size']: '50px', ['--rot']: '-5deg', ['--float']: '19s' } as any) }}>✂️</span>
        <span className="doodle" style={{ top:'58%', left:'12%', ...( { ['--size']: '52px', ['--rot']: '6deg', ['--float']: '17s' } as any) }}>🧽</span>
        <span className="doodle" style={{ top:'66%', left:'35%', ...( { ['--size']: '54px', ['--rot']: '-10deg', ['--float']: '20s' } as any) }}>🐱</span>
        <span className="doodle" style={{ top:'70%', left:'72%', ...( { ['--size']: '46px', ['--rot']: '12deg', ['--float']: '14s' } as any) }}>🐶</span>
        <span className="doodle" style={{ top:'78%', left:'52%', ...( { ['--size']: '48px', ['--rot']: '0deg', ['--float']: '22s' } as any) }}>🐟</span>
        <span className="doodle" style={{ top:'84%', left:'18%', ...( { ['--size']: '44px', ['--rot']: '8deg', ['--float']: '21s' } as any) }}>🐤</span>
        <span className="doodle" style={{ top:'22%', left:'44%', ...( { ['--size']: '40px', ['--rot']: '-18deg', ['--float']: '12s' } as any) }}>⭐️</span>
        <span className="doodle" style={{ top:'50%', left:'90%', ...( { ['--size']: '40px', ['--rot']: '18deg', ['--float']: '12s' } as any) }}>⭐️</span>
        {/* more icons: tools/animals to enrich the theme */}
        <span className="doodle" style={{ top:'10%', left:'40%', ...( { ['--size']: '42px', ['--rot']: '-6deg', ['--float']: '16s' } as any) }}>🖍️</span>
        <span className="doodle" style={{ top:'16%', left:'24%', ...( { ['--size']: '38px', ['--rot']: '10deg', ['--float']: '15s' } as any) }}>🖊️</span>
        <span className="doodle" style={{ top:'34%', left:'74%', ...( { ['--size']: '40px', ['--rot']: '-14deg', ['--float']: '19s' } as any) }}>✒️</span>
        <span className="doodle" style={{ top:'62%', left:'84%', ...( { ['--size']: '48px', ['--rot']: '4deg', ['--float']: '18s' } as any) }}>📐</span>
        <span className="doodle" style={{ top:'76%', left:'8%', ...( { ['--size']: '40px', ['--rot']: '-8deg', ['--float']: '20s' } as any) }}>🧮</span>
        <span className="doodle" style={{ top:'86%', left:'66%', ...( { ['--size']: '44px', ['--rot']: '6deg', ['--float']: '17s' } as any) }}>🦊</span>
        <span className="doodle" style={{ top:'26%', left:'6%', ...( { ['--size']: '44px', ['--rot']: '0deg', ['--float']: '21s' } as any) }}>🐼</span>
        <span className="doodle" style={{ top:'56%', left:'48%', ...( { ['--size']: '36px', ['--rot']: '0deg', ['--float']: '14s' } as any) }}>🦉</span>
        <span className="doodle" style={{ top:'44%', left:'30%', ...( { ['--size']: '36px', ['--rot']: '0deg', ['--float']: '13s' } as any) }}>🦀</span>
      </div>
      <main className="container grid" style={{ gap: 16 }}>
      <h1 className="title">オンラインお絵描きあてバトル</h1>
      {!ready && <p className="subtitle">サインイン準備中…</p>}
      {ready && (
        <>
          {mode === "none" && (
            <div className="row" style={{ gap: 12 }}>
              <button className="button" onClick={() => setMode("create")}>部屋を作成する</button>
              <button className="button" onClick={() => setMode("join")}>部屋に入室する</button>
            </div>
          )}

          {mode !== "none" && (
            <div className="card" style={{ maxWidth: 520 }}>
              <div className="panelHeader">
                <strong>{mode === "create" ? "部屋を作成" : "部屋に入室"}</strong>
                <button className="button ghost" onClick={() => setMode("none")}>戻る</button>
              </div>
              <form onSubmit={onSubmit} className="grid" style={{ gap: 10, marginTop: 12 }}>
                <label className="label">
                  <div className="labelHead">
                    <span>部屋名</span>
                    <span className="helpIcon" title="2〜24文字。半角/全角どちらも可。同名の部屋は作成できません。">？</span>
                  </div>
                  <input className={`input${errors.name ? " invalid" : ""}`} value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors(v=>({ ...v, name: undefined })) }} required minLength={2} maxLength={24} />
                  {errors.name && <span className="fieldError">{errors.name}</span>}
                </label>
                <label className="label">
                  <div className="labelHead">
                    <span>パスワード</span>
                    <span className="helpIcon" title="4〜16文字。部屋の鍵として使用します。">？</span>
                  </div>
                  <input className={`input${errors.password ? " invalid" : ""}`} value={password} onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors(v=>({ ...v, password: undefined })) }} required minLength={4} maxLength={16} type="password" />
                  {errors.password && <span className="fieldError">{errors.password}</span>}
                </label>
                <label className="label">
                  <div className="labelHead">
                    <span>ユーザー名</span>
                    <span className="helpIcon" title="1〜16文字。ルーム内で一意である必要があります。">？</span>
                  </div>
                  <input className={`input${errors.username ? " invalid" : ""}`} value={username} onChange={(e) => { setUsername(e.target.value); if (errors.username) setErrors(v=>({ ...v, username: undefined })) }} required minLength={1} maxLength={16} />
                  {errors.username && <span className="fieldError">{errors.username}</span>}
                </label>
                {mode === "create" && (
                  <div className="row">
                    <label className="label">ラウンド数
                      <input className="input" type="number" min={1} max={20} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
                    </label>
                    <label className="label">制限時間（分）
                      <select className="input" value={roundTime} onChange={(e) => setRoundTime(Number(e.target.value))}>
                        <option value={60}>1分</option>
                        <option value={120}>2分</option>
                        <option value={180}>3分</option>
                        <option value={240}>4分</option>
                        <option value={300}>5分</option>
                      </select>
                    </label>
                  </div>
                )}
                <div className="row">
                  <button className="button" type="submit" disabled={loading}>{loading ? "送信中…" : (mode === "create" ? "作成して入室" : "入室する")}</button>
                  {error && <span style={{ color: "#ff6b6b" }}>{error}</span>}
                </div>
              </form>
            </div>
          )}

          <section className="card">
            <h3>遊び方・ルール</h3>
            <ul>
              <li>参加者は「部屋を作成」または「部屋に入室」します。入室する際は、部屋名・パスワード・ニックネームを入力します。</li>
              <li>部屋を作成した人が<strong>ホスト</strong>、入室した人が<strong>ゲスト</strong>になります。ホストは部屋作成時に<strong>ラウンド数</strong>（1人の出題者に対して回答者が制限時間内に答える一連の流れ）や<strong>制限時間</strong>を設定し、ゲームを開始できます。</li>
              <li>ゲームが始まると、1人が<strong>出題者</strong>となり、他の参加者は<strong>回答者</strong>になります。出題者はお題に沿って絵を描きます。</li>
              <li>回答者は出題者の描く絵を見て、制限時間内にお題が何かをテキストで回答します。正解すると全員に通知され、5秒後に次のラウンドが始まります。</li>
              <li>出題者は毎回ランダムに決まりますが、全員が一度出題者を経験するまでは同じ人が再度出題者になることはありません。</li>
              <li>誰かが正解すると、<strong>正解者に5点</strong>、<strong>出題者に3点</strong>が入ります。制限時間内に正解者がいない場合は、誰にも点数は入りません。</li>
              <li>描画は全員に<strong>リアルタイムで同期</strong>されます。ペンや消しゴムの使用、線の太さや色の変更も可能です。</li>
              <li>全ラウンド終了時に最も得点の高い参加者が<strong>優勝</strong>です。同点の場合は複数人が優勝となります。</li>
              <li>1部屋につき最小2人、最大20人まで遊べます。</li>
            </ul>

          </section>
        </>
      )}
    </main>
    </div>
  )
}
