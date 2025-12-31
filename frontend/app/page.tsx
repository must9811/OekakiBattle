"use client"
import { supabase } from "@/lib/supabaseClient"
import { useAnonAuth } from "@/lib/useAnonAuth"
import { User } from "@supabase/supabase-js"
import { FormEvent, useEffect, useMemo, useState } from "react"

type FieldErrors = { name?: string; password?: string; username?: string }

export default function HomePage() {
  const ready = useAnonAuth()
  const [mode, setMode] = useState<"none" | "create" | "join">("none")
  const [loginMode, setLoginMode] = useState<"none" | "login" | "signup" | "reset">("none")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [username, setUsername] = useState("")
  const [loginUsername, setLoginUsername] = useState("")
  const [loginPassword, setLoginPassword] = useState("")
  const [resetUsername, setResetUsername] = useState("")
  const [signupEmail, setSignupEmail] = useState("")
  const [signupUsername, setSignupUsername] = useState("")
  const [signupPassword, setSignupPassword] = useState("")
  const [signupPasswordConfirm, setSignupPasswordConfirm] = useState("")
  const [settingsUsername, setSettingsUsername] = useState("")
  const [settingsPassword, setSettingsPassword] = useState("")
  const [settingsPasswordConfirm, setSettingsPasswordConfirm] = useState("")
  const [rounds, setRounds] = useState(3)
  const [roundTime, setRoundTime] = useState(60)
  const [loading, setLoading] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [errors, setErrors] = useState<FieldErrors>({})
  const [loginError, setLoginError] = useState<string | undefined>()
  const [resetErrors, setResetErrors] = useState<{
    username?: string
    form?: string
  }>({})
  const [resetSuccess, setResetSuccess] = useState<string | undefined>()
  const [signupErrors, setSignupErrors] = useState<{
    email?: string
    username?: string
    password?: string
    passwordConfirm?: string
    form?: string
  }>({})
  const [settingsErrors, setSettingsErrors] = useState<{
    username?: string
    password?: string
    passwordConfirm?: string
    form?: string
  }>({})
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [profileName, setProfileName] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const { data } = await supabase.auth.getUser()
      if (!mounted) return
      setAuthUser(data.user ?? null)
      if (data.user && !data.user.is_anonymous) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("username")
          .eq("user_id", data.user.id)
          .maybeSingle()
        if (mounted) {
          setProfileName(profile?.username ?? null)
          setSettingsUsername(profile?.username ?? "")
        }
      } else if (mounted) {
        setProfileName(null)
      }
    }
    load()
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null
      setAuthUser(user)
      if (!user || user.is_anonymous) {
        setProfileName(null)
        return
      }
      supabase
        .from("profiles")
        .select("username")
        .eq("user_id", user.id)
        .maybeSingle()
        .then(({ data }) => {
          if (mounted) {
            setProfileName(data?.username ?? null)
            setSettingsUsername(data?.username ?? "")
          }
        })
    })
    return () => {
      mounted = false
      listener?.subscription?.unsubscribe()
    }
  }, [])

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
        const known = ['room_name_taken', 'room_not_found', 'invalid_password', 'room_full', 'duplicate_username', 'room_not_joinable', 'forbidden', 'missing_params', 'bad_request'] as const
        const bodyErr = (fnData && typeof (fnData as any).error === 'string') ? (fnData as any).error : undefined
        if (bodyErr) return bodyErr
        const ctx = (fnError as any)?.context as any
        if (ctx && typeof ctx === 'object' && typeof ctx.text === 'function') {
          try {
            const res: Response = ctx
            const clone = res.clone()
            let parsed: any = undefined
            try { parsed = await clone.json() } catch { }
            if (parsed && typeof parsed.error === 'string') return parsed.error
            const raw = await res.text()
            if (raw) {
              if (raw.includes('uq_room_user') || raw.includes('unique constraint "uq_room_user"') || raw.includes('duplicate key')) return 'duplicate_username'
              for (const k of known) { if (raw.includes(k)) return k }
              try { const j = JSON.parse(raw); if (j?.error) return j.error } catch { }
            }
          } catch { }
        }
        const msg = typeof fnError?.message === 'string' ? fnError.message : ''
        if (msg.includes('uq_room_user') || msg.includes('unique constraint "uq_room_user"') || msg.includes('duplicate key')) return 'duplicate_username'
        for (const k of known) { if (msg.includes(k)) return k }
        try { const parsed = JSON.parse(msg); if (parsed && typeof parsed.error === 'string') return parsed.error } catch { }
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

  async function onLoginSubmit(e: FormEvent) {
    e.preventDefault()
    setLoginError(undefined)
    const trimmedUsername = loginUsername.trim()
    if (!trimmedUsername || !loginPassword) {
      setLoginError("ユーザー名とパスワードを入力してください。")
      return
    }
    setAuthLoading(true)
    try {
      const { data, error: lookupError } = await supabase.rpc("get_login_email", {
        p_username: trimmedUsername,
      })
      if (lookupError) throw lookupError
      const email = typeof data === "string" ? data : null
      if (!email) {
        setLoginError("ユーザー名またはパスワードが違います。")
        return
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: loginPassword,
      })
      if (signInError) {
        setLoginError("ユーザー名またはパスワードが違います。")
        return
      }
      setLoginMode("none")
      setLoginUsername("")
      setLoginPassword("")
    } catch (e: any) {
      setLoginError("ログインに失敗しました。時間をおいて再試行してください。")
    } finally {
      setAuthLoading(false)
    }
  }

  async function onResetSubmit(e: FormEvent) {
    e.preventDefault()
    setResetErrors({})
    setResetSuccess(undefined)
    const uname = resetUsername.trim()
    if (!uname) {
      setResetErrors({ username: "ユーザー名を入力してください。" })
      return
    }
    setAuthLoading(true)
    try {
      const { data, error: lookupError } = await supabase.rpc("get_login_email", {
        p_username: uname,
      })
      if (lookupError) {
        setResetErrors({ form: "パスワード再設定に失敗しました。時間をおいて再試行してください。" })
        return
      }
      const email = typeof data === "string" ? data : null
      if (!email) {
        setResetErrors({ username: "ユーザー名が見つかりません。" })
        return
      }
      const redirectTo = `${window.location.origin}/reset-password`
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
      if (resetError) {
        setResetErrors({ form: "パスワード再設定に失敗しました。時間をおいて再試行してください。" })
        return
      }
      setResetSuccess("パスワード再設定メールを送信しました。")
    } catch (e: any) {
      setResetErrors({ form: "パスワード再設定に失敗しました。時間をおいて再試行してください。" })
    } finally {
      setAuthLoading(false)
    }
  }

  async function onSignupSubmit(e: FormEvent) {
    e.preventDefault()
    setSignupErrors({})
    const email = signupEmail.trim()
    const uname = signupUsername.trim()
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    const passwordOk = /^[A-Za-z0-9]{8,50}$/.test(signupPassword)
    const nextErrors: typeof signupErrors = {}
    if (!email) nextErrors.email = "メールアドレスを入力してください。"
    if (!uname) nextErrors.username = "ユーザー名を入力してください。"
    if (!signupPassword) nextErrors.password = "パスワードを入力してください。"
    if (!signupPasswordConfirm) nextErrors.passwordConfirm = "パスワード再入力を入力してください。"
    if (email && !emailOk) nextErrors.email = "メールアドレスの形式が正しくありません。"
    if (uname && (uname.length < 1 || uname.length > 20)) nextErrors.username = "ユーザー名は1〜20文字で入力してください。"
    if (signupPassword && !passwordOk) nextErrors.password = "パスワードは8〜50文字の英数字で入力してください。"
    if (signupPassword && signupPasswordConfirm && signupPassword !== signupPasswordConfirm) {
      nextErrors.passwordConfirm = "パスワードが一致しません。"
    }
    if (Object.keys(nextErrors).length > 0) {
      setSignupErrors(nextErrors)
      return
    }
    setAuthLoading(true)
    try {
      const { data, error: signUpError } = await supabase.functions.invoke("sign-up", {
        body: { email, username: uname, password: signupPassword },
      })
      const getSignUpCode = async () => {
        if (typeof data?.error === "string") return data.error
        const ctx = (signUpError as any)?.context as any
        if (ctx && typeof ctx === "object" && typeof ctx.text === "function") {
          try {
            const res: Response = ctx
            const clone = res.clone()
            try {
              const parsed = await clone.json()
              if (typeof parsed?.error === "string") return parsed.error
            } catch {}
            const raw = await res.text()
            if (raw) {
              if (raw.includes("duplicate_username")) return "duplicate_username"
              if (raw.includes("email_taken")) return "email_taken"
              if (raw.includes("invalid_email")) return "invalid_email"
              if (raw.includes("weak_password")) return "weak_password"
            }
          } catch {}
        }
        const msg = signUpError?.message || ""
        if (msg.includes("duplicate_username")) return "duplicate_username"
        if (msg.includes("email_taken")) return "email_taken"
        if (msg.includes("invalid_email")) return "invalid_email"
        if (msg.includes("weak_password")) return "weak_password"
        return undefined
      }
      const code = await getSignUpCode()
      if (signUpError || code) {
        switch (code) {
          case "duplicate_username":
            setSignupErrors({ username: "そのユーザー名は既に使われています。" })
            return
          case "email_taken":
            setSignupErrors({ email: "そのメールアドレスは既に登録されています。" })
            return
          case "invalid_email":
            setSignupErrors({ email: "メールアドレスの形式が正しくありません。" })
            return
          case "weak_password":
            setSignupErrors({ password: "パスワードは8〜50文字の英数字で入力してください。" })
            return
          default:
            setSignupErrors({ form: "アカウント登録に失敗しました。時間をおいて再試行してください。" })
            return
        }
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: signupPassword,
      })
      if (signInError) {
        setSignupErrors({ form: "登録後のログインに失敗しました。ログイン画面からお試しください。" })
        return
      }
      setLoginMode("none")
      setSignupEmail("")
      setSignupUsername("")
      setSignupPassword("")
      setSignupPasswordConfirm("")
    } catch (e: any) {
      setSignupErrors({ form: "アカウント登録に失敗しました。時間をおいて再試行してください。" })
    } finally {
      setAuthLoading(false)
    }
  }

  async function onLogout() {
    setAuthLoading(true)
    try {
      await supabase.auth.signOut()
      await supabase.auth.signInAnonymously()
    } finally {
      setAuthLoading(false)
    }
  }

  async function onSettingsSubmit(e: FormEvent) {
    e.preventDefault()
    setSettingsErrors({})
    const uname = settingsUsername.trim()
    const passwordOk = settingsPassword ? /^[A-Za-z0-9]{8,50}$/.test(settingsPassword) : true
    const nextErrors: typeof settingsErrors = {}
    if (uname.length < 1 || uname.length > 20) nextErrors.username = "ユーザー名は1〜20文字で入力してください。"
    if (settingsPassword && !passwordOk) nextErrors.password = "パスワードは8〜50文字の英数字で入力してください。"
    if (settingsPassword && settingsPasswordConfirm && settingsPassword !== settingsPasswordConfirm) {
      nextErrors.passwordConfirm = "パスワードが一致しません。"
    }
    if (settingsPassword && !settingsPasswordConfirm) nextErrors.passwordConfirm = "パスワード再入力を入力してください。"
    if (Object.keys(nextErrors).length > 0) {
      setSettingsErrors(nextErrors)
      return
    }
    setAuthLoading(true)
    try {
      if (authUser && uname && uname !== profileName) {
        const { error: updateProfileError } = await supabase
          .from("profiles")
          .update({ username: uname })
          .eq("user_id", authUser.id)
        if (updateProfileError) {
          const msg = String(updateProfileError.message || "")
          const dup = updateProfileError.code === "23505" || msg.includes("duplicate") || msg.includes("unique")
          setSettingsErrors({ username: dup ? "そのユーザー名は既に使われています。" : "ユーザー名の更新に失敗しました。" })
          return
        }
        setProfileName(uname)
      }
      if (settingsPassword) {
        const { error: updatePasswordError } = await supabase.auth.updateUser({
          password: settingsPassword,
        })
        if (updatePasswordError) {
          setSettingsErrors({ password: "パスワードの更新に失敗しました。" })
          return
        }
      }
      setSettingsPassword("")
      setSettingsPasswordConfirm("")
      setSettingsOpen(false)
    } catch (e: any) {
      setSettingsErrors({ form: "設定の更新に失敗しました。時間をおいて再試行してください。" })
    } finally {
      setAuthLoading(false)
    }
  }

  const isLoggedIn = !!authUser && !authUser.is_anonymous

  return (
    <div className="homeBg">
      <div className="doodles" aria-hidden>
        <span className="doodle" style={{ top: '12%', left: '8%', ...({ ['--size']: '44px', ['--rot']: '-12deg', ['--float']: '13s' } as any) }}>✏️</span>
        <span className="doodle" style={{ top: '18%', left: '78%', ...({ ['--size']: '56px', ['--rot']: '8deg', ['--float']: '18s' } as any) }}>🖌️</span>
        <span className="doodle" style={{ top: '32%', left: '20%', ...({ ['--size']: '52px', ['--rot']: '0deg', ['--float']: '16s' } as any) }}>🎨</span>
        <span className="doodle" style={{ top: '28%', left: '60%', ...({ ['--size']: '42px', ['--rot']: '15deg', ['--float']: '15s' } as any) }}>📏</span>
        <span className="doodle" style={{ top: '40%', left: '86%', ...({ ['--size']: '50px', ['--rot']: '-5deg', ['--float']: '19s' } as any) }}>✂️</span>
        <span className="doodle" style={{ top: '58%', left: '12%', ...({ ['--size']: '52px', ['--rot']: '6deg', ['--float']: '17s' } as any) }}>🧽</span>
        <span className="doodle" style={{ top: '66%', left: '35%', ...({ ['--size']: '54px', ['--rot']: '-10deg', ['--float']: '20s' } as any) }}>🐱</span>
        <span className="doodle" style={{ top: '70%', left: '72%', ...({ ['--size']: '46px', ['--rot']: '12deg', ['--float']: '14s' } as any) }}>🐶</span>
        <span className="doodle" style={{ top: '78%', left: '52%', ...({ ['--size']: '48px', ['--rot']: '0deg', ['--float']: '22s' } as any) }}>🐟</span>
        <span className="doodle" style={{ top: '84%', left: '18%', ...({ ['--size']: '44px', ['--rot']: '8deg', ['--float']: '21s' } as any) }}>🐤</span>
        <span className="doodle" style={{ top: '22%', left: '44%', ...({ ['--size']: '40px', ['--rot']: '-18deg', ['--float']: '12s' } as any) }}>⭐️</span>
        <span className="doodle" style={{ top: '50%', left: '90%', ...({ ['--size']: '40px', ['--rot']: '18deg', ['--float']: '12s' } as any) }}>⭐️</span>
        {/* more icons: tools/animals to enrich the theme */}
        <span className="doodle" style={{ top: '10%', left: '40%', ...({ ['--size']: '42px', ['--rot']: '-6deg', ['--float']: '16s' } as any) }}>🖍️</span>
        <span className="doodle" style={{ top: '16%', left: '24%', ...({ ['--size']: '38px', ['--rot']: '10deg', ['--float']: '15s' } as any) }}>🖊️</span>
        <span className="doodle" style={{ top: '34%', left: '74%', ...({ ['--size']: '40px', ['--rot']: '-14deg', ['--float']: '19s' } as any) }}>✒️</span>
        <span className="doodle" style={{ top: '62%', left: '84%', ...({ ['--size']: '48px', ['--rot']: '4deg', ['--float']: '18s' } as any) }}>📐</span>
        <span className="doodle" style={{ top: '76%', left: '8%', ...({ ['--size']: '40px', ['--rot']: '-8deg', ['--float']: '20s' } as any) }}>🧮</span>
        <span className="doodle" style={{ top: '86%', left: '66%', ...({ ['--size']: '44px', ['--rot']: '6deg', ['--float']: '17s' } as any) }}>🦊</span>
        <span className="doodle" style={{ top: '26%', left: '6%', ...({ ['--size']: '44px', ['--rot']: '0deg', ['--float']: '21s' } as any) }}>🐼</span>
        <span className="doodle" style={{ top: '56%', left: '48%', ...({ ['--size']: '36px', ['--rot']: '0deg', ['--float']: '14s' } as any) }}>🦉</span>
        <span className="doodle" style={{ top: '44%', left: '30%', ...({ ['--size']: '36px', ['--rot']: '0deg', ['--float']: '13s' } as any) }}>🦀</span>
      </div>
      <main className="container grid" style={{ gap: 16 }}>
        <h1 className="title">オンラインお絵描きあてバトル</h1>
        {!ready && <p className="subtitle">サインイン準備中…</p>}
        {ready && (
          <>
            {!isLoggedIn && loginMode === "login" && (
              <div className="modalBackdrop" onClick={() => setLoginMode("none")} role="presentation">
                <div className="modalCard card" onClick={(e) => e.stopPropagation()}>
                  <div className="panelHeader">
                    <strong>ログイン</strong>
                    <button className="button ghost" onClick={() => setLoginMode("none")}>閉じる</button>
                  </div>
                  <form onSubmit={onLoginSubmit} className="grid" style={{ gap: 10, marginTop: 12 }}>
                    <label className="label">
                      <span>ユーザー名</span>
                      <input className="input" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} />
                    </label>
                    <label className="label">
                      <span>パスワード</span>
                      <input className="input" type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} />
                    </label>
                    <div className="row">
                      <button className="button" type="submit" disabled={authLoading}>
                        {authLoading ? "ログイン中…" : "ログイン"}
                      </button>
                      {loginError && <span style={{ color: "#ff6b6b" }}>{loginError}</span>}
                    </div>
                    <button className="button ghost" type="button" onClick={() => setLoginMode("reset")}>
                      パスワードを忘れた方
                    </button>
                    <button className="button ghost" type="button" onClick={() => setLoginMode("signup")}>
                      アカウント登録はこちら
                    </button>
                  </form>
                </div>
              </div>
            )}

            {!isLoggedIn && loginMode === "reset" && (
              <div className="modalBackdrop" onClick={() => setLoginMode("none")} role="presentation">
                <div className="modalCard card" onClick={(e) => e.stopPropagation()}>
                  <div className="panelHeader">
                    <strong>パスワード再設定</strong>
                    <button className="button ghost" onClick={() => setLoginMode("none")}>閉じる</button>
                  </div>
                  <form onSubmit={onResetSubmit} className="grid" style={{ gap: 10, marginTop: 12 }}>
                    <label className="label">
                      <div className="labelHead">
                        <span>ユーザー名</span>
                        <span className="helpIcon" data-tip="登録済みのユーザー名を入力してください。">？</span>
                        {resetErrors.username && <span className="fieldError inline">{resetErrors.username}</span>}
                      </div>
                      <input
                        className={`input${resetErrors.username ? " invalid" : ""}`}
                        value={resetUsername}
                        onChange={(e) => {
                          setResetUsername(e.target.value)
                          if (resetErrors.username || resetErrors.form) {
                            setResetErrors(v => ({ ...v, username: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <div className="row">
                      <button className="button" type="submit" disabled={authLoading}>
                        {authLoading ? "送信中…" : "再設定メールを送信"}
                      </button>
                      {resetErrors.form && <span className="fieldError">{resetErrors.form}</span>}
                      {resetSuccess && <span className="fieldSuccess">{resetSuccess}</span>}
                    </div>
                    <button className="button ghost" type="button" onClick={() => setLoginMode("login")}>
                      ログインへ戻る
                    </button>
                  </form>
                </div>
              </div>
            )}

            {!isLoggedIn && loginMode === "signup" && (
              <div className="modalBackdrop" onClick={() => setLoginMode("none")} role="presentation">
                <div className="modalCard card" onClick={(e) => e.stopPropagation()}>
                  <div className="panelHeader">
                    <strong>アカウント登録</strong>
                    <button className="button ghost" onClick={() => setLoginMode("none")}>閉じる</button>
                  </div>
                  <form onSubmit={onSignupSubmit} className="grid" style={{ gap: 10, marginTop: 12 }}>
                    <label className="label">
                      <div className="labelHead">
                        <span>メールアドレス</span>
                        <span className="helpIcon" data-tip="例: name@example.com の形式で入力してください。">？</span>
                        {signupErrors.email && <span className="fieldError inline">{signupErrors.email}</span>}
                      </div>
                      <input
                        className={`input${signupErrors.email ? " invalid" : ""}`}
                        type="email"
                        value={signupEmail}
                        onChange={(e) => {
                          setSignupEmail(e.target.value)
                          if (signupErrors.email || signupErrors.form) {
                            setSignupErrors(v => ({ ...v, email: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <label className="label">
                      <div className="labelHead">
                        <span>ユーザー名</span>
                        <span className="helpIcon" data-tip="1〜20文字。ほかのユーザーと重複不可。">？</span>
                        {signupErrors.username && <span className="fieldError inline">{signupErrors.username}</span>}
                      </div>
                      <input
                        className={`input${signupErrors.username ? " invalid" : ""}`}
                        value={signupUsername}
                        maxLength={20}
                        onChange={(e) => {
                          setSignupUsername(e.target.value)
                          if (signupErrors.username || signupErrors.form) {
                            setSignupErrors(v => ({ ...v, username: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <label className="label">
                      <div className="labelHead">
                        <span>パスワード</span>
                        <span className="helpIcon" data-tip="8〜50文字の英数字のみ使用できます。">？</span>
                        {signupErrors.password && <span className="fieldError inline">{signupErrors.password}</span>}
                      </div>
                      <input
                        className={`input${signupErrors.password ? " invalid" : ""}`}
                        type="password"
                        value={signupPassword}
                        minLength={8}
                        maxLength={50}
                        onChange={(e) => {
                          setSignupPassword(e.target.value)
                          if (signupErrors.password || signupErrors.form) {
                            setSignupErrors(v => ({ ...v, password: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <label className="label">
                      <div className="labelHead">
                        <span>パスワード再入力</span>
                        {signupErrors.passwordConfirm && <span className="fieldError inline">{signupErrors.passwordConfirm}</span>}
                      </div>
                      <input
                        className={`input${signupErrors.passwordConfirm ? " invalid" : ""}`}
                        type="password"
                        value={signupPasswordConfirm}
                        minLength={8}
                        maxLength={50}
                        onChange={(e) => {
                          setSignupPasswordConfirm(e.target.value)
                          if (signupErrors.passwordConfirm || signupErrors.form) {
                            setSignupErrors(v => ({ ...v, passwordConfirm: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <div className="row">
                      <button className="button" type="submit" disabled={authLoading}>
                        {authLoading ? "登録中…" : "登録する"}
                      </button>
                      {signupErrors.form && <span className="fieldError">{signupErrors.form}</span>}
                    </div>
                    <button className="button ghost" type="button" onClick={() => setLoginMode("login")}>
                      ログインへ戻る
                    </button>
                  </form>
                </div>
              </div>
            )}

            {isLoggedIn && settingsOpen && (
              <div className="modalBackdrop" onClick={() => setSettingsOpen(false)} role="presentation">
                <div className="modalCard card" onClick={(e) => e.stopPropagation()}>
                  <div className="panelHeader">
                    <strong>ユーザー設定</strong>
                    <button className="button ghost" onClick={() => setSettingsOpen(false)}>閉じる</button>
                  </div>
                  <form onSubmit={onSettingsSubmit} className="grid" style={{ gap: 10, marginTop: 12 }}>
                    <label className="label">
                      <div className="labelHead">
                        <span>ユーザー名</span>
                        <span className="helpIcon" data-tip="1〜20文字。ほかのユーザーと重複不可。">？</span>
                        {settingsErrors.username && <span className="fieldError inline">{settingsErrors.username}</span>}
                      </div>
                      <input
                        className={`input${settingsErrors.username ? " invalid" : ""}`}
                        value={settingsUsername}
                        maxLength={20}
                        onChange={(e) => {
                          setSettingsUsername(e.target.value)
                          if (settingsErrors.username || settingsErrors.form) {
                            setSettingsErrors(v => ({ ...v, username: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <label className="label">
                      <div className="labelHead">
                        <span>新しいパスワード</span>
                        <span className="helpIcon" data-tip="8〜50文字の英数字のみ使用できます。">？</span>
                        {settingsErrors.password && <span className="fieldError inline">{settingsErrors.password}</span>}
                      </div>
                      <input
                        className={`input${settingsErrors.password ? " invalid" : ""}`}
                        type="password"
                        value={settingsPassword}
                        minLength={8}
                        maxLength={50}
                        onChange={(e) => {
                          setSettingsPassword(e.target.value)
                          if (settingsErrors.password || settingsErrors.form) {
                            setSettingsErrors(v => ({ ...v, password: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <label className="label">
                      <div className="labelHead">
                        <span>パスワード再入力</span>
                        {settingsErrors.passwordConfirm && <span className="fieldError inline">{settingsErrors.passwordConfirm}</span>}
                      </div>
                      <input
                        className={`input${settingsErrors.passwordConfirm ? " invalid" : ""}`}
                        type="password"
                        value={settingsPasswordConfirm}
                        minLength={8}
                        maxLength={50}
                        onChange={(e) => {
                          setSettingsPasswordConfirm(e.target.value)
                          if (settingsErrors.passwordConfirm || settingsErrors.form) {
                            setSettingsErrors(v => ({ ...v, passwordConfirm: undefined, form: undefined }))
                          }
                        }}
                      />
                    </label>
                    <div className="row">
                      <button className="button" type="submit" disabled={authLoading}>
                        {authLoading ? "更新中…" : "保存する"}
                      </button>
                      {settingsErrors.form && <span className="fieldError">{settingsErrors.form}</span>}
                    </div>
                  </form>
                </div>
              </div>
            )}

            {mode === "none" && (
              <div className="row" style={{ gap: 12, justifyContent: "space-between" }}>
                <div className="row" style={{ gap: 12 }}>
                  <button className="button" onClick={() => setMode("create")}>部屋を作成する</button>
                  <button className="button" onClick={() => setMode("join")}>部屋に入室する</button>
                </div>
                {!isLoggedIn ? (
                  <button className="button ghost" onClick={() => setLoginMode("login")}>
                    🔐 ログイン
                  </button>
                ) : (
                  <div className="row" style={{ gap: 8 }}>
                    <div
                      className="userBadge clickable"
                      onClick={() => setSettingsOpen(true)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setSettingsOpen(true) }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="userIcon" aria-hidden>👤</div>
                      <div className="userName">{profileName ?? authUser?.email ?? "ユーザー"}</div>
                    </div>
                    <button className="button ghost" onClick={onLogout} disabled={authLoading}>
                      {authLoading ? "処理中…" : "🚪 ログアウト"}
                    </button>
                  </div>
                )}
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
                    <input className={`input${errors.name ? " invalid" : ""}`} value={name} onChange={(e) => { setName(e.target.value); if (errors.name) setErrors(v => ({ ...v, name: undefined })) }} required minLength={2} maxLength={24} />
                    {errors.name && <span className="fieldError">{errors.name}</span>}
                  </label>
                  <label className="label">
                    <div className="labelHead">
                      <span>パスワード</span>
                      <span className="helpIcon" title="4〜16文字。部屋の鍵として使用します。">？</span>
                    </div>
                    <input className={`input${errors.password ? " invalid" : ""}`} value={password} onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors(v => ({ ...v, password: undefined })) }} required minLength={4} maxLength={16} type="password" />
                    {errors.password && <span className="fieldError">{errors.password}</span>}
                  </label>
                  <label className="label">
                    <div className="labelHead">
                      <span>ユーザー名</span>
                      <span className="helpIcon" title="1〜16文字。ルーム内で一意である必要があります。">？</span>
                    </div>
                    <input className={`input${errors.username ? " invalid" : ""}`} value={username} onChange={(e) => { setUsername(e.target.value); if (errors.username) setErrors(v => ({ ...v, username: undefined })) }} required minLength={1} maxLength={16} />
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
                <br />
                <li>部屋を作成した人が<strong>ホスト</strong>、入室した人が<strong>ゲスト</strong>になります。ホストは部屋作成時に<strong>ラウンド数</strong>（1人の出題者に対して回答者が制限時間内に答える一連の単位）や<strong>制限時間</strong>を設定し、ゲームを開始できます。</li>
                <br />
                <li>ゲームが始まると、1人が<strong>出題者</strong>となり、他の参加者は<strong>回答者</strong>になります。出題者はお題に沿って絵を描きます。</li>
                <br />
                <li>回答者は出題者の描く絵を見て、制限時間内にお題が何かをテキストで回答します。正解すると全員に通知され、5秒後に次のラウンドが始まります。</li>
                <br />
                <li>出題者は毎回ランダムに決まりますが、全員が一度出題者を経験するまでは同じ人が再度出題者になることはありません。</li>
                <br />
                <li>誰かが正解すると、<strong>正解者と出題者に1点</strong>が入ります。制限時間内に正解者がいない場合は、誰にも点数は入りません。</li>
                <br />
                <li>描画は全員にリアルタイムで同期されます。消しゴムやクリア、線の太さや色の変更も可能です。</li>
                <br />
                <li>全ラウンド終了時に最も得点の高い参加者が優勝です。同点の場合は複数人が優勝となります。</li>
                <br />
                <li>1部屋につき最小2人、最大20人まで遊べます。</li>
              </ul>

            </section>
          </>
        )}
      </main>
    </div>
  )
}
