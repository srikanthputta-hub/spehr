import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * severityRowVariants — the "one more visual weight than urgent" helper.
 *
 * Critical/severe rows in a table or list get a left border-accent stripe
 * IN ADDITION TO their status badge, so a scanning clinician's peripheral
 * vision catches them before they read the text. Pair with row-hover
 * (mandatory on any clickable/actionable row) via the `interactive` prop.
 *
 * Usable as a className helper (`severityRowVariants({ severity })`) on an
 * existing <div>/<li>/<button>, or via the <SeverityRow> wrapper below when
 * a plain element is enough.
 *
 * NOT on a <tr> directly: per the CSS table-rendering spec, a border set
 * on a table ROW is never painted under border-collapse: separate (the
 * default) — only td/th borders render. In an HTML <table>, apply this to
 * the row's first <td>/<th> instead (see finance-board.tsx's Coverage Gaps
 * table), with `pl-3` compensating for the 4px border so the cell's text
 * keeps the same left inset as its sibling cells.
 */
const severityRowVariants = cva("border-l-4 pl-3 -ml-px", {
  variants: {
    severity: {
      critical: "border-l-critical",
      warning: "border-l-warning",
      none: "border-l-transparent",
    },
    interactive: {
      true: "transition-colors hover:bg-muted/50 cursor-pointer",
      false: "",
    },
  },
  defaultVariants: {
    severity: "none",
    interactive: false,
  },
});

export interface SeverityRowProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof severityRowVariants> {}

function SeverityRow({ className, severity, interactive, ...props }: SeverityRowProps) {
  return (
    <div className={cn(severityRowVariants({ severity, interactive }), className)} {...props} />
  );
}

export { SeverityRow, severityRowVariants };
export default SeverityRow;
