import { getValidSession, saveConversationId } from "./session";

export interface ChatResult {
  conversationId: string;
  reply: string;
}

// One transparent re-mint-and-retry on 401 -- a stored access_token can be rejected
// even before its own expiry (e.g. the session was revoked), and the visitor should
// never see that as a failure if a fresh session fixes it silently.
export async function sendMessage(apiBase: string, siteKey: string, message: string): Promise<ChatResult> {
  const attempt = async (forceNewSession: boolean): Promise<Response> => {
    const session = await getValidSession(apiBase, siteKey, forceNewSession);
    return fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, conversation_id: session.conversation_id }),
    });
  };

  let response = await attempt(false);
  if (response.status === 401) {
    response = await attempt(true);
  }

  if (response.status === 429) {
    throw new Error("We're getting a lot of messages right now -- please try again in a moment.");
  }
  if (!response.ok) {
    throw new Error("Something went wrong sending that message.");
  }

  const data = (await response.json()) as { conversation_id: string; reply: string };
  saveConversationId(siteKey, data.conversation_id);
  return { conversationId: data.conversation_id, reply: data.reply };
}
