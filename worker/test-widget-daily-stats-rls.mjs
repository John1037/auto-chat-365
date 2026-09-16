// Real RLS verification for widget_daily_stats -- caught missing in review, this
// confirms the fix: a tenant owner can read their own widget's stats through the
// real RLS-scoped client (their own JWT, not the service-role client), a DIFFERENT
// tenant's owner gets zero rows for it (the actual tenant-isolation property that
// matters), and an anonymous widget visitor session gets zero rows too.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function createOwner(service, anon, email, password) {
  await service.auth.admin.createUser({ email, password, email_confirm: true });
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password });
  return { client, userId: signIn.user.id };
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const password = "test-password-123!";

  const { data: tenantA } = await service.from("tenants").insert({ name: "RLS Stats Test A" }).select("id").single();
  const { data: widgetA } = await service.from("widgets").insert({ tenant_id: tenantA.id }).select("id").single();
  const emailA = `stats-rls-owner-a-${Date.now()}@example.test`;
  await service.from("tenant_members").insert({ tenant_id: tenantA.id, user_id: (await service.auth.admin.createUser({ email: emailA, password, email_confirm: true })).data.user.id, role: "owner" });

  const { data: tenantB } = await service.from("tenants").insert({ name: "RLS Stats Test B" }).select("id").single();
  const emailB = `stats-rls-owner-b-${Date.now()}@example.test`;
  await service.from("tenant_members").insert({ tenant_id: tenantB.id, user_id: (await service.auth.admin.createUser({ email: emailB, password, email_confirm: true })).data.user.id, role: "owner" });

  await service.from("widget_daily_stats").insert({
    widget_id: widgetA.id,
    tenant_id: tenantA.id,
    stat_date: "2026-01-01",
    conversations_started: 7,
    messages_count: 20,
  });

  console.log("--- Tenant A's own owner can see tenant A's stats via their own RLS-scoped session ---");
  {
    const clientA = createClient(SUPABASE_URL, ANON_KEY);
    await clientA.auth.signInWithPassword({ email: emailA, password });
    const { data, error } = await clientA.from("widget_daily_stats").select("*").eq("widget_id", widgetA.id);
    assert(!error, `no error reading own tenant's stats (${error?.message})`);
    assert(data.length === 1 && data[0].conversations_started === 7, `owner A sees their own real stats row (got ${JSON.stringify(data)})`);
  }

  console.log("--- Tenant B's owner gets ZERO rows for tenant A's widget -- the actual isolation property ---");
  {
    const clientB = createClient(SUPABASE_URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: emailB, password });
    const { data, error } = await clientB.from("widget_daily_stats").select("*").eq("widget_id", widgetA.id);
    assert(!error, `no error, just filtered to nothing (${error?.message})`);
    assert(data.length === 0, `tenant B sees none of tenant A's stats (got ${data.length} rows)`);

    // Also confirm an unfiltered query doesn't leak it either -- the isolation is
    // RLS itself, not just this test's own eq() filter happening to exclude it.
    const { data: unfiltered } = await clientB.from("widget_daily_stats").select("*");
    assert(!unfiltered.some((row) => row.widget_id === widgetA.id), "an unfiltered query from tenant B never includes tenant A's row either");
  }

  console.log("--- An anonymous widget-visitor session gets zero rows (default-deny, not a policy match) ---");
  {
    const { data: widgetSessionUser } = await service.auth.signInAnonymously();
    await service.from("widget_sessions").insert({ id: widgetSessionUser.user.id, tenant_id: tenantA.id, widget_id: widgetA.id });
    const visitorClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${widgetSessionUser.session.access_token}` } },
    });
    const { data, error } = await visitorClient.from("widget_daily_stats").select("*");
    assert(!error, `no error, just an empty result (${error?.message})`);
    assert(data.length === 0, "an anonymous visitor session sees no stats rows at all, from any tenant");
  }

  await service.from("tenants").delete().eq("id", tenantA.id);
  await service.from("tenants").delete().eq("id", tenantB.id);
  console.log("\nALL WIDGET_DAILY_STATS RLS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
