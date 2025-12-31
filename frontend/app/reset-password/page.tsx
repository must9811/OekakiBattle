"use client"
import { useEffect, useState, FormEvent } from "react"
import { supabase } from "@/lib/supabaseClient"

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [password, setPassword] = useState("")
  const [passwordConfirm, setPasswordConfirm] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true
    const checkSession = async () => {
      const { data } = await supabase.auth.getSession()
      if (!mounted) return
      if (data.session?.user) {
        setReady(true)
      } else {
        setInvalid(true)
      }
    }
    checkSession()
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return
      if (event === "PASSWORD_RECOVERY" || session?.user) {
        setReady(true)
        setInvalid(false)
      }
    })
    return () => {
      mounted = false
      listener?.subscription?.unsubscribe()
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(undefined)
    const passwordOk = /^[A-Za-z0-9]{8,50}$/.test(password)
    if (!password || !passwordConfirm) {
      setError("パスワードを入力してください。")
      return
    }
    if (!passwordOk) {
      setError("パスワードは8〜50文字の英数字で入力してください。")
      return
    }
    if (password !== passwordConfirm) {
      setError("パスワードが一致しません。")
      return
    }
    setLoading(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError("パスワードの更新に失敗しました。もう一度お試しください。")
        return
      }
      setSuccess(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="homeBg">
      <main className="container grid" style={{ gap: 16 }}>
        <h1 className="title">パスワード再設定</h1>
        {invalid && <p className="subtitle">再設定リンクが無効です。もう一度やり直してください。</p>}
        {ready && !success && (
          <div className="card" style={{ maxWidth: 520 }}>
            <form onSubmit={onSubmit} className="grid" style={{ gap: 10 }}>
              <label className="label">
                <div className="labelHead">
                  <span>新しいパスワード</span>
                  <span className="helpIcon" data-tip="8〜50文字の英数字のみ使用できます。">？</span>
                </div>
                <input
                  className={`input${error ? " invalid" : ""}`}
                  type="password"
                  value={password}
                  minLength={8}
                  maxLength={50}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label className="label">
                <span>パスワード再入力</span>
                <input
                  className={`input${error ? " invalid" : ""}`}
                  type="password"
                  value={passwordConfirm}
                  minLength={8}
                  maxLength={50}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                />
              </label>
              <div className="row">
                <button className="button" type="submit" disabled={loading}>
                  {loading ? "更新中…" : "パスワードを更新"}
                </button>
                {error && <span className="fieldError">{error}</span>}
              </div>
            </form>
          </div>
        )}
        {success && (
          <div className="card" style={{ maxWidth: 520 }}>
            <p className="subtitle">パスワードを更新しました。ログイン画面へ戻ってください。</p>
            <a className="button ghost" href="/">トップへ戻る</a>
          </div>
        )}
      </main>
    </div>
  )
}
