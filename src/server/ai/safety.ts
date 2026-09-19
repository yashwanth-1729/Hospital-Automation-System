/**
 * Deterministic safety net. Runs on every enquiry regardless of AI provider,
 * so a model mistake can never downgrade an emergency to a routine booking.
 * Includes common Hinglish phrasings seen in Indian patient enquiries.
 */

const EMERGENCY_PATTERNS: [string, RegExp][] = [
  ["chest pain", /\bchest\s*(pain|tightness|pressure)\b|\bseene\s*(me|mein)\s*dard\b/i],
  ["breathing difficulty", /\b(can'?t|cannot|unable to|difficulty|trouble)\s+breath|\bbreathless|\bshortness of breath\b|\bsaans\s*(nahi|lene\s*me|phool)/i],
  ["unconscious", /\bunconscious\b|\bfainted\b|\bnot responding\b|\bbehosh\b/i],
  ["heavy bleeding", /\b(heavy|severe|lot of|continuous)\s+bleeding\b|\bbleeding (heavily|a lot)\b|\bkhoon\s*(beh|nikal)/i],
  ["stroke signs", /\bstroke\b|\bparaly[sz]|\bface\s+(drooping|droop)\b|\bslurred speech\b|\blakwa\b/i],
  ["seizure", /\bseizure|\bconvulsion|\bfits\b|\bmirgi\b/i],
  ["self-harm", /\bsuicid|\bkill (myself|himself|herself)\b|\bself[-\s]?harm\b|\bend my life\b/i],
  ["poisoning/overdose", /\boverdose\b|\bpoison|\bswallowed\b|\bzeher\b/i],
  ["accident/injury", /\baccident\b|\bhead injury\b|\bserious(ly)? injur/i],
  ["heart attack", /\bheart attack\b/i],
  ["emergency stated", /\bemergency\b|\bcritical condition\b|\bdying\b/i],
];

/** Not an emergency on its own, but a person should look before anything is automated. */
const URGENCY_PATTERNS: [string, RegExp][] = [
  ["urgency stated", /\burgent(ly)?\b|\basap\b|\bimmediately\b|\bturant\b|\bjaldi\b/i],
];

const CLINICAL_QUESTION_PATTERNS: [string, RegExp][] = [
  ["medication question", /\b(which|what|kaun\s*si)\s+(medicine|tablet|drug|dawai|dawa)\b|\bshould i take\b|\bdosage\b|\bdose of\b|\bstop (taking|my) (medicine|tablet)/i],
  ["result interpretation", /\b(is|are) (my|the) (report|result|value|level)s? (normal|ok|bad|serious)\b|\bwhat does (my|the) (report|result)\b|\binterpret\b/i],
  ["diagnosis request", /\bwhat (disease|condition|illness) (do|does|is)\b|\bdo i have\b|\bis it (cancer|serious|dangerous)\b|\bdiagnos/i],
  ["treatment advice", /\bhome remed|\bhow (to|do i) (treat|cure)\b|\bwhat treatment\b|\bilaaj\b/i],
];

export interface SafetyCheck {
  emergency: boolean;
  clinicalQuestion: boolean;
  urgency: boolean;
  flags: string[];
}

export function checkSafety(text: string): SafetyCheck {
  const emergencyFlags = EMERGENCY_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
  const clinicalFlags = CLINICAL_QUESTION_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
  const urgencyFlags = URGENCY_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
  return {
    emergency: emergencyFlags.length > 0,
    clinicalQuestion: clinicalFlags.length > 0,
    urgency: urgencyFlags.length > 0,
    flags: [...emergencyFlags, ...clinicalFlags, ...urgencyFlags],
  };
}
