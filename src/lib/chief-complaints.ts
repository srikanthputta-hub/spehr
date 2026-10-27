/**
 * Patient-voice chief complaints library.
 *
 * Each entry is phrased in the patient's own words and pre-routed to one of
 * the 22 clinical departments S.P.E.H.R supports. The `Auto Doc` automation
 * agent reads `department` to drive condition-specific orders, lab panels,
 * and discharge templates.
 */

export type Department =
  | "Family Medicine"
  | "Internal Medicine"
  | "Pediatrics"
  | "Emergency Department"
  | "Intensive Care Unit"
  | "Traumatology"
  | "Cardiology"
  | "Neurology"
  | "Oncology"
  | "Dermatology"
  | "Gastroenterology"
  | "Endocrinology"
  | "Pulmonology"
  | "General Surgery"
  | "Orthopedic Surgery"
  | "Neurosurgery"
  | "Cardiothoracic Surgery"
  | "Obstetrics and Gynecology"
  | "Radiology"
  | "Pathology"
  | "Anesthesiology"
  | "Psychiatry";

export const DEPARTMENTS: Department[] = [
  "Family Medicine",
  "Internal Medicine",
  "Pediatrics",
  "Emergency Department",
  "Intensive Care Unit",
  "Traumatology",
  "Cardiology",
  "Neurology",
  "Oncology",
  "Dermatology",
  "Gastroenterology",
  "Endocrinology",
  "Pulmonology",
  "General Surgery",
  "Orthopedic Surgery",
  "Neurosurgery",
  "Cardiothoracic Surgery",
  "Obstetrics and Gynecology",
  "Radiology",
  "Pathology",
  "Anesthesiology",
  "Psychiatry",
];

export type Acuity = "low" | "med" | "high" | "critical";

export interface PatientComplaint {
  text: string;
  department: Department;
  acuity: Acuity;
}

export const PATIENT_COMPLAINTS: PatientComplaint[] = [
  // Cardiology
  {
    text: "My chest feels incredibly tight and I'm dizzy",
    department: "Cardiology",
    acuity: "critical",
  },
  {
    text: "I have crushing pressure in the middle of my chest that won't go away",
    department: "Cardiology",
    acuity: "critical",
  },
  {
    text: "My heart is racing and I can feel it pounding in my throat",
    department: "Cardiology",
    acuity: "high",
  },
  {
    text: "I keep getting short of breath just walking to the bathroom",
    department: "Cardiology",
    acuity: "high",
  },
  {
    text: "My ankles have been swelling up and I can barely fit my shoes",
    department: "Cardiology",
    acuity: "med",
  },
  {
    text: "I almost passed out walking up the stairs this morning",
    department: "Cardiology",
    acuity: "high",
  },

  // Neurology
  {
    text: "The right side of my face is drooping and I can't speak clearly",
    department: "Neurology",
    acuity: "critical",
  },
  {
    text: "I had the worst headache of my life and then everything went blurry",
    department: "Neurology",
    acuity: "critical",
  },
  {
    text: "I'm having a hard time finding the right words today",
    department: "Neurology",
    acuity: "high",
  },
  {
    text: "My left arm went completely numb a few hours ago",
    department: "Neurology",
    acuity: "high",
  },
  {
    text: "I keep getting these tingling shocks down my back when I bend over",
    department: "Neurology",
    acuity: "med",
  },
  {
    text: "My hands have been shaking and I can't seem to stop them",
    department: "Neurology",
    acuity: "med",
  },

  // Pulmonology
  { text: "I can't catch my breath even sitting still", department: "Pulmonology", acuity: "high" },
  {
    text: "I've had a wet cough for two weeks and now I'm coughing up blood",
    department: "Pulmonology",
    acuity: "high",
  },
  {
    text: "My inhaler isn't helping anymore and my chest is whistling",
    department: "Pulmonology",
    acuity: "high",
  },
  { text: "I wake up at night gasping for air", department: "Pulmonology", acuity: "med" },

  // Gastroenterology
  {
    text: "I can't keep any food down since last night",
    department: "Gastroenterology",
    acuity: "med",
  },
  {
    text: "My stomach is killing me, it feels like something burst",
    department: "Gastroenterology",
    acuity: "high",
  },
  {
    text: "I've been throwing up blood this morning",
    department: "Gastroenterology",
    acuity: "critical",
  },
  {
    text: "My poop has been black and tarry for the last two days",
    department: "Gastroenterology",
    acuity: "high",
  },
  {
    text: "I have terrible heartburn that feels like fire in my chest",
    department: "Gastroenterology",
    acuity: "med",
  },
  {
    text: "My belly is so bloated and I haven't gone to the bathroom in five days",
    department: "Gastroenterology",
    acuity: "med",
  },

  // Endocrinology
  {
    text: "My blood sugar keeps reading over 400 and I feel awful",
    department: "Endocrinology",
    acuity: "high",
  },
  {
    text: "I've been so thirsty and peeing constantly the last week",
    department: "Endocrinology",
    acuity: "med",
  },
  {
    text: "I've lost twenty pounds without trying and I'm always exhausted",
    department: "Endocrinology",
    acuity: "med",
  },
  {
    text: "My hands won't stop trembling and my heart is pounding for no reason",
    department: "Endocrinology",
    acuity: "med",
  },

  // Emergency Department / general acute
  {
    text: "I slipped on the ice and now my wrist is bent the wrong way",
    department: "Emergency Department",
    acuity: "high",
  },
  {
    text: "I cut my hand on a kitchen knife and it won't stop bleeding",
    department: "Emergency Department",
    acuity: "med",
  },
  {
    text: "I'm having a really bad allergic reaction, my lips are swelling",
    department: "Emergency Department",
    acuity: "critical",
  },
  {
    text: "I think I took too many of my pills by accident",
    department: "Emergency Department",
    acuity: "critical",
  },
  {
    text: "My eye got splashed with chemicals at work",
    department: "Emergency Department",
    acuity: "high",
  },

  // ICU
  {
    text: "My family says I've been confused and barely responsive all day",
    department: "Intensive Care Unit",
    acuity: "critical",
  },
  {
    text: "I have a high fever, my heart is racing, and I just feel like I'm dying",
    department: "Intensive Care Unit",
    acuity: "critical",
  },

  // Traumatology
  {
    text: "I was in a car crash and my chest hit the steering wheel really hard",
    department: "Traumatology",
    acuity: "critical",
  },
  {
    text: "I fell off a ladder and landed on my back, I can't really move",
    department: "Traumatology",
    acuity: "critical",
  },
  {
    text: "Somebody hit me in the head and I blacked out for a minute",
    department: "Traumatology",
    acuity: "high",
  },

  // Orthopedic Surgery
  {
    text: "I twisted my knee playing basketball and now it won't hold my weight",
    department: "Orthopedic Surgery",
    acuity: "med",
  },
  {
    text: "My shoulder popped out of place when I reached for something",
    department: "Orthopedic Surgery",
    acuity: "high",
  },
  {
    text: "My back has been aching for months and now my leg is going numb",
    department: "Orthopedic Surgery",
    acuity: "med",
  },
  {
    text: "I think I broke my ankle, I heard it crack when I landed",
    department: "Orthopedic Surgery",
    acuity: "high",
  },

  // Neurosurgery
  {
    text: "I hit my head a couple days ago and now I keep throwing up",
    department: "Neurosurgery",
    acuity: "critical",
  },
  {
    text: "I've had shooting pain down my leg and now I can't feel my foot",
    department: "Neurosurgery",
    acuity: "high",
  },

  // General Surgery
  {
    text: "I've got really bad pain in my lower right belly and I feel feverish",
    department: "General Surgery",
    acuity: "high",
  },
  {
    text: "There's a painful bulge in my groin that I can't push back in",
    department: "General Surgery",
    acuity: "high",
  },
  {
    text: "My right side hurts whenever I eat anything greasy",
    department: "General Surgery",
    acuity: "med",
  },

  // Cardiothoracic Surgery
  {
    text: "My cardiologist said I need an urgent surgery for a blocked valve",
    department: "Cardiothoracic Surgery",
    acuity: "high",
  },
  {
    text: "I was told there's an aneurysm in my chest that's getting bigger",
    department: "Cardiothoracic Surgery",
    acuity: "high",
  },

  // OB/GYN
  {
    text: "I'm pregnant and I just started bleeding heavily",
    department: "Obstetrics and Gynecology",
    acuity: "high",
  },
  {
    text: "I'm in labor and my contractions are about three minutes apart",
    department: "Obstetrics and Gynecology",
    acuity: "high",
  },
  {
    text: "I haven't felt my baby move all day and I'm 32 weeks along",
    department: "Obstetrics and Gynecology",
    acuity: "critical",
  },
  {
    text: "I've been having really bad pelvic pain and bleeding between periods",
    department: "Obstetrics and Gynecology",
    acuity: "med",
  },

  // Pediatrics
  {
    text: "My toddler has had a fever of 103 for two days and won't drink anything",
    department: "Pediatrics",
    acuity: "high",
  },
  {
    text: "My baby's been pulling at her ear and crying nonstop all night",
    department: "Pediatrics",
    acuity: "med",
  },
  {
    text: "My son had a seizure at school today and we've never seen one before",
    department: "Pediatrics",
    acuity: "critical",
  },
  {
    text: "My daughter's been wheezing and her chest is sucking in when she breathes",
    department: "Pediatrics",
    acuity: "high",
  },

  // Family Medicine / Internal Medicine
  {
    text: "I just feel run down, low fever, and my whole body aches",
    department: "Family Medicine",
    acuity: "low",
  },
  {
    text: "I need a refill on my blood pressure meds and a quick check-up",
    department: "Family Medicine",
    acuity: "low",
  },
  {
    text: "I've had a sore throat and runny nose for about five days",
    department: "Family Medicine",
    acuity: "low",
  },
  {
    text: "My blood pressure has been creeping up on the home monitor",
    department: "Internal Medicine",
    acuity: "med",
  },
  {
    text: "I'm always tired no matter how much I sleep and my joints hurt",
    department: "Internal Medicine",
    acuity: "low",
  },
  {
    text: "I'm here for follow-up of my diabetes and cholesterol",
    department: "Internal Medicine",
    acuity: "low",
  },

  // Oncology
  { text: "I found a hard lump in my breast last week", department: "Oncology", acuity: "med" },
  {
    text: "I've been losing weight, sweating at night, and feeling these lumps in my neck",
    department: "Oncology",
    acuity: "med",
  },
  { text: "I'm here for my next round of chemotherapy", department: "Oncology", acuity: "low" },

  // Dermatology
  {
    text: "I have a mole on my back that's been changing shape and color",
    department: "Dermatology",
    acuity: "med",
  },
  {
    text: "My whole back broke out in this itchy red rash overnight",
    department: "Dermatology",
    acuity: "low",
  },
  {
    text: "A spot on my arm has been crusty and won't heal for months",
    department: "Dermatology",
    acuity: "low",
  },

  // Radiology (scheduled imaging visits)
  { text: "My doctor sent me here for an MRI of my knee", department: "Radiology", acuity: "low" },
  {
    text: "I need a follow-up CT scan to check on a nodule in my lung",
    department: "Radiology",
    acuity: "low",
  },

  // Pathology (specimen / lab review consult)
  {
    text: "I'm here to discuss the biopsy results my surgeon sent off",
    department: "Pathology",
    acuity: "low",
  },

  // Anesthesiology (pre-op clinic)
  {
    text: "I'm here for my pre-surgery anesthesia evaluation",
    department: "Anesthesiology",
    acuity: "low",
  },
  {
    text: "I had a bad reaction to anesthesia last time and I'm worried about my surgery tomorrow",
    department: "Anesthesiology",
    acuity: "med",
  },

  // Psychiatry
  {
    text: "I've been having thoughts of hurting myself and I'm scared",
    department: "Psychiatry",
    acuity: "critical",
  },
  {
    text: "I haven't slept in days and my mind is racing nonstop",
    department: "Psychiatry",
    acuity: "high",
  },
  {
    text: "I keep having panic attacks where I think I'm dying",
    department: "Psychiatry",
    acuity: "med",
  },
  {
    text: "I just feel hopeless and empty, I can't even get out of bed",
    department: "Psychiatry",
    acuity: "high",
  },
];

/* ----------------------------------------------------------------- */
/*  Pickers                                                           */
/* ----------------------------------------------------------------- */

const _recent = new Set<number>();
const _recentMax = 40;

/** Pick a complaint with low repeat probability across this client session. */
export function pickComplaint(): PatientComplaint {
  let idx = Math.floor(Math.random() * PATIENT_COMPLAINTS.length);
  let tries = 0;
  while (_recent.has(idx) && tries < 12) {
    idx = Math.floor(Math.random() * PATIENT_COMPLAINTS.length);
    tries++;
  }
  _recent.add(idx);
  if (_recent.size > _recentMax) {
    // drop oldest-ish (Set preserves insertion order)
    const first = _recent.values().next().value;
    if (first !== undefined) _recent.delete(first);
  }
  return PATIENT_COMPLAINTS[idx];
}

/** Heuristic department router for complaints arriving from non-tagged sources. */
export function routeDepartment(text: string): Department {
  const t = text.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));
  if (has("chest", "heart", "palpit", "syncope", "passed out")) return "Cardiology";
  if (
    has("stroke", "slurr", "droop", "weakness", "numb", "tingl", "seizure", "headache", "migraine")
  )
    return "Neurology";
  if (has("breath", "wheez", "cough", "asthma", "copd", "inhaler", "gasping")) return "Pulmonology";
  if (
    has(
      "vomit",
      "diarr",
      "abdomin",
      "belly",
      "stomach",
      "stool",
      "constipat",
      "heartburn",
      "blood in stool",
    )
  )
    return "Gastroenterology";
  if (has("sugar", "diabet", "thyroid", "thirst", "polyur")) return "Endocrinology";
  if (has("rash", "mole", "skin", "itchy", "lesion")) return "Dermatology";
  if (has("lump", "tumor", "chemo", "cancer", "mass")) return "Oncology";
  if (has("fracture", "broke", "twist", "sprain", "dislocat", "joint", "shoulder", "knee", "ankle"))
    return "Orthopedic Surgery";
  if (has("head injur", "concuss", "spinal", "disc", "sciatica")) return "Neurosurgery";
  if (has("crash", "fall", "trauma", "assault", "hit")) return "Traumatology";
  if (has("appendic", "hernia", "gallbladder", "cholecyst")) return "General Surgery";
  if (has("pregnant", "labor", "contraction", "bleeding pelvic", "fetal"))
    return "Obstetrics and Gynecology";
  if (has("toddler", "child", "infant", "baby", "pediatric")) return "Pediatrics";
  if (has("suicid", "depress", "anxiet", "panic", "manic", "psychos")) return "Psychiatry";
  if (has("mri", "ct scan", "x-ray", "imaging")) return "Radiology";
  if (has("biopsy", "specimen", "pathology")) return "Pathology";
  if (has("anesthesia", "pre-op")) return "Anesthesiology";
  if (has("icu", "septic", "unresponsive", "barely respond")) return "Intensive Care Unit";
  if (has("emergency", "bleeding", "overdose", "allergic")) return "Emergency Department";
  return "Family Medicine";
}
