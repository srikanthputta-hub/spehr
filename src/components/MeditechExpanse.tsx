import { ReactNode } from "react";

/**
 * MEDITECH Expanse-style module ribbon — the dense, dark info strip
 * that sits directly under the global header on every Expanse module.
 * Renders a navy bar with monospaced metadata chips.
 */
export function ModuleRibbon({
  module,
  context,
  stats,
  right,
}: {
  module: string;
  context?: string;
  stats?: { label: string; value: ReactNode; tone?: "default" | "good" | "warn" | "bad" }[];
  right?: ReactNode;
}) {
  const toneClass = (t?: string) =>
    t === "good"
      ? "text-emerald-300"
      : t === "warn"
        ? "text-amber-300"
        : t === "bad"
          ? "text-red-300"
          : "text-cyan-200";
  return (
    <div className="border-b border-[#0a1a30] bg-gradient-to-r from-[#08172b] via-[#0c2340] to-[#0e2b4f] text-slate-100">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 px-6 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] uppercase tracking-[0.22em] text-slate-300">
            MEDITECH Expanse · {module}
          </span>
          {context && (
            <>
              <span className="text-slate-500">|</span>
              <span className="text-[11px] font-mono text-cyan-200">{context}</span>
            </>
          )}
        </div>
        {stats && stats.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {stats.map((s, i) => (
              <div key={i} className="flex items-baseline gap-1.5">
                <span className="text-[9px] uppercase tracking-[0.18em] text-slate-400">
                  {s.label}
                </span>
                <span className={`text-xs font-mono font-semibold ${toneClass(s.tone)}`}>
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        )}
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
    </div>
  );
}

/**
 * MEDITECH Expanse-style section header — uppercase tracking, navy fill,
 * thin teal underline. Used as the bar above every clinical panel/table.
 */
export function SectionHeader({
  icon,
  title,
  subtitle,
  right,
  tone = "navy",
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  tone?: "navy" | "teal" | "amber";
}) {
  const bg =
    tone === "teal"
      ? "from-[#0f5a6a] to-[#2d8a9e]"
      : tone === "amber"
        ? "from-[#7a4a08] to-[#b06f10]"
        : "from-[#0c2340] to-[#163b6b]";
  return (
    <div className={`flex items-center justify-between bg-gradient-to-r ${bg} px-4 py-2 border-b-2 border-[#2d8a9e]`}>
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="text-slate-100">{icon}</span>}
        <h3 className="text-[11px] uppercase tracking-[0.22em] font-bold text-white truncate">
          {title}
        </h3>
        {subtitle && (
          <span className="text-[10px] font-mono text-cyan-200 truncate">
            · {subtitle}
          </span>
        )}
      </div>
      {right && <div className="flex items-center gap-2 text-[10px] text-cyan-100">{right}</div>}
    </div>
  );
}

/**
 * Status pill with dot — MEDITECH Expanse convention. Color-coded by tone.
 */
export function StatusPill({
  tone = "default",
  children,
  pulse = false,
}: {
  tone?: "good" | "warn" | "bad" | "info" | "default";
  children: ReactNode;
  pulse?: boolean;
}) {
  const map = {
    good: "bg-emerald-100 text-emerald-800 ring-emerald-600/30",
    warn: "bg-amber-100 text-amber-800 ring-amber-600/30",
    bad: "bg-red-100 text-red-800 ring-red-600/30",
    info: "bg-cyan-100 text-cyan-800 ring-cyan-600/30",
    default: "bg-slate-100 text-slate-700 ring-slate-400/30",
  } as const;
  const dot = {
    good: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-red-500",
    info: "bg-cyan-500",
    default: "bg-slate-400",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${map[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]} ${pulse ? "animate-pulse" : ""}`} />
      {children}
    </span>
  );
}