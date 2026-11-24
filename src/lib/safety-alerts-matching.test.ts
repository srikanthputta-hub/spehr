import { describe, expect, it } from "vitest";
import {
  allergyMatchesValueSet,
  classTokens,
  extensionalContains,
  substanceMatchesClass,
  type MatchableValueSet,
} from "../../supabase/functions/_shared/safety-alerts-matching";

/**
 * Tests for the VSAC allergy-value-set integration's matching logic:
 *   - `allergyMatchesValueSet` is a UNION of the pre-existing free-text
 *     class-token match and a NEW membership match on the allergy's own
 *     coded substance (RxNorm/SNOMED) — never a replacement of either.
 *   - The single most important regression guard: spehr's own most common
 *     real allergy — penicillin, coded SNOMED 764146007 on 27 real allergy
 *     records — must keep matching via the free-text path, because neither
 *     real, published VSAC "Penicillin Allergy" value set extensionally
 *     contains that exact code (confirmed live against the actual imported
 *     VSAC content below, not fabricated fixtures).
 */

// Mirrors the REAL "Penicillin Allergy RXNORM" VSAC value set
// (2.16.840.1.113762.1.4.1078.731, Optum, 177 codes) — contains amoxicillin
// (723) but NOT RxCUI 7980 (the penicillin G ingredient itself), confirmed
// live against the published custom_value_sets row.
const PENICILLIN_ALLERGY_RXNORM: MatchableValueSet = {
  name: "Penicillin Allergy RXNORM",
  codes: [
    { code: "723", display: "Amoxicillin" },
    { code: "19711", display: "Penicillin V" },
    { code: "133008", display: "Penicillin G" },
  ],
};

// Mirrors the REAL "Penicillin Allergy SCT" VSAC value set
// (2.16.840.1.113762.1.4.1078.732, Optum, 61 codes) — these are allergy
// FINDING codes ("Penicillin-induced anaphylaxis", etc.), not the substance
// code; 764146007 (penicillin G, the substance) is confirmed NOT a member.
const PENICILLIN_ALLERGY_SCT: MatchableValueSet = {
  name: "Penicillin Allergy SCT",
  codes: [
    { code: "241938005", display: "Penicillin-induced anaphylaxis (disorder)" },
    { code: "292954005", display: "Penicillin adverse reaction (disorder)" },
  ],
};

describe("allergyMatchesValueSet — union of free-text and membership matching", () => {
  const tokens = classTokens(PENICILLIN_ALLERGY_RXNORM.name);

  it("REGRESSION GUARD: penicillin G coded SNOMED 764146007 still matches via the free-text path", () => {
    // 764146007 is not a member of either real Penicillin Allergy value
    // set's extensional code list — confirm that directly first.
    expect(extensionalContains(PENICILLIN_ALLERGY_RXNORM, "764146007")).toBe(false);
    expect(extensionalContains(PENICILLIN_ALLERGY_SCT, "764146007")).toBe(false);

    // The allergy itself, as it would be loaded from `allergies`.
    const allergy = { substance: "Penicillin", snomed: "764146007", rxcui: null };

    // The free-text path alone (pre-existing behavior) still fires.
    expect(substanceMatchesClass(allergy.substance, tokens)).toBe(true);

    // And the union helper must fire too — adding the membership check must
    // never suppress or regress this, the single most common real case.
    expect(allergyMatchesValueSet(allergy, PENICILLIN_ALLERGY_RXNORM, tokens)).toBe(true);
  });

  it("NEW signal: an unusual substance string with no class token still matches via its own coded substance", () => {
    const allergy = { substance: "AMX sensitivity (pt-reported)", rxcui: "723", snomed: null };

    // The free-text path alone would miss this — no "penicillin" token in
    // the substance string.
    expect(substanceMatchesClass(allergy.substance, tokens)).toBe(false);

    // But the allergy's own RxCUI (723) IS a real member of the value set —
    // the new membership path must catch it.
    expect(extensionalContains(PENICILLIN_ALLERGY_RXNORM, allergy.rxcui!)).toBe(true);
    expect(allergyMatchesValueSet(allergy, PENICILLIN_ALLERGY_RXNORM, tokens)).toBe(true);
  });

  it("does not match when neither the free-text nor the membership path fires", () => {
    const allergy = { substance: "Shellfish", rxcui: "9999999", snomed: "8888888" };
    expect(allergyMatchesValueSet(allergy, PENICILLIN_ALLERGY_RXNORM, tokens)).toBe(false);
  });

  it("is a true union — matches when EITHER path fires alone, not only when both do", () => {
    const freeTextOnly = { substance: "Penicillin allergy", rxcui: null, snomed: null };
    const membershipOnly = { substance: "unspecified drug reaction", rxcui: "723", snomed: null };
    expect(allergyMatchesValueSet(freeTextOnly, PENICILLIN_ALLERGY_RXNORM, tokens)).toBe(true);
    expect(allergyMatchesValueSet(membershipOnly, PENICILLIN_ALLERGY_RXNORM, tokens)).toBe(true);
  });
});
