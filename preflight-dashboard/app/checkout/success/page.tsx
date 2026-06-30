import Link from "next/link";

export const metadata = {
  title: "PreFlight Repo Risk Report Ordered",
  description: "Next steps after ordering your private PreFlight Repo Risk Report."
};

type CheckoutSuccessPageProps = {
  searchParams?: Promise<{
    checkout_id?: string | string[];
  }>;
};

function normalizeCheckoutId(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }

  return value || "";
}

export default async function CheckoutSuccessPage({ searchParams }: CheckoutSuccessPageProps) {
  const params = searchParams ? await searchParams : {};
  const checkoutId = normalizeCheckoutId(params.checkout_id);
  const emailBody = encodeURIComponent(
    `Hey Avinash,\n\nI ordered the PreFlight Repo Risk Report.\n\nCheckout ID: ${checkoutId || "(not shown)"}\nPublic GitHub repo URL:\n\nThanks.`
  );
  const emailHref = `mailto:av29nassh@gmail.com?subject=PreFlight%20Repo%20Risk%20Report%20-%20Repo%20URL&body=${emailBody}`;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#08090c] px-6 py-10 text-[#f7f4ef]">
      <div className="technical-grid pointer-events-none absolute inset-0 opacity-70" />
      <div className="absolute left-1/2 top-0 h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-cyan-300/10 blur-3xl" />
      <section className="relative mx-auto flex min-h-[calc(100vh-80px)] w-full max-w-5xl items-center">
        <div className="grid w-full gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[34px] border border-white/12 bg-white/[0.055] p-7 shadow-[0_28px_120px_rgba(0,0,0,0.46)] backdrop-blur md:p-10">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-4 py-2 font-mono text-xs font-black uppercase tracking-[0.18em] text-emerald-200">
              Payment received
            </div>
            <h1 className="max-w-3xl text-5xl font-black leading-[0.92] tracking-[-0.07em] md:text-7xl">
              Your repo risk report is queued.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/68">
              Send your public GitHub repo URL now so I can run the manual verification pass and deliver your private PreFlight report within 48-72 hours.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                className="inline-flex min-h-14 items-center justify-center rounded-full bg-[#f35252] px-6 text-sm font-black text-white shadow-[0_18px_50px_rgba(243,82,82,0.28)] transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-200"
                href={emailHref}
              >
                Email repo URL
              </a>
              <Link
                className="inline-flex min-h-14 items-center justify-center rounded-full border border-white/16 bg-white/[0.06] px-6 text-sm font-black text-white/88 transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-200"
                href="/"
              >
                Back to PreFlight
              </Link>
            </div>
            {checkoutId ? (
              <p className="mt-6 rounded-2xl border border-white/10 bg-black/24 p-4 font-mono text-xs text-white/52">
                Checkout ID: <span className="text-white/78">{checkoutId}</span>
              </p>
            ) : null}
          </div>

          <aside className="rounded-[34px] border border-white/10 bg-black/30 p-7 backdrop-blur md:p-8">
            <p className="font-mono text-xs font-black uppercase tracking-[0.18em] text-cyan-200">
              What happens next
            </p>
            <ol className="mt-7 space-y-5">
              {[
                ["1", "Email your public GitHub repo URL to av29nassh@gmail.com."],
                ["2", "I scan the repo and manually verify the top security findings."],
                ["3", "You receive the private report plus your 30-day PreFlight Pro key."]
              ].map(([step, text]) => (
                <li className="flex gap-4" key={step}>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-200/25 bg-cyan-200/10 font-mono text-sm font-black text-cyan-100">
                    {step}
                  </span>
                  <span className="pt-1 text-sm leading-6 text-white/70">{text}</span>
                </li>
              ))}
            </ol>
            <div className="mt-8 rounded-3xl border border-yellow-200/20 bg-yellow-200/[0.07] p-5">
              <p className="text-sm font-bold text-yellow-100">Manual fulfillment note</p>
              <p className="mt-2 text-sm leading-6 text-white/62">
                This is not an automated scanner dump. The report is manually verified so you get useful findings, not noise.
              </p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
