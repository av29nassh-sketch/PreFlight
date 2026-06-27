"use client";

import { useState } from "react";
import { ArrowRight, Check, CreditCard, QrCode } from "lucide-react";

type PaymentTab = "card" | "upi";

const features = [
  "Full local CLI background daemon (forever)",
  "Real-time VS Code Companion Extension (forever)",
  "Advanced MCP Server for Claude/Cursor integration (forever)",
  "Lifetime updates with zero recurring fees or hidden expirations"
];

const safetyNotice =
  "⚠️ Beta Architecture & Safety Notice: PreFlight Pro is currently in active Beta. While our local AST daemon is designed to catch severe structural anomalies, hallucinated syntax, and potential Supabase RLS drifts in real-time, it does not guarantee 100% error elimination. AI-assisted code should always be explicitly reviewed by a senior engineer before being pushed to a production environment. Use PreFlight as an advanced automated guardrail, not a replacement for manual code review.";

interface FounderOfferCardProps {
  checkoutUrl: string;
}

export function FounderOfferCard({ checkoutUrl }: FounderOfferCardProps) {
  const [activeTab, setActiveTab] = useState<PaymentTab>("card");
  const [qrAvailable, setQrAvailable] = useState(true);

  return (
    <section className="relative z-10 mx-auto max-w-7xl px-6 pb-24" id="pricing">
      <div className="relative overflow-hidden rounded-[2rem] border border-cyan-300/25 bg-[linear-gradient(145deg,rgba(34,211,238,0.12),rgba(255,255,255,0.035)_38%,rgba(10,10,10,0.92))] p-6 shadow-[0_40px_140px_rgba(0,0,0,0.55)] md:p-8 lg:p-10">
        <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200 to-transparent" />
        <div className="absolute -right-28 top-10 h-72 w-72 rounded-full bg-cyan-300/10 blur-3xl" />
        <div className="absolute -bottom-32 left-16 h-72 w-72 rounded-full bg-emerald-300/10 blur-3xl" />

        <div className="relative grid gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
          <div>
            <div className="inline-flex items-center rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.22em] text-emerald-200">
              All-in weekend offer
            </div>
            <h2 className="mt-6 max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-white md:text-6xl">
              Founder&apos;s Lifetime Pass
            </h2>
            <div className="mt-6 rounded-3xl border border-white/10 bg-black/35 p-5">
              <p className="text-xl font-semibold tracking-[-0.02em] text-zinc-500 line-through md:text-2xl">
                $35 / ₹3,000 (Standard Lifetime)
              </p>
              <p className="text-3xl font-semibold tracking-[-0.03em] text-white md:text-5xl">
                $30 / ₹2,499
              </p>
              <p className="mt-2 text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200">
                One-Time Payment
              </p>
              <p className="mt-4 text-base leading-7 text-zinc-300">
                Strictly limited to launch weekend. Permanently changes to a recurring $19/month subscription on Sunday night.
              </p>
            </div>

            <ul className="mt-6 space-y-3 text-sm text-zinc-200">
              {features.map((feature) => (
                <li className="flex gap-3" key={feature}>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-[1.7rem] border border-white/10 bg-black/55 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            <div className="grid gap-2 rounded-2xl bg-white/[0.04] p-1 sm:grid-cols-2">
              <button
                className={
                  activeTab === "card"
                    ? "inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-bold text-zinc-950"
                    : "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                }
                onClick={() => setActiveTab("card")}
                type="button"
              >
                <CreditCard className="h-4 w-4" />
                Pay Globally via Credit Card
              </button>
              <button
                className={
                  activeTab === "upi"
                    ? "inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-bold text-zinc-950"
                    : "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
                }
                onClick={() => setActiveTab("upi")}
                type="button"
              >
                <QrCode className="h-4 w-4" />
                Pay in India via UPI
              </button>
            </div>

            {activeTab === "card" ? (
              <div className="mt-5 rounded-3xl border border-cyan-300/20 bg-cyan-300/[0.07] p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-200">
                  Global checkout
                </p>
                <div className="mt-4 rounded-2xl border border-dashed border-cyan-200/45 bg-black/35 px-4 py-3 text-sm font-semibold leading-6 text-cyan-50">
                  🏷️ Use code DISCOUNTHUB at checkout for the $30 weekend rate
                </div>
                <p className="mt-3 text-lg font-semibold text-white">
                  Pay by card and receive your Founder&apos;s Key after confirmation.
                </p>
                <a
                  className="mt-6 inline-flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-cyan-200 px-5 text-sm font-bold text-zinc-950 transition hover:bg-white active:translate-y-px"
                  href={checkoutUrl}
                >
                  Open Polar Checkout
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            ) : (
              <div className="mt-5 rounded-3xl border border-emerald-300/20 bg-emerald-300/[0.07] p-6 text-center">
                <div className="mb-5 rounded-2xl border border-dashed border-emerald-200/45 bg-black/35 px-4 py-3 text-sm font-semibold leading-6 text-emerald-50">
                  🏷️ Apply code DISCOUNTHUB mentally and pay ₹2,499
                </div>
                <div className="mx-auto flex min-h-72 max-w-sm items-center justify-center rounded-[1.5rem] border border-white/10 bg-white p-4">
                  {qrAvailable ? (
                    <img
                      alt="PreFlight Pro UPI QR code"
                      className="h-full max-h-64 w-full object-contain"
                      onError={() => setQrAvailable(false)}
                      src="/preflight-pro-upi.jpeg"
                    />
                  ) : (
                    <div className="px-5 text-center text-sm font-semibold text-zinc-900">
                      Add your QR image at public/preflight-pro-upi.jpeg
                    </div>
                  )}
                </div>
                <p className="mx-auto mt-5 max-w-md text-sm leading-6 text-emerald-50">
                  Scan the QR code and transfer exactly ₹2,499. Reply to your receipt email with your transaction ID or screenshot for instant key confirmation.
                </p>
              </div>
            )}

            <div className="mt-5 rounded-2xl border border-slate-600/30 bg-slate-950/55 px-4 py-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="text-xs leading-6 text-slate-400 md:text-[13px]">
                {safetyNotice}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
