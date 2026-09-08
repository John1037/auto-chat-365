// Origin allowlisting is the real enforcement -- this file only makes the browser's
// CORS handshake work once a route has already decided a request is allowed.
// Preflight (OPTIONS) responses reflect whatever Origin asked, since a preflight
// carries no body/credentials by itself; the actual POST handler is what checks the
// Origin against the resolved tenant's allowed_origins and can still 403 it.

export function corsPreflightResponse(request: Request): Response {
  const origin = request.headers.get("Origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

export function withCorsHeaders(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

// allowed_origins entries are either an exact origin ("http://localhost:8080") or a
// "*.example.com" suffix pattern for subdomains.
export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return allowedOrigins.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return origin === pattern;
  });
}
