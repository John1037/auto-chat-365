export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  conversation_id?: string;
}

function storageKey(siteKey: string): string {
  return `autochat365_session_${siteKey}`;
}

function loadSession(siteKey: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(storageKey(siteKey));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    // Private browsing / blocked storage -- degrade to no persistence rather than
    // throwing, the widget still works for this page load.
    return null;
  }
}

function saveSession(siteKey: string, session: StoredSession): void {
  try {
    localStorage.setItem(storageKey(siteKey), JSON.stringify(session));
  } catch {
    // Same degrade-gracefully reasoning as loadSession.
  }
}

function isExpired(session: StoredSession): boolean {
  return Date.now() >= session.expires_at * 1000 - 60_000; // 60s safety buffer
}

export function getConversationId(siteKey: string): string | undefined {
  return loadSession(siteKey)?.conversation_id;
}

export function saveConversationId(siteKey: string, conversationId: string): void {
  const existing = loadSession(siteKey);
  if (existing) saveSession(siteKey, { ...existing, conversation_id: conversationId });
}

// Reuses a stored, unexpired session; otherwise mints a fresh one. Pass force=true
// to always mint fresh (used for the one-retry-on-401 path in api.ts) -- the prior
// conversation_id is carried over either way so history isn't lost.
export async function getValidSession(apiBase: string, siteKey: string, force = false): Promise<StoredSession> {
  const existing = loadSession(siteKey);
  if (!force && existing && !isExpired(existing)) return existing;

  const response = await fetch(`${apiBase}/api/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_key: siteKey }),
  });
  if (!response.ok) {
    throw new Error(`session-start failed (${response.status})`);
  }
  const data = (await response.json()) as { access_token: string; refresh_token: string; expires_at: number };
  const session: StoredSession = { ...data, conversation_id: existing?.conversation_id };
  saveSession(siteKey, session);
  return session;
}
