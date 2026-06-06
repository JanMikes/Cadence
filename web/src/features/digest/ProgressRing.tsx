/** A small SVG goal-progress ring ("3/5") — the digest's momentum signal (§10.3). */
export function ProgressRing({ done, total, size = 56 }: { done: number; total: number; size?: number }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const complete = total > 0 && done >= total;
  return (
    <div className="relative inline-flex items-center justify-center" aria-label={`${done} of ${total} done`}>
      <svg width={size} height={size} className="-rotate-90">
        <title>{`${done} of ${total} done`}</title>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          className={complete ? "text-green-400" : "text-primary"}
        />
      </svg>
      <span className="absolute text-xs font-semibold tabular-nums">
        {done}/{total}
      </span>
    </div>
  );
}
