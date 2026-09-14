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

// Length instructions carry a concrete cap and explicitly override the pull of a
// long context block -- a bare adjective like "concise" is too easily outweighed by
// an instruction to answer from a large chunk of retrieved reference text, which is
// exactly the failure mode this is fixing (a widget set to "concise" still producing
// long answers because "use the context" was the stronger signal).
const RESPONSE_LENGTH_INSTRUCTIONS: Record<string, string> = {
  terse: "Respond in a single short sentence, no more than about 15 words. No lists, no elaboration, even if the reference context above is long.",
  concise: "Respond in 2-3 short sentences at most. Include only the single most important point and omit secondary detail, even if the reference context above is long.",
  normal: "Respond with a normal, natural length -- typically one short paragraph or a few sentences.",
  verbose: "Respond thoroughly, covering relevant nuance and detail. Multiple paragraphs or a structured list are fine when they help.",
};

// Falls back to the schema's own default value for anything that isn't a recognized
// key -- defensive against a stored value predating some future added/renamed option,
// so the prompt still gets a real instruction instead of silently dropping one.
function lookup(map: Record<string, string>, value: string, fallbackKey: string): string {
  return map[value] ?? map[fallbackKey];
}

export function buildSystemPrompt(personality: WidgetPersonality, retrievedContext: string): string {
  const characterInstruction = lookup(CHARACTER_STYLE_INSTRUCTIONS, personality.characterStyle, "helpful");
  const styleInstruction = lookup(RESPONSE_STYLE_INSTRUCTIONS, personality.responseStyle, "balanced");
  const lengthInstruction = lookup(RESPONSE_LENGTH_INSTRUCTIONS, personality.responseLength, "normal");

  const contextBlock = retrievedContext
    ? `Answer using only the following context when relevant:\n${retrievedContext}\n\n`
    : "";

  // The context block comes BEFORE the style directives, not after: models weight
  // instructions closest to where generation actually starts most heavily, and a
  // directive placed ahead of a large context block was consistently getting
  // outweighed by "answer using the context" once real context existed -- the same
  // gap that let a hardcoded "helpful assistant" framing bleed into every other
  // character style (fixed here by not hardcoding any persona word in the base line
  // at all; the character style below is the only source of tone).
  return (
    "You are an assistant for this business.\n\n" +
    contextBlock +
    "Follow these instructions for every reply, even if they push against your default style:\n" +
    `- Tone: ${characterInstruction}\n` +
    `- Technical level: ${styleInstruction}\n` +
    `- Length: ${lengthInstruction}`
  );
}
