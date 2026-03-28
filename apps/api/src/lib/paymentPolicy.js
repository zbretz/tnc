import { stripeEnabled } from "./stripe.js";

/**
 * Parse env as boolean. Prefer `true` / `false` in .env; `yes`/`no`, `1`/`0`, `on`/`off` also accepted.
 * Unknown non-empty values fall back to `defaultValue`.
 */
export function parseEnvBoolean(name, defaultValue = false) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(s)) return true;
  if (["false", "no", "0", "off"].includes(s)) return false;
  return defaultValue;
}

/** Raw env: TNC_REQUIRE_PAYMENT_METHOD_TO_BOOK (default false). */
export function requirePaymentMethodToBookFromEnv() {
  return parseEnvBoolean("TNC_REQUIRE_PAYMENT_METHOD_TO_BOOK", false);
}

/** Require a saved default PM when creating a trip (Stripe must be enabled). */
export function effectiveRequirePaymentMethodToBook() {
  return stripeEnabled() && requirePaymentMethodToBookFromEnv();
}
