import crypto from "crypto";
import mongoose, { Schema } from "mongoose";
import Razorpay from "razorpay";

export type BillingConfig = {
  enabled: boolean;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  currency: string;
  activationFeePaise: number;
  messageFeePaise: number;
};

export const Payment = mongoose.model("Payment", new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["activation", "wallet_topup"], required: true, index: true },
  amountPaise: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, unique: true, sparse: true },
  razorpaySignature: String,
  status: { type: String, enum: ["created", "authorized", "captured", "failed", "refunded"], default: "created", index: true },
  webhookEventsProcessed: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));

export const Wallet = mongoose.model("Wallet", new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  balancePaise: { type: Number, default: 0 },
  reservedPaise: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true }));

export const WalletTransaction = mongoose.model("WalletTransaction", new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type: { type: String, enum: ["topup", "message_reservation", "message_usage", "reservation_release", "refund", "adjustment"], required: true },
  amountPaise: { type: Number, required: true },
  balanceBeforePaise: { type: Number, required: true },
  balanceAfterPaise: { type: Number, required: true },
  referenceType: String,
  referenceId: String,
  note: String,
  createdAt: { type: Date, default: Date.now },
}, { timestamps: false }));

export const RazorpayWebhookEvent = mongoose.model("RazorpayWebhookEvent", new Schema({
  eventId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  receivedAt: { type: Date, default: Date.now },
}, { timestamps: false }));

let client: Razorpay | null = null;

export function configureBilling(config: BillingConfig) {
  if (config.enabled && (!config.keyId || !config.keySecret)) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when billing is enabled");
  }
  if (config.enabled) client = new Razorpay({ key_id: config.keyId, key_secret: config.keySecret });
}

function razorpay() {
  if (!client) throw new Error("Razorpay is not configured");
  return client;
}

export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret: string) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(orderId + "|" + paymentId).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function verifyWebhookSignature(rawBody: string, signature: string, secret: string) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function createOrder(type: "activation" | "wallet_topup", userId: string, amountPaise: number, currency: string) {
  const order = await razorpay().orders.create({
    amount: amountPaise,
    currency,
    receipt: "ss_" + type + "_" + userId.slice(-10) + "_" + Date.now(),
    notes: { userId, type },
  });
  await Payment.create({ userId, type, amountPaise, currency, razorpayOrderId: order.id, status: "created" });
  return order;
}

export async function markPaymentCaptured(payment: any) {
  const p: any = await Payment.findOne({ razorpayOrderId: payment.order_id });
  if (!p) throw new Error("Payment order not found");
  if (Number(payment.amount) !== p.amountPaise || payment.currency !== p.currency) throw new Error("Payment amount mismatch");
  p.razorpayPaymentId = payment.id;
  p.status = "captured";
  await p.save();
  return p;
}

export async function creditWallet(userId: string, amountPaise: number, referenceId: string, note = "Razorpay wallet top-up") {
  if (amountPaise <= 0) throw new Error("Wallet amount must be positive");
  if (await WalletTransaction.exists({ type: "topup", referenceId })) return;
  const wallet: any = await Wallet.findOneAndUpdate(
    { userId },
    { $inc: { balancePaise: amountPaise }, $setOnInsert: { userId } },
    { upsert: true, new: false },
  );
  const before = Number(wallet?.balancePaise || 0);
  await WalletTransaction.create({
    userId, type: "topup", amountPaise,
    balanceBeforePaise: before, balanceAfterPaise: before + amountPaise,
    referenceType: "payment", referenceId, note,
  });
}

export async function reserveMessageCredit(userId: string, amountPaise: number, referenceId: string, enabled: boolean) {
  if (!enabled) return true;
  const wallet: any = await Wallet.findOneAndUpdate(
    { userId, balancePaise: { $gte: amountPaise } },
    { $inc: { reservedPaise: amountPaise } },
    { new: true },
  );
  if (!wallet) return false;
  await WalletTransaction.create({
    userId, type: "message_reservation", amountPaise: 0,
    balanceBeforePaise: wallet.balancePaise, balanceAfterPaise: wallet.balancePaise,
    referenceType: "publication", referenceId, note: "Reserved message credit",
  });
  return true;
}

export async function finalizeMessageCredit(userId: string, amountPaise: number, referenceId: string, enabled: boolean) {
  if (!enabled) return;
  const wallet: any = await Wallet.findOneAndUpdate(
    { userId, reservedPaise: { $gte: amountPaise }, balancePaise: { $gte: amountPaise } },
    { $inc: { reservedPaise: -amountPaise, balancePaise: -amountPaise } },
    { new: true },
  );
  if (!wallet) throw new Error("Unable to commit wallet usage");
  await WalletTransaction.create({
    userId, type: "message_usage", amountPaise: -amountPaise,
    balanceBeforePaise: wallet.balancePaise + amountPaise, balanceAfterPaise: wallet.balancePaise,
    referenceType: "publication", referenceId, note: "Successful WhatsApp message",
  });
}

export async function releaseMessageCredit(userId: string, amountPaise: number, referenceId: string, enabled: boolean) {
  if (!enabled) return;
  const wallet: any = await Wallet.findOneAndUpdate(
    { userId, reservedPaise: { $gte: amountPaise } },
    { $inc: { reservedPaise: -amountPaise } },
    { new: true },
  );
  if (!wallet) return;
  await WalletTransaction.create({
    userId, type: "reservation_release", amountPaise: 0,
    balanceBeforePaise: wallet.balancePaise, balanceAfterPaise: wallet.balancePaise,
    referenceType: "publication", referenceId, note: "Released failed message reservation",
  });
}

export async function processCapturedPayment(paymentId: string) {
  const payment: any = await razorpay().payments.fetch(paymentId);
  if (payment.status !== "captured") throw new Error("Payment is not captured");
  const record: any = await markPaymentCaptured(payment);
  return record;
}
