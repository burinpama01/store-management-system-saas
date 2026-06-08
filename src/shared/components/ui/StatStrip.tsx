interface Stat {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}

interface Props {
  stats: Stat[];
}

export function StatStrip({ stats }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className="metric-card px-4 py-3">
          <p className="label-muted truncate">{stat.label}</p>
          <p
            className={`mt-1 stat-value truncate ${
              stat.accent ? "text-[var(--color-brand)]" : ""
            }`}
          >
            {stat.value}
          </p>
          {stat.sub && (
            <p className="mt-1 text-xs text-[var(--color-text-muted)] truncate">{stat.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}
