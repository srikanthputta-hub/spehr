// Synchronous global mock store for AI Differential notes.
// Bypasses the 10s timer + Supabase fetch to verify cross-board UI wiring.

export interface MockAiNote {
  mrn: string;
  type: "AI_DIFFERENTIAL";
  text: string;
  created_at: string;
}

export const MOCK_AI_NOTES: Record<string, MockAiNote> = {
  "MRN-325733": {
    mrn: "MRN-325733",
    type: "AI_DIFFERENTIAL",
    text: "AI Consult [Local Mock]: Based on presentation, rule out ACS, Pulmonary Embolism, and Aortic Dissection. Recommend STAT Troponin x2, 12-lead ECG, D-dimer, and CT Angiography of the chest.",
    created_at: new Date().toISOString(),
  },
};

export function getMockAiNote(mrn: string | null | undefined): MockAiNote | null {
  if (!mrn) return null;
  return MOCK_AI_NOTES[mrn] ?? null;
}

export const MOCK_AI_MRNS: Set<string> = new Set(Object.keys(MOCK_AI_NOTES));