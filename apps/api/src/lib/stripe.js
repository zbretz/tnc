import Stripe from "stripe";

let stripeSingleton = null;

export function stripeEnabled() {
  const k = process.env.STRIPE_SECRET_KEY;
  return typeof k === "string" && k.trim().length > 0 && k.trim().startsWith("sk_");
}

export function getStripe() {
  if (!stripeEnabled()) return null;
  if (!stripeSingleton) {
    stripeSingleton = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
  }
  return stripeSingleton;
}
