// Real DB-level validation checks: the timezone trigger rejects a bogus IANA name
// (and accepts a real one), and the retention check constraint enforces 1-24.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: tenant } = await service.from("tenants").insert({ name: "TZ/Retention Validation Test" }).select("id").single();
  const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id }).select("id").single();

  console.log("--- Widget timezone validation ---");
  {
    const { error } = await service.from("widgets").update({ timezone: "Not/A_Real_Zone" }).eq("id", widget.id);
    assert(!!error, `a bogus timezone is rejected by the trigger (error: ${error?.message})`);

    const { error: okError } = await service.from("widgets").update({ timezone: "America/New_York" }).eq("id", widget.id);
    assert(!okError, `a real IANA timezone is accepted (error: ${okError?.message})`);

    const { data: reread } = await service.from("widgets").select("timezone").eq("id", widget.id).single();
    assert(reread.timezone === "America/New_York", `saved timezone persisted correctly (got '${reread.timezone}')`);
  }

  console.log("--- Widget default timezone ---");
  {
    const { data: fresh } = await service.from("widgets").insert({ tenant_id: tenant.id }).select("timezone").single();
    assert(fresh.timezone === "UTC", `a new widget defaults to UTC (got '${fresh.timezone}')`);
  }

  console.log("--- Tenant retention policy validation ---");
  {
    assert((await service.from("tenants").select("conversation_retention_months").eq("id", tenant.id).single()).data.conversation_retention_months === 13, "a new tenant defaults to 13 months");

    const { error: tooLow } = await service.from("tenants").update({ conversation_retention_months: 0 }).eq("id", tenant.id);
    assert(!!tooLow, `0 months is rejected (error: ${tooLow?.message})`);

    const { error: tooHigh } = await service.from("tenants").update({ conversation_retention_months: 25 }).eq("id", tenant.id);
    assert(!!tooHigh, `25 months is rejected (error: ${tooHigh?.message})`);

    const { error: ok1 } = await service.from("tenants").update({ conversation_retention_months: 1 }).eq("id", tenant.id);
    assert(!ok1, "1 month (lower bound) is accepted");
    const { error: ok24 } = await service.from("tenants").update({ conversation_retention_months: 24 }).eq("id", tenant.id);
    assert(!ok24, "24 months (upper bound) is accepted");
  }

  await service.from("tenants").delete().eq("id", tenant.id);
  console.log("\nALL TIMEZONE/RETENTION VALIDATION CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
