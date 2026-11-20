import mongoose, { Schema } from "mongoose";
import { Payment } from "./billing";

export type Seller = { name: string; address: string; email: string };

/// One receipt per captured payment, numbered in sequence per year
/// (SS-2026-000001). Not a GST tax invoice: it carries no tax lines.
export const Receipt = mongoose.model("Receipt", new Schema(
  {
    number: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", required: true, unique: true },
    type: { type: String, required: true },
    description: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    razorpayPaymentId: String,
    // Copied at issue time, so a later change to the seller details or the
    // customer's name does not rewrite a receipt already issued.
    seller: { name: String, address: String, email: String },
    buyer: { name: String, email: String },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
));

const Counter = mongoose.model("Counter", new Schema({ _id: String, seq: { type: Number, default: 0 } }));

const DESCRIPTIONS: Record<string, string> = {
  activation: "SoloSync account activation (one-time)",
  wallet_topup: "SoloSync prepaid message credit",
};

/// Issues the receipt for a captured payment, once. Safe to call from every
/// place a payment can be confirmed (checkout verify, webhook, backfill):
/// the unique paymentId makes the second call return the first receipt.
export async function issueReceipt(payment: any, seller: Seller) {
  if (!payment || payment.status !== "captured") return null;
  const existing = await Receipt.findOne({ paymentId: payment._id });
  if (existing) return existing;

  const user: any = await mongoose.model("User").findById(payment.userId).lean();
  const issuedAt = new Date();
  const year = issuedAt.getUTCFullYear();
  const counter: any = await Counter.findOneAndUpdate(
    { _id: "receipt-" + year }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" },
  );
  try {
    return await Receipt.create({
      number: `SS-${year}-${String(counter.seq).padStart(6, "0")}`,
      userId: payment.userId, paymentId: payment._id, type: payment.type,
      description: DESCRIPTIONS[payment.type] || "SoloSync payment",
      amountPaise: payment.amountPaise, currency: payment.currency || "INR",
      razorpayPaymentId: payment.razorpayPaymentId,
      seller, buyer: { name: user?.name || "", email: user?.email || "" },
      issuedAt,
    });
  } catch (e: any) {
    // Lost a race with another confirmation of the same payment.
    if (e?.code === 11000) return Receipt.findOne({ paymentId: payment._id });
    throw e;
  }
}

/// Receipts for payments captured before receipts existed, or whose
/// confirmation path failed after capture.
export async function backfillReceipts(userId: any, seller: Seller) {
  const issued = await Receipt.find({ userId }).distinct("paymentId");
  const missing = await Payment.find({ userId, status: "captured", _id: { $nin: issued } }).sort({ createdAt: 1 });
  for (const p of missing) await issueReceipt(p, seller);
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const money = (paise: number, currency: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR" }).format((paise || 0) / 100);

/// A printable page. Print → Save as PDF gives the customer a file.
export function receiptHtml(r: any) {
  const date = new Date(r.issuedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${esc(r.number)}</title>
<style>
body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;background:#f4f5f7;margin:0;padding:32px 16px}
.sheet{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:40px}
.head{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;border-bottom:1px solid #eee;padding-bottom:24px}
h1{font-size:22px;margin:0 0 4px}.muted{color:#666;font-size:13px;line-height:1.5}.right{text-align:right}
.parties{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin:24px 0}
.label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}th,td{padding:12px 8px;border-bottom:1px solid #eee;text-align:left}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#888}td.amt,th.amt{text-align:right}
.total td{font-weight:700;border-bottom:0;font-size:16px}.paid{display:inline-block;background:#e7f6ec;color:#1f7a3d;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
.foot{margin-top:28px;font-size:12px;color:#888}
@media print{body{background:#fff;padding:0}.sheet{border:0;padding:0}}
</style></head><body><div class="sheet">
<div class="head"><div><h1>${esc(r.seller?.name || "SoloSync")}</h1><div class="muted">${esc(r.seller?.address || "").replace(/\n/g, "<br>")}${r.seller?.email ? "<br>" + esc(r.seller.email) : ""}</div></div>
<div class="right"><h1>Receipt</h1><div class="muted">${esc(r.number)}<br>${esc(date)}</div><div style="margin-top:8px"><span class="paid">Paid</span></div></div></div>
<div class="parties"><div><div class="label">Billed to</div><div>${esc(r.buyer?.name || "")}</div><div class="muted">${esc(r.buyer?.email || "")}</div></div>
<div class="right"><div class="label">Payment reference</div><div class="muted">${esc(r.razorpayPaymentId || "—")}</div></div></div>
<table><thead><tr><th>Description</th><th class="amt">Amount</th></tr></thead>
<tbody><tr><td>${esc(r.description)}</td><td class="amt">${esc(money(r.amountPaise, r.currency))}</td></tr>
<tr class="total"><td>Total paid</td><td class="amt">${esc(money(r.amountPaise, r.currency))}</td></tr></tbody></table>
<div class="foot">This is a payment receipt, not a tax invoice. To save it as a PDF, use your browser's Print → Save as PDF.</div>
</div></body></html>`;
}
