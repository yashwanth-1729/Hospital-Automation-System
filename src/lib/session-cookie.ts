/** Shared by the proxy (which only checks the cookie is present) and the server (which verifies it). */
export const SESSION_COOKIE = "nit_session";

/** Only same-site paths are honoured after sign-in, so a crafted link cannot bounce people elsewhere. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === "/login" || value.startsWith("/login?")) return "/";
  return value.slice(0, 500);
}
