import type { SupabaseClient } from "@supabase/supabase-js";

// Never trust client-supplied widget_ids directly -- returns only the ones that
// actually belong to this tenant. Shared by every route that accepts a visibility
// selection at write time (ingest-document, ingest-document-files) or edit time
// (update-document-visibility).
export async function verifyOwnedWidgetIds(service: SupabaseClient, tenantId: string, widgetIds: string[]): Promise<string[]> {
  if (widgetIds.length === 0) return [];
  const { data } = await service.from("widgets").select("id").eq("tenant_id", tenantId).in("id", widgetIds);
  return (data ?? []).map((w) => w.id as string);
}
