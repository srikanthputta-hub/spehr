import { ORDER_SETS, type Severity } from "@/lib/cds-order-sets";

type StoredSuggestion = {
  id: string;
  firedAt: string;
  dismissed?: boolean;
  triggerCode?: string;
  triggerDisplay?: string;
};

function shortLabel(id: string): string {
  switch (id) {
    case "acs":
      return "🔴 ACS Protocol";
    case "sepsis-bundle":
      return "🔴 Sepsis Protocol";
    case "septic-shock":
      return "🔴 Septic Shock";
    case "infection-workup":
      return "⚠ Infection Workup";
    default:
      return ORDER_SETS[id]?.label ?? "CDS Protocol";
  }
}

export default function CdsProtocolTabButton({
  suggestion,
  onOpen,
}: {
  suggestion: StoredSuggestion;
  onOpen: () => void;
}) {
  const os = ORDER_SETS[suggestion.id];
  if (!os) return null;
  const sev: Severity = os.severity;
  const isAmber = sev === "amber";
  const border =
    sev === "critical"
      ? "border-red-700 ring-1 ring-red-500"
      : isAmber
        ? "border-amber-500"
        : "border-red-500";
  const dotColor = isAmber ? "bg-amber-600" : "bg-red-600";
  return (
    <button
      type="button"
      onClick={onOpen}
      title="View CDS protocol"
      className={`px-4 py-1.5 text-[13px] font-semibold rounded-t-[14px] rounded-b-sm border border-b-0 bg-amber-100 text-red-900 hover:bg-amber-200 transition flex items-center gap-2 whitespace-nowrap ${border}`}
    >
      <span className="relative flex h-2.5 w-2.5">
        <span
          className={`absolute inline-flex h-full w-full rounded-full ${dotColor} opacity-70 animate-ping`}
        />
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dotColor}`} />
      </span>
      <span>{shortLabel(suggestion.id)}</span>
    </button>
  );
}