import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./supabaseClient";

export interface AuthedContext {
  supabase: SupabaseClient;
  session: Session;
}

// For "user" pages (logged-in tenant members): redirects to /login.html if there's no
// session, otherwise returns it. getSession() waits for supabase-js's own detection of
// a magic-link redirect in the URL to finish first, so this is safe to call
// immediately whether we just arrived from the email link or are revisiting with an
// existing session either way.
export async function requireSession(): Promise<AuthedContext | null> {
  const supabase = await getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    location.href = "/login.html";
    return null;
  }

  // Clean a magic-link token out of the URL now that the session is established --
  // purely cosmetic, but avoids leaving a sensitive-looking fragment
  // visible/bookmarkable. This project's implicit auth flow puts those tokens in the
  // hash (#access_token=...), never the query string -- stripping location.search too
  // used to wipe out a page's own params (e.g. widget-settings.html's ?id=) before
  // that page's own script ever got to read them, since requireSession() runs first.
  if (location.hash) {
    history.replaceState({}, "", location.pathname + location.search);
  }

  return { supabase, session };
}

// For site-admin pages: everything requireSession() does, plus a self-check against
// site_admins (RLS only ever lets a caller see their own row -- see
// supabase/migrations/0006_site_admins.sql -- so a non-empty result here is a
// reliable, live signal, not a cached claim). This is a UX gate only: the actual
// admin write endpoints re-verify server-side and must never trust this alone.
export async function requireSiteAdmin(): Promise<AuthedContext | null> {
  const context = await requireSession();
  if (!context) return null;

  const { data } = await context.supabase
    .from("site_admins")
    .select("user_id")
    .eq("user_id", context.session.user.id)
    .maybeSingle();

  if (!data) {
    location.href = "/dashboard.html";
    return null;
  }

  return context;
}

// Re-checks the current session immediately before an authenticated fetch, instead
// of trusting the token requireSession() captured once at page load. supabase-js
// keeps the underlying session refreshed in the background for as long as the page
// stays open, but nothing re-reads it unless asked -- a page (or a captured
// access_token variable) that's been sitting open for a while sends a now-stale
// token otherwise, and the API call fails with "invalid or expired session" even
// though the visitor never actually got signed out. getSession() returns
// supabase-js's current, live value (refreshing it first if it's already expired).
export async function getAccessToken(supabase: SupabaseClient): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

// Populates the Widgets section's live sub-list in the sidebar (every widget by
// name, newest first) -- present on every authenticated page, not just the widgets
// pages themselves, so a tenant can jump straight to any widget's settings from
// wherever they are. Shared here (like wireSignOut) rather than duplicated per
// page-script.
export async function populateSidebarWidgets(supabase: SupabaseClient): Promise<void> {
  const container = document.querySelector<HTMLElement>("#sidebar-widget-list");
  if (!container) return;

  const { data } = await supabase
    .from("widgets")
    .select("id, name")
    .order("created_at", { ascending: false });

  const currentId = new URLSearchParams(location.search).get("id");
  const onSettingsPage = location.pathname === "/widget-settings.html";

  container.innerHTML = "";
  for (const widget of data ?? []) {
    const link = document.createElement("a");
    link.className = "sidebar-widget-link";
    link.href = `/widget-settings.html?id=${widget.id}`;
    link.textContent = widget.name;
    if (onSettingsPage && widget.id === currentId) link.classList.add("active");
    container.appendChild(link);
  }
}

// Wires the #sign-out link present on every authenticated page's top bar. Shared
// rather than duplicated per page-script, since app-shell.ts (dashboard/settings/
// knowledge-base-analysis) and the other Knowledge Base pages (which need their own
// scripts for page-specific logic) all need this same handful of lines.
export function wireSignOut(): void {
  document.querySelector<HTMLElement>("#sign-out")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const supabase = await getSupabaseClient();
    await supabase.auth.signOut();
    location.href = "/";
  });
}
