import crypto from "crypto";
import mongoose, { Schema } from "mongoose";

export const API_KEY_SCOPES = [
  "account:read",
  "connection:read",
  "connection:manage",
  "messages:read",
  "messages:send",
] as const;

export type ApiKeyScope = typeof API_KEY_SCOPES[number];

const ApiKey = mongoose.model(
  "ApiKey",
  new Schema(
    {
      userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
      name: { type: String, required: true, trim: true, maxlength: 80 },
      environment: { type: String, enum: ["test", "live"], default: "live" },
      prefix: { type: String, required: true },
      last4: { type: String, required: true },
      keyHash: { type: String, required: true, unique: true, index: true },
      scopes: { type: [String], enum: API_KEY_SCOPES, default: ["account:read", "connection:read", "connection:manage", "messages:read", "messages:send"] },
      lastUsedAt: Date,
      revokedAt: Date,
    },
    { timestamps: true },
  ),
);

function hashKey(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function publicApiKeyView(key: any) {
  return {
    id: String(key._id),
    name: key.name,
    environment: key.environment,
    prefix: key.prefix,
    last4: key.last4,
    scopes: key.scopes,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt || null,
    revokedAt: key.revokedAt || null,
    status: key.revokedAt ? "revoked" : "active",
  };
}

export async function createApiKey(
  userId: string,
  name: string,
  scopes: string[],
  environment: "test" | "live" = "live",
) {
  const safeName = String(name || "").trim().slice(0, 80);
  if (!safeName) throw Error("API key name is required");

  const requested = Array.from(new Set(scopes)).filter((scope): scope is ApiKeyScope =>
    (API_KEY_SCOPES as readonly string[]).includes(scope),
  );
  if (!requested.length) throw Error("At least one API key scope is required");

  const secret = crypto.randomBytes(32).toString("base64url");
  const prefix = environment === "test" ? "ss_test_" : "ss_live_";
  const value = prefix + secret;
  const doc: any = await ApiKey.create({
    userId,
    name: safeName,
    environment,
    prefix,
    last4: secret.slice(-4),
    keyHash: hashKey(value),
    scopes: requested,
  });

  return { key: value, record: publicApiKeyView(doc) };
}

export async function listApiKeys(userId: string) {
  const rows: any[] = await ApiKey.find({ userId }).sort({ createdAt: -1 }).lean();
  return rows.map(publicApiKeyView);
}

export async function revokeApiKey(userId: string, id: string) {
  const key: any = await ApiKey.findOneAndUpdate(
    { _id: id, userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
    { new: true },
  );
  if (!key) throw Error("API key not found or already revoked");
  return publicApiKeyView(key);
}

export async function rotateApiKey(userId: string, id: string) {
  const existing: any = await ApiKey.findOne({ _id: id, userId, revokedAt: { $exists: false } });
  if (!existing) throw Error("API key not found or already revoked");

  const result = await createApiKey(userId, existing.name, existing.scopes, existing.environment);
  existing.revokedAt = new Date();
  await existing.save();
  return result;
}

export async function authenticateApiKey(value: string) {
  const token = String(value || "").trim();
  if (!token.startsWith("ss_test_") && !token.startsWith("ss_live_")) return null;
  const key: any = await ApiKey.findOne({
    keyHash: hashKey(token),
    revokedAt: { $exists: false },
  });
  if (!key) return null;

  key.lastUsedAt = new Date();
  await key.save();
  return key;
}

export function hasApiKeyScope(key: any, scope: ApiKeyScope) {
  return Array.isArray(key?.scopes) && key.scopes.includes(scope);
}
