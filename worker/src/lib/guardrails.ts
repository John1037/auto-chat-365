// Deterministic, non-LLM guardrail checks -- these run before a message ever
// reaches the chat model. Per the platform-vs-tenant guardrail split: everything in
// this file except containsProfanity/matchesBlockedTopic is a fixed platform floor
// (chat.ts applies it unconditionally); those two are the actual per-widget dials
// (see migration 0018) applied on top of the floor.

export const MAX_MESSAGE_LENGTH = 4000;

// --- Secret / payment-data redaction (platform floor) ---------------------------

// Luhn check cuts down on false positives from ordinary 13-19 digit numbers (order
// numbers, phone numbers) that aren't actually a card number.
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style secret key
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe / this platform's own site_key shape
  /\bpk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

// Replaces card numbers (Luhn-validated) and common credential/token shapes with a
// placeholder -- applied to the visitor's own message before it's stored or sent to
// the chat model, so a pasted card number or API key never lands in the messages
// table or an LLM provider's logs. Never applied to what the visitor's own browser
// displays back to them (that's their own literal input, rendered client-side).
export function redactSensitiveInfo(text: string): string {
  let result = text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return passesLuhn(digits) ? "[redacted card number]" : match;
  });
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

// --- Prompt injection / jailbreak screening (platform floor) --------------------

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:the )?(?:previous|prior|above|earlier) instructions?/i,
  /disregard (?:all )?(?:the )?(?:previous|prior|above|earlier)/i,
  /forget (?:all )?(?:your|the) (?:previous|prior|above) (?:instructions?|rules?|prompt)/i,
  /reveal (?:your|the) (?:system )?prompt/i,
  /(?:show|print|repeat|output) (?:me )?(?:your|the) (?:system )?(?:prompt|instructions)/i,
  /what (?:are|is) your (?:system )?(?:prompt|instructions)/i,
  /you are now (?:in )?(?:dan|developer mode|jailbreak)/i,
  /enter developer mode/i,
  /act as if you (?:have no|had no) (?:restrictions|rules|guidelines)/i,
  /pretend (?:that )?you have no (?:restrictions|rules|guidelines)/i,
  /(?:override|bypass) your (?:instructions|guidelines|restrictions)/i,
  /you (?:have no|are not bound by) (?:rules|restrictions|guidelines)/i,
];

// A deterministic, best-effort net for well-known jailbreak phrasings -- not a
// substitute for the model's own training against these, but per the "never trust
// the model with access control" rule, a real request shouldn't only be as safe as
// the model's own judgment on that one call.
export function detectPromptInjectionAttempt(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// --- NSFW hard floor (platform floor, independent of nsfw_policy) ---------------

// OpenAI's moderation "sexual" category does not distinguish ordinary consensual
// adult content from incest, non-consent, or sexual violence -- verified directly
// against the real API (all three score identically as "sexual", with "sexual
// violence" also picking up the separate general "violence" category, not a
// sexual-specific one). A tenant enabling nsfw_policy therefore can't rely on that
// one coarse score alone; these categories are screened deterministically instead,
// and this check always applies regardless of nsfw_policy -- there is no tenant
// setting that can turn it off. sexual/minors is additionally covered by
// moderation.ts's own always-on hard-block category, independent of this list.
const NSFW_HARD_BLOCK_PATTERNS: RegExp[] = [
  /\bnon[- ]?consensual\b/i,
  /\bnon[- ]?consent\b/i,
  /\bwithout (?:her|his|their) consent\b/i,
  /\bagainst (?:her|his|their) will\b/i,
  /\bforc(?:e|es|ed|ing) (?:her|him|them)? ?(?:to have sex|into sex|to sleep with)\b/i,
  /\brape[sd]?\b/i,
  /\braping\b/i,
  /\bincest(?:uous)?\b/i,
];

// A family relation term and a sexual-act term appearing anywhere in the same
// message, in either order (e.g. "have sex with my stepsister" as well as
// "stepsister ... sex") -- a single fixed-order regex would only ever catch one
// phrasing, and a short chat message can put either word first.
const STEP_FAMILY_PATTERN = /\bstep ?(?:dad|mom|father|mother|brother|sister|son|daughter)\b/i;
const MINOR_PATTERN = /\b(?:a |my )?(?:minor|child|kid|underage)\b/i;
const SEXUAL_ACT_PATTERN = /\b(?:sex|sexual|fuck(?:ing)?|sleep(?:ing)? with|nude|naked)\b/i;

export function detectHardBlockedNsfwContent(text: string): boolean {
  if (NSFW_HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (STEP_FAMILY_PATTERN.test(text) && SEXUAL_ACT_PATTERN.test(text)) return true;
  if (MINOR_PATTERN.test(text) && SEXUAL_ACT_PATTERN.test(text)) return true;
  return false;
}

// --- Tenant-configurable dials ---------------------------------------------------

// Deliberately modest -- common English profanity, not slurs (hate speech is a
// platform-floor moderation-API category, not a tenant dial; see moderation.ts).
const PROFANITY_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt", "piss"];
// \w* on both sides, not just after -- a word boundary alone would miss a profanity
// word appearing as a suffix within a compound (e.g. "bullshit" starts with "bull",
// not "shit", so an anchored-prefix match alone would let it straight through).
const PROFANITY_PATTERN = new RegExp(`\\b\\w*(?:${PROFANITY_WORDS.join("|")})\\w*\\b`, "i");

export function containsProfanity(text: string): boolean {
  return PROFANITY_PATTERN.test(text);
}

// Case-insensitive substring match against the tenant's own configured list.
// Substring (not word-boundary) is deliberate -- a blocked topic is usually a phrase
// ("competitor pricing"), and a tenant would rather over-match than have a trivial
// pluralization/punctuation difference slip past it.
export function matchesBlockedTopic(text: string, blockedTopics: string[]): string | null {
  const lower = text.toLowerCase();
  return blockedTopics.find((topic) => topic.trim() && lower.includes(topic.trim().toLowerCase())) ?? null;
}
