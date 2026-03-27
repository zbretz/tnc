/**
 * Minimal E.164 normalization for US + already-prefixed numbers.
 * Production apps often use libphonenumber; this keeps the dependency footprint small.
 */
export function normalizePhoneE164(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return null;
}
