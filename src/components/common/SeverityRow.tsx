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
 * Usable as a className helper (`severityRowVariants({ severity })` on an
 * existing <tr>/<div>) or via the <SeverityRow> wrapper below when a plain
 * element is enough.
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
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof severityRowVariants> {}

function SeverityRow({ className, severity, interactive, ...props }: SeverityRowProps) {
  return (
    <div className={cn(severityRowVariants({ severity, interactive }), className)} {...props} />
  );
}

export { SeverityRow, severityRowVariants };
export default SeverityRow;
