import { Express, Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

export type AdminConfig = { email: string; password: string };

function unauthorized(res: Response) {
  res.set("WWW-Authenticate", 'Basic realm="SoloSync Admin"');
  return res.status(401).send("Authentication required");
}

function auth(config: AdminConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!config.email || !config.password) return res.status(503).send("Admin dashboard is not configured");
    const header = req.header("authorization") || "";
    if (!header.startsWith("Basic ")) return unauthorized(res);
    try {
      const [email, password] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
      if (email !== config.email || password !== config.password) return unauthorized(res);
      next();
    } catch { return unauthorized(res); }
  };
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SoloSync Admin</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#e8edf4;background:#080a0f}*{box-sizing:border-box}body{margin:0}
nav{position:fixed;inset:0 auto 0 0;width:220px;background:#0d1118;border-right:1px solid #202733;padding:22px 14px}
.brand{font-weight:800;font-size:20px;padding:10px 12px 25px}.brand small{display:block;color:#6f7b8d;font-size:10px;letter-spacing:.16em;margin-top:5px}
nav button{display:block;width:100%;text-align:left;background:transparent;color:#9ca8b8;border:0;border-radius:9px;padding:11px 12px;margin:3px 0;cursor:pointer}
nav button.active,nav button:hover{background:#18202b;color:#fff}
main{margin-left:220px;padding:30px;max-width:1500px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px}
h1{font-size:32px;margin:0}.muted{color:#7f8a9c}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}
.card{background:#10151d;border:1px solid #222b37;border-radius:14px;padding:18px}.card span{display:block;color:#7d8999;font-size:12px}.card strong{font-size:27px;display:block;margin-top:8px}
.panel{background:#10151d;border:1px solid #222b37;border-radius:14px;padding:18px;margin-bottom:18px}.panel h2{font-size:16px;margin:0 0 15px}
.table{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:11px 9px;border-bottom:1px solid #202733;white-space:nowrap}th{color:#788496;font-weight:600}
.badge{display:inline-block;padding:4px 7px;border-radius:999px;background:#19222d;color:#b9c5d4}.ok{color:#8ee6aa}.bad{color:#ff9898}.warn{color:#e8ca78}
section{display:none}section.active{display:block}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
button.refresh{background:#e8edf4;color:#0b0e13;border:0;border-radius:8px;padding:9px 13px;font-weight:700;cursor:pointer}
@media(max-width:900px){nav{position:static;width:auto;display:flex;overflow:auto;height:auto}.brand{display:none}main{margin:0;padding:18px}.cards{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}
</style></head>
<body><nav><div class="brand">SoloSync<small>ADMIN CONSOLE</small></div>
<button data-tab="overview">Overview</button><button data-tab="users">Users</button><button data-tab="connections">WhatsApp</button><button data-tab="publications">Publications</button><button data-tab="payments">Payments</button><button data-tab="wallets">Wallets</button><button data-tab="ledger">Ledger</button></nav>
<main><div class="top"><div><h1 id="title">Overview</h1><span class="muted">Operations console</span></div><button class="refresh" onclick="load()">Refresh</button></div>
<section id="overview" class="active"><div class="cards" id="cards"></div><div class="grid"><div class="panel"><h2>System</h2><div id="system"></div></div><div class="panel"><h2>Recent activity</h2><div id="recent"></div></div></div></section>
<section id="users"><div class="panel"><h2>Users</h2><div class="table" id="usersTable"></div></div></section>
<section id="connections"><div class="panel"><h2>WhatsApp connections</h2><div class="table" id="connectionsTable"></div></div></section>
<section id="publications"><div class="panel"><h2>Publications</h2><div class="table" id="publicationsTable"></div></div></section>
<section id="payments"><div class="panel"><h2>Razorpay payments</h2><div class="table" id="paymentsTable"></div></div></section>
<section id="wallets"><div class="panel"><h2>Wallets</h2><div class="table" id="walletsTable"></div></div></section>
<section id="ledger"><div class="panel"><h2>Billing ledger</h2><div class="table" id="ledgerTable"></div></div></section>
</main>
<script>
const esc=v=>String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const money=p=>(Number(p||0)/100).toFixed(2)+" INR";
const table=(cols,rows)=>"<table><thead><tr>"+cols.map(c=>"<th>"+c+"</th>").join("")+"</tr></thead><tbody>"+rows.map(r=>"<tr>"+r.map(c=>"<td>"+c+"</td>").join("")+"</tr>").join("")+"</tbody></table>";
async function get(path){const r=await fetch("/admin/api/"+path);if(!r.ok)throw Error(await r.text());return r.json()}
async function load(){
 const [o,u,c,p,pa,w,l]=await Promise.all([get("overview"),get("users"),get("connections"),get("publications"),get("payments"),get("wallets"),get("ledger")]);
 document.getElementById("cards").innerHTML=[["Users",o.users],["Connected",o.connected],["Messages",o.publications],["Published",o.published],["Revenue",money(o.revenuePaise)]].map(x=>'<div class="card"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join("");
 document.getElementById("system").innerHTML="<p>MongoDB: <b class='ok'>"+esc(o.mongo)+"</b></p><p>Billing: <b>"+esc(o.billing)+"</b></p><p>Uptime: "+esc(o.uptime)+"s</p>";
 document.getElementById("recent").innerHTML=o.recent.map(x=>"<p><b>"+esc(x.kind)+"</b> · "+esc(x.email)+" · "+esc(x.status)+"<br><span class='muted'>"+esc(x.createdAt)+"</span></p>").join("")||"<span class='muted'>No activity</span>";
 document.getElementById("usersTable").innerHTML=table(["Email","Name","Auth","Billing","Created"],u.map(x=>[esc(x.email),esc(x.name),esc(x.authProvider),esc(x.billingStatus),esc(x.createdAt)]));
 document.getElementById("connectionsTable").innerHTML=table(["User","Phone","Status","Session","Updated"],c.map(x=>[esc(x.email),esc(x.phoneNumber),"<span class='"+(x.status==="WORKING"?"ok":"warn")+"'>"+esc(x.status)+"</span>",esc(x.sessionName),esc(x.updatedAt)]));
 document.getElementById("publicationsTable").innerHTML=table(["User","Chat","Kind","Status","Attempts","Created"],p.map(x=>[esc(x.email),esc(x.chatId),esc(x.kind),"<span class='"+(x.status==="published"?"ok":x.status==="failed"?"bad":"warn")+"'>"+esc(x.status)+"</span>",x.attempts,esc(x.createdAt)]));
 document.getElementById("paymentsTable").innerHTML=table(["User","Type","Amount","Order","Payment","Status","Created"],pa.map(x=>[esc(x.email),esc(x.type),money(x.amountPaise),esc(x.razorpayOrderId),esc(x.razorpayPaymentId),esc(x.status),esc(x.createdAt)]));
 document.getElementById("walletsTable").innerHTML=table(["User","Balance","Reserved","Updated"],w.map(x=>[esc(x.email),money(x.balancePaise),money(x.reservedPaise),esc(x.updatedAt)]));
 document.getElementById("ledgerTable").innerHTML=table(["User","Kind","Units","Amount","Status","Created"],l.map(x=>[esc(x.email),esc(x.kind),x.units,money(x.amountPaise),esc(x.status),esc(x.createdAt)]));
}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));document.querySelectorAll("section").forEach(x=>x.classList.remove("active"));b.classList.add("active");document.getElementById(b.dataset.tab).classList.add("active");document.getElementById("title").textContent=b.textContent});
load().catch(e=>document.body.insertAdjacentHTML("beforeend","<pre>"+esc(e.message)+"</pre>"));
</script></body></html>`;

export function mountAdmin(app: Express, config: AdminConfig) {
  const guard = auth(config);
  app.get("/admin", guard, (_req, res) => res.type("html").send(page));

  app.get("/admin/api/overview", guard, async (_req, res) => {
    const User = mongoose.model("User"), Connection = mongoose.model("WhatsappConnection"), Publication = mongoose.model("Publication"), Payment = mongoose.model("Payment"), Ledger = mongoose.model("BillingLedger");
    const [users, connected, publications, published, revenue, recent] = await Promise.all([
      User.countDocuments(), Connection.countDocuments({ status: "WORKING" }), Publication.countDocuments(),
      Publication.countDocuments({ status: "published" }),
      Payment.aggregate([{ $match: { status: "captured" } }, { $group: { _id: null, total: { $sum: "$amountPaise" } } }]),
      Publication.find().sort({ createdAt: -1 }).limit(8).lean(),
    ]);
    const recentUsers = await User.find({ _id: { $in: recent.map((x:any)=>x.userId) } }).select("email").lean();
    const email = new Map(recentUsers.map((x:any)=>[String(x._id),x.email]));
    res.json({ users, connected, publications, published, revenuePaise: revenue[0]?.total || 0, billing: process.env.BILLING_ENABLED === "true" ? "enabled" : "disabled", mongo: mongoose.connection.readyState === 1 ? "ready" : "down", uptime: Math.round(process.uptime()), recent: recent.map((x:any)=>({kind:x.kind,email:email.get(String(x.userId))||"unknown",status:x.status,createdAt:x.createdAt})) });
  });

  const list = async (modelName:string, res:Response, fields?:string) => {
    const rows:any[] = await mongoose.model(modelName).find().sort({ createdAt:-1 }).limit(200).lean();
    res.json(rows);
  };
  app.get("/admin/api/users", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("User").find().sort({createdAt:-1}).limit(500).lean(); res.json(rows.map(x=>({id:x._id,email:x.email,name:x.name||"",authProvider:x.authProvider,billingStatus:x.billingStatus||"ACTIVE",createdAt:x.createdAt})));
  });
  app.get("/admin/api/connections", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("WhatsappConnection").find().sort({updatedAt:-1}).limit(500).lean();
    const ids=rows.map(x=>x.userId); const users:any[]=await mongoose.model("User").find({_id:{$in:ids}}).select("email").lean(); const em=new Map(users.map(x=>[String(x._id),x.email]));
    res.json(rows.map(x=>({...x,email:em.get(String(x.userId))||"unknown"})));
  });
  app.get("/admin/api/publications", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("Publication").find().sort({createdAt:-1}).limit(500).lean();
    const ids=rows.map(x=>x.userId); const users:any[]=await mongoose.model("User").find({_id:{$in:ids}}).select("email").lean(); const em=new Map(users.map(x=>[String(x._id),x.email]));
    res.json(rows.map(x=>({...x,email:em.get(String(x.userId))||"unknown"})));
  });
  app.get("/admin/api/payments", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("Payment").find().sort({createdAt:-1}).limit(500).lean();
    const ids=rows.map(x=>x.userId); const users:any[]=await mongoose.model("User").find({_id:{$in:ids}}).select("email").lean(); const em=new Map(users.map(x=>[String(x._id),x.email]));
    res.json(rows.map(x=>({...x,email:em.get(String(x.userId))||"unknown"})));
  });
  app.get("/admin/api/wallets", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("Wallet").find().sort({updatedAt:-1}).limit(500).lean();
    const ids=rows.map(x=>x.userId); const users:any[]=await mongoose.model("User").find({_id:{$in:ids}}).select("email").lean(); const em=new Map(users.map(x=>[String(x._id),x.email]));
    res.json(rows.map(x=>({...x,email:em.get(String(x.userId))||"unknown"})));
  });
  app.get("/admin/api/ledger", guard, async (_req,res)=> {
    const rows:any[]=await mongoose.model("BillingLedger").find().sort({createdAt:-1}).limit(500).lean();
    const ids=rows.map(x=>x.userId); const users:any[]=await mongoose.model("User").find({_id:{$in:ids}}).select("email").lean(); const em=new Map(users.map(x=>[String(x._id),x.email]));
    res.json(rows.map(x=>({...x,email:em.get(String(x.userId))||"unknown"})));
  });
}
