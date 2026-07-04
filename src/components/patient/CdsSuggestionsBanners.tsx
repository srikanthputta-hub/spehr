import { useEffect, useState } from "react";
import { X, AlertTriangle, Siren } from "lucide-react";
import { ORDER_SETS, type Severity } from "@/lib/cds-order-sets";

type Stored = {
  version: 1;
  admissionKey: string | null;
  suggestions: Array<{ id: string; firedAt: string; dismissed?: boolean }>;
};

function keyFor(mrn: string) {
  return `spehr.cds.suggestions.${mrn}`;
}

function read(mrn: string): Stored | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(keyFor(mrn));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j?.version !== 1) return null;
    return j as Stored;
  } catch {
    return null;
  }
}

function write(mrn: string, payload: Stored) {
  try {
    window.localStorage.setItem(keyFor(mrn), JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent("spehr:cds", { detail: { mrn } }));
  } catch {
    /* noop */
  }
}

const SEVERITY_STYLES: Record<Severity, { wrap: string; text: string; icon: string }> = {
  critical: {
    wrap: "border-red-700 bg-red-100/90",
    text: "text-red-900",
    icon: "text-red-700",
  },
  red: {
    wrap: "border-red-400 bg-red-50",
    text: "text-red-900",
    icon: "text-red-600",
  },
  amber: {
    wrap: "border-amber-300 bg-amber-50",
    text: "text-amber-900",
    icon: "text-amber-600",
  },
};

export default function CdsSuggestionsBanners({ mrn }: { mrn: string }) {
  const [state, setState] = useState<Stored | null>(() => read(mrn));
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setState(read(mrn));
    const onEvt = (e: Event) => {
      const detailMrn = (e as CustomEvent).detail?.mrn;
      if (!detailMrn || detailMrn === mrn) setState(read(mrn));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(mrn)) setState(read(mrn));
    };
    window.addEventListener("spehr:cds", onEvt as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("spehr:cds", onEvt as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [mrn]);

  const dismiss = (id: string) => {
    if (!state) return;
    const next: Stored = {
      ...state,
      suggestions: state.suggestions.map((s) =>
        s.id === id ? { ...s, dismissed: true } : s,
      ),
    };
    setState(next);
    write(mrn, next);
  };

  const active = (state?.suggestions ?? []).filter((s) => !s.dismissed && ORDER_SETS[s.id]);
  const openSet = openId ? ORDER_SETS[openId] : null;

  if (active.length === 0 && !openSet) return null;

  return (
    <>
      <div className="mx-3 mt-2 space-y-2">
        {active.map((s) => {
          const os = ORDER_SETS[s.id];
          const sev = SEVERITY_STYLES[os.severity];
          const Icon = os.severity === "amber" ? AlertTriangle : Siren;
          return (
            <div
              key={s.id}
              className={`flex items-start gap-2 rounded border px-3 py-2 text-[12px] ${sev.wrap} ${sev.text}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 flex-none ${sev.icon}`} />
              <div className="flex-1 font-semibold">{os.label}</div>
              <button
                onClick={() => setOpenId(s.id)}
                className="rounded border border-current/40 bg-white/70 px-2 py-0.5 text-[11px] font-semibold hover:bg-white"
              >
                View Order Set
              </button>
              <button
                onClick={() => dismiss(s.id)}
                className="rounded p-0.5 hover:bg-black/5"
                aria-label="Dismiss suggestion"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {openSet && (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          <button
            className="flex-1 bg-black/40"
            aria-label="Close order set"
            onClick={() => setOpenId(null)}
          />
          <aside className="w-full max-w-md bg-white shadow-2xl flex flex-col">
            <header
              className={`flex items-center justify-between px-4 py-3 border-b ${SEVERITY_STYLES[openSet.severity].wrap} ${SEVERITY_STYLES[openSet.severity].text}`}
            >
              <div className="text-sm font-semibold">{openSet.label}</div>
              <button
                onClick={() => setOpenId(null)}
                className="rounded p-0.5 hover:bg-black/10"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 py-3 text-[13px] text-slate-800">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
                Suggested Order Set — display only
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {openSet.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </div>
            <footer className="border-t border-slate-200 px-4 py-2 text-right">
              <button
                onClick={() => setOpenId(null)}
                className="rounded border border-slate-300 bg-white px-3 py-1 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}