import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: Promise<SupabaseClient> | null = null;

// Fetches which Supabase project to talk to from our own Worker (/api/config) rather
// than baking it in at build time -- keeps the site pages in sync with whatever
// SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY the Worker is actually running with (local
// vs. production) with no separate build-time config step.
export function getSupabaseClient(): Promise<SupabaseClient> {
  if (!cached) {
    cached = fetch("/api/config")
      .then((r) => r.json())
      .then(({ supabaseUrl, supabasePublishableKey }) => createClient(supabaseUrl, supabasePublishableKey));
  }
  return cached;
}
