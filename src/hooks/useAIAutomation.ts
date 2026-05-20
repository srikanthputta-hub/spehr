import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

function buildDifferential(complaint: string | null | undefined): string {
  const c = (complaint || "non-specific presentation").trim();
  return `AI Consult [Auto-Generated]: Based on presentation of ${c}, rule out Acute Coronary Syndrome, Pulmonary Embolism, and Aortic Dissection. Recommend STAT Troponin, 12-lead ECG, and CT Angiography of the chest.`;
}

/**
 * Background engine: for every newly admitted patient, waits 10s and writes
 * an AI_DIFFERENTIAL note into clinical_notes. Idempotent — skips MRNs that
 * already have an AI note in the DB or are already scheduled this session.
 */
export function useAIAutomation() {
  const scheduled = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const scheduleFor = async (
      mrn: string | null | undefined,
      complaint: string | null | undefined,
    ) => {
      if (!mrn || scheduled.current.has(mrn)) return;
      scheduled.current.add(mrn);

      const { data: existing } = await supabase
        .from("clinical_notes")
        .select("id")
        .eq("mrn", mrn)
        .eq("note_type", "AI_DIFFERENTIAL")
        .limit(1);
      if (cancelled) return;
      if (existing && existing.length > 0) return;

      const t = setTimeout(async () => {
        if (cancelled) return;
        try {
          const { error } = await supabase.from("clinical_notes").insert({
            mrn,
            note_type: "AI_DIFFERENTIAL",
            author: "Ghost AI Differential Engine",
            content: buildDifferential(complaint),
          });
          if (error) throw error;
        } catch (error) {
          console.log("AI Differential Error: ", error);
          // Allow UI consumers to fall back to a local mock — they handle
          // their own timeout-based fallback so we just log here.
        }
      }, 10_000);
      timers.push(t);
    };

    (async () => {
      const { data } = await supabase
        .from("patients")
        .select("mrn, chief_complaint, status")
        .eq("status", "Admitted");
      if (cancelled || !data) return;
      for (const p of data as Array<{ mrn: string | null; chief_complaint: string | null }>) {
        scheduleFor(p.mrn, p.chief_complaint);
      }
    })();

    const channel = supabase
      .channel("ai-automation-patients")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "patients" },
        (payload: any) => {
          const p = payload.new;
          if (p?.status === "Admitted") scheduleFor(p.mrn, p.chief_complaint);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "patients" },
        (payload: any) => {
          const p = payload.new;
          if (p?.status === "Admitted") scheduleFor(p.mrn, p.chief_complaint);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
      supabase.removeChannel(channel);
    };
  }, []);
}