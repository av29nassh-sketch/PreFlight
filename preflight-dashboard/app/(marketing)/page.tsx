export const dynamic = "force-dynamic";

const terminalLines = [
  { tone: "muted", text: "$ preflight scan --fix" },
  { tone: "muted", text: "🔍 [PHASE 1] Running Offline Local AST Optimization Pass..." },
  { tone: "good", text: "[LOCAL] AST scaffold applied for app/Dashboard.tsx" },
  { tone: "muted", text: "🚀 [PHASE 2] Handing Off Remaining Architectural Flaws to PreFlight Pro Deep Reasoning Engine..." },
  { tone: "warn", text: "[PRO] SQL fix generated via Pro Engine for lib/db.ts" },
  { tone: "bad", text: '- "SELECT * FROM users WHERE id = " + userId' },
  { tone: "good", text: '+ ({ text: "SELECT * FROM users WHERE id = $1", values: [userId] })' },
  { tone: "good", text: "Deep multi-file patch prepared for tenant-sync boundary" }
];

const architectureCards = [
  {
    eyebrow: "Free Tier",
    title: "PreFlight Guardian",
    copy: "Scans and automatically fixes basic security and structural issues completely offline.",
    bullets: ["Runs fully offline", "Immediate structural fixes", "No source upload during the local pass"]
  },
  {
    eyebrow: "Pro Tier",
    title: "PreFlight Pro",
    copy: "Scans and automatically fixes everything—including complex multi-file architectural flaws, tenant isolation logic, and parametric SQL injections.",
    bullets: ["Multi-file vulnerability patching", "Parametric SQL injection fixes", "Auth, billing, tenant, webhook reasoning"]
  },
  {
    eyebrow: "Free vs Pro",
    title: "Pay for deeper reasoning, not basic safety",
    copy: "The free engine handles offline AST scanning and standard structural remediations. Pro unlocks the premium Deep Reasoning Pipeline.",
    bullets: ["Free CLI remains useful by itself", "Pro extends, not replaces, the local engine", "Invite-only beta onboarding today"]
  }
];

const pricing = [
  {
    name: "Free Tier",
    price: "$0",
    billing: "Forever free",
    description: "For developers who want a private local gate before AI-generated code lands in production.",
    features: ["Core AST scanning", "Offline credential leak detection", "Standard single-file syntax fixes", "Open-source CLI workflow"],
    cta: "View free version",
    href: "https://github.com/av29nassh-sketch/PreFlight",
    accent: "border-zinc-800 bg-zinc-900/55"
  },
  {
    name: "Solo Founders",
    price: "$19/month",
    billing: "Per founder / developer",
    description: "For solo builders who want the premium Pro Engine path for SQL, auth, billing, and multi-file remediation.",
    features: ["Full PreFlight Pro reasoning integration", "Secure proxy token management", "Multi-file dependency patching", "Invite-only beta access"],
    cta: "Apply for Solo Beta",
    href: "https://waitlister.me/p/preflight",
    featured: true
  },
  {
    name: "Teams",
    price: "$49/seat/month",
    billing: "Per seat, per month",
    description: "For engineering teams that need shared rollout, policy alignment, and premium support on top of the Pro engine.",
    features: ["Pro Engine reasoning for every seat", "Shared onboarding and rollout", "Prioritized support", "Team beta waitlist"],
    cta: "Join Teams Waitlist",
    href: "https://waitlister.me/p/preflight",
    accent: "border-zinc-800 bg-zinc-900/55"
  }
];

const quickStartBlocks = [
  {
    title: "1. Global Installation",
    label: "Install",
    lines: [
      "npm install -g preflight-guardian@beta"
    ]
  },
  {
    title: "2. Authenticate Pro Engine",
    label: "PowerShell",
    lines: [
      '$env:PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"'
    ]
  },
  {
    title: "2. Authenticate Pro Engine",
    label: "Bash / macOS",
    lines: [
      'export PREFLIGHT_PRO_KEY="PREFLIGHT-BETA-XXXXX"'
    ]
  },
  {
    title: "3. Run Deep Remediation",
    label: "Run",
    lines: [
      "preflight scan ./your-project-dir --fix"
    ]
  }
];

function TerminalDemo() {
  return (
    <div className="rounded-lg border border-emerald-400/20 bg-zinc-950 shadow-[0_30px_100px_rgba(16,185,129,0.12)]">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </div>
        <div className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">preflight terminal</div>
      </div>
      <div className="space-y-3 p-5 font-mono text-sm leading-6">
        {terminalLines.map((line) => (
          <div
            className={
              line.tone === "good"
                ? "text-emerald-300"
                : line.tone === "bad"
                  ? "text-rose-300"
                  : line.tone === "warn"
                    ? "text-amber-200"
                    : "text-zinc-400"
            }
            key={line.text}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MarketingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_12%,rgba(20,184,166,0.16),transparent_34%),radial-gradient(circle_at_82%_8%,rgba(244,63,94,0.09),transparent_28%),linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[length:auto,auto,64px_64px,64px_64px]" />

      <header className="relative z-10 border-b border-zinc-800/80">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <a className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300" href="/">
            PreFlight
          </a>
        </nav>
      </header>

      <section className="relative z-10 mx-auto grid max-w-7xl gap-10 px-6 py-16 lg:grid-cols-[minmax(0,0.92fr)_minmax(480px,1.08fr)] lg:items-center lg:py-24">
        <div>
          <div className="inline-flex rounded-md border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
            Local-first security remediation
          </div>
          <h1 className="mt-6 max-w-4xl text-5xl font-semibold leading-[1.02] tracking-normal text-zinc-50 md:text-7xl">
            PreFlight: Real-time AI security remediation right in your CLI.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300">
            Catch unsafe AI-generated auth, billing, RLS, webhook, SSRF, and secret-handling changes before they hit production. Free gives you the offline AST safety layer. PreFlight Pro unlocks the premium Deep Reasoning Pipeline when the fix needs deeper architectural context.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a className="inline-flex h-12 items-center justify-center rounded-md bg-emerald-300 px-5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px" href="#pricing">
              View beta access
            </a>
            <a className="inline-flex h-12 items-center justify-center rounded-md border border-zinc-700 px-5 text-sm font-semibold text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px" href="https://waitlister.me/p/preflight">
              Apply for beta
            </a>
          </div>
          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3 text-sm">
            {["Offline first", "Solo $19/month", "Invite-only beta"].map((item) => (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-zinc-300" key={item}>
                {item}
              </div>
            ))}
          </div>
          <div className="mt-5 max-w-2xl rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm leading-6 text-emerald-100">
            <span className="font-semibold text-emerald-200">Zero-Retention Architecture:</span> Your source code is processed in-memory and never stored on our servers or databases.
          </div>
        </div>
        <TerminalDemo />
      </section>

      <section className="relative z-10 border-y border-zinc-800/80 bg-zinc-950/80">
        <div className="mx-auto grid max-w-7xl gap-4 px-6 py-10 md:grid-cols-3">
          {architectureCards.map((card) => (
            <article className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5" key={card.title}>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">{card.eyebrow}</div>
              <h2 className="mt-4 text-xl font-semibold text-zinc-50">{card.title}</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">{card.copy}</p>
              <ul className="mt-4 space-y-2 text-sm text-zinc-300">
                {card.bullets.map((bullet) => (
                  <li className="flex gap-3" key={bullet}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-300" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-7xl px-6 py-16" id="pricing">
        <div className="max-w-2xl">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Pricing</div>
          <h2 className="mt-4 text-4xl font-semibold text-zinc-50">Choose the path that matches your remediation depth: free local AST, solo Pro, or team rollout.</h2>
          <p className="mt-4 text-base leading-7 text-zinc-400">
            The free CLI stays useful on its own. Paid plans unlock the Deep Reasoning layer, secure proxy-backed fixes, and higher-touch onboarding. During beta, Solo and Teams access both start through the waitlist.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {pricing.map((plan) => (
            <article
              className={
                plan.featured
                  ? "rounded-lg border border-emerald-300/50 bg-emerald-400/[0.07] p-6 shadow-[0_25px_100px_rgba(16,185,129,0.16)]"
                  : `rounded-lg p-6 ${plan.accent}`
              }
              key={plan.name}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-semibold text-zinc-50">{plan.name}</h3>
                  <div className="mt-3 flex items-end gap-3">
                    <div className="text-4xl font-semibold tracking-tight text-zinc-50">{plan.price}</div>
                    <div className="pb-1 text-sm text-zinc-400">{plan.billing}</div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">{plan.description}</p>
                </div>
                {plan.featured ? (
                  <span className="rounded-md bg-emerald-300 px-2.5 py-1 text-xs font-bold uppercase tracking-[0.14em] text-zinc-950">
                    Beta
                  </span>
                ) : null}
              </div>
              <ul className="mt-6 space-y-3 text-sm text-zinc-300">
                {plan.features.map((feature) => (
                  <li className="flex gap-3" key={feature}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-300" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <a
                href={plan.href}
                className={
                  plan.featured
                    ? "mt-7 inline-flex h-12 w-full items-center justify-center rounded-md bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px disabled:cursor-wait disabled:opacity-70"
                    : "mt-7 inline-flex h-12 w-full items-center justify-center rounded-md border border-zinc-700 px-5 text-sm font-semibold text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px"
                }
              >
                {plan.cta}
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="relative z-10 border-t border-zinc-800/80 bg-zinc-950/90">
        <div className="mx-auto max-w-7xl px-6 py-16">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Quick Start</div>
            <h2 className="mt-4 text-4xl font-semibold text-zinc-50">Install once, authenticate once, then run deep remediation from any terminal.</h2>
            <p className="mt-4 text-base leading-7 text-zinc-400">
              Phase 1 stays local and private. Phase 2 only kicks in for the remaining SQL and architectural flaws that need the Pro Engine.
            </p>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            {quickStartBlocks.map((block) => (
              <article className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5" key={block.label}>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">{block.label}</div>
                <h3 className="mt-3 text-lg font-semibold text-zinc-50">{block.title}</h3>
                <pre className="mt-4 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 text-sm leading-7 text-zinc-200">
                  <code>{block.lines.join("\n")}</code>
                </pre>
              </article>
            ))}
          </div>

          <div className="mt-6 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] px-5 py-4 text-sm leading-7 text-emerald-100">
            <span className="font-semibold text-emerald-200">⚡ Frictionless Workflow:</span> PreFlight registers as a core system utility. You don't have to navigate to a specific installation folder or invoke complex script commands every time. Simply open any terminal, jump into a project, and run <code className="rounded bg-zinc-950/80 px-1.5 py-0.5 text-zinc-100">preflight scan .</code> to optimize your codebase on the fly.
          </div>
        </div>
      </section>
    </main>
  );
}
