import * as React from "react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";

import { cn } from "@/lib/utils";

export type KpiTrendDirection = "up" | "down" | "flat";

export interface KpiTrend {
  direction: KpiTrendDirection;
  /** Short label, e.g. "+4% vs. last week" — kept as text, not just an arrow. */
  label: string;
  /**
   * Whether an "up" trend is good news for this metric (default true).
   * Set to false for metrics where fewer/lower is better (e.g. wait time),
   * so the color reads correctly instead of always green-for-up.
   */
  positiveDirection?: "up" | "down";
}

export interface KpiTileProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The single headline number (or short string like "12m"). */
  value: React.ReactNode;
  /** The single label describing what the number is. */
  label: string;
  /** Optional trend indicator — resist adding more than this to a tile. */
  trend?: KpiTrend;
}

/**
 * KpiTile — one number, one label, one optional trend indicator.
 *
 * Deliberately resists sparklines/icons/gradients: the charter calls those
 * out as decoration that competes with the number a clinician needs to
 * read at a glance. Elevation is a hairline border only (no shadow on a
 * static tile).
 */
function KpiTile({ className, value, label, trend, ...props }: KpiTileProps) {
  const positive = trend?.positiveDirection ?? "up";
  const trendTone =
    !trend || trend.direction === "flat"
      ? "text-neutral"
      : trend.direction === positive
        ? "text-success"
        : "text-critical";

  const TrendIcon =
    trend?.direction === "up" ? TrendingUp : trend?.direction === "down" ? TrendingDown : Minus;

  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-4 flex flex-col gap-1", className)}
      {...props}
    >
      <div className="text-[22px] font-semibold leading-tight tabular-nums text-card-foreground">
        {value}
      </div>
      <div className="text-xs font-normal text-muted-foreground">{label}</div>
      {trend && (
        <div className={cn("mt-1 flex items-center gap-1 text-[11px] font-semibold", trendTone)}>
          <TrendIcon className="h-3 w-3" aria-hidden="true" />
          <span>{trend.label}</span>
        </div>
      )}
    </div>
  );
}

export { KpiTile };
export default KpiTile;
