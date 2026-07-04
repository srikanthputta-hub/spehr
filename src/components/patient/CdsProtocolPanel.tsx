import { useState } from "react";
import { X } from "lucide-react";
import { ORDER_SETS } from "@/lib/cds-order-sets";

type StoredSuggestion = {
  id: string;
  firedAt: string;
  dismissed?: boolean;
  triggerCode?: string;
  triggerDisplay?: string;
};

type Stored = {
  version: 1;
  admissionKey: string | null;
  suggestions: StoredSuggestion[];
};

function keyFor(mrn: string) {
  return `spehr.cds.suggestions.${mrn}`;
}

const HEADERS: Record<string, string> = {
  "acs": "🔴 ACS Protocol — Immediate Workup Suggested",
  "sepsis-bundle": "🔴 Sepsis Protocol — 3-Hour Bundle Suggested",
  "septic-shock": "🔴 Septic Shock — Escalated Protocol",
  "infection-workup": "⚠ Infection Workup — Suggested Order Set",
};

export default function CdsProtocolPanel({
  mrn,
  suggestion,
  onClose,
}: {
  mrn: string;
  suggestion: StoredSuggestion;
  onClose: () => void;
}) {
  const os = ORDER_SETS[suggestion.id];
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  if (!os) return null;

  const header = HEADERS[suggestion.id] ?? os.label;
  const isAmber = os.severity === "amber";
  const headerBg = isAmber
    ? "bg-amber-100 border-amber-400 text-amber-900"
    : os.severity === "critical"
      ? "bg-red-100 border-red-700 text-red-900"
      : "bg-red-50 border-red-400 text-red-900";

  const dismiss = () => {
    try {
      const raw = window.localStorage.getItem(keyFor(mrn));
      if (raw) {
        const j = JSON.parse(raw) as Stored;
        if (j?.version === 1 && Array.isArray(j.suggestions)) {
          const next: Stored = {
            ...j,
            suggestions: j.suggestions.map((s) =>
              s.id === suggestion.id ? { ...s, dismissed: true } : s,
            ),
          };
          window.localStorage.setItem(keyFor(mrn), JSON.stringify(next));
          window.dispatchEvent(new CustomEvent("spehr:cds", { detail: { mrn } }));
        }
      }
    } catch {
      /* noop */
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label="Close protocol"
        onClick={onClose}
      />
      <aside className="w-96 h-full bg-white shadow-2xl flex flex-col">
        <header className={`px-4 py-3 border-b ${headerBg}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-bold leading-snug">{header}</div>
            <button
              onClick={onClose}
              className="rounded p-0.5 hover:bg-black/10"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-1 text-[11px] text-slate-700">
            Triggered by:{" "}
            <span className="font-semibold">
              {suggestion.triggerDisplay ??
                (suggestion.triggerCode
                  ? `SNOMED ${suggestion.triggerCode}`
                  : "approved clinical concept")}
            </span>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
            Suggested Order Set — display only
          </div>
          <ul className="space-y-1.5">
            {os.items.map((it) => {
              const done = !!checked[it];
              return (
                <li key={it}>
                  <label className="flex items-start gap-2 text-[13px] text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-emerald-600"
                      checked={done}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [it]: e.target.checked }))
                      }
                    />
                    <span className={done ? "line-through text-slate-400" : ""}>{it}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="border-t border-slate-200 px-4 py-2 flex items-center justify-between">
          <button
            onClick={dismiss}
            className="rounded border border-red-300 bg-red-50 px-3 py-1 text-[12px] font-semibold text-red-800 hover:bg-red-100"
          >
            Dismiss Protocol
          </button>
          <button
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </footer>
      </aside>
    </div>
  );
}