/**
 * Live 45-second SLA countdown badge + progress bar.
 * Flips amber under 15s, red+pulsing under 5s.
 *
 * Shared by:
 *   - System Admin → Medical Dictionary → Safety Alerts (SafetyQueue)
 *   - Physician Dashboard PatientSafetyAlertQueue
 *   - Pharmacy Queue held-order row
 */
export function SlaCountdown({
  autoResolveAt,
  createdAt,
  nowTs,
  compact = false,
}: {
  autoResolveAt: string | null;
  createdAt: string;
  nowTs: number;
  compact?: boolean;
}) {
  const TOTAL_MS = 45_000;
  const end = autoResolveAt
    ? new Date(autoResolveAt).getTime()
    : new Date(createdAt).getTime() + TOTAL_MS;
  const remaining = Math.max(0, end - nowTs);
  const secs = Math.ceil(remaining / 1000);
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const pct = Math.max(0, Math.min(100, (remaining / TOTAL_MS) * 100));
  const critical = remaining <= 5_000;
  const warning = remaining <= 15_000 && !critical;
  const tone = critical
    ? "border-red-300 bg-red-50 text-red-700"
    : warning
      ? "border-amber-300 bg-amber-50 text-amber-700"
      : "border-slate-300 bg-slate-50 text-slate-700";
  const barColor = critical
    ? "bg-red-500"
    : warning
      ? "bg-amber-500"
      : "bg-emerald-500";
  const widthClass = compact ? "w-36" : "w-44";
  return (
    <div
      className={`${widthClass} rounded-md border px-2 py-1 ${tone} ${critical ? "animate-pulse" : ""}`}
    >
      <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider">
        <span>SLA Auto-Fallback</span>
        <span className="font-mono">
          {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/60">
        <div
          className={`h-full ${barColor} transition-[width] duration-500 ease-linear`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}