import type { Env } from "./env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function deepseekChat(env: Env, messages: ChatMessage[]): Promise<string> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "deepseek-chat", messages }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek chat request failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content;
}
