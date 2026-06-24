import {
  ArrowRight,
  Check,
  Code2,
  Cpu,
  LockKeyhole,
  Network,
  ShieldCheck,
  Terminal
} from "lucide-react";
import { AuditRequestCard } from "../../components/audit-request-card";

export const dynamic = "force-dynamic";

const waitlistUrl = "https://waitlister.me/p/preflight";
const vsixDownloadUrl = "/downloads/preflight-companion-0.0.1.vsix";

const terminalLines = [
  "npm install -g preflight-pro",
  "preflight start"
];

const pricingPlans = [
  {
    name: "Free Tier",
    price: "$0",
    billing: "forever",
    description: "Start with the local-first safety gate and enough free remediation to prove the workflow.",
    features: [
      "Unlimited local AST scanning",
      "The Eye daemon and save-time IDE alerts",
      "Native Windows popup fallback without the VSIX",
      "MCP integration for AI-native editors",
      "10 Free Deep-Reasoning AI Fixes"
    ],
    cta: "Install PreFlight",
    href: "https://github.com/av29nassh-sketch/PreFlight",
    icon: ShieldCheck
  },
  {
    name: "Solo Founder",
    price: "$19",
    billing: "/mo",
    description: "For builders shipping AI-generated apps who want unlimited automated remediation.",
    features: [
      "Unlimited Deep-Reasoning AI Fixes",
      "Complex architecture patches",
      "SQL, SSRF, auth, and tenant-boundary remediation",
      "Priority beta onboarding"
    ],
    cta: "Join Solo Beta",
    href: waitlistUrl,
    featured: true,
    icon: Cpu
  },
  {
    name: "Teams",
    price: "$49",
    billing: "/seat/mo",
    description: "For teams that need shared security posture, policy enforcement, and rollout support.",
    features: [
      "Team policy enforcement",
      "Shared risk-score dashboards",
      "Centralized remediation visibility",
      "Priority support"
    ],
    cta: "Join Teams Waitlist",
    href: waitlistUrl,
    icon: Network
  }
];

const setupPaths = [
  {
    title: "Path A: CLI-first workflow",
    description: "Use this when you want PreFlight in any terminal, CI check, MCP client, or non-VS Code workflow.",
    cta: "Start with the CLI",
    href: "https://github.com/av29nassh-sketch/PreFlight",
    steps: [
      "npm install -g preflight-pro",
      "preflight start",
      "preflight scan . --fix"
    ]
  },
  {
    title: "Path B: VS Code / Cursor workflow",
    description: "Use this when you want save-time squiggles, IDE alerts, and the Fix with PreFlight AI button.",
    cta: "Download VSIX",
    href: vsixDownloadUrl,
    steps: [
      "npm install -g preflight-pro",
      "Download the VSIX extension",
      "Extensions > ... > Install from VSIX",
      "preflight start",
      "Open your project and save a file"
    ]
  }
];

function TerminalBlock() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/70 shadow-[0_0_80px_rgba(16,185,129,0.12)] backdrop-blur">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/80 to-transparent" />
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
        </div>
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">
          <Terminal className="h-3.5 w-3.5" />
          install
        </div>
      </div>
      <div className="space-y-4 p-6 font-mono text-sm leading-7 sm:text-base">
        {terminalLines.map((line) => (
          <div className="flex gap-3 text-zinc-200" key={line}>
            <span className="select-none text-emerald-300">$</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 px-6 py-4 text-sm text-zinc-400">
        Also available as a native VS Code Extension. The Eye daemon watches saves; MCP support connects AI-native editors.
      </div>
    </div>
  );
}

function SetupPaths() {
  return (
    <section className="relative z-10 mx-auto max-w-7xl px-6 pb-20">
      <div className="grid gap-5 lg:grid-cols-[0.78fr_1.22fr] lg:items-stretch">
        <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
            <Terminal className="h-3.5 w-3.5" />
            setup order
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-white md:text-4xl">
            Two ways in. Both activate with <span className="text-cyan-200">preflight start</span>.
          </h2>
          <p className="mt-4 text-base leading-7 text-zinc-400">
            Install the global CLI once so The Eye daemon, MCP server, Windows fallback popup, and extension can all call the same <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-zinc-200">preflight</code> command. Then run <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-zinc-200">preflight start</code> in a project to register it and start watching.
          </p>
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/35 p-4 text-sm leading-6 text-zinc-300">
            <span className="font-semibold text-white">VSIX beta note:</span> the extension is optional visual UI. The global CLI owns the engine, The Eye daemon, MCP server, fallback popup, and fix pipeline.
          </div>
          <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.07] p-4 text-sm leading-6 text-emerald-50">
            <span className="font-semibold text-emerald-200">No extension installed?</span> The Eye still watches your project. Terminal-only users and desktop-agent users get native Windows hard-block popups when no VS Code/Cursor extension client is connected.
          </div>
          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.07] p-4 text-sm leading-6 text-cyan-100">
            <span className="font-semibold text-cyan-200">Beta / Pro keys:</span> Free includes unlimited scans and 10 total patches. After that, run <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-cyan-50">preflight auth YOUR_KEY</code> to unlock unlimited fixes.
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {setupPaths.map((path) => (
            <article className="rounded-3xl border border-white/10 bg-black/35 p-6 shadow-[0_20px_80px_rgba(0,0,0,0.24)]" key={path.title}>
              <h3 className="text-xl font-semibold text-white">{path.title}</h3>
              <p className="mt-3 min-h-16 text-sm leading-6 text-zinc-400">{path.description}</p>
              <ol className="mt-5 space-y-3">
                {path.steps.map((step, index) => (
                  <li className="flex gap-3 text-sm text-zinc-200" key={step}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-300/25 bg-cyan-300/10 text-xs font-bold text-cyan-200">
                      {index + 1}
                    </span>
                    <code className="rounded-md bg-white/[0.055] px-2 py-1 font-mono text-zinc-100">{step}</code>
                  </li>
                ))}
              </ol>
              <a className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.045] px-4 text-sm font-semibold text-white transition hover:border-cyan-300/40 hover:bg-cyan-300/10" href={path.href}>
                {path.cta}
                <ArrowRight className="h-4 w-4" />
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function MarketingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0A0A0A] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(34,211,238,0.14),transparent_30%),radial-gradient(circle_at_85%_0%,rgba(248,113,113,0.11),transparent_26%),linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[length:auto,auto,72px_72px,72px_72px]" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_center,transparent,rgba(10,10,10,0.78)_72%)]" />

      <header className="relative z-10 border-b border-white/10">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <a className="flex items-center gap-3" href="/">
            <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-cyan-300/30 bg-black shadow-[0_0_24px_rgba(34,211,238,0.18)]">
              <img
                alt="PreFlight"
                className="h-8 w-8 object-contain"
                src="/preflight-notification.png"
              />
            </span>
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-zinc-100">
              PreFlight
            </span>
          </a>
          <div className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a className="transition hover:text-white" href="#audit">
              Audit
            </a>
            <a className="transition hover:text-white" href="#pricing">
              Pricing
            </a>
            <a className="transition hover:text-white" href={vsixDownloadUrl}>
              Download VSIX
            </a>
            <a className="transition hover:text-white" href="https://github.com/av29nassh-sketch/PreFlight">
              GitHub
            </a>
          </div>
        </nav>
      </header>

      <section className="relative z-10 mx-auto grid max-w-7xl gap-12 px-6 pb-24 pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.74fr)] lg:items-center lg:pt-28">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">
            <LockKeyhole className="h-3.5 w-3.5" />
            Local-first AI code security
          </div>

          <h1 className="mt-7 max-w-5xl text-5xl font-semibold leading-[0.98] tracking-[-0.04em] text-white md:text-7xl">
            Stop AI Coding Drift Before It Ships.
          </h1>

          <p className="mt-7 max-w-3xl text-lg leading-8 text-zinc-300 md:text-xl">
            The local-first safety gate for AI coding workflows. Powered by a custom Micro-Fuzzer and Quantized CPG to catch hallucinated code, exposed secrets, and structural flaws.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-bold text-zinc-950 transition hover:bg-cyan-100 active:translate-y-px" href="#audit">
              Get Free Audit
              <ArrowRight className="h-4 w-4" />
            </a>
            <a className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/[0.03] px-5 text-sm font-semibold text-white transition hover:border-cyan-300/40 hover:bg-cyan-300/10 active:translate-y-px" href={waitlistUrl}>
              Join Pro Beta
            </a>
            <a className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-5 text-sm font-semibold text-cyan-100 transition hover:border-cyan-200/60 hover:bg-cyan-300/15 active:translate-y-px" href={vsixDownloadUrl}>
              Download VSIX
            </a>
          </div>

          <div className="mt-10 grid max-w-4xl gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Micro-Fuzzer", "Payloads risky flows"],
              ["Quantized CPG", "Tracks source to sink"],
              ["The Eye", "Watches saves locally"],
              ["MCP-ready", "Connects AI editors"]
            ].map(([title, copy]) => (
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={title}>
                <div className="text-sm font-semibold text-white">{title}</div>
                <div className="mt-1 text-sm text-zinc-500">{copy}</div>
              </div>
            ))}
          </div>
        </div>

        <TerminalBlock />
      </section>

      <div id="audit">
        <AuditRequestCard />
      </div>

      <SetupPaths />

      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-24" id="pricing">
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400">
            <Code2 className="h-3.5 w-3.5" />
            Pricing
          </div>
          <h2 className="mt-5 text-4xl font-semibold tracking-[-0.03em] text-white md:text-5xl">
            Start local. Scale into automated remediation.
          </h2>
          <p className="mt-4 text-base leading-7 text-zinc-400">
            PreFlight keeps basic safety accessible while Pro unlocks the deeper reasoning layer for complex architecture patches.
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {pricingPlans.map((plan) => {
            const Icon = plan.icon;

            return (
              <article
                className={
                  plan.featured
                    ? "relative overflow-hidden rounded-3xl border border-cyan-300/40 bg-cyan-300/[0.075] p-6 shadow-[0_0_90px_rgba(34,211,238,0.13)]"
                    : "relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.035] p-6"
                }
                key={plan.name}
              >
                {plan.featured ? <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200 to-transparent" /> : null}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/35">
                    <Icon className={plan.featured ? "h-5 w-5 text-cyan-200" : "h-5 w-5 text-zinc-300"} />
                  </div>
                  {plan.featured ? (
                    <span className="rounded-full bg-cyan-200 px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-zinc-950">
                      Popular
                    </span>
                  ) : null}
                </div>

                <h3 className="mt-6 text-2xl font-semibold text-white">{plan.name}</h3>
                <div className="mt-4 flex items-end gap-2">
                  <span className="text-5xl font-semibold tracking-[-0.04em] text-white">{plan.price}</span>
                  <span className="pb-2 text-sm text-zinc-500">{plan.billing}</span>
                </div>
                <p className="mt-4 min-h-20 text-sm leading-6 text-zinc-400">{plan.description}</p>

                <ul className="mt-6 space-y-3 text-sm text-zinc-300">
                  {plan.features.map((feature) => (
                    <li className="flex gap-3" key={feature}>
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  className={
                    plan.featured
                      ? "mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-cyan-200 px-5 text-sm font-bold text-zinc-950 transition hover:bg-white active:translate-y-px"
                      : "mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-5 text-sm font-semibold text-white transition hover:border-cyan-300/40 hover:bg-cyan-300/10 active:translate-y-px"
                  }
                  href={plan.href}
                >
                  {plan.cta}
                  <ArrowRight className="h-4 w-4" />
                </a>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
