type StatCardProps = {
  label: string;
  value: string;
  helper: string;
  tone?: "neutral" | "red" | "yellow" | "green";
};

const toneStyles = {
  neutral: "border-zinc-800 bg-zinc-900/70 text-zinc-100",
  red: "border-rose-400/25 bg-rose-400/[0.08] text-rose-100",
  yellow: "border-amber-300/25 bg-amber-300/[0.08] text-amber-100",
  green: "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-100"
};

export function StatCard({ label, value, helper, tone = "neutral" }: StatCardProps) {
  return (
    <section className={`rounded-lg border p-5 shadow-[0_18px_70px_rgba(0,0,0,0.22)] backdrop-blur-sm ${toneStyles[tone]}`}>
      <div className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-4 text-3xl font-semibold tracking-normal text-zinc-50">{value}</div>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{helper}</p>
    </section>
  );
}
