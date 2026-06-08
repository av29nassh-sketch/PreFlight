"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type TimelineDatum = {
  date: string;
  label: string;
  red: number;
  yellow: number;
  total: number;
};

type DriftTimelineChartProps = {
  data: TimelineDatum[];
};

export function DriftTimelineChart({ data }: DriftTimelineChartProps) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Drift Timeline</h2>
          <p className="mt-1 text-sm text-zinc-500">Daily intercept volume from CLI, CI, and MCP loops.</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-300">
          Daily
        </div>
      </div>

      <div className="mt-5 h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: -18 }} accessibilityLayer>
            <CartesianGrid stroke="#27272a" strokeDasharray="4 6" vertical={false} />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              minTickGap={24}
              tick={{ fill: "#71717a", fontSize: 12 }}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#71717a", fontSize: 12 }}
            />
            <Tooltip
              contentStyle={{
                background: "#09090b",
                border: "1px solid #27272a",
                borderRadius: 8,
                color: "#fafafa"
              }}
              labelStyle={{ color: "#d4d4d8" }}
            />
            <Line type="monotone" dataKey="red" name="Red" stroke="#f43f5e" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="yellow" name="Yellow" stroke="#f59e0b" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="total" name="Total" stroke="#14b8a6" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
