// Real verification of compute_widget_daily_stats() and purge_expired_conversations()
// against genuinely backdated data (real rows with real past created_at values, not
// a mocked clock) -- these two only make sense evaluated against real elapsed time,
// so that's exactly what this constructs.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
  console.log("  ok:", msg);
}

async function main() {
  const service = createClient(SUPABASE_URL, SERVICE_KEY);

  console.log("--- compute_widget_daily_stats: a conversation starting at 23:59 local counts its whole day, even messages that land after local midnight ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Batch Stats Test" }).select("id").single();
    // UTC widget for simplicity -- "local" and UTC are the same, keeping the 23:59
    // boundary easy to construct and verify precisely. created_at backdated well
    // before the conversation below -- in reality a widget always predates its own
    // conversations, and compute_widget_daily_stats() deliberately skips any day
    // before a widget existed (so it never manufactures meaningless all-zero rows
    // for a widget's pre-history); a widget "created" after its own test data would
    // incorrectly trigger that same guard here.
    const tenDaysAgo = new Date();
    tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, timezone: "UTC", created_at: tenDaysAgo.toISOString() }).select("id").single();
    const { data: authUser } = await service.auth.admin.createUser({ email: `batch-stats-visitor-${Date.now()}@example.test`, password: "x", email_confirm: true });
    await service.from("widget_sessions").insert({ id: authUser.user.id, tenant_id: tenant.id, widget_id: widget.id });

    // Day D at 23:59:30 UTC -- 3 days ago, safely past both the day boundary and the
    // 24h grace period by the time this test runs.
    const dayStart = new Date();
    dayStart.setUTCDate(dayStart.getUTCDate() - 3);
    dayStart.setUTCHours(23, 59, 30, 0);
    const statDate = dayStart.toISOString().slice(0, 10);

    const { data: conversation } = await service
      .from("conversations")
      .insert({ tenant_id: tenant.id, session_id: authUser.user.id, created_at: dayStart.toISOString() })
      .select("id")
      .single();

    // Two messages: one right at creation (still day D), one 90 seconds later --
    // past local midnight, into day D+1 -- which must still count toward day D,
    // since the conversation itself started on day D.
    const laterMessageTime = new Date(dayStart.getTime() + 90_000);
    await service.from("messages").insert([
      { conversation_id: conversation.id, tenant_id: tenant.id, session_id: authUser.user.id, role: "user", content: "hi", created_at: dayStart.toISOString() },
      { conversation_id: conversation.id, tenant_id: tenant.id, session_id: authUser.user.id, role: "assistant", content: "hello", created_at: laterMessageTime.toISOString() },
    ]);
    console.log(`  conversation started ${dayStart.toISOString()} (day ${statDate}), second message landed ${laterMessageTime.toISOString()}`);

    const { error: rpcError } = await service.rpc("compute_widget_daily_stats");
    assert(!rpcError, `compute_widget_daily_stats ran without error (${rpcError?.message})`);

    const { data: stats } = await service.from("widget_daily_stats").select("*").eq("widget_id", widget.id).eq("stat_date", statDate).maybeSingle();
    console.log("  computed row:", JSON.stringify(stats));
    assert(stats !== null, `a stats row was created for day ${statDate}`);
    assert(stats.conversations_started === 1, `conversations_started is 1 (got ${stats?.conversations_started})`);
    assert(stats.messages_count === 2, `messages_count is 2, including the message that landed after local midnight (got ${stats?.messages_count})`);

    console.log("--- Re-running is idempotent (safe to re-run, same correct numbers, not doubled) ---");
    await service.rpc("compute_widget_daily_stats");
    const { data: statsAgain } = await service.from("widget_daily_stats").select("conversations_started, messages_count").eq("widget_id", widget.id).eq("stat_date", statDate).single();
    assert(statsAgain.conversations_started === 1 && statsAgain.messages_count === 2, "re-running produced the same numbers, not doubled");

    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("--- compute_widget_daily_stats: today (not yet past its 24h grace period) is NOT computed ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Batch Stats Test Too Recent" }).select("id").single();
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id, timezone: "UTC" }).select("id").single();
    const { data: authUser } = await service.auth.admin.createUser({ email: `batch-stats-recent-${Date.now()}@example.test`, password: "x", email_confirm: true });
    await service.from("widget_sessions").insert({ id: authUser.user.id, tenant_id: tenant.id, widget_id: widget.id });
    await service.from("conversations").insert({ tenant_id: tenant.id, session_id: authUser.user.id });

    await service.rpc("compute_widget_daily_stats");
    const today = new Date().toISOString().slice(0, 10);
    const { data: stats } = await service.from("widget_daily_stats").select("*").eq("widget_id", widget.id).eq("stat_date", today).maybeSingle();
    assert(stats === null, "no stats row was created for today -- it hasn't cleared its 24h grace period yet");

    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("--- purge_expired_conversations: an old conversation past retention is deleted; a recent one is not ---");
  {
    const { data: tenant } = await service.from("tenants").insert({ name: "Purge Test", conversation_retention_months: 1 }).select("id").single();
    const { data: widget } = await service.from("widgets").insert({ tenant_id: tenant.id }).select("id").single();
    const { data: authUser } = await service.auth.admin.createUser({ email: `purge-test-${Date.now()}@example.test`, password: "x", email_confirm: true });
    await service.from("widget_sessions").insert({ id: authUser.user.id, tenant_id: tenant.id, widget_id: widget.id });

    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    const { data: oldConvo } = await service.from("conversations").insert({ tenant_id: tenant.id, session_id: authUser.user.id, created_at: twoMonthsAgo.toISOString() }).select("id").single();
    await service.from("messages").insert({ conversation_id: oldConvo.id, tenant_id: tenant.id, session_id: authUser.user.id, role: "user", content: "old message", created_at: twoMonthsAgo.toISOString() });

    const { data: recentConvo } = await service.from("conversations").insert({ tenant_id: tenant.id, session_id: authUser.user.id }).select("id").single();
    await service.from("messages").insert({ conversation_id: recentConvo.id, tenant_id: tenant.id, session_id: authUser.user.id, role: "user", content: "recent message" });

    const { error: purgeError } = await service.rpc("purge_expired_conversations");
    assert(!purgeError, `purge_expired_conversations ran without error (${purgeError?.message})`);

    const { data: oldStillThere } = await service.from("conversations").select("id").eq("id", oldConvo.id).maybeSingle();
    const { data: oldMessagesStillThere } = await service.from("messages").select("id").eq("conversation_id", oldConvo.id);
    assert(oldStillThere === null, "the conversation older than the tenant's 1-month retention was deleted");
    assert(oldMessagesStillThere.length === 0, "its messages were deleted too");

    const { data: recentStillThere } = await service.from("conversations").select("id").eq("id", recentConvo.id).maybeSingle();
    assert(recentStillThere !== null, "the recent conversation (within retention) was NOT deleted");

    await service.from("tenants").delete().eq("id", tenant.id);
  }

  console.log("\nALL DAILY STATS BATCH JOB CHECKS PASSED");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
