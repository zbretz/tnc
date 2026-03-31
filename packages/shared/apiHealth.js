/**
 * GET {baseUrl}/health — TNC API returns `{ ok: true }`.
 * @returns {{ ok: true, status: number } | { ok: false, error: string, status?: number }}
 */
export async function fetchApiHealth(baseUrl) {
  const base = typeof baseUrl === "string" ? baseUrl.replace(/\/$/, "") : "";
  if (!base) return { ok: false, error: "No API URL configured" };
  const url = `${base}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === true) {
      return { ok: true, status: res.status };
    }
    return { ok: false, error: "Unexpected /health body", status: res.status };
  } catch (e) {
    clearTimeout(timer);
    const msg =
      e?.name === "AbortError" ? "Request timed out" : e?.message || String(e);
    return { ok: false, error: msg };
  }
}
