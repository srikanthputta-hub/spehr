import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * StatusBadge — the shared semantic-status badge.
 *
 * Always pairs a soft-tinted background with a matching text color AND a
 * short text label (never color alone — see the design-system charter's
 * badge rule). Uses only the semantic-status token tier (success / warning
 * / critical / info / neutral), never the brand hue.
 */
const statusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold leading-none transition-colors",
  {
    variants: {
      status: {
        success: "border-success/30 bg-success-soft text-success",
        warning: "border-warning/30 bg-warning-soft text-warning",
        critical: "border-critical/30 bg-critical-soft text-critical",
        info: "border-info/30 bg-info-soft text-info",
        neutral: "border-neutral/30 bg-neutral-soft text-neutral",
      },
    },
    defaultVariants: {
      status: "neutral",
    },
  },
);

export interface StatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof statusBadgeVariants> {
  /** Short text label — required, since color alone must never carry meaning. */
  label: string;
  /** Optional leading icon (e.g. a Lucide icon element) or status dot. */
  icon?: React.ReactNode;
}

function StatusBadge({ className, status, label, icon, ...props }: StatusBadgeProps) {
  return (
    <span className={cn(statusBadgeVariants({ status }), className)} {...props}>
      {icon}
      {label}
    </span>
  );
}

export { StatusBadge, statusBadgeVariants };
export default StatusBadge;
