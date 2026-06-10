"use client";

import { type FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "../../src/lib/supabase-browser";

type AuthMode = "signin" | "signup";

type AuthFormProps = {
  initialMode?: AuthMode;
};

function setDashboardEmailCookie(email: string) {
  const encodedEmail = encodeURIComponent(email);
  const secureFlag = typeof window !== "undefined" && window.location.protocol === "https:" ? "; Secure" : "";

  document.cookie = `preflight_user_email=${encodedEmail}; Path=/; Max-Age=2592000; SameSite=Lax${secureFlag}`;
}

function safeRedirectTarget(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsedUrl = new URL(value, window.location.origin);

    if (parsedUrl.origin === window.location.origin && parsedUrl.pathname.startsWith("/")) {
      return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
    }

    if (parsedUrl.protocol === "https:" && (parsedUrl.hostname === "polar.sh" || parsedUrl.hostname.endsWith(".polar.sh"))) {
      return parsedUrl.toString();
    }
  } catch {
    return null;
  }

  return null;
}

export function AuthForm({ initialMode = "signin" }: AuthFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [redirectTo, setRedirectTo] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isSignup = mode === "signup";
  const postAuthTarget = redirectTo || "/dashboard";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRedirectTo(safeRedirectTarget(params.get("redirect_to")));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createBrowserSupabaseClient();

      if (isSignup) {
        const { error: signupError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}${postAuthTarget.startsWith("/") ? postAuthTarget : "/dashboard"}`
          }
        });

        if (signupError) {
          throw signupError;
        }
      } else {
        const { error: signinError } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (signinError) {
          throw signinError;
        }
      }

      setDashboardEmailCookie(email);
      setMessage(isSignup ? "Account created. Redirecting." : "Signed in. Redirecting.");

      if (redirectTo && !redirectTo.startsWith("/")) {
        window.location.assign(redirectTo);
        return;
      }

      router.push(postAuthTarget);
      router.refresh();
    } catch (authError) {
      const nextMessage = authError instanceof Error ? authError.message : "Authentication failed. Please try again.";
      setError(nextMessage);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_12%,rgba(20,184,166,0.16),transparent_34%),radial-gradient(circle_at_82%_8%,rgba(244,63,94,0.09),transparent_28%),linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[length:auto,auto,64px_64px,64px_64px]" />

      <header className="relative z-10 border-b border-zinc-800/80">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <a className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300" href="/">
            PreFlight
          </a>
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <a className="rounded-md px-3 py-2 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" href="/">
              Home
            </a>
            <a className="rounded-md px-3 py-2 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" href="/dashboard">
              Dashboard
            </a>
          </div>
        </nav>
      </header>

      <main className="relative z-10 mx-auto grid min-h-[calc(100vh-73px)] max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[0.9fr_420px] lg:items-center">
        <section>
          <div className="inline-flex rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
            Account access
          </div>
          <h1 className="mt-6 max-w-3xl text-5xl font-semibold leading-[1.02] tracking-normal text-zinc-50 md:text-6xl">
            Ship with the guardrail already watching.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300">
            Sign in to view team telemetry, manage remediation credits, and connect your CLI without manually handling license keys.
          </p>
          <div className="mt-8 max-w-2xl rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm leading-6 text-emerald-100">
            <span className="font-semibold text-emerald-200">Zero-Retention Architecture:</span> Source snippets are processed in memory for remediation and are never stored as dashboard records.
          </div>
        </section>

        <section className="rounded-lg border border-zinc-800 bg-zinc-950/90 p-6 shadow-[0_30px_100px_rgba(16,185,129,0.12)]">
          <div>
            <h2 className="text-2xl font-semibold text-zinc-50">{isSignup ? "Create your account" : "Sign in to PreFlight"}</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-400">
              {redirectTo
                ? "Create or access your account first, then checkout will open in this tab."
                : isSignup
                  ? "Start with trial credits, then connect your CLI."
                  : "Use the email and password connected to your PreFlight account."}
            </p>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <label className="block">
              <span className="text-sm font-medium text-zinc-300">Email</span>
              <input
                autoComplete="email"
                className="mt-2 h-12 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-300">Password</span>
              <input
                autoComplete={isSignup ? "new-password" : "current-password"}
                className="mt-2 h-12 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-300 focus:ring-2 focus:ring-emerald-300/20"
                minLength={6}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 6 characters"
                required
                type="password"
                value={password}
              />
            </label>

            {error ? (
              <div className="rounded-md border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-sm leading-6 text-rose-200">{error}</div>
            ) : null}

            {message ? (
              <div className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-sm leading-6 text-emerald-200">{message}</div>
            ) : null}

            <button
              className="inline-flex h-12 w-full items-center justify-center rounded-md bg-emerald-300 px-5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px disabled:cursor-wait disabled:opacity-70"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Working..." : isSignup ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="mt-5 border-t border-zinc-800 pt-5 text-center text-sm text-zinc-400">
            {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
            <button
              className="font-semibold text-emerald-300 hover:text-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
              onClick={() => {
                setMode(isSignup ? "signin" : "signup");
                setError(null);
                setMessage(null);
              }}
              type="button"
            >
              {isSignup ? "Sign in" : "Sign up"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
