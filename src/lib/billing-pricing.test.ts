import { describe, expect, it } from "vitest";
import {
  composeCharges,
  lengthOfStayFractionalDays,
  priceForMed,
  priceForLab,
  type BuildChargesInput,
} from "./billing-pricing";

/**
 * Regression tests for L17's billing bugs:
 *   1. every drug billed a flat $38 regardless of which drug (stale/
 *      missing RxNorm map entries — fixed by re-keying MED_PRICE_BY_RXNORM
 *      off real codes verified live against medication_orders)
 *   2. a fabricated "LOINC:LAB-000" code presented as a real LOINC code
 *      when there's no actual LOINC on the order
 *   3. a full day of room & board billed for a 12-minute stay
 */
describe("billing-pricing — L17 regressions", () => {
  it("prices real medications actually seen in medication_orders distinctly, not a flat $38", () => {
    // Verified live against medication_orders before writing this test —
    // these are real rxnorm_code values, not guesses.
    expect(priceForMed("29046")).toBe(14); // Lisinopril — used to be mislabeled "Albuterol" at this exact code
    expect(priceForMed("83367")).toBe(20); // Atorvastatin
    expect(priceForMed("723")).toBe(16); // Amoxicillin — had no map entry at all before this fix
    expect(priceForMed("236991")).toBe(42); // Clopidogrel — had no map entry at all before this fix
    expect(priceForMed("1298839")).toBe(30); // Azithromycin — had no map entry at all before this fix

    // These must NOT all collapse to the $38 default just because they're
    // all real, distinctly-priced drugs.
    const prices = new Set(
      ["29046", "83367", "723", "236991", "1298839"].map((code) => priceForMed(code)),
    );
    expect(prices.size).toBeGreaterThan(1);
    expect(prices.has(38)).toBe(false);
  });

  it("still falls back to a sane default for a genuinely unknown RxNorm code", () => {
    expect(priceForMed("99999999")).toBe(38);
    expect(priceForMed(null)).toBe(38);
  });

  it("only labels a lab/medication charge with a real code system when a real code exists", () => {
    const input: BuildChargesInput = {
      admissionTime: "2026-01-01T00:00:00Z",
      dischargeTime: "2026-01-02T00:00:00Z",
      room: "204",
      meds: [{ rxnorm: null, name: "Mystery Drug", administered_at: "2026-01-01T06:00:00Z" }],
      labs: [{ loinc: null, name: "Mystery Panel", collected_at: "2026-01-01T06:00:00Z" }],
    };
    const charges = composeCharges(input);
    const med = charges.find((c) => c.category === "medication");
    const lab = charges.find((c) => c.category === "lab");
    expect(med?.codeSystem).toBe("internal");
    expect(med?.code).toBe("RX-000");
    expect(lab?.codeSystem).toBe("internal");
    expect(lab?.code).toBe("LAB-000");
  });

  it("labels a real LOINC/RxNorm code with the real code system", () => {
    const input: BuildChargesInput = {
      admissionTime: "2026-01-01T00:00:00Z",
      dischargeTime: "2026-01-02T00:00:00Z",
      room: "204",
      meds: [{ rxnorm: "29046", name: "Lisinopril", administered_at: "2026-01-01T06:00:00Z" }],
      labs: [{ loinc: "2160-0", name: "Creatinine", collected_at: "2026-01-01T06:00:00Z" }],
    };
    const charges = composeCharges(input);
    const med = charges.find((c) => c.category === "medication");
    const lab = charges.find((c) => c.category === "lab");
    expect(med?.codeSystem).toBe("RxNorm");
    expect(med?.code).toBe("29046");
    expect(lab?.codeSystem).toBe("LOINC");
    expect(lab?.code).toBe("2160-0");
  });

  it("prorates room/board for a short same-day stay instead of billing a full day", () => {
    // A 12-minute stay.
    const los = lengthOfStayFractionalDays("2026-01-01T10:00:00Z", "2026-01-01T10:12:00Z");
    expect(los).toBe(0.25); // quarter-day minimum, not a full day (1.0)
    expect(los).toBeLessThan(1);

    const input: BuildChargesInput = {
      admissionTime: "2026-01-01T10:00:00Z",
      dischargeTime: "2026-01-01T10:12:00Z",
      room: "204",
      meds: [],
      labs: [],
    };
    const charges = composeCharges(input);
    const room = charges.find((c) => c.category === "room");
    // Full day would be 850; a 12-minute stay must bill less than that.
    expect(room?.amount).toBeLessThan(850);
    expect(room?.amount).toBe(212.5);
  });

  it("still bills a full multi-day stay correctly (no regression for the common case)", () => {
    const los = lengthOfStayFractionalDays("2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z");
    expect(los).toBe(3);
  });

  it("priceForLab falls back to a sane default for an unknown LOINC code", () => {
    expect(priceForLab("99999-9")).toBe(95);
    expect(priceForLab(null)).toBe(95);
  });
});

describe("billing-pricing — governed radiology value sets", () => {
  // Real, published VSAC "CT Abdomen and Pelvis" value set content
  // (OID 2.16.840.1.113762.1.4.1078.1244), confirmed live before writing
  // this test — not a fabricated fixture.
  const CT_ABD_PELVIS_VALUE_SET = {
    name: "CT Abdomen and Pelvis",
    codes: [
      {
        code: "419394006",
        system: "SNOMED CT",
        display: "Computed tomography of abdomen and pelvis (procedure)",
      },
      {
        code: "74176",
        system: "CPT",
        display: "Computed tomography, abdomen and pelvis; without contrast material",
      },
      {
        code: "74177",
        system: "CPT",
        display: "Computed tomography, abdomen and pelvis; with contrast material(s)",
      },
    ],
  };

  const baseInput = {
    admissionTime: "2026-01-01T00:00:00Z",
    dischargeTime: "2026-01-02T00:00:00Z",
    room: "204",
    meds: [],
    labs: [],
  } satisfies Omit<BuildChargesInput, "imagingOrders" | "radiologyValueSets">;

  it("resolves the CT Abdomen/Pelvis imaging CPT from the published value set when wired", () => {
    const input: BuildChargesInput = {
      ...baseInput,
      imagingOrders: [
        {
          snomed: "169071000",
          exam_type: "CT Abdomen/Pelvis",
          modality: "CT",
          body_part: "Abdomen/Pelvis",
        },
      ],
      radiologyValueSets: [CT_ABD_PELVIS_VALUE_SET],
    };
    const charges = composeCharges(input);
    const imaging = charges.find((c) => c.category === "advanced_imaging");
    expect(imaging?.codeSystem).toBe("CPT");
    // Same code the static fallback already used — now sourced from the
    // real governed value set instead of a bare literal.
    expect(imaging?.code).toBe("74176");
    expect(imaging?.description).toContain(
      "Computed tomography, abdomen and pelvis; without contrast material",
    );
  });

  it("still falls back to the static CPT map when no governed value set is wired (no regression)", () => {
    const input: BuildChargesInput = {
      ...baseInput,
      imagingOrders: [
        {
          snomed: "169071000",
          exam_type: "CT Abdomen/Pelvis",
          modality: "CT",
          body_part: "Abdomen/Pelvis",
        },
      ],
      // radiologyValueSets intentionally omitted.
    };
    const charges = composeCharges(input);
    const imaging = charges.find((c) => c.category === "advanced_imaging");
    expect(imaging?.codeSystem).toBe("CPT");
    expect(imaging?.code).toBe("74176");
  });

  it("leaves other exam types untouched by the governed value set", () => {
    const input: BuildChargesInput = {
      ...baseInput,
      imagingOrders: [
        { snomed: "399208008", exam_type: "Chest X-ray", modality: "XR", body_part: "Chest" },
      ],
      radiologyValueSets: [CT_ABD_PELVIS_VALUE_SET],
    };
    const charges = composeCharges(input);
    const imaging = charges.find((c) => c.category === "imaging");
    expect(imaging?.code).toBe("71046");
    expect(imaging?.codeSystem).toBe("CPT");
  });
});
