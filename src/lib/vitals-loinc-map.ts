/**
 * Vitals column → LOINC mapping used by Stream E of the coding pipeline.
 */
export const VITALS_LOINC: Record<string, { code: string; display: string }> = {
  hr:           { code: "8867-4",  display: "Heart rate" },
  bp_systolic:  { code: "8480-6",  display: "Systolic blood pressure" },
  bp_diastolic: { code: "8462-4",  display: "Diastolic blood pressure" },
  spo2:         { code: "59408-5", display: "Oxygen saturation" },
  rr:           { code: "9279-1",  display: "Respiratory rate" },
  temp_c:       { code: "8310-5",  display: "Body temperature" },
};