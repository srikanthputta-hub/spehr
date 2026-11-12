import { describe, expect, it } from "vitest";
import { buildDischargeMarkdown, computeSafetyFlags } from "./discharge-narrative";

/**
 * Tests for the discharge-summary accuracy fixes:
 *   1. Reported imaging (radiology_orders) is included in "Laboratory &
 *      Imaging Findings" — it was never queried/rendered before.
 *   2. "Procedures Performed" is derived from real `procedures` rows
 *      instead of always printing the same hardcoded negative claim.
 *   3. `computeSafetyFlags()` is wired into the generated narrative as a
 *      "Clinical Completeness Check" section instead of being computed
 *      and silently discarded.
 */

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
});
