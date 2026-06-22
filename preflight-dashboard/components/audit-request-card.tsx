"use client";

import { useState } from "react";
import { ArrowRight, FileCode2, GitBranch, Globe2, Mail, ScanLine } from "lucide-react";

const auditTypes = [
  {
    label: "GitHub Repo URL",
    value: "github",
    icon: GitBranch
  },
  {
    label: "Live Website URL",
    value: "website",
    icon: Globe2
  },
  {
    label: "Paste Code Block",
    value: "code",
    icon: FileCode2
  }
] as const;

const waitlistUrl = "https://waitlister.me/p/preflight";

type AuditType = (typeof auditTypes)[number]["value"];

export function AuditRequestCard() {
  const [inputType, setInputType] = useState<AuditType>("github");
  const [target, setTarget] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submitAuditRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setMessage("");

    try {
      const response = await fetch("/api/audit/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputType,
          target,
          email
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Could not submit audit request.");
      }

      setStatus("success");
      setMessage("Audit request received. We will email the report after review.");
      setTarget("");
      setEmail("");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not submit audit request.");
    }
  }

  return (
    <section className="relative z-10 mx-auto -mt-8 max-w-5xl px-6 pb-20">
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.045] p-6 shadow-[0_30px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl md:p-8">
        <div className="absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
        <div className="absolute -right-24 -top-24 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute -bottom-28 -left-24 h-64 w-64 rounded-full bg-red-500/10 blur-3xl" />

        <div className="relative">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">
                <ScanLine className="h-3.5 w-3.5" />
                manual review
              </div>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white md:text-4xl">
                Get a Free Manual Code Audit
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400 md:text-base">
                Send a repo, live URL, or suspicious code block. We will review the highest-risk AI coding drift paths and email the report.
              </p>
            </div>
            <div className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-4 py-2 text-sm text-emerald-100">
              Free, human-reviewed first pass
            </div>
          </div>

          <form className="mt-8 grid gap-4" onSubmit={submitAuditRequest}>
            <div className="grid gap-3 md:grid-cols-3">
              {auditTypes.map(({ label, value, icon: Icon }) => (
                <label
                  className="flex cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-4 text-sm font-medium text-zinc-200 transition hover:border-cyan-300/40 hover:bg-cyan-300/5"
                  key={value}
                >
                  <input
                    checked={inputType === value}
                    className="h-4 w-4 accent-cyan-300"
                    name="audit-type"
                    onChange={() => setInputType(value)}
                    type="radio"
                  />
                  <Icon className="h-4 w-4 text-cyan-200" />
                  {label}
                </label>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-[1fr_0.62fr]">
              <label className="grid gap-2">
                <span className="text-sm font-medium text-zinc-300">URL or code</span>
                <textarea
                  className="min-h-32 resize-y rounded-2xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm text-zinc-100 outline-none ring-0 transition placeholder:text-zinc-600 focus:border-cyan-300/60"
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder="https://github.com/your-org/your-repo or paste a risky route.ts block..."
                  required
                  value={target}
                />
              </label>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-zinc-300">Your Email Address</span>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                    <input
                      className="h-12 w-full rounded-2xl border border-white/10 bg-black/40 pl-11 pr-4 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-cyan-300/60"
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      required
                      type="email"
                      value={email}
                    />
                  </div>
                </label>
                <button
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-cyan-200 px-5 text-sm font-bold text-zinc-950 transition hover:bg-white active:translate-y-px disabled:cursor-wait disabled:opacity-70"
                  disabled={status === "submitting"}
                >
                  {status === "submitting" ? "Submitting..." : "Run Free Security Audit"}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </form>

          {message ? (
            <div
              className={
                status === "success"
                  ? "mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100"
                  : "mt-4 rounded-2xl border border-red-300/20 bg-red-300/10 px-4 py-3 text-sm text-red-100"
              }
            >
              {message}
            </div>
          ) : null}

          <a className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-zinc-400 transition hover:text-cyan-200" href={waitlistUrl}>
            Want unlimited automated fixes? Join the Pro Beta Waitlist
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
