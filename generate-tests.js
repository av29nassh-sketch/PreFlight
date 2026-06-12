const fs = require("node:fs");
const path = require("node:path");

const root = path.join(process.cwd(), "hardcore-test-suite");

function write(relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${contents.trim()}\n`, "utf8");
}

fs.rmSync(root, { recursive: true, force: true });

// preflight-ignore: ambiguous-ast
write(
  "app/actions/bad.ssrf.ts",
  `
export async function preview(formData: FormData) {
  "use server";
  const target = formData.get("url");
  return fetch(target as string);
}
`
);

// preflight-ignore: ambiguous-ast
write(
  "app/actions/fixed.ssrf.ts",
  `
import { validateOutboundUrl } from "@/lib/security/url";

export async function preview(formData: FormData) {
  "use server";
  const target = formData.get("url");
  const safeTarget = validateOutboundUrl(target);
  return fetch(safeTarget);
}
`
);

write(
  "lib/security/url.ts",
  `
export function validateOutboundUrl(value: FormDataEntryValue | null) {
  const parsed = new URL(String(value));
  if (!["https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported outbound protocol");
  }
  if (!["api.stripe.com", "example.com"].includes(parsed.hostname)) {
    throw new Error("Outbound host is not allowlisted");
  }
  return parsed.toString();
}
`
);

write(
  "app/client/bad.service-role.tsx",
  `
"use client";

export function ServiceRoleLeak() {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return <pre>{serviceRole}</pre>;
}
`
);

write(
  "app/client/fixed.service-role.tsx",
  `
"use client";

export function ServiceRoleStatus() {
  return <span>Server credentials are never rendered in client components.</span>;
}
`
);

write(
  "app/client/bad.stripe-secret.tsx",
  `
"use client";

export function CheckoutButton() {
  const stripeSecret = "sk_live_DEMO_PLACEHOLDER_1234567890abcdef";
  return <button data-token={stripeSecret}>Checkout</button>;
}
`
);

write(
  "app/client/fixed.stripe-secret.tsx",
  `
"use client";

export function CheckoutButton() {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  return <button data-token={publishableKey}>Checkout</button>;
}
`
);

write(
  "supabase/migrations/bad.rls-bypass.sql",
  `
create table public.profiles (
  id uuid primary key,
  email text not null
);

alter table public.profiles enable row level security;

create policy "bad_profiles_read_all"
on public.profiles
for select
using (true);
`
);

write(
  "supabase/migrations/fixed.rls-bypass.sql",
  `
create table public.accounts (
  id uuid primary key,
  email text not null
);

alter table public.accounts enable row level security;

create policy "fixed_accounts_read_self"
on public.accounts
for select
using (auth.uid() = id);
`
);

// preflight-ignore: ambiguous-ast
write(
  "app/api/webhooks/stripe/bad.webhook.ts",
  `
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const event = await req.json();
  if (event.type === "checkout.session.completed") {
    await fetch("https://internal.example/billing/sync");
  }
  return Response.json({ received: true });
}
`
);

write(
  "app/api/webhooks/stripe/fixed.webhook.ts",
  `
import Stripe from "stripe";
import { headers } from "next/headers";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const body = await req.text();
  const signature = (await headers()).get("stripe-signature");
  const event = stripe.webhooks.constructEvent(body, signature!, process.env.STRIPE_WEBHOOK_SECRET!);
  await markEventProcessedOnce(event.id);
  return Response.json({ received: true });
}

async function markEventProcessedOnce(eventId: string) {
  return eventId;
}
`
);

write(
  "staged-rls.diff",
  `
diff --git a/supabase/migrations/bad.rls-bypass.sql b/supabase/migrations/bad.rls-bypass.sql
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/supabase/migrations/bad.rls-bypass.sql
@@ -0,0 +1,9 @@
+create table public.profiles (
+  id uuid primary key,
+  email text not null
+);
+alter table public.profiles enable row level security;
+create policy "bad_profiles_read_all"
+on public.profiles
+for select
+using (true);
`
);

// preflight-ignore: ambiguous-ast
write(
  "staged-webhook.diff",
  `
diff --git a/app/api/webhooks/stripe/bad.webhook.ts b/app/api/webhooks/stripe/bad.webhook.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/app/api/webhooks/stripe/bad.webhook.ts
@@ -0,0 +1,9 @@
+import Stripe from "stripe";
+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
+export async function POST(req: Request) {
+  const event = await req.json();
+  if (event.type === "checkout.session.completed") {
+    await fetch("https://internal.example/billing/sync");
+  }
+  return Response.json({ received: true });
+}
`
);

write(
  "staged-fixed-rls.diff",
  `
diff --git a/supabase/migrations/fixed.rls-bypass.sql b/supabase/migrations/fixed.rls-bypass.sql
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/supabase/migrations/fixed.rls-bypass.sql
@@ -0,0 +1,9 @@
+create table public.accounts (
+  id uuid primary key,
+  email text not null
+);
+alter table public.accounts enable row level security;
+create policy "fixed_accounts_read_self"
+on public.accounts
+for select
+using (auth.uid() = id);
`
);

write(
  "staged-fixed-webhook.diff",
  `
diff --git a/app/api/webhooks/stripe/fixed.webhook.ts b/app/api/webhooks/stripe/fixed.webhook.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/app/api/webhooks/stripe/fixed.webhook.ts
@@ -0,0 +1,11 @@
+import Stripe from "stripe";
+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
+export async function POST(req: Request) {
+  const body = await req.text();
+  const event = stripe.webhooks.constructEvent(body, "sig", process.env.STRIPE_WEBHOOK_SECRET!);
+  await markEventProcessedOnce(event.id);
+  return Response.json({ received: true });
+}
+async function markEventProcessedOnce(eventId: string) {
+  return eventId;
+}
`
);

console.log(`Generated ${root}`);
