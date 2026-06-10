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
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-5 shadow-[0_18px_80px_rgba(0,0,0,0.26)] backdrop-blur-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Drift Timeline</h2>
          <p className="mt-1 text-sm text-zinc-500">Daily intercept volume from CLI, CI, and MCP loops.</p>
        </div>
        <div className="rounded-md border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 font-mono text-xs font-medium text-cyan-200">
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
                border: "1px solid #3f3f46",
                borderRadius: 8,
                color: "#fafafa"
              }}
              labelStyle={{ color: "#d4d4d8" }}
            />
            <Line type="monotone" dataKey="red" name="Red" stroke="#fb7185" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="yellow" name="Yellow" stroke="#fbbf24" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="total" name="Total" stroke="#67e8f9" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
