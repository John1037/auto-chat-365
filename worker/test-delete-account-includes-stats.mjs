// Confirms delete_tenant_account (updated in migration 0026) also removes
// widget_daily_stats -- a real regression check that the earlier
// test-delete-tenant-account.mjs predates this feature and wouldn't otherwise catch.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "Delete Account Stats Test" }).select("id").single();
  const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id }).select("id").single();

  await service.from("widget_daily_stats").insert({ widget_id: widget.id, tenant_id: tenant.id, stat_date: "2026-01-01", conversations_started: 5, messages_count: 10 });
  const { data: before } = await service.from("widget_daily_stats").select("*").eq("widget_id", widget.id);
  assert(before.length === 1, "seeded stats row exists before deletion");

  const { error } = await service.rpc("delete_tenant_account", { p_tenant_id: tenant.id });
  assert(!error, `delete_tenant_account ran without error (${error?.message})`);

  const { data: after } = await service.from("widget_daily_stats").select("*").eq("widget_id", widget.id);
  assert(after.length === 0, "widget_daily_stats rows are gone after account deletion");

  console.log("\nALL DELETE-ACCOUNT-INCLUDES-STATS CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
