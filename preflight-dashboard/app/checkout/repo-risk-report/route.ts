import { NextResponse } from "next/server";

const fallbackEmailUrl =
  "mailto:av29nassh@gmail.com?subject=PreFlight%20Repo%20Risk%20Report&body=I%20want%20to%20order%20the%20%2449%20PreFlight%20Repo%20Risk%20Report.%0A%0ARepo%20URL%3A%20%0AEmail%3A%20";

export function GET() {
  const checkoutUrl =
    process.env.POLAR_REPO_RISK_REPORT_CHECKOUT_URL ||
    process.env.NEXT_PUBLIC_POLAR_REPO_RISK_REPORT_CHECKOUT_URL;

  if (checkoutUrl) {
    return NextResponse.redirect(checkoutUrl, 302);
  }

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Order PreFlight Repo Risk Report</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #08090c;
        color: #f7f4ef;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: min(560px, calc(100vw - 32px));
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 28px;
        padding: 32px;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03));
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.36);
      }
      .eyebrow {
        color: #53eafd;
        font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0 12px;
        font-size: clamp(34px, 8vw, 54px);
        line-height: 0.92;
        letter-spacing: -0.06em;
      }
      p {
        color: rgba(247, 244, 239, 0.74);
        font-size: 16px;
        line-height: 1.7;
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 18px;
        min-height: 52px;
        padding: 0 22px;
        border-radius: 999px;
        background: #f35252;
        color: white;
        font-weight: 800;
        text-decoration: none;
      }
      .note {
        margin-top: 18px;
        font-size: 13px;
        color: rgba(247, 244, 239, 0.55);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">Checkout is being configured</div>
      <h1>Order the $49 Repo Risk Report.</h1>
      <p>The secure checkout link is not connected on this deployment yet. Until it is live, email the repo URL and I will send payment instructions manually.</p>
      <a href="${fallbackEmailUrl}">Email Avinash to order</a>
      <p class="note">To enable direct checkout, add POLAR_REPO_RISK_REPORT_CHECKOUT_URL in Vercel and redeploy.</p>
    </main>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  );
}
