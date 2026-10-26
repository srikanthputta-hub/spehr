import type { AuditRow } from "./AuditCard";

type AuditSortField = "created_at" | "updated_at";

function timestamp(value?: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function rowSignature(row: AuditRow) {
  return [
    row.id,
    row.patient_mrn,
    row.raw_text ?? "",
    stableJson(row.extraction_mapping),
    stableJson(row.standardized_output),
    row.confidence_score ?? "",
    row.status ?? "",
    row.created_at ?? "",
    row.updated_at ?? "",
    row.approved_by ?? "",
  ].join("\u001f");
}

export function sortAuditRows(rows: AuditRow[], primary: AuditSortField) {
  const secondary: AuditSortField = primary === "updated_at" ? "created_at" : "updated_at";
  return [...rows].sort((a, b) => {
    const primaryDelta = timestamp(b[primary]) - timestamp(a[primary]);
    if (primaryDelta !== 0) return primaryDelta;

    const secondaryDelta = timestamp(b[secondary]) - timestamp(a[secondary]);
    if (secondaryDelta !== 0) return secondaryDelta;

    return String(b.id).localeCompare(String(a.id));
  });
}

export function auditRowsEqual(a: AuditRow[], b: AuditRow[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((row, index) => rowSignature(row) === rowSignature(b[index]));
}

export function admissionMapsEqual(a: Record<string, string>, b: Record<string, string>) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
