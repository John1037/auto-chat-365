import type { Env } from "../lib/env";
import { handleWidgetImageUpload } from "../lib/widgetImageUpload";

export function handleUploadWidgetLogo(request: Request, env: Env): Promise<Response> {
  return handleWidgetImageUpload(request, env, { pathSegment: "logo", column: "logo_url", label: "logo" });
}
