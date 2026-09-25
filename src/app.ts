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
import { WahaClient } from "./waha";

const env = {
  JWT_SECRET: process.env.JWT_SECRET || "change-me",
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  NODE_ENV: process.env.NODE_ENV || "development",
  WAHA_URL: process.env.WAHA_URL || "http://localhost:3000",
  WAHA_API_KEY: process.env.WAHA_API_KEY || "",
  WAHA_WEBHOOK_URL: process.env.WAHA_WEBHOOK_URL || "",
  WAHA_WEBHOOK_HMAC_KEY: process.env.WAHA_WEBHOOK_HMAC_KEY || "",
  BILLING_ENABLED: process.env.BILLING_ENABLED === "true",
  ACTIVATION_FEE_PAISE: Number(process.env.ACTIVATION_FEE_PAISE || 39900),
  MESSAGE_FEE_PAISE: Number(process.env.MESSAGE_FEE_PAISE || 10),
};

if (env.NODE_ENV === "production" && env.JWT_SECRET === "change-me") throw Error("JWT_SECRET must be configured");
if (env.NODE_ENV === "production" && !env.WAHA_API_KEY) throw Error("WAHA_API_KEY must be configured");

const User = mongoose.model("User", new Schema(
  { email: { type: String, required: true, unique: true, lowercase: true, trim: true }, passwordHash: { type: String, required: true } },
  { timestamps: true },
));
const WhatsappConnection = mongoose.model("WhatsappConnection", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    provider: { type: String, default: "waha" }, sessionName: { type: String, required: true, unique: true },
    status: { type: String, default: "STOPPED" }, phoneNumber: String, pushName: String, activationRecorded: { type: Boolean, default: false },
  },
  { timestamps: true },
));
const Publication = mongoose.model("Publication", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true }, connectionId: { type: Schema.Types.ObjectId, required: true },
    chatId: { type: String, required: true }, kind: { type: String, default: "text" }, text: String, mediaUrl: String,
    status: { type: String, default: "queued" }, attempts: { type: Number, default: 0 }, providerMessageId: String, error: String, publishedAt: Date,
  },
  { timestamps: true },
));
const BillingLedger = mongoose.model("BillingLedger", new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true }, publicationId: Schema.Types.ObjectId,
    kind: { type: String, required: true }, units: { type: Number, required: true }, amountPaise: { type: Number, required: true },
    status: { type: String, default: "recorded" }, note: String,
  },
  { timestamps: true },
));

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
const workerRedis = redis.duplicate();
const waha = new WahaClient({
  baseUrl: env.WAHA_URL, apiKey: env.WAHA_API_KEY,
  webhookUrl: env.WAHA_WEBHOOK_URL, webhookHmacKey: env.WAHA_WEBHOOK_HMAC_KEY,
});

type RawRequest = Request & { rawBody?: Buffer };
const app = express();
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as RawRequest).rawBody = Buffer.from(buf); } }));
app.use(cookieParser());
app.use("/api/auth", rateLimit({ windowMs: 60_000, max: 20 }));
app.use("/api/whatsapp", rateLimit({ windowMs: 60_000, max: 60 }));

const cookies = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
const access = (id: string) => jwt.sign({ sub: id, type: "access" }, env.JWT_SECRET, { expiresIn: "15m" });
const refresh = (id: string) => jwt.sign({ sub: id, type: "refresh", jti: crypto.randomUUID() }, env.JWT_SECRET, { expiresIn: "7d" });
const userView = (u: any) => ({ id: String(u._id), email: u.email, createdAt: u.createdAt });

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
    status: env.BILLING_ENABLED ? "pending_charge" : "recorded",
    note: env.BILLING_ENABLED ? "Payment provider integration pending" : "Test mode: payment disabled",
  });
  c.activationRecorded = true;
  await c.save();
}

async function recordMessage(userId: string, publicationId: any) {
  await BillingLedger.create({
    userId, publicationId, kind: "message", units: 1, amountPaise: env.MESSAGE_FEE_PAISE,
    status: env.BILLING_ENABLED ? "pending_charge" : "recorded",
    note: env.BILLING_ENABLED ? "Payment provider integration pending" : "Test mode: payment disabled",
  });
}

async function publish(publicationId: string) {
  const p: any = await Publication.findById(publicationId);
  if (!p) return;
  const c: any = await WhatsappConnection.findById(p.connectionId);
  if (!c) throw Error("WhatsApp connection not found");
  p.status = "publishing"; p.attempts += 1; await p.save();

  let result: any;
  if (p.kind === "image" && p.mediaUrl) result = await waha.sendImage(c.sessionName, p.chatId, p.mediaUrl, p.text);
  else if (p.kind === "video" && p.mediaUrl) result = await waha.sendVideo(c.sessionName, p.chatId, p.mediaUrl, p.text);
  else result = await waha.sendText(c.sessionName, p.chatId, p.text || "");

  p.status = "published"; p.providerMessageId = result?.id || result?.key?.id; p.publishedAt = new Date(); p.error = undefined; await p.save();
  await recordMessage(String(p.userId), p._id);
}

async function worker() {
  await workerRedis.connect();
  for (;;) {
    const item = await workerRedis.brPop("solosync:publish", 0);
    if (!item) continue;
    const job = JSON.parse(item.element);
    try { await publish(job.publicationId); }
    catch (e: any) {
      const p: any = await Publication.findById(job.publicationId);
      if (p && p.attempts < 3) await workerRedis.lPush("solosync:publish", JSON.stringify(job));
      else if (p) { p.status = "failed"; p.error = String(e?.message || e); await p.save(); }
    }
  }
}

app.get("/health", (_, res) => res.json({ status: "ok" }));
app.get("/ready", async (_, res) => { try { await mongoose.connection.db?.command({ ping: 1 }); await redis.ping(); res.json({ status: "ready" }); } catch { res.status(503).json({ status: "not_ready" }); } });

app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase(), password = String(req.body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ message: "Valid email and password of at least 8 characters are required" });
    if (await User.exists({ email })) return res.status(409).json({ message: "Account already exists" });
    const u: any = await User.create({ email, passwordHash: await bcrypt.hash(password, 12) });
    const token = refresh(String(u._id));
    await redis.setEx("session:" + crypto.createHash("sha256").update(token).digest("hex"), 604800, String(u._id));
    res.cookie("access_token", access(String(u._id)), { ...cookies, maxAge: 900000 });
    res.cookie("refresh_token", token, { ...cookies, maxAge: 604800000 });
    res.status(201).json({ user: userView(u) });
  } catch { res.status(500).json({ message: "Unable to create account" }); }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), password = String(req.body.password || "");
  const u: any = await User.findOne({ email });
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ message: "Invalid email or password" });
  const token = refresh(String(u._id));
  await redis.setEx("session:" + crypto.createHash("sha256").update(token).digest("hex"), 604800, String(u._id));
  res.cookie("access_token", access(String(u._id)), { ...cookies, maxAge: 900000 });
  res.cookie("refresh_token", token, { ...cookies, maxAge: 604800000 });
  res.json({ user: userView(u) });
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const token = req.cookies.refresh_token; if (!token) throw Error();
    const p: any = jwt.verify(token, env.JWT_SECRET);
    if (p.type !== "refresh" || !(await redis.get("session:" + crypto.createHash("sha256").update(token).digest("hex")))) throw Error();
    res.cookie("access_token", access(p.sub), { ...cookies, maxAge: 900000 }); res.json({ ok: true });
  } catch { res.status(401).json({ message: "Refresh session expired" }); }
});
app.post("/api/auth/logout", async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) await redis.del("session:" + crypto.createHash("sha256").update(token).digest("hex"));
  res.clearCookie("access_token", cookies); res.clearCookie("refresh_token", cookies); res.status(204).end();
});
app.get("/api/auth/me", async (req, res) => { try { res.json({ user: userView(await auth(req)) }); } catch { res.status(401).json({ message: "Not authenticated" }); } });

app.post("/api/whatsapp/connect", async (req, res) => {
  try {
    const user: any = await auth(req);
    let c: any = await connectionFor(String(user._id));
    if (!c) {
      const sessionName = "user_" + String(user._id);
      try { await waha.createSession(sessionName); } catch (e: any) { if (!String(e.message).includes("already")) throw e; await waha.startSession(sessionName); }
      c = await WhatsappConnection.create({ userId: user._id, sessionName, status: "STARTING" });
      await recordActivation(String(user._id), c);
    } else { try { await waha.startSession(c.sessionName); } catch {} }
    const session: any = await waha.getSession(c.sessionName);
    c.status = session.status || c.status; c.phoneNumber = session.me?.id?.replace("@c.us", "") || c.phoneNumber; c.pushName = session.me?.pushName || c.pushName; await c.save();
    res.json({ connection: c, session });
  } catch (e: any) { res.status(500).json({ message: e.message || "Unable to connect WhatsApp" }); }
});

app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const user: any = await auth(req), c: any = await connectionFor(String(user._id));
    if (!c) return res.json({ connected: false });
    const session: any = await waha.getSession(c.sessionName);
    c.status = session.status || c.status; c.phoneNumber = session.me?.id?.replace("@c.us", "") || c.phoneNumber; c.pushName = session.me?.pushName || c.pushName; await c.save();
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
    const p: any = await Publication.create({ userId: user._id, connectionId: c._id, chatId, kind, text, mediaUrl });
    await redis.lPush("solosync:publish", JSON.stringify({ publicationId: String(p._id) }));
    res.status(202).json({ publication: { id: String(p._id), status: "queued", feePaise: env.MESSAGE_FEE_PAISE, billingEnabled: env.BILLING_ENABLED } });
  } catch (e: any) { res.status(500).json({ message: e.message || "Unable to queue message" }); }
});

app.get("/api/billing/summary", async (req, res) => {
  try {
    const user: any = await auth(req), rows: any[] = await BillingLedger.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const total = rows.reduce((s, r) => s + r.amountPaise, 0), messages = rows.filter(r => r.kind === "message").reduce((s, r) => s + r.units, 0);
    res.json({ billingEnabled: env.BILLING_ENABLED, activationFeePaise: env.ACTIVATION_FEE_PAISE, messageFeePaise: env.MESSAGE_FEE_PAISE, messageCount: messages, recordedAmountPaise: total, recordedAmountRupees: total / 100, entries: rows });
  } catch (e: any) { res.status(401).json({ message: e.message || "Unable to read billing" }); }
});

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
