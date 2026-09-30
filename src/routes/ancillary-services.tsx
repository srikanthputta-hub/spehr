import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Pill, FlaskConical, Scan, ArrowRight } from "lucide-react";
import { BoardHeader } from "@/components/BoardShell";
import { ModuleRibbon } from "@/components/ClinicalShell";
import { supabase } from "@/integrations/supabase/client";
import { useFacility } from "@/lib/facility-context";
import { KpiTile } from "@/components/common/KpiTile";

export const Route = createFileRoute("/ancillary-services")({
  head: () => ({
    meta: [
      { title: "Clinical Ancillary Services · S.P.E.H.R." },
      {
        name: "description",
        content:
          "Unified ancillary services hub — Pharmacy, Laboratory, and Radiology workspaces for the active facility.",
      },
    ],
  }),
  component: AncillaryHub,
});

type Counts = {
  pharmacyPending: number;
  pharmacyDispensed: number;
  labPending: number;
  labResulted: number;
  radPending: number;
  radReported: number;
};

const EMPTY: Counts = {
  pharmacyPending: 0,
  pharmacyDispensed: 0,
  labPending: 0,
  labResulted: 0,
  radPending: 0,
  radReported: 0,
};

function AncillaryHub() {
  const { facility } = useFacility();
  const [counts, setCounts] = useState<Counts>(EMPTY);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [pharmPending, pharmDisp, labPend, labRes, radPend, radRep] = await Promise.all([
        supabase
          .from("medication_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", [
            "Ordered", "Pending", "Pending Verification", "ORDERED", "PENDING",
            "PENDING_PHARMACY", "PENDING_VERIFICATION", "HELD_SAFETY_REVIEW",
          ]),
        supabase
          .from("medication_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", ["Dispensed", "DISPENSED", "Administered", "ADMINISTERED"]),
        supabase
          .from("lab_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", ["Ordered", "ORDERED", "Pending", "PENDING", "Pending Collection", "Processing", "PROCESSING"]),
        supabase
          .from("lab_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", ["Reported", "Resulted", "Completed"]),
        supabase
          .from("radiology_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", ["ordered", "Ordered", "ORDERED", "pending", "Pending", "PENDING"]),
        supabase
          .from("radiology_orders")
          .select("id", { count: "exact", head: true })
          .eq("facility_name", facility)
          .in("status", ["Reported", "REPORTED", "reported", "Completed"]),
      ]);
      if (!active) return;
      setCounts({
        pharmacyPending: pharmPending.count ?? 0,
        pharmacyDispensed: pharmDisp.count ?? 0,
        labPending: labPend.count ?? 0,
        labResulted: labRes.count ?? 0,
        radPending: radPend.count ?? 0,
        radReported: radRep.count ?? 0,
      });
    };
    load();
    const iv = setInterval(load, 12000);
    const channel = supabase
      .channel(`ancillary-hub-${facility}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "medication_orders" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "lab_orders" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "radiology_orders" }, load)
      .subscribe();
    return () => {
      active = false;
      clearInterval(iv);
      supabase.removeChannel(channel);
    };
  }, [facility]);

  return (
    <main className="min-h-screen bg-slate-50">
      <BoardHeader
        title={`Clinical Ancillary Services | ${facility}`}
        subtitle="Pharmacy · Laboratory · Radiology"
        badge="Ancillary Services"
      />
      <ModuleRibbon
        module="ANC"
        context={`${facility} · Ancillary Services Hub`}
        stats={[
          { label: "Rx Pending", value: counts.pharmacyPending, tone: counts.pharmacyPending > 0 ? "warn" : "good" },
          { label: "Lab Pending", value: counts.labPending, tone: counts.labPending > 0 ? "warn" : "good" },
          { label: "Rad Pending", value: counts.radPending, tone: counts.radPending > 0 ? "warn" : "good" },
          { label: "Mode", value: "Unified" },
        ]}
      />
      <section className="max-w-[1400px] mx-auto px-6 py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <TileCard
            to="/pharmacy-queue"
            title="Pharmacy"
            subtitle="Order verification & dispensing"
            icon={<Pill className="h-6 w-6" />}
            accent="teal"
            pending={counts.pharmacyPending}
            done={counts.pharmacyDispensed}
            doneLabel="Dispensed"
          />
          <TileCard
            to="/lab-board"
            title="Laboratory"
            subtitle="Specimen results & verification"
            icon={<FlaskConical className="h-6 w-6" />}
            accent="blue"
            pending={counts.labPending}
            done={counts.labResulted}
            doneLabel="Resulted"
          />
          <TileCard
            to="/radiology-board"
            title="Radiology"
            subtitle="Imaging orders & reports"
            icon={<Scan className="h-6 w-6" />}
            accent="amber"
            pending={counts.radPending}
            done={counts.radReported}
            doneLabel="Reported"
          />
        </div>

        <p className="mt-8 text-[11px] text-slate-500 text-center">
          One roster · one facility selector · three ancillary services. Facility selection is
          shared with every sub-dashboard.
        </p>
      </section>
    </main>
  );
}

type Accent = "teal" | "blue" | "amber";

const ACCENT: Record<
  Accent,
  { iconBg: string; iconFg: string; ring: string; border: string; badge: string }
> = {
  teal: {
    iconBg: "bg-[#2d8a9e]/15",
    iconFg: "text-[#2d8a9e]",
    ring: "hover:ring-[#2d8a9e]/40",
    border: "border-l-4 border-l-[#2d8a9e]",
    badge: "bg-[#2d8a9e]/10 text-[#0f5766] ring-1 ring-[#2d8a9e]/25",
  },
  blue: {
    iconBg: "bg-indigo-100",
    iconFg: "text-indigo-700",
    ring: "hover:ring-indigo-400/40",
    border: "border-l-4 border-l-indigo-500",
    badge: "bg-indigo-50 text-indigo-800 ring-1 ring-indigo-200",
  },
  amber: {
    iconBg: "bg-amber-100",
    iconFg: "text-amber-700",
    ring: "hover:ring-amber-400/40",
    border: "border-l-4 border-l-amber-500",
    badge: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  },
};

function TileCard({
  to,
  title,
  subtitle,
  icon,
  accent,
  pending,
  done,
  doneLabel,
}: {
  to: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accent: Accent;
  pending: number;
  done: number;
  doneLabel: string;
}) {
  const a = ACCENT[accent];
  return (
    <Link
      to={to}
      className={`group block rounded-sm border border-slate-300 bg-white shadow-sm ${a.border} hover:shadow-md hover:ring-2 ${a.ring} transition p-5`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`grid place-items-center h-11 w-11 rounded-lg ${a.iconBg} ${a.iconFg}`}>
            {icon}
          </span>
          <div>
            <div className="text-sm font-bold uppercase tracking-[0.16em] text-slate-900">
              {title}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">{subtitle}</div>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-slate-400 group-hover:text-slate-700 transition" />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <KpiTile value={pending} label="Pending" />
        <KpiTile value={done} label={doneLabel} />
      </div>

      <div className="mt-3">
        <span className={`inline-flex items-center rounded-sm px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${a.badge}`}>
          Open Workspace
        </span>
      </div>
    </Link>
  );
}