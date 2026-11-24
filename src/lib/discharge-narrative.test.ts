import { describe, expect, it } from "vitest";
import {
  buildDischargeMarkdown,
  checkDischargeMedAllergyConflicts,
  computeSafetyFlags,
  parseFollowUpDays,
  reconcileDischargeMedications,
  stripDuplicateLabel,
  type MatchableValueSet,
} from "./discharge-narrative";

/**
 * Tests for the discharge-summary accuracy fixes:
 *   1. Reported imaging (radiology_orders) is included in "Laboratory &
 *      Imaging Findings" — it was never queried/rendered before.
 *   2. "Procedures Performed" is derived from real `procedures` rows
 *      instead of always printing the same hardcoded negative claim.
 *   3. `computeSafetyFlags()` is wired into the generated narrative as a
 *      "Clinical Completeness Check" section instead of being computed
 *      and silently discarded.
 *   4. (C4) The exam/condition/hospital-course sections never assert a
 *      finding this system didn't actually observe, and only cite real
 *      vitals when present.
 *   5. (C3) Discharge medications are reconciled against documented
 *      allergies (reusing Safety Alerts Engine's Rule 1 matching helpers)
 *      and carry an explicit CONTINUE/STOP decision.
 *   6. (H7) A clinician-authored discharge note is rendered verbatim,
 *      never discarded.
 *   7. (L19) A `result_value` that already embeds its own test-name
 *      prefix doesn't double up against the bolded label next to it.
 */

const PENICILLIN_ALLERGY_VS: MatchableValueSet = {
  name: "Penicillin Allergy RXNORM(optum)",
  codes: [{ code: "723", display: "Amoxicillin" }],
};

const basePatient = {
  first_name: "William",
  last_name: "Martinez",
  mrn: "MRN-943559",
  age: 41,
  gender: "male",
  chief_complaint: "Sharp lower back pain after a fall this afternoon",
  admission_time: "2026-11-12T19:30:00Z",
  diagnosis: "Blunt Trauma",
};

describe("buildDischargeMarkdown — imaging", () => {
  it("includes a reported radiology study in Laboratory & Imaging Findings", () => {
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [],
      [],
      [
        {
          exam_type: "CT Abdomen/Pelvis",
          modality: "CT",
          body_part: "Abdomen/Pelvis",
          status: "Reported",
          report_text: "FINDINGS: ...",
          impression: "No acute abdomen/pelvis abnormality identified. Correlate clinically.",
          ordered_at: "2026-11-12T19:30:37Z",
          resulted_at: "2026-11-12T19:33:00Z",
        },
      ],
      [],
    );
    expect(md).toContain("CT Abdomen/Pelvis (Imaging)");
    expect(md).toContain("No acute abdomen/pelvis abnormality identified");
  });

  it("omits a still-pending (not yet reported) imaging order", () => {
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [],
      [],
      [
        {
          exam_type: "MRI Brain",
          status: "ordered",
          report_text: null,
          impression: null,
          resulted_at: null,
        },
      ],
      [],
    );
    expect(md).not.toContain("MRI Brain");
  });

  it("falls back to the normal-studies line when there are no labs or imaging", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(md).toContain("All diagnostic studies within reference ranges");
  });
});

describe("buildDischargeMarkdown — procedures", () => {
  it("lists a real completed procedure instead of the hardcoded negative claim", () => {
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [],
      [],
      [],
      [
        {
          display_text: "Lumbar spine X-ray",
          status: "completed",
          performed_at: "2026-11-12T19:30:36Z",
          cpt_code: "72100",
          cpt_display: "Radiologic exam, spine, lumbosacral; 2 or 3 views",
        },
      ],
    );
    expect(md).toContain("Lumbar spine X-ray");
    expect(md).toContain("CPT 72100");
    expect(md).not.toContain(
      "No major surgical or interventional procedures were performed during this admission",
    );
  });

  it("prints a data-driven (not the old static) negative claim when no procedures exist", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(md).toContain("No procedures are recorded in the structured chart for this admission");
  });
});

describe("buildDischargeMarkdown — Clinical Completeness Check (safety flags wiring)", () => {
  it("surfaces a computeSafetyFlags() critical flag in the rendered markdown", () => {
    const chestPainPatient = {
      ...basePatient,
      chief_complaint: "severe crushing chest pain",
      admission_time: "2026-11-12T10:00:00Z",
      discharge_time: "2026-11-12T10:20:00Z", // 20 min LOS — implausible for high acuity
    };
    const flags = computeSafetyFlags(chestPainPatient, [], []);
    expect(flags.length).toBeGreaterThan(0);

    const md = buildDischargeMarkdown(chestPainPatient, [], [], [], [], []);
    expect(md).toContain("Clinical Completeness Check");
    expect(md).toContain("CRITICAL");
    expect(md).toContain("workup incomplete");
  });

  it("prints a clean-check line when no safety flags are raised", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(md).toContain("Clinical Completeness Check");
    expect(md).toContain("no missing-workup or length-of-stay flags identified");
  });

  it("flags (warning) any implausibly short inpatient length-of-stay, not just high-acuity complaints", () => {
    const flags = computeSafetyFlags(
      {
        ...basePatient,
        chief_complaint: "fever and cough",
        admission_time: "2026-11-21T10:00:00Z",
        discharge_time: "2026-11-21T10:11:00Z", // 11 min — the C4 "0h 11m" case
      },
      [],
      [],
    );
    expect(flags.some((f) => /unusually short|implausibly short/.test(f.message))).toBe(true);
  });
});

describe("buildDischargeMarkdown — C4 fabrication fixes", () => {
  it("never invents organ-system exam findings; cites only real vitals", () => {
    const withVitals = buildDischargeMarkdown(basePatient, [], [], [], [], [], null, {
      hr: 98,
      bp_systolic: 122,
      bp_diastolic: 78,
      spo2: 97,
      temp_c: 37.1,
      rr: 16,
    });
    expect(withVitals).toContain("HR 98/min");
    expect(withVitals).not.toContain("Clear to auscultation bilaterally");
    expect(withVitals).not.toContain("Regular rate and rhythm; no murmurs");

    const withoutVitals = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(withoutVitals).toContain(
      "No admission vital signs or physical-examination findings are documented",
    );
    expect(withoutVitals).not.toContain("Clear to auscultation bilaterally");
  });

  it("never asserts an unobserved condition-at-discharge or hospital-course narrative", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(md).not.toContain("ambulating independently");
    expect(md).not.toContain("pain controlled");
    expect(md).not.toContain("afebrile");
    expect(md).toContain("Not independently documented by this system");
  });
});

describe("buildDischargeMarkdown — H7 clinician note wiring", () => {
  it("renders the clinician's typed discharge note verbatim instead of discarding it", () => {
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [],
      [],
      [],
      [],
      "Patient tolerated admission well. Discussed wound care in detail with daughter present.",
    );
    expect(md).toContain("Clinician's Discharge Note");
    expect(md).toContain("Discussed wound care in detail with daughter present");
    expect(md).toContain("Per the discharging clinician's note below");
  });
});

describe("C3 — discharge medication vs. allergy reconciliation", () => {
  const penicillinAllergicPatient = { ...basePatient, chief_complaint: "fever and cough" };
  const amoxicillin = {
    medication_name: "Amoxicillin",
    display_name: "Amoxicillin",
    rxnorm_code: "723",
    status: "administered",
    dose: "500 mg",
  };
  const allergies = [{ substance: "Penicillin", reaction: "anaphylaxis", severity: "severe" }];

  it("reconcileDischargeMedications forces STOP on a documented allergy conflict", () => {
    const [result] = reconcileDischargeMedications([amoxicillin], allergies, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(result.decision).toBe("STOP");
    expect(result.reason).toContain("Penicillin");
  });

  it("defaults to CONTINUE when there is no documented conflict", () => {
    const [result] = reconcileDischargeMedications([amoxicillin], [], [PENICILLIN_ALLERGY_VS]);
    expect(result.decision).toBe("CONTINUE");
  });

  it("checkDischargeMedAllergyConflicts raises a hard, visible flag", () => {
    const flags = checkDischargeMedAllergyConflicts([amoxicillin], allergies, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("critical");
    expect(flags[0].message).toContain("Amoxicillin");
    expect(flags[0].message).toContain("Penicillin");
  });

  it("surfaces the conflict as a hard flag AND an explicit STOP decision in the rendered summary", () => {
    const md = buildDischargeMarkdown(
      penicillinAllergicPatient,
      [amoxicillin],
      [],
      allergies,
      [],
      [],
      null,
      null,
      [PENICILLIN_ALLERGY_VS],
    );
    expect(md).toContain("CRITICAL");
    expect(md).toContain("Discharge Medication Allergy Conflict");
    expect(md).toContain("Decision: STOP");
  });

  it("does not false-positive a safe medication with no documented allergy", () => {
    const flags = checkDischargeMedAllergyConflicts(
      [{ medication_name: "Acetaminophen", rxnorm_code: "161", status: "administered" }],
      allergies,
      [PENICILLIN_ALLERGY_VS],
    );
    expect(flags).toHaveLength(0);
  });

  // Regression guard (the single most important check for the VSAC
  // allergy-value-set integration): spehr's own most common real allergy is
  // penicillin, coded SNOMED 764146007 on 27 real allergy records — a code
  // that neither real, published VSAC "Penicillin Allergy" value set
  // extensionally enumerates (RXNORM lacks the penicillin G ingredient
  // itself; SCT is built from allergy FINDING codes, not the substance
  // code). This must keep firing on the free-text path regardless of the
  // allergy's own code or whether that code happens to sit in the VS.
  it("still flags amoxicillin against a penicillin allergy coded as SNOMED 764146007 (penicillin G) — free-text path unaffected by membership matching", () => {
    const penicillinGAllergy = [
      {
        substance: "Penicillin",
        reaction: "anaphylaxis",
        severity: "severe",
        substance_snomed: "764146007", // not a member of PENICILLIN_ALLERGY_VS's codes
      },
    ];
    const [result] = reconcileDischargeMedications([amoxicillin], penicillinGAllergy, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(result.decision).toBe("STOP");
    expect(result.reason).toContain("Penicillin");

    const flags = checkDischargeMedAllergyConflicts([amoxicillin], penicillinGAllergy, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("critical");
  });

  // NEW — the additive membership signal: an allergy documented with a
  // substance string that carries none of the value set's name-derived
  // class tokens (so the original free-text path alone would miss it), but
  // whose own coded substance (substance_rxcui) IS a real extensional
  // member of the value set. The union must still catch this.
  it("flags amoxicillin against an allergy documented with an unusual substance string but a code that is a real value-set member", () => {
    const unusualStringAllergy = [
      {
        substance: "AMX sensitivity (pt-reported)", // no "penicillin" token anywhere
        reaction: "rash",
        severity: "moderate",
        substance_rxcui: "723", // Amoxicillin RxCUI — IS a member of PENICILLIN_ALLERGY_VS
      },
    ];
    const [result] = reconcileDischargeMedications([amoxicillin], unusualStringAllergy, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(result.decision).toBe("STOP");
    expect(result.reason).toContain("AMX sensitivity");
  });

  it("does NOT flag when neither the free-text nor the membership path matches", () => {
    const unrelatedAllergy = [
      { substance: "Shellfish", reaction: "hives", severity: "mild", substance_rxcui: "9999999" },
    ];
    const flags = checkDischargeMedAllergyConflicts([amoxicillin], unrelatedAllergy, [
      PENICILLIN_ALLERGY_VS,
    ]);
    expect(flags).toHaveLength(0);
  });
});

describe("L19 — doubled lab label fix", () => {
  it("stripDuplicateLabel removes a label already baked into the value", () => {
    expect(stripDuplicateLabel("Hemoglobin", "Hemoglobin: 14.6 g/dL")).toBe("14.6 g/dL");
    expect(stripDuplicateLabel("Hemoglobin", "14.6 g/dL")).toBe("14.6 g/dL");
    expect(stripDuplicateLabel("WBC", "wbc - 7.2 K/uL")).toBe("7.2 K/uL");
  });

  it("the rendered summary never doubles the lab label against its own value", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], [], null, null, []);
    expect(md).not.toMatch(/Hemoglobin: Hemoglobin:/);
  });

  it("strips the duplicate label end-to-end for a lab row stored with an embedded test name", () => {
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [
        {
          test_type: "Hemoglobin",
          display_name: "Hemoglobin",
          status: "Resulted",
          result_value: "Hemoglobin: 14.6 g/dL",
        },
      ],
    );
    expect(md).toContain("**Hemoglobin**: 14.6 g/dL");
    expect(md).not.toContain("Hemoglobin: Hemoglobin: 14.6 g/dL");
  });
});

describe("buildDischargeMarkdown — Follow-Up Care interval (H12 fix)", () => {
  it("defaults to 7 days when no followUpDays is passed, unchanged from before", () => {
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], []);
    expect(md).toContain("within 7 days");
  });

  it("quotes the explicit followUpDays value instead of the old hardcoded 7", () => {
    // followUpDays is now the 10th positional arg (clinicianNote/vitals/
    // publishedValueSets were inserted before it for the C4/C3/H7 fixes).
    const md = buildDischargeMarkdown(basePatient, [], [], [], [], [], null, null, [], 14);
    expect(md).toContain("within 14 days");
    expect(md).not.toContain("within 7 days");
  });

  it("names the PCP when one is on file", () => {
    const md = buildDischargeMarkdown(
      { ...basePatient, primary_care_physician: "Dr. Alan Reyes, MD" },
      [],
      [],
      [],
      [],
      [],
      null,
      null,
      [],
      10,
    );
    expect(md).toContain("Schedule follow-up with **Dr. Alan Reyes, MD** within 10 days");
  });
});

describe("parseFollowUpDays (H12 fix)", () => {
  it("parses the DischargeDialog's own default text", () => {
    expect(parseFollowUpDays("Patient stable for discharge. Follow up with PCP in 7 days.")).toBe(
      7,
    );
  });

  it("parses a clinician edit to a different day count", () => {
    expect(parseFollowUpDays("Follow up with PCP in 14 days.")).toBe(14);
  });

  it("converts a stated week count to days", () => {
    expect(parseFollowUpDays("Discharged with surgical follow-up in 2 weeks.")).toBe(14);
  });

  it("converts a stated hour count to (rounded-up) days", () => {
    expect(parseFollowUpDays("Discharged with OB follow-up in 48 hours.")).toBe(2);
  });

  it("returns null when no follow-up interval is stated", () => {
    expect(parseFollowUpDays("Patient tolerating diet, ambulating without difficulty.")).toBeNull();
  });

  it("returns null for empty/missing text", () => {
    expect(parseFollowUpDays("")).toBeNull();
    expect(parseFollowUpDays(null)).toBeNull();
    expect(parseFollowUpDays(undefined)).toBeNull();
  });
});

describe("H7 + H12 coexistence — clinician note and follow-up-days both land in one summary", () => {
  it("renders the clinician's verbatim note AND quotes the follow-up interval parsed from that same text", () => {
    const clinicianText =
      "Patient tolerated admission well. Follow up with PCP in 14 days for suture removal.";
    const followUpDays = parseFollowUpDays(clinicianText) ?? 7;
    const md = buildDischargeMarkdown(
      basePatient,
      [],
      [],
      [],
      [],
      [],
      clinicianText,
      null,
      [],
      followUpDays,
    );
    // H7: the clinician's own text is never discarded or replaced.
    expect(md).toContain("Clinician's Discharge Note");
    expect(md).toContain("Follow up with PCP in 14 days for suture removal");
    // H12: the SAME stated interval drives the Follow-Up Care section's wording.
    expect(md).toContain("within 14 days");
    expect(md).not.toContain("within 7 days");
  });
});
