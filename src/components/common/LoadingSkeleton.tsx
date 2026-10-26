import * as React from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * LoadingSkeleton — the shared loading-state convention.
 *
 * shadcn's `Skeleton` primitive is the right building block already; what
 * was missing was a convention for shaping it like the content it replaces
 * instead of a generic spinner. Use these for anything with a plausible
 * >500ms fetch (a table, a KPI row, a detail panel) so the layout doesn't
 * jump once data arrives.
 *
 * Reach for `Skeleton` directly for a one-off shape; reach for these when
 * the shape recurs across dashboards.
 */

export interface KpiRowSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of KPI tiles to mirror. Defaults to 3. */
  count?: number;
}

function KpiRowSkeleton({ className, count = 3, ...props }: KpiRowSkeletonProps) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", className)}
      {...props}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export interface TableSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of placeholder rows. Defaults to 5. */
  rows?: number;
  /** Number of placeholder columns. Defaults to 4. */
  columns?: number;
}

function TableSkeleton({ className, rows = 5, columns = 4, ...props }: TableSkeletonProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border py-2 last:border-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className={cn("h-4", c === 0 ? "w-1/4" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface CardSkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of body lines to mirror below the title bar. Defaults to 3. */
  lines?: number;
}

function CardSkeleton({ className, lines = 3, ...props }: CardSkeletonProps) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-4 flex flex-col gap-3", className)}
      {...props}
    >
      <Skeleton className="h-4 w-1/3" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full last:w-2/3" />
        ))}
      </div>
    </div>
  );
}

export { KpiRowSkeleton, TableSkeleton, CardSkeleton };
