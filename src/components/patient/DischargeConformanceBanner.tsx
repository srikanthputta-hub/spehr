import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

type State = { count: number; at: string; dismissed: boolean } | null;

function keyFor(mrn: string) {
  return `spehr.discharge.conformance.${mrn}`;
}

function read(mrn: string): State {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(keyFor(mrn));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (typeof j?.count !== "number") return null;
    return { count: j.count, at: String(j.at ?? ""), dismissed: !!j.dismissed };
  } catch {
    return null;
  }
}

export default function DischargeConformanceBanner({ mrn }: { mrn: string }) {
  const [state, setState] = useState<State>(() => read(mrn));

  useEffect(() => {
    setState(read(mrn));
    const onEvt = (e: Event) => {
      const detailMrn = (e as CustomEvent).detail?.mrn;
      if (!detailMrn || detailMrn === mrn) setState(read(mrn));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(mrn)) setState(read(mrn));
    };
    window.addEventListener("spehr:conformance", onEvt as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("spehr:conformance", onEvt as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, [mrn]);

  if (!state || state.dismissed || state.count <= 0) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(
        keyFor(mrn),
        JSON.stringify({ ...state, dismissed: true }),
      );
    } catch {
      /* noop */
    }
    setState({ ...state, dismissed: true });
  };

  return (
    <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
      <div className="flex-1">
        <span className="font-semibold">⚠ {state.count} non-conformant code{state.count === 1 ? "" : "s"} detected</span>
        <span className="ml-1">— review before sharing externally.</span>
      </div>
      <button
        onClick={dismiss}
        className="rounded p-0.5 text-amber-700 hover:bg-amber-100"
        aria-label="Dismiss conformance warning"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}