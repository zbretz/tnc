import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const PRESIGN_TTL_SEC = 900;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** True when bucket is set; credentials come from env keys or the default AWS SDK chain (e.g. IAM role). */
export function isAvatarS3Configured() {
  return Boolean(process.env.S3_AVATAR_BUCKET?.trim());
}

function extensionForContentType(ct) {
  const m = String(ct).toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  return null;
}

function normalizeContentType(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  if (t === "image/jpg") return "image/jpeg";
  if (ALLOWED_TYPES.has(t)) return t;
  return null;
}

function s3Client() {
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  return new S3Client({ region });
}

/**
 * Public URL riders/apps use to load the avatar. Override with CloudFront or custom domain.
 * @param {string} bucket
 * @param {string} key
 * @param {string} region
 */
export function buildAvatarPublicUrl(bucket, key, region) {
  const base = process.env.S3_AVATAR_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base) {
    return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${safeKey}`;
}

/**
 * @param {{ keyPrefix: string, contentType: string }} opts
 * @returns {Promise<{ uploadUrl: string, publicUrl: string, key: string, contentType: string, expiresIn: number }>}
 */
export async function createAvatarPresignedPut({ keyPrefix, contentType: contentTypeIn }) {
  const bucket = process.env.S3_AVATAR_BUCKET?.trim();
  if (!bucket) {
    const err = new Error("S3_AVATAR_BUCKET not set");
    err.code = "S3_NOT_CONFIGURED";
    throw err;
  }
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  const contentType = normalizeContentType(contentTypeIn);
  if (!contentType) {
    const err = new Error("contentType must be image/jpeg, image/png, or image/webp");
    err.code = "INVALID_CONTENT_TYPE";
    throw err;
  }
  const ext = extensionForContentType(contentType);
  if (!ext) {
    const err = new Error("unsupported content type");
    err.code = "INVALID_CONTENT_TYPE";
    throw err;
  }
  const prefix = String(keyPrefix || "avatars").replace(/^\/+|\/+$/g, "");
  const key = `${prefix}/${crypto.randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const client = s3Client();
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: PRESIGN_TTL_SEC });
  const publicUrl = buildAvatarPublicUrl(bucket, key, region);

  return {
    uploadUrl,
    publicUrl,
    key,
    contentType,
    expiresIn: PRESIGN_TTL_SEC,
  };
}
