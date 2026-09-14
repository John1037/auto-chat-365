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

// Read-only lookup for widget init: is there already a live session to restore
// history for? Unlike getValidSession(), this never mints a new one -- a brand new
// session by definition has no prior conversation to show, so there's no reason to
// pay a session-start round trip just to find that out.
export function peekValidSession(siteKey: string): StoredSession | null {
  const existing = loadSession(siteKey);
  return existing && !isExpired(existing) ? existing : null;
}

export function saveConversationId(siteKey: string, conversationId: string): void {
  const existing = loadSession(siteKey);
  if (existing) saveSession(siteKey, { ...existing, conversation_id: conversationId });
}

// Reuses a stored, unexpired session; otherwise mints a fresh one. Pass force=true
// to always mint fresh (used for the one-retry-on-401 path in api.ts).
//
// A fresh mint can NOT carry the old conversation_id forward: /api/session-start
// always calls signInAnonymously(), which creates a brand-new anonymous user (a new
// session_id) every time it runs, rather than resuming the previous one. chat.ts
// looks up an existing conversation_id with `WHERE session_id = callerId`, so a
// conversation_id from a since-replaced session_id can never match -- every message
// would 404 as "conversation not found" from that point on. That failure mode
// previously surfaced to visitors as a generic "Failed to fetch" (that response
// path was missing CORS headers, like every other error path before the CORS fix),
// which is why it went unnoticed: it looked identical to a network error.
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
  const session: StoredSession = { ...data };
  saveSession(siteKey, session);
  return session;
}
