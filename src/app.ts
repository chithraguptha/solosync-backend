import express, { Request } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose, { Schema } from "mongoose";
import crypto from "crypto";
import { createClient } from "redis";
import { OAuth2Client } from "google-auth-library";
import { WahaClient } from "./waha";
import {
  configureBilling, createOrder, Payment, Wallet, WalletTransaction, RazorpayWebhookEvent,
  verifyCheckoutSignature, verifyWebhookSignature, processCapturedPayment, markPaymentCaptured,
  reserveMessageCredit, finalizeMessageCredit, releaseMessageCredit, creditWallet,
} from "./billing";
import { mountAdmin } from "./admin";

const env = {
  JWT_SECRET: process.env.JWT_SECRET || "change-me",
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  NODE_ENV: process.env.NODE_ENV || "development",
  WAHA_URL: process.env.WAHA_URL || "http://localhost:3000",
  WAHA_API_KEY: process.env.WAHA_API_KEY || "",
  WAHA_WEBHOOK_URL: process.env.WAHA_WEBHOOK_URL || "",
  WAHA_WEBHOOK_HMAC_KEY: process.env.WAHA_WEBHOOK_HMAC_KEY || "",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/api/auth/google/callback",
  BILLING_ENABLED: process.env.BILLING_ENABLED === "true",
  ACTIVATION_FEE_PAISE: Number(process.env.ACTIVATION_FEE_PAISE || 39900),
  MESSAGE_FEE_PAISE: Number(process.env.MESSAGE_FEE_PAISE || 10),
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || "",
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || "",
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  RAZORPAY_CURRENCY: process.env.RAZORPAY_CURRENCY || "INR",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
};

if (env.NODE_ENV === "production" && env.JWT_SECRET === "change-me") throw Error("JWT_SECRET must be configured");
if (env.NODE_ENV === "production" && !env.WAHA_API_KEY) throw Error("WAHA_API_KEY must be configured");
if (env.BILLING_ENABLED && env.NODE_ENV === "production" && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)) throw Error("Razorpay configuration is required when billing is enabled");

const User = mongoose.model("User", new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String },
    googleId: { type: String, unique: true, sparse: true },
    name: String,
    avatarUrl: String,
    authProvider: { type: String, enum: ["password", "google", "both"], default: "password" },
    billingStatus: { type: String, enum: ["PENDING_ACTIVATION", "ACTIVE", "SUSPENDED"], default: () => env.BILLING_ENABLED ? "PENDING_ACTIVATION" : "ACTIVE" },
  },
  { timestamps: true },
));

const WhatsappConnection = mongoose.model("WhatsappConnection", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    provider: { type: String, default: "waha" },
    sessionName: { type: String, required: true, unique: true },
    status: { type: String, default: "STOPPED" },
    phoneNumber: String,
    pushName: String,
    activationRecorded: { type: Boolean, default: false },
  },
  { timestamps: true },
));

const Publication = mongoose.model("Publication", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    chatId: { type: String, required: true, index: true },
    kind: { type: String, enum: ["text", "image", "video"], default: "text" },
    text: String,
    mediaUrl: String,
    status: { type: String, enum: ["queued", "publishing", "published", "failed"], default: "queued", index: true },
    attempts: { type: Number, default: 0 },
    providerMessageId: String,
    error: String,
    publishedAt: Date,
  },
  { timestamps: true },
));

const BillingLedger = mongoose.model("BillingLedger", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    publicationId: Schema.Types.ObjectId,
    kind: { type: String, required: true },
    units: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, default: "recorded" },
    note: String,
  },
  { timestamps: true },
));

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
const workerRedis = redis.duplicate();
const waha = new WahaClient({
  baseUrl: env.WAHA_URL,
  apiKey: env.WAHA_API_KEY,
  webhookUrl: env.WAHA_WEBHOOK_URL,
  webhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY,
});
const google = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
configureBilling({
  enabled: env.BILLING_ENABLED,
  keyId: env.RAZORPAY_KEY_ID,
  keySecret: env.RAZORPAY_KEY_SECRET,
  webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  currency: env.RAZORPAY_CURRENCY,
  activationFeePaise: env.ACTIVATION_FEE_PAISE,
  messageFeePaise: env.MESSAGE_FEE_PAISE,
});

type RawRequest = Request & { rawBody?: Buffer };
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as RawRequest).rawBody = Buffer.from(buf); } }));
app.use(cookieParser());
app.use("/api/auth", rateLimit({ windowMs: 60_000, max: 30 }));
app.use("/api/whatsapp", rateLimit({ windowMs: 60_000, max: 60 }));

const cookies = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
const access = (id: string) => jwt.sign({ sub: id, type: "access" }, env.JWT_SECRET, { expiresIn: "15m" });
const refresh = (id: string) => jwt.sign({ sub: id, type: "refresh", jti: crypto.randomUUID() }, env.JWT_SECRET, { expiresIn: "7d" });
const userView = (u: any) => ({
  id: String(u._id), email: u.email, name: u.name || u.email.split("@")[0],
  avatarUrl: u.avatarUrl || null, authProvider: u.authProvider, billingStatus: u.billingStatus || "ACTIVE", createdAt: u.createdAt,
});

async function issueSession(res: express.Response, userId: string) {
  const token = refresh(userId);
  await redis.setEx("session:" + crypto.createHash("sha256").update(token).digest("hex"), 604800, userId);
  res.cookie("access_token", access(userId), { ...cookies, maxAge: 900000 });
  res.cookie("refresh_token", token, { ...cookies, maxAge: 604800000 });
}

async function auth(req: Request) {
  const token = req.cookies?.access_token;
  if (!token) throw Error("Not authenticated");
  const p: any = jwt.verify(token, env.JWT_SECRET);
  if (p.type !== "access") throw Error("Invalid token");
  const user = await User.findById(p.sub);
  if (!user) throw Error("User not found");
  return user;
}

const connectionFor = (id: string) => WhatsappConnection.findOne({ userId: id });

async function recordActivation(userId: string, c: any) {
  if (c.activationRecorded) return;
  await BillingLedger.create({
    userId, kind: "activation", units: 1, amountPaise: env.ACTIVATION_FEE_PAISE,
    status: "recorded", note: env.BILLING_ENABLED ? "Razorpay activation payment captured" : "Local test mode",
  });
  c.activationRecorded = true;
  c.status = c.status || "STARTING";
  await c.save();
  await mongoose.model("User").findByIdAndUpdate(userId, { billingStatus: "ACTIVE" });
}

async function recordMessage(userId: string, publicationId: any) {
  const exists = await BillingLedger.exists({ publicationId, kind: "message" });
  if (exists) return;
  await BillingLedger.create({
    userId, publicationId, kind: "message", units: 1, amountPaise: env.MESSAGE_FEE_PAISE,
    status: "recorded",
    note: env.BILLING_ENABLED ? "Payment provider integration pending" : "Test mode: payment disabled",
  });
}

async function publish(publicationId: string) {
  const p: any = await Publication.findById(publicationId);
  if (!p || p.status === "published") return;
  const c: any = await WhatsappConnection.findById(p.connectionId);
  if (!c) throw Error("WhatsApp connection not found");

  p.status = "publishing";
  p.attempts += 1;
  await p.save();

  try {
    let result: any;
    if (p.kind === "image" && p.mediaUrl) result = await waha.sendImage(c.sessionName, p.chatId, p.mediaUrl, p.text);
    else if (p.kind === "video" && p.mediaUrl) result = await waha.sendVideo(c.sessionName, p.chatId, p.mediaUrl, p.text);
    else result = await waha.sendText(c.sessionName, p.chatId, p.text || "");

    p.status = "published";
    p.providerMessageId = result?.id || result?.key?.id;
    p.publishedAt = new Date();
    p.error = undefined;
    await p.save();
    await finalizeMessageCredit(String(p.userId), env.MESSAGE_FEE_PAISE, String(p._id), env.BILLING_ENABLED);
    await recordMessage(String(p.userId), p._id);
  } catch (error: any) {
    p.status = p.attempts < 3 ? "queued" : "failed";
    p.error = String(error?.message || error);
    await p.save();
    if (p.status === "failed") await releaseMessageCredit(String(p.userId), env.MESSAGE_FEE_PAISE, String(p._id), env.BILLING_ENABLED);
    throw error;
  }
}

async function worker() {
  await workerRedis.connect();
  for (;;) {
    const item = await workerRedis.brPop("solosync:publish", 0);
    if (!item) continue;
    try { await publish(JSON.parse(item.element).publicationId); }
    catch (e: any) {
      const p: any = await Publication.findById(JSON.parse(item.element).publicationId);
      if (p && p.status === "queued" && p.attempts < 3) await workerRedis.lPush("solosync:publish", item.element);
    }
  }
}

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.get("/ready", async (_, res) => {
  try { await mongoose.connection.db?.command({ ping: 1 }); await redis.ping(); res.json({ status: "ready" }); }
  catch { res.status(503).json({ status: "not_ready" }); }
});

app.get("/api/auth/google", async (_req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return res.status(503).json({ message: "Google authentication is not configured" });
  const state = crypto.randomBytes(32).toString("hex");
  await redis.setEx("google-oauth:" + state, 600, "1");
  const url = google.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
  res.redirect(url);
});

app.get("/api/auth/google/callback", async (req, res) => {
  try {
    const state = String(req.query.state || "");
    if (!state || !(await redis.getDel("google-oauth:" + state))) throw Error("Invalid Google authentication state");
    const code = String(req.query.code || "");
    if (!code) throw Error("Google authorization was cancelled");

    const { tokens } = await google.getToken(code);
    if (!tokens.id_token) throw Error("Google did not return an identity token");
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) throw Error("Google account could not be verified");

    let user: any = await User.findOne({ $or: [{ googleId: payload.sub }, { email: payload.email.toLowerCase() }] });
    if (!user) {
      user = await User.create({
        email: payload.email.toLowerCase(),
        googleId: payload.sub,
        name: payload.name || payload.email.split("@")[0],
        avatarUrl: payload.picture,
        authProvider: "google",
      });
    } else {
      user.googleId = payload.sub;
      user.name = payload.name || user.name;
      user.avatarUrl = payload.picture || user.avatarUrl;
      user.authProvider = user.passwordHash ? "both" : "google";
      await user.save();
    }

    await issueSession(res, String(user._id));
    res.redirect(env.FRONTEND_ORIGIN);
  } catch (e: any) {
    const message = encodeURIComponent(e.message || "Google sign-in failed");
    res.redirect(env.FRONTEND_ORIGIN + "?auth_error=" + message);
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ message: "Valid email and password of at least 8 characters are required" });
    if (await User.exists({ email })) return res.status(409).json({ message: "Account already exists. Use Google sign-in or sign in with your password." });
    const u: any = await User.create({ email, passwordHash: await bcrypt.hash(password, 12), authProvider: "password" });
    await issueSession(res, String(u._id));
    res.status(201).json({ user: userView(u) });
  } catch { res.status(500).json({ message: "Unable to create account" }); }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), password = String(req.body.password || "");
  const u: any = await User.findOne({ email });
  if (!u?.passwordHash || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ message: "Invalid email or password" });
  await issueSession(res, String(u._id));
  res.json({ user: userView(u) });
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const token = req.cookies.refresh_token;
    if (!token) throw Error();
    const p: any = jwt.verify(token, env.JWT_SECRET);
    if (p.type !== "refresh" || !(await redis.get("session:" + crypto.createHash("sha256").update(token).digest("hex")))) throw Error();
    res.cookie("access_token", access(p.sub), { ...cookies, maxAge: 900000 });
    res.json({ ok: true });
  } catch { res.status(401).json({ message: "Refresh session expired" }); }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) await redis.del("session:" + crypto.createHash("sha256").update(token).digest("hex"));
  res.clearCookie("access_token", cookies); res.clearCookie("refresh_token", cookies); res.status(204).end();
});

app.get("/api/auth/me", async (req, res) => {
  try { res.json({ user: userView(await auth(req)) }); }
  catch { res.status(401).json({ message: "Not authenticated" }); }
});

app.post("/api/whatsapp/connect", async (req, res) => {
  try {
    const user: any = await auth(req);
    if (user.billingStatus === "SUSPENDED") return res.status(403).json({ message: "Account is suspended" });
    if (env.BILLING_ENABLED && user.billingStatus !== "ACTIVE") return res.status(402).json({ message: "Activation payment required", code: "ACTIVATION_REQUIRED" });
    let c: any = await connectionFor(String(user._id));
    if (!c) {
      const sessionName = "user_" + String(user._id);
      try { await waha.createSession(sessionName); } catch (e: any) { if (!String(e.message).includes("already")) throw e; }
      try { await waha.startSession(sessionName); } catch {}
      c = await WhatsappConnection.create({ userId: user._id, sessionName, status: "STARTING" });
      if (!env.BILLING_ENABLED) await recordActivation(String(user._id), c);
    } else {
      try { await waha.startSession(c.sessionName); } catch {}
    }
    const session: any = await waha.getSession(c.sessionName);
    c.status = session.status || c.status;
    c.phoneNumber = session.me?.id?.replace("@c.us", "") || c.phoneNumber;
    c.pushName = session.me?.pushName || c.pushName;
    await c.save();
    res.json({ connection: c, session });
  } catch (e: any) { res.status(500).json({ message: e.message || "Unable to connect WhatsApp" }); }
});

app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const user: any = await auth(req), c: any = await connectionFor(String(user._id));
    if (!c) return res.json({ connected: false });
    const session: any = await waha.getSession(c.sessionName);
    c.status = session.status || c.status;
    c.phoneNumber = session.me?.id?.replace("@c.us", "") || c.phoneNumber;
    c.pushName = session.me?.pushName || c.pushName;
    await c.save();
    res.json({ connected: session.status === "WORKING", connection: c, session });
  } catch (e: any) { res.status(401).json({ message: e.message || "Unable to read status" }); }
});

app.get("/api/whatsapp/qr", async (req, res) => {
  try {
    const user: any = await auth(req), c: any = await connectionFor(String(user._id));
    if (!c) return res.status(404).json({ message: "Connect WhatsApp first" });
    res.json(await waha.getQr(c.sessionName));
  } catch (e: any) { res.status(502).json({ message: e.message || "Unable to get QR code" }); }
});

app.get("/api/whatsapp/channels", async (req, res) => {
  try {
    const user: any = await auth(req), c: any = await connectionFor(String(user._id));
    if (!c) return res.status(404).json({ message: "Connect WhatsApp first" });
    res.json({ channels: await waha.getChannels(c.sessionName) });
  } catch (e: any) { res.status(502).json({ message: e.message || "Unable to list channels" }); }
});

app.post("/api/whatsapp/publish", async (req, res) => {
  try {
    const user: any = await auth(req), c: any = await connectionFor(String(user._id));
    if (!c) return res.status(400).json({ message: "Connect WhatsApp first" });
    const chatId = String(req.body.chatId || "").trim(), text = String(req.body.text || "");
    const kind = String(req.body.kind || "text"), mediaUrl = req.body.mediaUrl ? String(req.body.mediaUrl) : undefined;
    if (!chatId || (!text && !mediaUrl)) return res.status(400).json({ message: "chatId and text/media are required" });
    if (!["text", "image", "video"].includes(kind)) return res.status(400).json({ message: "Unsupported message kind" });
    const session: any = await waha.getSession(c.sessionName);
    if (session.status !== "WORKING") return res.status(409).json({ message: "WhatsApp session is not ready", status: session.status });
    const p: any = await Publication.create({ userId: user._id, connectionId: c._id, chatId, kind, text, mediaUrl } as any);
    const reserved = await reserveMessageCredit(String(user._id), env.MESSAGE_FEE_PAISE, String(p._id), env.BILLING_ENABLED);
    if (!reserved) { await p.deleteOne(); return res.status(402).json({ message: "Insufficient wallet balance. Top up your wallet to send messages.", code: "INSUFFICIENT_BALANCE" }); }
    try {
      await redis.lPush("solosync:publish", JSON.stringify({ publicationId: String(p._id) }));
    } catch (error) {
      await releaseMessageCredit(String(user._id), env.MESSAGE_FEE_PAISE, String(p._id), env.BILLING_ENABLED);
      await p.deleteOne();
      throw error;
    }
    res.status(202).json({ publication: { id: String(p._id), status: "queued", feePaise: env.MESSAGE_FEE_PAISE } });
  } catch (e: any) { res.status(500).json({ message: e.message || "Unable to queue message" }); }
});

app.get("/api/messages", async (req, res) => {
  try {
    const user: any = await auth(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const skip = (page - 1) * limit;
    const [messages, total] = await Promise.all([
      Publication.find({ userId: user._id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Publication.countDocuments({ userId: user._id }),
    ]);
    res.json({ messages, page, limit, total, pages: Math.ceil(total / limit) });
  } catch (e: any) { res.status(401).json({ message: e.message || "Unable to read messages" }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const user: any = await auth(req);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [rows, recent, connection] = await Promise.all([
      Publication.aggregate([
        { $match: { userId: user._id } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          successful: { $sum: { $cond: [{ $eq: ["$status", "published"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          queued: { $sum: { $cond: [{ $in: ["$status", ["queued", "publishing"]] }, 1, 0] } },
        } },
      ]),
      Publication.countDocuments({ userId: user._id, createdAt: { $gte: since } }),
      connectionFor(String(user._id)),
    ]);
    const s = rows[0] || { total: 0, successful: 0, failed: 0, queued: 0 };
    res.json({
      connection: connection ? {
        status: connection.status, phoneNumber: connection.phoneNumber, pushName: connection.pushName,
        connected: connection.status === "WORKING",
      } : null,
      stats: {
        total: s.total, successful: s.successful, failed: s.failed, queued: s.queued,
        successRate: s.total ? Number(((s.successful / s.total) * 100).toFixed(1)) : 0,
        failureRate: s.total ? Number(((s.failed / s.total) * 100).toFixed(1)) : 0,
        last24Hours: recent,
      },
    });
  } catch (e: any) { res.status(401).json({ message: e.message || "Unable to read dashboard" }); }
});

app.get("/api/billing/summary", async (req, res) => {
  try {
    const user: any = await auth(req);
    const rows: any[] = await BillingLedger.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const total = rows.reduce((s, r) => s + r.amountPaise, 0);
    const messages = rows.filter(r => r.kind === "message").reduce((s, r) => s + r.units, 0);
    res.json({ billingEnabled: env.BILLING_ENABLED, activationFeePaise: env.ACTIVATION_FEE_PAISE, messageFeePaise: env.MESSAGE_FEE_PAISE, messageCount: messages, recordedAmountPaise: total, recordedAmountRupees: total / 100, entries: rows });
  } catch (e: any) { res.status(401).json({ message: e.message || "Unable to read billing" }); }
});


// Billing / Razorpay
app.get("/api/billing/config", async (req, res) => {
  try {
    const user: any = await auth(req);
    const wallet: any = await Wallet.findOne({ userId: user._id }).lean();
    res.json({ enabled: env.BILLING_ENABLED, keyId: env.RAZORPAY_KEY_ID || null, activationFeePaise: env.ACTIVATION_FEE_PAISE, messageFeePaise: env.MESSAGE_FEE_PAISE, billingStatus: user.billingStatus || "ACTIVE", wallet: wallet ? { balancePaise: wallet.balancePaise, reservedPaise: wallet.reservedPaise } : { balancePaise: 0, reservedPaise: 0 } });
  } catch (e:any) { res.status(401).json({ message: e.message || "Unable to read billing config" }); }
});

app.post("/api/billing/activation/order", async (req, res) => {
  try {
    const user:any = await auth(req);
    if (!env.BILLING_ENABLED) { user.billingStatus = "ACTIVE"; await user.save(); return res.json({ disabled: true, billingStatus: "ACTIVE" }); }
    if (user.billingStatus === "ACTIVE") return res.json({ alreadyActive: true, billingStatus: "ACTIVE" });
    const existing:any = await Payment.findOne({ userId:user._id, type:"activation", status:"created" }).sort({createdAt:-1});
    const order = existing ? { id: existing.razorpayOrderId, amount: existing.amountPaise, currency: existing.currency } : await createOrder("activation", String(user._id), env.ACTIVATION_FEE_PAISE, env.RAZORPAY_CURRENCY);
    res.json({ keyId: env.RAZORPAY_KEY_ID, order, amountPaise: env.ACTIVATION_FEE_PAISE, currency: env.RAZORPAY_CURRENCY });
  } catch(e:any) { res.status(500).json({ message:e.message || "Unable to create activation order" }); }
});

app.post("/api/billing/activation/verify", async (req,res) => {
  try {
    const user:any=await auth(req);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature }=req.body||{};
    const p:any=await Payment.findOne({userId:user._id,razorpayOrderId:razorpay_order_id,type:"activation"});
    if(!p || p.amountPaise!==env.ACTIVATION_FEE_PAISE) return res.status(400).json({message:"Invalid activation order"});
    if(!verifyCheckoutSignature(razorpay_order_id,razorpay_payment_id,razorpay_signature,env.RAZORPAY_KEY_SECRET)) return res.status(400).json({message:"Invalid payment signature"});
    const captured:any=await processCapturedPayment(razorpay_payment_id);
    captured.razorpaySignature=razorpay_signature; await captured.save();
    user.billingStatus="ACTIVE"; await user.save();
    if (!(await BillingLedger.exists({ userId:user._id, kind:"activation" }))) await BillingLedger.create({userId:user._id,kind:"activation",units:1,amountPaise:p.amountPaise,status:"recorded",note:"Razorpay Checkout verified"});
    res.json({ok:true,billingStatus:"ACTIVE"});
  }catch(e:any){res.status(400).json({message:e.message||"Payment verification failed"});}
});

app.post("/api/billing/wallet/order", async (req,res) => {
  try {
    const user:any=await auth(req);
    if(!env.BILLING_ENABLED) return res.json({disabled:true});
    const amountPaise=Math.round(Number(req.body.amountPaise||0));
    if(!Number.isInteger(amountPaise) || amountPaise<10000 || amountPaise>100000000) return res.status(400).json({message:"Top-up must be between ₹100 and ₹1,000,000"});
    const order=await createOrder("wallet_topup",String(user._id),amountPaise,env.RAZORPAY_CURRENCY);
    res.json({keyId:env.RAZORPAY_KEY_ID,order,amountPaise,currency:env.RAZORPAY_CURRENCY});
  }catch(e:any){res.status(400).json({message:e.message||"Unable to create wallet order"});}
});

app.post("/api/billing/wallet/verify", async(req,res)=>{
  try{
    const user:any=await auth(req); const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
    const p:any=await Payment.findOne({userId:user._id,razorpayOrderId:razorpay_order_id,type:"wallet_topup"});
    if(!p) return res.status(400).json({message:"Invalid wallet order"});
    if(!verifyCheckoutSignature(razorpay_order_id,razorpay_payment_id,razorpay_signature,env.RAZORPAY_KEY_SECRET)) return res.status(400).json({message:"Invalid payment signature"});
    const captured:any=await processCapturedPayment(razorpay_payment_id);
    captured.razorpaySignature=razorpay_signature; await captured.save();
    if(captured.status==="captured") await creditWallet(String(user._id),p.amountPaise,String(p._id));
    const wallet:any=await Wallet.findOne({userId:user._id}).lean();
    res.json({ok:true,wallet:{balancePaise:wallet?.balancePaise||0,reservedPaise:wallet?.reservedPaise||0}});
  }catch(e:any){res.status(400).json({message:e.message||"Wallet payment verification failed"});}
});

app.get("/api/billing/wallet", async(req,res)=>{
  try{const user:any=await auth(req);const wallet:any=await Wallet.findOne({userId:user._id}).lean();const transactions=await WalletTransaction.find({userId:user._id}).sort({createdAt:-1}).limit(100).lean();res.json({wallet:{balancePaise:wallet?.balancePaise||0,reservedPaise:wallet?.reservedPaise||0},transactions});}
  catch(e:any){res.status(401).json({message:e.message||"Unable to read wallet"});}
});

app.post("/webhooks/razorpay", async(req,res)=>{
  const signature=req.header("X-Razorpay-Signature")||"";
  const raw=(req as RawRequest).rawBody?.toString("utf8")||"";
  if(!env.RAZORPAY_WEBHOOK_SECRET || !verifyWebhookSignature(raw,signature,env.RAZORPAY_WEBHOOK_SECRET)) return res.status(401).json({message:"Invalid Razorpay webhook signature"});
  try{
    const eventId=req.header("x-razorpay-event-id")||crypto.createHash("sha256").update(raw).digest("hex");
    const inserted=await RazorpayWebhookEvent.create({eventId,event:req.body?.event||"unknown"}).catch((e:any)=>e?.code===11000?null:Promise.reject(e));
    if(!inserted) return res.status(204).end();
    const event=req.body?.event;
    const payment=req.body?.payload?.payment?.entity;
    if(payment && (event==="payment.captured" || event==="order.paid")){
      const p:any=await markPaymentCaptured(payment);
      if(p.type==="activation"){
        await mongoose.model("User").findByIdAndUpdate(p.userId,{billingStatus:"ACTIVE"});
        if (!(await BillingLedger.exists({userId:p.userId,kind:"activation"}))) await BillingLedger.create({userId:p.userId,kind:"activation",units:1,amountPaise:p.amountPaise,status:"recorded",note:"Razorpay webhook captured"});
      }
      if(p.type==="wallet_topup"){
        const already=await WalletTransaction.exists({type:"topup",referenceId:String(p._id)});
        if(!already) await creditWallet(String(p.userId),p.amountPaise,String(p._id));
      }
    }
    if(payment && event==="payment.failed") await Payment.findOneAndUpdate({razorpayOrderId:payment.order_id},{status:"failed",razorpayPaymentId:payment.id});
    res.status(204).end();
  }catch(e:any){res.status(500).json({message:e.message||"Webhook processing failed"});}
});

mountAdmin(app, { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });

app.post("/webhooks/waha", async (req, res) => {
  const raw = (req as RawRequest).rawBody?.toString("utf8") || JSON.stringify(req.body);
  if (!waha.verifyWebhook(raw, req.header("X-Webhook-Hmac") || undefined)) return res.status(401).json({ message: "Invalid webhook signature" });
  try {
    if (req.body?.event === "session.status") {
      const c: any = await WhatsappConnection.findOne({ sessionName: req.body.session });
      if (c) { c.status = req.body.payload?.status || c.status; await c.save(); }
    }
    res.status(204).end();
  } catch { res.status(400).json({ message: "Invalid webhook" }); }
});

export async function startApp() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/solosync");
  await redis.connect();
  app.listen(Number(process.env.PORT || 4000), "0.0.0.0", () => console.log("SoloSync API listening"));
  worker().catch(e => console.error("publisher worker stopped", e));
}
