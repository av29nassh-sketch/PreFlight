"use client";

import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip
} from "recharts";

type SeverityDatum = {
  name: "Red" | "Yellow" | "Green";
  value: number;
  color: string;
};

type SeverityDonutChartProps = {
  data: SeverityDatum[];
};

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-zinc-800 bg-zinc-950/60 text-sm text-zinc-500">
      No telemetry in this window
    </div>
  );
}

export function SeverityDonutChart({ data }: SeverityDonutChartProps) {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Severity Breakdown</h2>
          <p className="mt-1 text-sm text-zinc-500">Red blocks, yellow review gates, and green receipts.</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300">
          30 days
        </div>
      </div>

      <div className="mt-5 h-72">
        {total === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="84%"
                paddingAngle={3}
                stroke="none"
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                cursor={false}
                contentStyle={{
                  background: "#09090b",
                  border: "1px solid #27272a",
                  borderRadius: 8,
                  color: "#fafafa"
                }}
                formatter={(value, name) => [`${value} findings`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        {data.map((item) => (
          <div key={item.name} className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="text-xs font-medium text-zinc-400">{item.name}</span>
            </div>
            <div className="mt-1 text-lg font-semibold text-zinc-100">{item.value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
