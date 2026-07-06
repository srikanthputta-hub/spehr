import { useEffect, useState } from "react";
import { CheckCircle2, X, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoHint } from "@/components/ui/info-hint";
import {
  getQaQueue,
  approveQaItem,
  rejectQaItem,
} from "@/lib/auto-api.functions";

type Item = {
  id: string;
  mrn: string;
  patient_name: string | null;
  complaint_snippet: string | null;
  confidence: number;
  proposed_codes: Record<string, string[]>;
  facility_name: string | null;
  sla_expires_at: string;
};

function pct(n: number) {
  return `${Number(n).toFixed(0)}%`;
}

function tone(c: number) {
  if (c >= 90) return "bg-lime-100 text-lime-800 border-lime-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

function CountdownBar({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const end = new Date(expiresAt).getTime();
  const remaining = Math.max(0, end - now);
  const total = 60_000;
  const pctRemain = Math.min(100, (remaining / total) * 100);
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <Timer className="h-3 w-3 text-slate-400" />
      <div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full ${pctRemain < 25 ? "bg-rose-500" : "bg-sky-500"}`}
          style={{ width: `${pctRemain}%` }}
        />
      </div>
      <span className="font-mono text-slate-500">
        {Math.ceil(remaining / 1000)}s SLA
      </span>
    </div>
  );
}

export function QaGovernanceQueue({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const res = await getQaQueue();
    setItems((res.items as Item[]) ?? []);
    onCountChange?.((res.items ?? []).length);
  };

  useEffect(() => {
    void load();
    const id = setInterval(load, 8_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async (id: string) => {
    setBusy(id);
    try {
      await approveQaItem({ data: { id } });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const reject = async (id: string) => {
    setBusy(id);
    try {
      await rejectQaItem({ data: { id } });
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-violet-200 bg-violet-50/30 p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-900">
            NLP Confidence & QA Governance Queue
          </h3>
          <InfoHint text="Mappings scoring 80–94% confidence are held here for mandatory administrator review before FHIR push. 95% or higher auto-commits; below 80% auto-rejects." />
          <Badge variant="outline" className="bg-white text-violet-700 border-violet-300">
            {items.length} pending
          </Badge>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500">
          AUTO API · NLP_CONFIDENCE_GATE
        </div>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-700">
          ✓ All NLP mappings are within auto-commit confidence thresholds. No
          items pending review.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const icd10 = (it.proposed_codes?.["ICD-10"] as string[]) ?? [];
            const snomed = (it.proposed_codes?.["SNOMED CT"] as string[]) ?? [];
            return (
              <div
                key={it.id}
                className="rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px] text-slate-500">
                        {it.mrn}
                      </span>
                      <span className="text-sm font-semibold text-slate-900">
                        {it.patient_name ?? "—"}
                      </span>
                      <Badge
                        variant="outline"
                        className={tone(it.confidence)}
                      >
                        {pct(it.confidence)} confidence
                      </Badge>
                    </div>
                    {it.complaint_snippet && (
                      <div className="text-xs text-slate-600 mt-0.5 truncate">
                        “{it.complaint_snippet}”
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 flex-wrap mt-2">
                      {icd10.map((c) => (
                        <span
                          key={c}
                          className="rounded-full bg-orange-50 text-orange-700 border border-orange-200 px-2 py-0.5 text-[10px] font-mono"
                        >
                          ICD-10 · {c}
                        </span>
                      ))}
                      {snomed.map((c) => (
                        <span
                          key={c}
                          className="rounded-full bg-violet-50 text-violet-700 border border-violet-200 px-2 py-0.5 text-[10px] font-mono"
                        >
                          SNOMED · {c}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full ${
                          it.confidence >= 90 ? "bg-lime-500" : "bg-amber-500"
                        }`}
                        style={{ width: `${Math.min(100, it.confidence)}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <CountdownBar expiresAt={it.sla_expires_at} />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        disabled={busy === it.id}
                        onClick={() => approve(it.id)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                        Approve & Push
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-rose-200 text-rose-700 hover:bg-rose-50"
                        disabled={busy === it.id}
                        onClick={() => reject(it.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}