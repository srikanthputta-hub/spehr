All changes are scoped to the `LiveTerminologyMatrix` component and its `PillRow` popover in `src/routes/system-admin.tsx` (lines ~2583–2949). Nothing else is touched.

### 1. Approved-only data source
In the loader (around line 2620), after fetching the top-15 patients, query `nlp_audit_logs` for those MRNs filtered to `status = 'approved'`:

```ts
const { data: approvedLogs } = await supabase
  .from("nlp_audit_logs")
  .select("patient_mrn, raw_text, standardized_output, updated_at")
  .in("patient_mrn", mrns)
  .eq("status", "approved")
  .order("updated_at", { ascending: false });
```

Build `approvedByMrn = Map<mrn, {raw_text, standardized_output}>` keeping the newest row per MRN. Then filter the `patients` list down to those whose MRN is a key in that map before the rest of the pipeline runs (labs/meds/procedures queries continue as-is, just over the reduced MRN set — or against the original set, filtering happens at cell-build time). Patients with no approved audit row are dropped entirely; if the result is empty the existing "No admissions to display." state renders.

### 2. Remove chief-complaint subtitle
Line 2853 — delete the `<div className="text-[10px] text-slate-500 truncate max-w-[180px]">{r.chief_complaint ?? "—"}</div>` line. Keep only the `{r.name}` line. No other row changes.

### 3. Raw Data row in pill popup
Pipe a per-MRN `rawText` through to `PillRow`:

- Extend `MatrixCell` with `raw_text: string | null` (populated from `approvedByMrn.get(mrn)?.raw_text ?? null`).
- Add a `rawText` prop to `PillRow` and pass `r.raw_text` from each `<PillRow ... />` call site (5 columns).
- In `PopoverContent` (line 2886), prepend one block **above everything else**, before the system/code header:

```tsx
{rawText && (
  <div className="rounded border border-slate-200 bg-amber-50/60 px-2 py-1.5 mb-1">
    <div className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Raw Data</div>
    <div className="text-[11px] text-slate-800 leading-snug">{rawText}</div>
  </div>
)}
```

Everything else in the popup (system pill, code, display, value set, description, FHIR CodeableConcept block, View in Authoring, Translate to ICD-10) stays byte-for-byte unchanged.

### Notes
- `nlp_audit_logs.raw_text` is the original submitted text for that patient's coding pass (the CC/HPI blob that produced the SNOMED/ICD-10 pills, and by extension the meds/labs pulled in the same pipeline). It is shown identically for every pill on that row, matching the example given ("shortness of breath since yesterday evening" for the dyspnea SNOMED code).
- No schema changes, no other components touched, no styling changes elsewhere.
