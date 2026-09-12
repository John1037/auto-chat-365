import type { Env } from "../lib/env";
import { handleWidgetImageUpload } from "../lib/widgetImageUpload";

export function handleUploadWidgetAvatar(request: Request, env: Env): Promise<Response> {
  return handleWidgetImageUpload(request, env, { pathSegment: "avatar", column: "avatar_url", label: "avatar" });
}
