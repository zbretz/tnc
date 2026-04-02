import twilio from "twilio";

/**
 * Twilio is ready when Account SID + Auth Token exist and either a From number
 * or a Messaging Service SID is set (Messaging Service is preferred for A2P 10DLC).
 */
export function isTwilioOtpConfigured() {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  return Boolean(sid && token && (from || messagingServiceSid));
}

/**
 * Send a one-time passcode via Twilio Programmable SMS.
 * @returns {Promise<{ ok: true } | { ok: false, skipped?: true, error?: string }>}
 */
export async function sendOtpSms(phoneE164, code) {
  if (!isTwilioOtpConfigured()) {
    if (process.env.TNC_DEV_OTP_LOG === "1") {
      console.log("[tnc:otp] SMS not configured; code for", phoneE164, "=", code);
    }
    return { ok: false, skipped: true };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID.trim();
  const token = process.env.TWILIO_AUTH_TOKEN.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();

  const template =
    process.env.TWILIO_OTP_MESSAGE?.trim() || "Your verification code: {code}";
  const body = template.includes("{code}") ? template.split("{code}").join(code) : `${template} ${code}`;

  const client = twilio(sid, token);
  try {
    const opts = { to: phoneE164, body };
    if (messagingServiceSid) {
      opts.messagingServiceSid = messagingServiceSid;
    } else {
      opts.from = from;
    }
    await client.messages.create(opts);
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    const codeTwilio = e?.code;
    console.error("[tnc:otp] Twilio error", codeTwilio, msg);
    return { ok: false, error: "sms_send_failed" };
  }
}
