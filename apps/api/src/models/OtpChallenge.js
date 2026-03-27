import mongoose from "mongoose";

const otpChallengeSchema = new mongoose.Schema(
  {
    phoneE164: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

otpChallengeSchema.index({ phoneE164: 1, createdAt: -1 });

export const OtpChallenge = mongoose.model("OtpChallenge", otpChallengeSchema);
