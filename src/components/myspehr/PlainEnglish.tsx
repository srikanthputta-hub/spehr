import { useState } from "react";
import { ChevronRight, MessageCircle } from "lucide-react";
import { translateCode } from "@/lib/chv-translations";

/**
 * Collapsible "Plain English" translation chip used across MySpehr.
 * Defaults to expanded. Renders nothing if no translation matches OR if
 * Plain English Mode is globally disabled.
 */
export function PlainEnglish({
  system,
  code,
  display,
  enabled = true,
  defaultOpen = true,
}: {
  system?: string;
  code?: string | null;
  display?: string | null;
  enabled?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!enabled) return null;
  const text = translateCode(system ?? "", code ?? null, display);
  if (!text) return null;
  return (
    <div className="mt-1 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700 hover:bg-sky-100"
      >
        <MessageCircle className="h-3 w-3" />
        Plain English
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-1 pl-2 text-[12px] leading-snug text-slate-500 italic">
          {text}
        </div>
      )}
    </div>
  );
}