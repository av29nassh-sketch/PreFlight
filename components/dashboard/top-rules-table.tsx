type RuleRow = {
  ruleId: string;
  count: number;
  red: number;
  yellow: number;
  lastSeen: string;
};

type TopRulesTableProps = {
  rows: RuleRow[];
};

export function TopRulesTable({ rows }: TopRulesTableProps) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-5 py-4">
        <h2 className="text-sm font-semibold text-zinc-100">Top Triggered Rules</h2>
        <p className="mt-1 text-sm text-zinc-500">Most frequent structural drift patterns across active repositories.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="bg-zinc-900/70 text-xs uppercase tracking-[0.12em] text-zinc-500">
            <tr>
              <th className="px-5 py-3 font-medium">Rule</th>
              <th className="px-5 py-3 font-medium">Total</th>
              <th className="px-5 py-3 font-medium">Red</th>
              <th className="px-5 py-3 font-medium">Yellow</th>
              <th className="px-5 py-3 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-zinc-500">
                  No triggered rules in the last 30 days.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.ruleId} className="bg-zinc-950">
                  <td className="px-5 py-4">
                    <code className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100">
                      {row.ruleId}
                    </code>
                  </td>
                  <td className="px-5 py-4 font-medium text-zinc-100">{row.count}</td>
                  <td className="px-5 py-4 text-red-300">{row.red}</td>
                  <td className="px-5 py-4 text-amber-300">{row.yellow}</td>
                  <td className="px-5 py-4 text-zinc-400">{row.lastSeen}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
