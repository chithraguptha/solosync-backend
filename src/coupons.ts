import crypto from "crypto";
import mongoose, { Schema } from "mongoose";
import { creditWallet } from "./billing";

/// A shareable code that gives the account redeeming it custom pricing.
///
/// Every benefit is optional and they combine: a coupon can waive or discount
/// the activation fee, set a per-message price, add wallet credit, or make the
/// account unlimited. Pricing set by a coupon stays on the account after the
/// coupon expires — expiry only stops new redemptions.
export const Coupon = mongoose.model("Coupon", new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: String,
    // null leaves the account's current price alone; 0 makes it free.
    activationFeePaise: { type: Number, default: null, min: 0 },
    messageFeePaise: { type: Number, default: null, min: 0 },
    walletCreditPaise: { type: Number, default: 0, min: 0 },
    unlimitedMessages: { type: Boolean, default: false },
    // Lets the account connect several WhatsApp numbers, at multiMessageFeePaise
    // per message (null = the standard multi-number price).
    multiNumberEnabled: { type: Boolean, default: false },
    maxConnections: { type: Number, default: null, min: 1 },
    multiMessageFeePaise: { type: Number, default: null, min: 0 },
    // null means no cap.
    maxRedemptions: { type: Number, default: null, min: 1 },
    redemptionCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
));

/// One row per account per coupon. The unique index is what stops a single
/// account redeeming the same code twice, including two requests racing.
export const CouponRedemption = mongoose.model("CouponRedemption", new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    code: { type: String, required: true },
    walletCreditPaise: { type: Number, default: 0 },
  },
  { timestamps: true },
).index({ couponId: 1, userId: 1 }, { unique: true }));

export class CouponError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

export function normalizeCode(code: unknown) {
  return String(code || "").trim().toUpperCase();
}

/// Readable codes: no 0/O or 1/I, so a code read aloud or copied off a
/// screenshot comes out right.
export function generateCode(prefix = "SS") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}-${out}`;
}

const optionalPaise = (v: unknown, field: string) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new CouponError("INVALID", `${field} must be zero or more`);
  return n;
};

export async function createCoupon(input: any) {
  const code = normalizeCode(input?.code) || generateCode();
  if (!CODE_PATTERN.test(code)) throw new CouponError("INVALID", "Code must be 3-32 letters, digits, - or _");
  const doc = {
    code,
    description: input?.description ? String(input.description).slice(0, 200) : undefined,
    activationFeePaise: optionalPaise(input?.activationFeePaise, "activationFeePaise"),
    messageFeePaise: optionalPaise(input?.messageFeePaise, "messageFeePaise"),
    walletCreditPaise: optionalPaise(input?.walletCreditPaise, "walletCreditPaise") || 0,
    unlimitedMessages: input?.unlimitedMessages === true || input?.unlimitedMessages === "true",
    multiNumberEnabled: input?.multiNumberEnabled === true || input?.multiNumberEnabled === "true",
    maxConnections: input?.maxConnections ? Math.max(1, Math.round(Number(input.maxConnections))) : null,
    multiMessageFeePaise: optionalPaise(input?.multiMessageFeePaise, "multiMessageFeePaise"),
    maxRedemptions: input?.maxRedemptions ? Math.max(1, Math.round(Number(input.maxRedemptions))) : null,
    expiresAt: input?.expiresAt ? new Date(input.expiresAt) : null,
  };
  if (doc.expiresAt && isNaN(doc.expiresAt.getTime())) throw new CouponError("INVALID", "expiresAt must be a date");
  if (doc.activationFeePaise === null && doc.messageFeePaise === null && !doc.walletCreditPaise && !doc.unlimitedMessages && !doc.multiNumberEnabled) {
    throw new CouponError("INVALID", "A coupon needs at least one benefit");
  }
  try { return await Coupon.create(doc); }
  catch (e: any) {
    if (e?.code === 11000) throw new CouponError("DUPLICATE", "A coupon with this code already exists", 409);
    throw e;
  }
}

function usable(coupon: any) {
  if (!coupon || !coupon.active) return new CouponError("NOT_FOUND", "This coupon code is not valid", 404);
  if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now()) return new CouponError("EXPIRED", "This coupon has expired");
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) return new CouponError("EXHAUSTED", "This coupon has been fully used");
  return null;
}

/// What the account would get, for showing before it commits.
export function couponView(coupon: any) {
  return {
    code: coupon.code,
    description: coupon.description || null,
    activationFeePaise: coupon.activationFeePaise ?? null,
    messageFeePaise: coupon.messageFeePaise ?? null,
    walletCreditPaise: coupon.walletCreditPaise || 0,
    unlimitedMessages: !!coupon.unlimitedMessages,
    multiNumberEnabled: !!coupon.multiNumberEnabled,
    maxConnections: coupon.maxConnections ?? null,
    multiMessageFeePaise: coupon.multiMessageFeePaise ?? null,
    expiresAt: coupon.expiresAt || null,
  };
}

export async function previewCoupon(code: unknown, userId: string) {
  const coupon: any = await Coupon.findOne({ code: normalizeCode(code) }).lean();
  const problem = usable(coupon);
  if (problem) throw problem;
  if (await CouponRedemption.exists({ couponId: coupon._id, userId })) throw new CouponError("ALREADY_REDEEMED", "You have already used this coupon", 409);
  return couponView(coupon);
}

/// Applies a coupon to an account. Safe against two requests racing, and
/// against the cap being overrun: the count is claimed atomically before the
/// redemption row is written, and handed back if that write loses.
export async function redeemCoupon(code: unknown, user: any) {
  const now = new Date();
  const coupon: any = await Coupon.findOneAndUpdate(
    {
      code: normalizeCode(code), active: true,
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        { $or: [{ maxRedemptions: null }, { $expr: { $lt: ["$redemptionCount", "$maxRedemptions"] } }] },
      ],
    },
    { $inc: { redemptionCount: 1 } },
    { new: true },
  );
  if (!coupon) {
    // Re-read only to say why: the claim above is what decides.
    throw usable(await Coupon.findOne({ code: normalizeCode(code) }).lean()) || new CouponError("NOT_FOUND", "This coupon code is not valid", 404);
  }

  let redemption: any;
  try {
    redemption = await CouponRedemption.create({ couponId: coupon._id, userId: user._id, code: coupon.code, walletCreditPaise: coupon.walletCreditPaise || 0 });
  } catch (e: any) {
    await Coupon.updateOne({ _id: coupon._id }, { $inc: { redemptionCount: -1 } });
    if (e?.code === 11000) throw new CouponError("ALREADY_REDEEMED", "You have already used this coupon", 409);
    throw e;
  }

  const $set: any = { couponCode: coupon.code };
  if (coupon.activationFeePaise != null) {
    $set.customActivationFeePaise = coupon.activationFeePaise;
    // A free activation activates now: there is nothing to pay.
    if (coupon.activationFeePaise === 0 && user.billingStatus === "PENDING_ACTIVATION") $set.billingStatus = "ACTIVE";
  }
  if (coupon.messageFeePaise != null) $set.customMessageFeePaise = coupon.messageFeePaise;
  if (coupon.multiNumberEnabled) {
    $set.multiNumberEnabled = true;
    if (coupon.maxConnections != null) $set.maxConnections = coupon.maxConnections;
    if (coupon.multiMessageFeePaise != null) $set.customMultiMessageFeePaise = coupon.multiMessageFeePaise;
  }
  if (coupon.unlimitedMessages) { $set.unlimitedMessages = true; if (user.billingStatus === "PENDING_ACTIVATION") $set.billingStatus = "ACTIVE"; }
  await mongoose.model("User").updateOne({ _id: user._id }, { $set });

  if (coupon.walletCreditPaise > 0) {
    await creditWallet(String(user._id), coupon.walletCreditPaise, "coupon:" + String(redemption._id), `Coupon ${coupon.code}`, "coupon");
  }

  console.log(JSON.stringify({ event: "coupon.redeemed", code: coupon.code, userId: String(user._id) }));
  return couponView(coupon);
}
