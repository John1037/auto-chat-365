export interface WidgetPersonality {
  characterStyle: string;
  responseStyle: string;
  responseLength: string;
}

// One instruction fragment per dropdown option (see migration 0017) -- folded into
// the system prompt rather than left as raw column values, so the model gets
// concrete guidance instead of just a label it has to interpret on its own.
const CHARACTER_STYLE_INSTRUCTIONS: Record<string, string> = {
  empathetic: "Respond with empathy, acknowledging the visitor's feelings and situation.",
  sympathetic: "Respond with sympathy and warmth toward the visitor's concerns.",
  friendly: "Respond in a friendly, approachable tone.",
  cheerful: "Respond in a cheerful, upbeat tone.",
  salesman: "Respond persuasively, like an enthusiastic salesperson -- highlight benefits and encourage the visitor to take action.",
  helpful: "Respond in a helpful, straightforward tone focused on solving the visitor's problem.",
  apologetic: "Respond with an apologetic tone, acknowledging any inconvenience to the visitor.",
  informative: "Respond in an informative, neutral, fact-focused tone.",
  enthusiastic: "Respond with enthusiasm and energy.",
};

const RESPONSE_STYLE_INSTRUCTIONS: Record<string, string> = {
  technical: "Use precise technical language and terminology where relevant; do not oversimplify.",
  balanced: "Use a balanced mix of plain language and technical detail, as appropriate to the question.",
  "non-technical": "Avoid technical jargon; explain things in simple, plain language.",
};

const RESPONSE_LENGTH_INSTRUCTIONS: Record<string, string> = {
  terse: "Keep responses as short as possible -- a sentence or two at most.",
  concise: "Keep responses concise and to the point.",
  normal: "Use a normal, natural response length.",
  verbose: "Provide thorough, detailed responses that cover relevant nuance.",
};

// Falls back to the schema's own default value for anything that isn't a recognized
// key -- defensive against a stored value predating some future added/renamed option,
// so the prompt still gets a real instruction instead of silently dropping one.
function lookup(map: Record<string, string>, value: string, fallbackKey: string): string {
  return map[value] ?? map[fallbackKey];
}

export function buildSystemPrompt(personality: WidgetPersonality, retrievedContext: string): string {
  const instructions = [
    lookup(CHARACTER_STYLE_INSTRUCTIONS, personality.characterStyle, "helpful"),
    lookup(RESPONSE_STYLE_INSTRUCTIONS, personality.responseStyle, "balanced"),
    lookup(RESPONSE_LENGTH_INSTRUCTIONS, personality.responseLength, "normal"),
  ].join(" ");

  const base = `You are a helpful assistant for this business. ${instructions}`;
  return retrievedContext
    ? `${base} Answer using only the following context when relevant:\n${retrievedContext}`
    : base;
}
