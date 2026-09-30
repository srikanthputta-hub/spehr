import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Lucide icon component — defaults to a plain inbox icon. No illustration library. */
  icon?: LucideIcon;
  /** One sentence explaining why this is empty (not a generic "No data"). */
  description: string;
  /** Optional short title above the description. */
  title?: string;
  /** Optional single action, e.g. "Create order" or "Clear filters". */
  action?: EmptyStateAction;
}

/**
 * EmptyState — icon + one sentence + optional action.
 *
 * Deliberately not an illustration/graphic — the charter calls out
 * over-engineered empty states as a thing to avoid here.
 */
function EmptyState({
  className,
  icon: Icon = Inbox,
  title,
  description,
  action,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      {title && <div className="text-sm font-semibold text-foreground">{title}</div>}
      <p className="max-w-sm text-sm font-normal text-muted-foreground">{description}</p>
      {action && (
        <Button size="sm" variant="outline" className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export { EmptyState };
export default EmptyState;
