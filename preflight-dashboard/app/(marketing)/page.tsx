import {
  ArrowRight,
  Bot,
  Code2,
  DatabaseZap,
  Eye,
  PlugZap,
  ShieldAlert,
  Terminal,
  TriangleAlert
} from "lucide-react";
import { FounderOfferCard } from "../../components/founder-offer-card";

export const dynamic = "force-dynamic";

const marketplaceUrl = "https://marketplace.visualstudio.com/items?itemName=PreflightPro.preflight-companion";
const polarCheckoutUrl =
  process.env.NEXT_PUBLIC_POLAR_LIFETIME_CHECKOUT_URL ||
  "https://buy.polar.sh/polar_cl_O8I8ASl3wIvmudZsRlQMUV8yFCP72tGFcVXqh1bCaiI";

const quickStartSteps = [
  {
    eyebrow: "Step 1",
    title: "Start Free (Local Sandbox)",
    text: "Install PreFlight locally to get 10 complimentary structural fixes to test the AST engine in your editor without an account.",
    lines: ["npm install -g preflight-pro@latest", "preflight start"]
  },
  {
    eyebrow: "Step 2",
    title: "Upgrade Anytime (Unlock Unlimited Lifetime Access)",
    text: "Once you have your Founder's Key, authenticate instantly via the CLI to lift all restrictions.",
    lines: ["preflight auth YOUR_LIFETIME_KEY"]
  }
];

const coreValues = [
  {
    title: "High-Velocity Drift",
    body: "AI coding tools move fast, but they don't know your deep structural architecture boundaries.",
    icon: Bot
  },
  {
    title: "Silent Bypasses",
    body: "A single hallucinated clause can accidentally bypass a critical Supabase RLS policy or security guardrail.",
    icon: DatabaseZap
  },
  {
    title: "Local Prevention",
    body: "Don't wait for a failed CI/CD pipeline or a broken production database. Catch it in the editor as you type.",
    icon: Eye
  }
];

function TerminalWindow({ lines }: { lines: string[] }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#050607]/90 shadow-[0_22px_80px_rgba(0,0,0,0.42)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/80 to-transparent" />
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff514f]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#f6c44d]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#39d98a]" />
        </div>
        <div className="flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.22em] text-zinc-500">
          <Terminal className="h-3.5 w-3.5" />
          terminal
        </div>
      </div>
      <div className="space-y-3 p-5 font-mono text-sm leading-7 text-zinc-100 md:text-base">
        {lines.map((line) => (
          <div className="flex gap-3" key={line}>
            <span className="select-none text-cyan-300">$</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InteractiveQuickStart() {
  return (
    <section className="relative z-10 mx-auto max-w-7xl px-6 py-24" id="quick-start">
      <div className="mb-10 max-w-3xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/25 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.22em] text-cyan-200">
          <PlugZap className="h-3.5 w-3.5" />
          Interactive Quick Start
        </div>
        <h2 className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-white md:text-6xl">
          The developer flow: free first, upgrade later.
        </h2>
        <p className="mt-4 text-base leading-7 text-zinc-400 md:text-lg">
          No account wall. No key required to start watching. Try the local daemon, then unlock unlimited remediation when the Founder&apos;s Key is in hand.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {quickStartSteps.map((step, index) => (
          <article
            className={
              index === 0
                ? "relative overflow-hidden rounded-[1.8rem] border border-cyan-300/25 bg-cyan-300/[0.07] p-6"
                : "relative overflow-hidden rounded-[1.8rem] border border-emerald-300/25 bg-emerald-300/[0.07] p-6"
            }
            key={step.title}
          >
            <div className="absolute -right-20 -top-24 h-52 w-52 rounded-full bg-white/10 blur-3xl" />
            <div className="relative">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/35 font-mono text-sm font-bold text-white">
                  {index + 1}
                </span>
                <span className="text-xs font-bold uppercase tracking-[0.22em] text-zinc-400">{step.eyebrow}</span>
              </div>
              <h3 className="mt-5 text-2xl font-semibold tracking-[-0.02em] text-white">{step.title}</h3>
              <p className="mt-3 min-h-20 text-sm leading-6 text-zinc-300 md:text-base">{step.text}</p>
              <div className="mt-5">
                <TerminalWindow lines={step.lines} />
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CoreProductValues() {
  return (
    <section className="relative z-10 mx-auto max-w-7xl px-6 pb-24">
      <div className="grid gap-5 lg:grid-cols-3">
        {coreValues.map((value) => {
          const Icon = value.icon;

          return (
            <article
              className="group relative overflow-hidden rounded-[1.6rem] border border-white/10 bg-white/[0.035] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.28)] transition duration-300 hover:-translate-y-1 hover:border-cyan-300/35 hover:bg-cyan-300/[0.055]"
              key={value.title}
            >
              <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold tracking-[-0.025em] text-white">{value.title}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-400 md:text-base">{value.body}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export default function MarketingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0A0A0A] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_16%_8%,rgba(34,211,238,0.15),transparent_32%),radial-gradient(circle_at_88%_2%,rgba(239,68,68,0.16),transparent_28%),radial-gradient(circle_at_50%_92%,rgba(16,185,129,0.12),transparent_30%),linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[length:auto,auto,auto,76px_76px,76px_76px]" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_center,transparent,rgba(10,10,10,0.86)_74%)]" />

      <div className="relative z-20 border-b border-red-300/20 bg-red-500/[0.08] px-6 py-3 text-center text-sm font-semibold leading-6 text-red-50">
        ⚡ LAUNCH WEEKEND SPECIAL: Save over 85% on the PreFlight Pro Lifetime Founder&apos;s Pass. Use code DISCOUNTHUB at checkout to get it for $30 / ₹2,499 before it changes to a $19/month subscription this Sunday night.
      </div>

      <header className="relative z-10 border-b border-white/10">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <a className="flex items-center gap-3" href="/">
            <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-cyan-300/25 bg-white shadow-[0_0_30px_rgba(34,211,238,0.16)]">
              <img alt="PreFlight" className="h-10 w-10 object-contain" src="/preflight-notification.png" />
            </span>
            <span className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-zinc-100">
              PreFlight
            </span>
          </a>
          <div className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a className="transition hover:text-white" href="#quick-start">
              Quick Start
            </a>
            <a className="transition hover:text-white" href="#pricing">
              Founder&apos;s Pass
            </a>
            <a className="transition hover:text-white" href={marketplaceUrl}>
              Marketplace
            </a>
          </div>
        </nav>
      </header>

      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-24 pt-20 md:pt-28">
        <div className="max-w-5xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.22em] text-cyan-200">
            <ShieldAlert className="h-3.5 w-3.5" />
            Local AST daemon · MCP · VS Code companion
          </div>

          <h1 className="mt-7 max-w-6xl text-5xl font-semibold leading-[0.96] tracking-[-0.055em] text-white md:text-7xl lg:text-8xl">
            Stop AI Agents from Breaking Your Production Database Architecture.
          </h1>

          <p className="mt-7 max-w-4xl text-lg leading-8 text-zinc-300 md:text-xl">
            PreFlight is a local AST background daemon, MCP server, and VS Code extension that blocks hallucinated code, broken Supabase RLS policies, and silent schema drift in real-time as you type.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <a
              className="inline-flex h-13 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-bold text-zinc-950 transition hover:bg-cyan-100 active:translate-y-px"
              href="#quick-start"
            >
              View Interactive Quick Start
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              className="inline-flex h-13 items-center justify-center gap-2 rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-5 text-sm font-semibold text-cyan-100 transition hover:border-cyan-200/60 hover:bg-cyan-300/15 active:translate-y-px"
              href={marketplaceUrl}
            >
              Install Extension via VS Marketplace
              <Code2 className="h-4 w-4" />
            </a>
          </div>
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="relative overflow-hidden rounded-[1.8rem] border border-white/10 bg-black/45 p-5">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red-300/80 to-transparent" />
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-red-200">
              <TriangleAlert className="h-4 w-4" />
              hard block caught on save
            </div>
            <pre className="mt-5 overflow-x-auto rounded-2xl border border-red-300/20 bg-red-950/15 p-5 font-mono text-sm leading-7 text-zinc-200">
              <code>{`PREFLIGHT HARD BLOCK
Detected: RLS_DRIFT
File: app/api/profiles/route.ts:42
Evidence: AI-generated mutation bypasses tenant boundary
Action: preflight fix app/api/profiles/route.ts`}</code>
            </pre>
          </div>
          <div className="relative overflow-hidden rounded-[1.8rem] border border-emerald-300/20 bg-emerald-300/[0.07] p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-emerald-200">
              <Eye className="h-4 w-4" />
              The Eye is watching
            </div>
            <p className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-white">
              Save-time alerts in VS Code/Cursor. Native Windows popup fallback when no extension client is connected.
            </p>
          </div>
        </div>
      </section>

      <InteractiveQuickStart />
      <CoreProductValues />
      <FounderOfferCard checkoutUrl={polarCheckoutUrl} />
    </main>
  );
}
