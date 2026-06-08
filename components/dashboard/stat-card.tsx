type StatCardProps = {
  label: string;
  value: string;
  helper: string;
  tone?: "neutral" | "red" | "yellow" | "green";
};

const toneStyles = {
  neutral: "border-zinc-800 bg-zinc-950 text-zinc-100",
  red: "border-red-950/70 bg-red-950/20 text-red-100",
  yellow: "border-amber-950/70 bg-amber-950/20 text-amber-100",
  green: "border-emerald-950/70 bg-emerald-950/20 text-emerald-100"
};

export function StatCard({ label, value, helper, tone = "neutral" }: StatCardProps) {
  return (
    <section className={`rounded-lg border p-5 ${toneStyles[tone]}`}>
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-4 text-3xl font-semibold tracking-normal">{value}</div>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{helper}</p>
    </section>
  );
}
