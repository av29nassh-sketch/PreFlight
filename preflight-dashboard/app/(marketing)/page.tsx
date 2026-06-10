const terminalLines = [
  { tone: "muted", text: "$ preflight scan --fix" },
  { tone: "warn", text: "HIGH-RISK DRIFT detected in app/api/billing/route.ts" },
  { tone: "muted", text: "-> Sending complex remediation context to Claude 3.5 Sonnet..." },
  { tone: "bad", text: "- const polar = new Polar({ accessToken: 'polar_live_...' })" },
  { tone: "good", text: "+ const polar = new Polar({ accessToken: process.env.POLAR_ACCESS_TOKEN! })" },
  { tone: "good", text: "✓ Patched unsafe secret handling without changing route behavior" },
  { tone: "muted", text: "PreFlight remediation attempted 1 fix: 1 applied, 0 skipped" }
];

const proofCards = [
  {
    eyebrow: "Local-first gate",
    title: "Stops AI drift before commit",
    copy: "Run read-only scans locally, then opt into reviewed auto-heal only when you ask for it."
  },
  {
    eyebrow: "Claude remediation",
    title: "Deep fixes for risky logic",
    copy: "Complex auth, billing, webhook, and tenant-boundary fixes route through the cloud only when local AST proof surrenders."
  },
  {
    eyebrow: "Governance ready",
    title: "Telemetry for teams",
    copy: "Track intercepted red and yellow findings across CLI, CI, and MCP loops from the dashboard."
  }
];

const pricing = [
  {
    name: "Free",
    price: "$0",
    description: "Five cloud remediation credits for private beta testers and solo builders.",
    features: ["5 free trial credits", "Local AST scan", "Interactive fix prompts", "No source upload for local checks"],
    cta: "Use 5 free fixes",
    href: "/dashboard",
    muted: true
  },
  {
    name: "Solo",
    price: "$19/mo",
    description: "For founders and vibecoders shipping with Cursor, Claude, and Copilot.",
    features: ["Unlimited deep-logic remediation", "Claude 3.5 Sonnet patching", "CLI login", "Polar/Supabase/Next.js guardrails"],
    cta: "Start Solo remediation",
    href: `/signup?redirect_to=${encodeURIComponent("https://polar.sh/YOUR_ORG/products/preflight-solo")}`,
    featured: true
  },
  {
    name: "Teams",
    price: "$49/seat/mo",
    description: "For engineering teams enforcing AI-code safety across repos.",
    features: ["Everything in Solo", "Org repository enforcement", "Team telemetry dashboard", "CI and MCP governance"],
    cta: "Start team checkout",
    href: `/signup?redirect_to=${encodeURIComponent("https://polar.sh/YOUR_ORG/products/preflight-teams")}`
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
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            <a className="rounded-md px-3 py-2 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" href="/dashboard">
              Dashboard
            </a>
            <a className="rounded-md border border-zinc-700 px-3 py-2 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" href="/login">
              Login
            </a>
          </div>
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
            Catch unsafe AI-generated auth, billing, RLS, webhook, SSRF, and secret-handling changes before they hit production. Local AST proof first. Claude remediation only when the fix needs deeper context.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a className="inline-flex h-12 items-center justify-center rounded-md bg-emerald-300 px-5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px" href="#pricing">
              Compare plans
            </a>
            <a className="inline-flex h-12 items-center justify-center rounded-md border border-zinc-700 px-5 text-sm font-semibold text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px" href="/dashboard">
              Open dashboard
            </a>
          </div>
          <div className="mt-8 grid max-w-2xl grid-cols-3 gap-3 text-sm">
            {["AST proof", "Claude patching", "Polar MoR"].map((item) => (
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
          {proofCards.map((card) => (
            <article className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5" key={card.title}>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">{card.eyebrow}</div>
              <h2 className="mt-4 text-xl font-semibold text-zinc-50">{card.title}</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">{card.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto max-w-7xl px-6 py-16" id="pricing">
        <div className="max-w-2xl">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Pricing</div>
          <h2 className="mt-4 text-4xl font-semibold text-zinc-50">Start free, upgrade when Claude starts doing the heavy lifting.</h2>
          <p className="mt-4 text-base leading-7 text-zinc-400">
            Free local scans stay local. Paid tiers unlock unlimited deep-logic AI remediation and governance workflows.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {pricing.map((plan) => (
            <article
              className={
                plan.featured
                  ? "rounded-lg border border-emerald-300/50 bg-emerald-400/[0.07] p-6 shadow-[0_25px_100px_rgba(16,185,129,0.16)]"
                  : "rounded-lg border border-zinc-800 bg-zinc-900/55 p-6"
              }
              key={plan.name}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-semibold text-zinc-50">{plan.name}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-400">{plan.description}</p>
                </div>
                {plan.featured ? (
                  <span className="rounded-md bg-emerald-300 px-2.5 py-1 text-xs font-bold uppercase tracking-[0.14em] text-zinc-950">
                    Pro
                  </span>
                ) : null}
              </div>
              <div className="mt-6 text-4xl font-semibold text-zinc-50">{plan.price}</div>
              <ul className="mt-6 space-y-3 text-sm text-zinc-300">
                {plan.features.map((feature) => (
                  <li className="flex gap-3" key={feature}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-300" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <a
                className={
                  plan.featured
                    ? "mt-7 inline-flex h-12 w-full items-center justify-center rounded-md bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 hover:bg-emerald-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px disabled:cursor-wait disabled:opacity-70"
                    : "mt-7 inline-flex h-12 w-full items-center justify-center rounded-md border border-zinc-700 px-5 text-sm font-semibold text-zinc-100 hover:border-zinc-500 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 active:translate-y-px"
                }
                href={plan.href}
              >
                {plan.cta}
              </a>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
