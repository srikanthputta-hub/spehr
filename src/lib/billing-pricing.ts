/**
 * Centralized pricing engine + FHIR R4 billing builders.
 *
 * Used by Auto Doc (server-side) when generating an Invoice on discharge,
 * and by the Finance "Backfill" server function for legacy discharged
 * encounters that pre-date the dynamic pricing rollout.
 */

export type ChargeCategory =
  | "room"
  | "nursing"
  | "consultation"
  | "medication"
  | "lab"
  | "admin";

export interface PricedCharge {
  code: string;
  codeSystem: "internal" | "LOINC" | "RxNorm" | "CPT";
  description: string;
  category: ChargeCategory;
  quantity: number;
  unitPrice: number;
  amount: number;
  serviceDate?: string;
}

/** Standard daily / per-event tariffs. Single source of truth. */
export const TARIFF = {
  bed_per_day: 850,
  icu_per_day: 2400,
  nursing_per_day: 220,
  consultant_per_day: 350,
  admin_fee: 150,
  pharmacy_handling: 75,
  biomedical_waste: 45,
  tax_rate: 0.05,
};

/**
 * RxNorm → unit price (USD per dose). Falls back to MED_DEFAULT.
 * Curated from a public-hospital tariff sheet — IV agents are pricier
 * than oral, controlled substances pricier than common antibiotics.
 */
const MED_PRICE_BY_RXNORM: Record<string, number> = {
  "7052": 62,    // Morphine
  "161": 18,     // Acetaminophen
  "5640": 22,    // Ibuprofen
  "243670": 14,  // Aspirin
  "83367": 28,   // Atorvastatin
  "866924": 24,  // Metoprolol
  "6809": 26,    // Metformin
  "11124": 32,   // Lisinopril
  "10582": 34,   // Levothyroxine
  "2670": 38,    // Codeine
  "1191": 16,    // Aspirin (alt code)
  "203150": 110, // Vancomycin IV
  "18631": 88,   // Ceftriaxone IV
  "7980": 64,    // Piperacillin
  "3640": 26,    // Furosemide
  "8163": 18,    // Omeprazole
  "29046": 22,   // Albuterol
  "8787": 14,    // Pantoprazole
  "4815": 96,    // Heparin
  "11289": 58,   // Apixaban
  "9863": 12,    // Ondansetron
};
const MED_DEFAULT = 38;

/**
 * LOINC → unit price (USD per result). Falls back to LAB_DEFAULT.
 */
const LAB_PRICE_BY_LOINC: Record<string, number> = {
  "10839-9": 145, // Troponin I
  "2157-6": 78,   // Creatine Kinase
  "6690-2": 48,   // WBC
  "718-7": 38,    // Hemoglobin
  "777-3": 42,    // Platelets
  "2345-7": 28,   // Glucose
  "2160-0": 32,   // Creatinine
  "2951-2": 26,   // Sodium
  "2823-3": 26,   // Potassium
  "24323-8": 95,  // CMP panel
  "58410-2": 75,  // CBC panel
  "33747-0": 60,  // BMP panel
  "1975-2": 82,   // Bilirubin total
  "1742-6": 64,   // ALT
  "1920-8": 64,   // AST
  "2885-2": 72,   // Total protein
  "3094-0": 38,   // BUN
  "2093-3": 58,   // Cholesterol total
  "2571-8": 52,   // Triglycerides
  "14647-2": 110, // BNP
  "33914-3": 95,  // eGFR
};
const LAB_DEFAULT = 95;

export function priceForMed(rxnorm?: string | null): number {
  if (!rxnorm) return MED_DEFAULT;
  return MED_PRICE_BY_RXNORM[String(rxnorm).trim()] ?? MED_DEFAULT;
}

export function priceForLab(loinc?: string | null): number {
  if (!loinc) return LAB_DEFAULT;
  return LAB_PRICE_BY_LOINC[String(loinc).trim()] ?? LAB_DEFAULT;
}

export function lengthOfStayDays(admit?: string | null, discharge?: string | null): number {
  if (!admit) return 1;
  const end = discharge ? new Date(discharge).getTime() : Date.now();
  const ms = end - new Date(admit).getTime();
  if (!isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

/* ---------------- FHIR R4 builders ---------------- */

export function buildChargeItemResource(args: {
  id: string;
  mrn: string;
  encounterId?: string;
  c: PricedCharge;
}) {
  const { id, mrn, encounterId, c } = args;
  return {
    resourceType: "ChargeItem",
    id,
    status: "billable",
    code: {
      coding: [
        {
          system:
            c.codeSystem === "LOINC"
              ? "http://loinc.org"
              : c.codeSystem === "RxNorm"
                ? "http://www.nlm.nih.gov/research/umls/rxnorm"
                : c.codeSystem === "CPT"
                  ? "http://www.ama-assn.org/go/cpt"
                  : "http://spehr.local/charge",
          code: c.code,
          display: c.description,
        },
      ],
      text: c.description,
    },
    subject: { reference: `Patient/${mrn}` },
    context: encounterId ? { reference: `Encounter/${encounterId}` } : undefined,
    occurrenceDateTime: c.serviceDate ?? new Date().toISOString(),
    quantity: { value: c.quantity },
    priceOverride: {
      value: c.unitPrice,
      currency: "USD",
    },
    factorOverride: 1,
    note: [{ text: `${c.category} charge` }],
  };
}

export function buildInvoiceResource(args: {
  id: string;
  invoiceNo: string;
  mrn: string;
  encounterId?: string;
  patientName?: string;
  chargeItems: Array<{ id: string; c: PricedCharge }>;
  subtotal: number;
  tax: number;
  total: number;
  status?: "issued" | "balanced" | "cancelled";
}) {
  const {
    id,
    invoiceNo,
    mrn,
    encounterId,
    patientName,
    chargeItems,
    subtotal,
    tax,
    total,
    status = "issued",
  } = args;
  return {
    resourceType: "Invoice",
    id,
    identifier: [
      { system: "http://spehr.local/invoice", value: invoiceNo },
    ],
    status,
    subject: {
      reference: `Patient/${mrn}`,
      display: patientName,
    },
    recipient: { reference: `Patient/${mrn}` },
    date: new Date().toISOString(),
    issuer: { display: "S Group Private Network" },
    account: encounterId ? { reference: `Encounter/${encounterId}` } : undefined,
    lineItem: chargeItems.map((li, idx) => ({
      sequence: idx + 1,
      chargeItemReference: { reference: `ChargeItem/${li.id}` },
      priceComponent: [
        {
          type: "base",
          amount: { value: li.c.unitPrice, currency: "USD" },
        },
      ],
    })),
    totalPriceComponent: [
      { type: "base", amount: { value: subtotal, currency: "USD" } },
      { type: "tax", factor: TARIFF.tax_rate, amount: { value: tax, currency: "USD" } },
    ],
    totalNet: { value: subtotal, currency: "USD" },
    totalGross: { value: total, currency: "USD" },
  };
}

export function buildPaymentNoticeResource(args: {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  mrn: string;
  amount: number;
  method?: string;
}) {
  const { id, invoiceId, invoiceNo, mrn, amount, method } = args;
  return {
    resourceType: "PaymentNotice",
    id,
    status: "active",
    request: { reference: `Invoice/${invoiceId}`, display: invoiceNo },
    created: new Date().toISOString(),
    payment: { display: method ?? "Card · Patient Portal" },
    paymentDate: new Date().toISOString().slice(0, 10),
    recipient: { display: "S Group Private Network" },
    amount: { value: amount, currency: "USD" },
    paymentStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/paymentstatus",
          code: "paid",
        },
      ],
    },
    extension: [
      { url: "http://spehr.local/mrn", valueString: mrn },
    ],
  };
}

/* ---------------- Charge composition ---------------- */

export interface BuildChargesInput {
  admissionTime?: string | null;
  dischargeTime?: string | null;
  room?: string | null;
  meds: Array<{
    rxnorm?: string | null;
    name?: string | null;
    administered_at?: string | null;
  }>;
  labs: Array<{
    loinc?: string | null;
    name?: string | null;
    collected_at?: string | null;
  }>;
}

/**
 * The "automated medical coder": turn the verified clinical course into
 * a list of priced FHIR ChargeItems.
 */
export function composeCharges(input: BuildChargesInput): PricedCharge[] {
  const los = lengthOfStayDays(input.admissionTime, input.dischargeTime);
  const out: PricedCharge[] = [];

  // Room & Board (LOS-driven)
  out.push({
    code: "RB-101",
    codeSystem: "internal",
    description: `Inpatient Room & Board · General Ward (Room ${input.room ?? "—"})`,
    category: "room",
    quantity: los,
    unitPrice: TARIFF.bed_per_day,
    amount: los * TARIFF.bed_per_day,
  });

  // Nursing
  out.push({
    code: "NC-220",
    codeSystem: "internal",
    description: "Nursing Care · 24-hour bedside coverage",
    category: "nursing",
    quantity: los,
    unitPrice: TARIFF.nursing_per_day,
    amount: los * TARIFF.nursing_per_day,
  });

  // Consultant rounding (daily attending fee)
  out.push({
    code: "MD-350",
    codeSystem: "internal",
    description: "Attending Physician · Daily Rounding & Charting",
    category: "consultation",
    quantity: los,
    unitPrice: TARIFF.consultant_per_day,
    amount: los * TARIFF.consultant_per_day,
  });

  // Medications — one ChargeItem per MedicationAdministration
  for (const m of input.meds) {
    const unit = priceForMed(m.rxnorm);
    out.push({
      code: String(m.rxnorm ?? "RX-000"),
      codeSystem: "RxNorm",
      description: `Medication · ${m.name ?? "Drug"}`,
      category: "medication",
      quantity: 1,
      unitPrice: unit,
      amount: unit,
      serviceDate: m.administered_at ?? undefined,
    });
  }

  // Labs — one ChargeItem per Observation
  for (const l of input.labs) {
    const unit = priceForLab(l.loinc);
    out.push({
      code: String(l.loinc ?? "LAB-000"),
      codeSystem: "LOINC",
      description: `Laboratory · ${l.name ?? "Diagnostic"}`,
      category: "lab",
      quantity: 1,
      unitPrice: unit,
      amount: unit,
      serviceDate: l.collected_at ?? undefined,
    });
  }

  // Pharmacy handling (only if meds present)
  if (input.meds.length > 0) {
    out.push({
      code: "RX-601",
      codeSystem: "internal",
      description: "Pharmacy Dispensing & Handling Fee",
      category: "admin",
      quantity: 1,
      unitPrice: TARIFF.pharmacy_handling,
      amount: TARIFF.pharmacy_handling,
    });
  }

  // Standard admin
  out.push({
    code: "HSP-001",
    codeSystem: "internal",
    description: "Hospital Administration & Records Fee",
    category: "admin",
    quantity: 1,
    unitPrice: TARIFF.admin_fee,
    amount: TARIFF.admin_fee,
  });
  out.push({
    code: "HSP-010",
    codeSystem: "internal",
    description: "Biomedical Waste & Sterilization",
    category: "admin",
    quantity: 1,
    unitPrice: TARIFF.biomedical_waste,
    amount: TARIFF.biomedical_waste,
  });

  return out;
}

export function summarizeCharges(charges: PricedCharge[]) {
  const subtotal = charges.reduce((s, c) => s + c.amount, 0);
  const tax = +(subtotal * TARIFF.tax_rate).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);
  return { subtotal: +subtotal.toFixed(2), tax, total };
}

export function makeInvoiceNo(mrn: string, dischargeTime?: string | null): string {
  const digits = (mrn ?? "0000").replace(/\D/g, "").slice(-6) || "000000";
  const t = new Date(dischargeTime ?? Date.now()).getTime().toString().slice(-5);
  return `INV-${digits}-${t}`;
}