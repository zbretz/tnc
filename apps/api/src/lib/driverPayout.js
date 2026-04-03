import { Trip } from "../models/Trip.js";
import { DriverProfile } from "../models/DriverProfile.js";
import { getStripe, stripeEnabled } from "./stripe.js";

const DEFAULT_APP_TAKE_PERCENT = 20;

/**
 * App take on fare only (integer cents). Rounds half away from zero on .5 via Math.round.
 */
export function computeAppTakeCents(fareCents, appTakePercent) {
  const fare = Math.max(0, Math.round(Number(fareCents) || 0));
  const pct = Math.min(100, Math.max(0, Number(appTakePercent)));
  return Math.round((fare * pct) / 100);
}

/**
 * Driver's share of the quoted trip fare in USD (before tips and Stripe fees), after platform take on fare only.
 * Matches integer-cent app take applied to rounded rider fare cents.
 */
export function driverShareUsdAfterAppTake(quotedFareUsd, appTakePercent) {
  const fareCents = Math.max(0, Math.round(Number(quotedFareUsd) * 100));
  if (!Number.isFinite(fareCents)) return null;
  const take = computeAppTakeCents(fareCents, appTakePercent ?? DEFAULT_APP_TAKE_PERCENT);
  return (fareCents - take) / 100;
}

/**
 * Driver pool before Stripe: (fare − app take) + tip (tip has no app take).
 */
export function computeDriverPoolBeforeStripeFeeCents(fareCents, tipCents, appTakeCents) {
  const fare = Math.max(0, Math.round(Number(fareCents) || 0));
  const tip = Math.max(0, Math.round(Number(tipCents) || 0));
  const take = Math.max(0, Math.round(Number(appTakeCents) || 0));
  return Math.max(0, fare - take) + tip;
}

/**
 * Net transfer to driver after full Stripe fee from their side.
 */
export function computeDriverNetCents(driverPoolBeforeFeeCents, stripeFeeCents) {
  const pool = Math.max(0, Math.round(Number(driverPoolBeforeFeeCents) || 0));
  const fee = Math.max(0, Math.round(Number(stripeFeeCents) || 0));
  return Math.max(0, pool - fee);
}

/**
 * @param {import("stripe").Stripe} stripe
 * @param {string} paymentIntentId
 * @returns {Promise<number|null>} fee in cents, or null if unavailable
 */
export async function fetchStripeFeeCentsForPaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId || !stripe) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    const ch = pi.latest_charge;
    if (!ch || typeof ch !== "object") return null;
    let bt = ch.balance_transaction;
    if (typeof bt === "string") {
      bt = await stripe.balanceTransactions.retrieve(bt);
    }
    if (bt && typeof bt.fee === "number" && Number.isFinite(bt.fee)) {
      return Math.max(0, Math.round(bt.fee));
    }
  } catch (e) {
    console.error("[tnc] fetchStripeFeeCentsForPaymentIntent", e?.message || e);
  }
  return null;
}

/**
 * Compute ledger + optional Connect transfer after rider payment succeeded.
 * Idempotent: skips if already `paid` with transfer id; recomputes from `pending_connect` when onboarding completes.
 *
 * @param {string|import("mongoose").Types.ObjectId} tripId
 */
export async function processDriverPayoutForTrip(tripId) {
  const id = String(tripId);
  const trip = await Trip.findById(id).exec();
  if (!trip) {
    return { ok: false, error: "not_found" };
  }

  const waivedOrSkipped = new Set([
    "waived",
    "skipped_stripe_disabled",
    "skipped_no_estimate",
    "skipped_no_payment_method",
    "skipped_below_minimum",
  ]);
  if (waivedOrSkipped.has(trip.fareChargeStatus)) {
    trip.driverPayoutStatus = "waived";
    trip.driverPayoutAppTakeCents = null;
    trip.driverPayoutStripeFeeCents = null;
    trip.driverPayoutNetCents = null;
    trip.driverPayoutTransferId = "";
    trip.driverPayoutError = "";
    trip.driverPayoutComputedAt = new Date();
    await trip.save();
    return { ok: true, status: "waived" };
  }

  if (trip.fareChargeStatus !== "succeeded") {
    return { ok: true, skipped: true, reason: "charge_not_succeeded" };
  }

  if (!trip.driver) {
    trip.driverPayoutStatus = "skipped_no_driver";
    trip.driverPayoutComputedAt = new Date();
    await trip.save();
    return { ok: true, status: "skipped_no_driver" };
  }

  const existingPaid =
    trip.driverPayoutStatus === "paid" &&
    typeof trip.driverPayoutTransferId === "string" &&
    trip.driverPayoutTransferId.startsWith("tr_");
  if (existingPaid) {
    return { ok: true, skipped: true, reason: "already_paid" };
  }

  const fareCents =
    trip.fareChargeFareCents != null && Number.isFinite(Number(trip.fareChargeFareCents))
      ? Math.round(Number(trip.fareChargeFareCents))
      : 0;
  const tipCents =
    trip.fareChargeTipCents != null && Number.isFinite(Number(trip.fareChargeTipCents))
      ? Math.max(0, Math.round(Number(trip.fareChargeTipCents)))
      : 0;

  const prof = await DriverProfile.findOne({ userId: trip.driver }).exec();
  const appTakePct =
    prof && typeof prof.appTakePercent === "number" && Number.isFinite(prof.appTakePercent)
      ? prof.appTakePercent
      : DEFAULT_APP_TAKE_PERCENT;

  const appTakeCents = computeAppTakeCents(fareCents, appTakePct);
  const poolBeforeFee = computeDriverPoolBeforeStripeFeeCents(fareCents, tipCents, appTakeCents);

  let stripeFeeCents = null;
  if (stripeEnabled()) {
    const stripe = getStripe();
    const piId = typeof trip.stripePaymentIntentId === "string" ? trip.stripePaymentIntentId.trim() : "";
    if (stripe && piId) {
      stripeFeeCents = await fetchStripeFeeCentsForPaymentIntent(stripe, piId);
    }
  }
  if (stripeFeeCents == null) {
    stripeFeeCents = 0;
  }

  const netCents = computeDriverNetCents(poolBeforeFee, stripeFeeCents);

  trip.driverPayoutAppTakeCents = appTakeCents;
  trip.driverPayoutStripeFeeCents = stripeFeeCents;
  trip.driverPayoutNetCents = netCents;
  trip.driverPayoutComputedAt = new Date();
  trip.driverPayoutError = "";

  const connectId =
    prof && typeof prof.stripeConnectAccountId === "string" ? prof.stripeConnectAccountId.trim() : "";
  const payoutsOk = Boolean(prof?.stripeConnectPayoutsEnabled && connectId.startsWith("acct_"));

  if (!payoutsOk) {
    trip.driverPayoutStatus = "pending_connect";
    trip.driverPayoutTransferId = "";
    await trip.save();
    return { ok: true, status: "pending_connect", netCents };
  }

  if (netCents <= 0) {
    trip.driverPayoutStatus = "paid";
    trip.driverPayoutTransferId = "";
    await trip.save();
    return { ok: true, status: "paid", netCents: 0, note: "zero_net_skip_transfer" };
  }

  const stripe = getStripe();
  if (!stripe) {
    trip.driverPayoutStatus = "pending_connect";
    await trip.save();
    return { ok: false, error: "stripe_unavailable" };
  }

  const currency = (trip.fareChargeCurrency || "usd").toLowerCase();
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: netCents,
        currency,
        destination: connectId,
        metadata: {
          tncTripId: String(trip._id),
          tncDriverUserId: String(trip.driver),
        },
      },
      { idempotencyKey: `tnc-driver-payout-${trip._id}` }
    );
    trip.driverPayoutStatus = "paid";
    trip.driverPayoutTransferId = transfer.id;
    await trip.save();
    return { ok: true, status: "paid", transferId: transfer.id, netCents };
  } catch (e) {
    const msg = e?.raw?.message || e?.message || "transfer_failed";
    trip.driverPayoutStatus = "failed";
    trip.driverPayoutError = msg;
    await trip.save();
    console.error("[tnc] processDriverPayoutForTrip transfer", e);
    return { ok: false, error: msg };
  }
}

/**
 * Connect transfer for driver's share of a successful rider cancellation fee (separate from trip fare payout).
 * @param {string|import("mongoose").Types.ObjectId} tripId
 */
export async function processRiderCancelFeePayout(tripId) {
  const id = String(tripId);
  const trip = await Trip.findById(id).exec();
  if (!trip) {
    return { ok: false, error: "not_found" };
  }
  if (trip.status !== "cancelled") {
    return { ok: true, skipped: true, reason: "not_cancelled" };
  }

  const waivedOrSkipped = new Set([
    "none",
    "waived",
    "skipped_stripe_disabled",
    "skipped_no_payment_method",
    "skipped_below_minimum",
  ]);
  if (waivedOrSkipped.has(trip.riderCancelChargeStatus)) {
    trip.riderCancelPayoutStatus = "waived";
    trip.riderCancelPayoutStripeFeeCents = null;
    trip.riderCancelPayoutNetCents = null;
    trip.riderCancelPayoutTransferId = "";
    trip.riderCancelPayoutError = "";
    trip.riderCancelPayoutComputedAt = new Date();
    await trip.save();
    return { ok: true, status: "waived" };
  }

  if (trip.riderCancelChargeStatus !== "succeeded") {
    return { ok: true, skipped: true, reason: "charge_not_succeeded" };
  }

  if (!trip.driver) {
    trip.riderCancelPayoutStatus = "skipped_no_driver";
    trip.riderCancelPayoutComputedAt = new Date();
    await trip.save();
    return { ok: true, status: "skipped_no_driver" };
  }

  const existingPaid =
    trip.riderCancelPayoutStatus === "paid" &&
    typeof trip.riderCancelPayoutTransferId === "string" &&
    trip.riderCancelPayoutTransferId.startsWith("tr_");
  if (existingPaid) {
    return { ok: true, skipped: true, reason: "already_paid" };
  }

  const poolBeforeFee =
    trip.riderCancelDriverShareCents != null && Number.isFinite(Number(trip.riderCancelDriverShareCents))
      ? Math.max(0, Math.round(Number(trip.riderCancelDriverShareCents)))
      : 0;

  let stripeFeeCents = null;
  if (stripeEnabled()) {
    const stripe = getStripe();
    const piId =
      typeof trip.stripeCancelPaymentIntentId === "string" ? trip.stripeCancelPaymentIntentId.trim() : "";
    if (stripe && piId) {
      stripeFeeCents = await fetchStripeFeeCentsForPaymentIntent(stripe, piId);
    }
  }
  if (stripeFeeCents == null) {
    stripeFeeCents = 0;
  }

  const netCents = computeDriverNetCents(poolBeforeFee, stripeFeeCents);

  trip.riderCancelPayoutStripeFeeCents = stripeFeeCents;
  trip.riderCancelPayoutNetCents = netCents;
  trip.riderCancelPayoutComputedAt = new Date();
  trip.riderCancelPayoutError = "";

  const prof = await DriverProfile.findOne({ userId: trip.driver }).exec();
  const connectId =
    prof && typeof prof.stripeConnectAccountId === "string" ? prof.stripeConnectAccountId.trim() : "";
  const payoutsOk = Boolean(prof?.stripeConnectPayoutsEnabled && connectId.startsWith("acct_"));

  if (!payoutsOk) {
    trip.riderCancelPayoutStatus = "pending_connect";
    trip.riderCancelPayoutTransferId = "";
    await trip.save();
    return { ok: true, status: "pending_connect", netCents };
  }

  if (netCents <= 0) {
    trip.riderCancelPayoutStatus = "paid";
    trip.riderCancelPayoutTransferId = "";
    await trip.save();
    return { ok: true, status: "paid", netCents: 0, note: "zero_net_skip_transfer" };
  }

  const stripe = getStripe();
  if (!stripe) {
    trip.riderCancelPayoutStatus = "pending_connect";
    await trip.save();
    return { ok: false, error: "stripe_unavailable" };
  }

  const currency = (trip.riderCancelChargeCurrency || "usd").toLowerCase();
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: netCents,
        currency,
        destination: connectId,
        metadata: {
          tncTripId: String(trip._id),
          tncDriverUserId: String(trip.driver),
          tncKind: "rider_cancel",
        },
      },
      { idempotencyKey: `tnc-driver-cancel-payout-${trip._id}` }
    );
    trip.riderCancelPayoutStatus = "paid";
    trip.riderCancelPayoutTransferId = transfer.id;
    await trip.save();
    return { ok: true, status: "paid", transferId: transfer.id, netCents };
  } catch (e) {
    const msg = e?.raw?.message || e?.message || "transfer_failed";
    trip.riderCancelPayoutStatus = "failed";
    trip.riderCancelPayoutError = msg;
    await trip.save();
    console.error("[tnc] processRiderCancelFeePayout transfer", e);
    return { ok: false, error: msg };
  }
}

/**
 * After Connect onboarding, retry payouts for this driver's completed trips.
 */
export async function processPendingDriverPayoutsForDriverUserId(driverUserId) {
  const uid = String(driverUserId);
  const fareTrips = await Trip.find({
    driver: uid,
    fareChargeStatus: "succeeded",
    driverPayoutStatus: { $in: ["pending_connect", "failed"] },
  })
    .select("_id")
    .lean()
    .exec();

  const cancelTrips = await Trip.find({
    driver: uid,
    status: "cancelled",
    riderCancelChargeStatus: "succeeded",
    riderCancelPayoutStatus: { $in: ["pending_connect", "failed"] },
  })
    .select("_id")
    .lean()
    .exec();

  const results = [];
  for (const t of fareTrips) {
    results.push({ tripId: String(t._id), kind: "fare", ...(await processDriverPayoutForTrip(t._id)) });
  }
  for (const t of cancelTrips) {
    results.push({
      tripId: String(t._id),
      kind: "rider_cancel",
      ...(await processRiderCancelFeePayout(t._id)),
    });
  }
  return results;
}

/**
 * Refresh Connect account flags from Stripe into DriverProfile.
 */
export async function refreshDriverConnectStatus(driverUserId) {
  if (!stripeEnabled()) return { ok: false, error: "stripe_disabled" };
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: "no_stripe" };

  const prof = await DriverProfile.findOne({ userId: driverUserId }).exec();
  if (!prof) return { ok: false, error: "no_profile" };
  const acctId = typeof prof.stripeConnectAccountId === "string" ? prof.stripeConnectAccountId.trim() : "";
  if (!acctId.startsWith("acct_")) return { ok: false, error: "no_connect_account" };

  try {
    const acct = await stripe.accounts.retrieve(acctId);
    prof.stripeConnectPayoutsEnabled = Boolean(acct.payouts_enabled);
    prof.stripeConnectDetailsSubmitted = Boolean(acct.details_submitted);
    await prof.save();
    return {
      ok: true,
      payoutsEnabled: prof.stripeConnectPayoutsEnabled,
      detailsSubmitted: prof.stripeConnectDetailsSubmitted,
    };
  } catch (e) {
    console.error("[tnc] refreshDriverConnectStatus", e);
    return { ok: false, error: e?.raw?.message || e?.message || "stripe_error" };
  }
}
