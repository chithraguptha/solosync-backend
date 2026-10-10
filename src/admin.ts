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

/// Every handler is wrapped. Express 5 forwards a rejection to the error
/// handler, but the default handler returns an HTML error page, which the
/// dashboard's fetch cannot parse — it throws on r.json() and the failure
/// surfaces as an empty panel rather than a message. Always answering JSON
/// is what makes a broken endpoint visible in the UI.
const wrap = (fn: (req: Request, res: Response) => Promise<any>) =>
  async (req: Request, res: Response) => {
    try { await fn(req, res); }
    catch (e: any) {
      console.error(JSON.stringify({ event: "admin.error", path: req.path, message: e?.message }));
      if (!res.headersSent) res.status(500).json({ error: e?.message || "Request failed" });
    }
  };

/// Never leave the server, at any depth. Password and API-key hashes are
/// still credentials: a leaked bcrypt hash is offline-crackable and a leaked
/// key hash tells an attacker when they have guessed right. "Full access to
/// the database" does not have to mean shipping these to a browser.
const SECRET_FIELDS = new Set(["passwordHash", "keyHash", "__v"]);

/// Immutable from the admin UI. _id is the identity the update is keyed on,
/// and timestamps are maintained by mongoose.
const READONLY_FIELDS = new Set(["_id", "id", "createdAt", "updatedAt"]);

/// Only plain objects and arrays are walked. Anything else — ObjectId, Date,
/// Buffer — is returned untouched, because rebuilding it from Object.entries
/// turns it into a bag of its internals: an ObjectId came back as a plain
/// object, so String(_id) produced "[object Object]" and every row linked to
/// a document id the server then rejected as invalid.
const isPlainObject = (v: any) =>
  v !== null && typeof v === "object" &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function redact(doc: any): any {
  if (Array.isArray(doc)) return doc.map(redact);
  if (!isPlainObject(doc)) return doc;
  const out: any = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SECRET_FIELDS.has(k)) { out[k] = v == null ? null : "•••• redacted"; continue; }
    out[k] = redact(v);
  }
  return out;
}

/// Coerce a value coming back from the browser to the type the schema wants.
/// Everything arrives as a string from a form input, and writing the string
/// "50" into a Number field leaves a document that fails validation the next
/// time anything touches it.
function coerce(model: any, field: string, value: any) {
  const path: any = model.schema.path(field);
  const type = path?.instance;
  if (value === "" || value === null) return null;
  if (type === "Number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw Error(`${field} must be a number`);
    return n;
  }
  if (type === "Boolean") return value === true || value === "true";
  if (type === "Date") {
    const d = new Date(value);
    if (isNaN(d.getTime())) throw Error(`${field} must be a date`);
    return d;
  }
  if (type === "ObjectId") {
    if (!mongoose.isValidObjectId(value)) throw Error(`${field} must be an object id`);
    return new mongoose.Types.ObjectId(String(value));
  }
  return value;
}

function describe(model: any) {
  const fields: any[] = [];
  model.schema.eachPath((name: string, path: any) => {
    if (SECRET_FIELDS.has(name)) return;
    fields.push({
      name,
      type: path.instance || "Mixed",
      readonly: READONLY_FIELDS.has(name),
      enum: path.enumValues?.length ? path.enumValues : undefined,
    });
  });
  return fields;
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SoloSync Admin</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#e8edf4;background:#080a0f}*{box-sizing:border-box}body{margin:0}
nav{position:fixed;inset:0 auto 0 0;width:230px;background:#0d1118;border-right:1px solid #202733;padding:20px 12px;overflow:auto}
.brand{font-weight:800;font-size:19px;padding:8px 12px 18px}.brand small{display:block;color:#6f7b8d;font-size:10px;letter-spacing:.16em;margin-top:5px}
.navlabel{font-size:9px;letter-spacing:.15em;color:#5b6676;padding:12px 12px 6px;font-weight:700}
nav button{display:flex;justify-content:space-between;gap:8px;width:100%;text-align:left;background:transparent;color:#9ca8b8;border:0;border-radius:8px;padding:9px 12px;margin:2px 0;cursor:pointer;font-size:13px}
nav button.active,nav button:hover{background:#18202b;color:#fff}nav button i{font-style:normal;color:#5f6b7c;font-size:11px}
main{margin-left:230px;padding:26px;max-width:1600px}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:20px}
h1{font-size:28px;margin:0}.muted{color:#7f8a9c;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}
.card{background:#10151d;border:1px solid #222b37;border-radius:13px;padding:16px}.card span{display:block;color:#7d8999;font-size:11px}.card strong{font-size:25px;display:block;margin-top:6px}
.panel{background:#10151d;border:1px solid #222b37;border-radius:13px;padding:16px;margin-bottom:16px}.panel h2{font-size:15px;margin:0 0 12px}
.tablewrap{overflow:auto;max-height:66vh}table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:9px;border-bottom:1px solid #202733;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
th{color:#788496;font-weight:600;position:sticky;top:0;background:#10151d;z-index:1}
tbody tr{cursor:pointer}tbody tr:hover{background:#151d27}
.badge{display:inline-block;padding:3px 7px;border-radius:999px;background:#19222d;color:#b9c5d4;font-size:11px}
.ok{color:#8ee6aa}.bad{color:#ff9898}.warn{color:#e8ca78}
.btn{background:#e8edf4;color:#0b0e13;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;font-size:12px}
.btn.ghost{background:#161d27;color:#cfd7e2;border:1px solid #2a3340}
.btn.danger{background:#2a1417;color:#ff9b9b;border:1px solid #522f34}
.btn:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input,select,textarea{background:#0a0e14;border:1px solid #2a3340;color:#e8edf4;border-radius:8px;padding:8px 10px;font:inherit;font-size:12px;outline:0}
input:focus,select:focus,textarea:focus{border-color:#6a7686}
#err{display:none;background:#2a1417;border:1px solid #522f34;color:#ffb4b4;padding:11px 14px;border-radius:10px;margin-bottom:14px;font-size:12px;white-space:pre-wrap}
#banner{display:none;background:#12211a;border:1px solid #27482f;color:#9fe0b4;padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:12px}
.drawer{position:fixed;inset:0 0 0 auto;width:min(620px,100%);background:#0d1118;border-left:1px solid #222b37;padding:22px;overflow:auto;transform:translateX(100%);transition:transform .16s ease;z-index:20}
.drawer.open{transform:none}.drawer h2{margin:0 0 4px;font-size:18px}
.field{display:block;margin:12px 0}.field span{display:block;font-size:11px;color:#7d8999;margin-bottom:5px}
.field input,.field select,.field textarea{width:100%}.field textarea{min-height:76px;font-family:ui-monospace,monospace}
.field.ro input{opacity:.5}
.drawer .actions{display:flex;gap:8px;margin-top:18px;position:sticky;bottom:0;background:#0d1118;padding-top:14px}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:19;display:none}.scrim.open{display:block}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;padding-top:12px;color:#7f8a9c;font-size:12px}
section{display:none}section.active{display:block}
.empty{padding:26px;text-align:center;color:#6f7b8d;font-size:12px}
@media(max-width:900px){nav{position:static;width:auto}main{margin:0;padding:16px}.cards{grid-template-columns:1fr 1fr}}
</style></head>
<body>
<nav>
  <div class="brand">SoloSync<small>ADMIN CONSOLE</small></div>
  <button data-tab="overview" class="active">Overview</button>
  <div class="navlabel">DATABASE</div>
  <div id="collections"></div>
</nav>
<main>
  <div class="top">
    <div><h1 id="title">Overview</h1><span class="muted" id="subtitle">Operations console</span></div>
    <div class="row"><button class="btn ghost" id="btn-refresh">Refresh</button></div>
  </div>
  <div id="err"></div><div id="banner"></div>
  <section id="overview" class="active">
    <div class="cards" id="cards"></div>
    <div class="panel"><h2>System</h2><div id="system" class="muted"></div></div>
  </section>
  <section id="browser">
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input id="q" placeholder="Search…" style="flex:1;min-width:200px">
        <button class="btn" id="btn-search">Search</button>
        <span class="muted" id="count"></span>
      </div>
      <div class="tablewrap" id="tablewrap"></div>
      <div class="pager">
        <button class="btn ghost" id="prev" >Previous</button>
        <span id="pageinfo"></span>
        <button class="btn ghost" id="next" >Next</button>
      </div>
    </div>
  </section>
</main>
<div class="scrim" id="scrim"></div>
<div class="drawer" id="drawer">
  <h2 id="dtitle">Record</h2><p class="muted" id="did"></p>
  <div id="dfields"></div>
  <div class="actions">
    <button class="btn" id="dsave">Save changes</button>
    <button class="btn ghost" id="dcancel">Cancel</button>
    <button class="btn danger" id="ddelete" style="margin-left:auto">Delete</button>
  </div>
</div>
<script src="/admin/admin.js"></script>
</body></html>`;

const script = `
var esc=function(v){return String(v==null?"":v).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
var money=function(p){return "₹"+(Number(p||0)/100).toFixed(2)};
var state={model:null,page:1,pages:1,q:"",fields:[],doc:null};

function showErr(m){var e=document.getElementById("err");e.textContent=m;e.style.display=m?"block":"none"}
function showOk(m){var b=document.getElementById("banner");b.textContent=m;b.style.display=m?"block":"none";if(m)setTimeout(function(){b.style.display="none"},4000)}

// Every failure is shown. The previous console could fail silently and leave
// an empty panel with no indication anything had gone wrong.
async function api(path,opts){
  var r;
  try { r=await fetch("/admin/api"+path,Object.assign({credentials:"same-origin",headers:{"Content-Type":"application/json"}},opts||{})); }
  catch(e){ throw Error("Network error reaching the admin API: "+e.message); }
  var text=await r.text(), body=null;
  try{ body=text?JSON.parse(text):null }catch(e){
    throw Error("HTTP "+r.status+" — the server did not return JSON:\\n"+text.slice(0,300));
  }
  if(!r.ok) throw Error(body&&body.error?body.error:"HTTP "+r.status);
  return body;
}

function cell(v){
  if(v==null) return '<span class="muted">—</span>';
  if(typeof v==="object") return esc(JSON.stringify(v));
  var s=String(v);
  if(/^(WORKING|published|captured|ACTIVE|active)$/.test(s)) return '<span class="badge ok">'+esc(s)+'</span>';
  if(/^(FAILED|failed|SUSPENDED|revoked)$/.test(s)) return '<span class="badge bad">'+esc(s)+'</span>';
  if(/^(PENDING_ACTIVATION|queued|STARTING|SCAN_QR_CODE|created)$/.test(s)) return '<span class="badge warn">'+esc(s)+'</span>';
  return esc(s.length>90?s.slice(0,90)+"…":s);
}

async function loadOverview(){
  var o=await api("/overview");
  document.getElementById("cards").innerHTML=[
    ["Users",o.users],["WhatsApp connected",o.connected],["Messages",o.publications],
    ["Delivered",o.published],["Revenue",money(o.revenuePaise)]
  ].map(function(x){return '<div class="card"><span>'+x[0]+'</span><strong>'+esc(x[1])+'</strong></div>'}).join("");
  document.getElementById("system").innerHTML=
    "MongoDB <b class='"+(o.mongo==="ready"?"ok":"bad")+"'>"+esc(o.mongo)+"</b> · Billing <b>"+esc(o.billing)+
    "</b> · Activation "+money(o.activationFeePaise)+" · Per message "+money(o.messageFeePaise)+
    " · Uptime "+esc(o.uptime)+"s";
}

async function loadCollections(){
  var cols=await api("/collections");
  document.getElementById("collections").innerHTML=cols.map(function(c){
    return '<button data-model="'+esc(c.name)+'">'+esc(c.label)+'<i>'+c.count+'</i></button>';
  }).join("");
  Array.prototype.forEach.call(document.querySelectorAll("nav button[data-model]"),function(b){
    b.onclick=function(){openModel(b.dataset.model)};
  });
}

function setTab(tab,title,sub){
  Array.prototype.forEach.call(document.querySelectorAll("section"),function(s){s.classList.remove("active")});
  document.getElementById(tab).classList.add("active");
  Array.prototype.forEach.call(document.querySelectorAll("nav button"),function(b){b.classList.remove("active")});
  document.getElementById("title").textContent=title;
  document.getElementById("subtitle").textContent=sub||"";
}

async function openModel(name){
  state.model=name;state.page=1;state.q="";document.getElementById("q").value="";
  var btn=document.querySelector('nav button[data-model="'+name+'"]');
  setTab("browser",name,"Click any row to view and edit it");
  if(btn)btn.classList.add("active");
  await loadRows();
}

async function loadRows(){
  showErr("");
  try{
    var d=await api("/c/"+encodeURIComponent(state.model)+"?page="+state.page+"&q="+encodeURIComponent(state.q));
    state.fields=d.fields;state.pages=d.pages;
    document.getElementById("count").textContent=d.total+" record"+(d.total===1?"":"s");
    document.getElementById("pageinfo").textContent="Page "+d.page+" of "+d.pages;
    document.getElementById("prev").disabled=d.page<=1;
    document.getElementById("next").disabled=d.page>=d.pages;
    if(!d.rows.length){document.getElementById("tablewrap").innerHTML='<div class="empty">No records.</div>';return}
    var cols=d.columns;
    document.getElementById("tablewrap").innerHTML=
      "<table><thead><tr>"+cols.map(function(c){return "<th>"+esc(c)+"</th>"}).join("")+"</tr></thead><tbody>"+
      d.rows.map(function(r){
        return '<tr data-id="'+esc(r._id)+'">'+cols.map(function(c){return "<td>"+cell(r[c])+"</td>"}).join("")+"</tr>";
      }).join("")+"</tbody></table>";
    Array.prototype.forEach.call(document.querySelectorAll("tbody tr"),function(tr){
      tr.onclick=function(){openDoc(tr.dataset.id)};
    });
  }catch(e){ showErr(e.message); document.getElementById("tablewrap").innerHTML=""; }
}

function pageBy(d){state.page=Math.min(Math.max(1,state.page+d),state.pages);loadRows()}
function search(){state.q=document.getElementById("q").value.trim();state.page=1;loadRows()}
document.getElementById("q").addEventListener("keydown",function(e){if(e.key==="Enter")search()});

async function openDoc(id){
  showErr("");
  try{
    var d=await api("/c/"+encodeURIComponent(state.model)+"/"+encodeURIComponent(id));
    state.doc=d.doc;
    document.getElementById("dtitle").textContent=state.model;
    document.getElementById("did").textContent=id;
    document.getElementById("dfields").innerHTML=d.fields.map(function(f){
      var v=state.doc[f.name];
      var val=v==null?"":(typeof v==="object"?JSON.stringify(v,null,2):String(v));
      if(f.enum) return '<label class="field"><span>'+esc(f.name)+' · '+esc(f.type)+'</span><select data-f="'+esc(f.name)+'">'+
        f.enum.map(function(o){return '<option'+(String(v)===o?" selected":"")+'>'+esc(o)+'</option>'}).join("")+'</select></label>';
      if(f.type==="Boolean") return '<label class="field"><span>'+esc(f.name)+' · Boolean</span><select data-f="'+esc(f.name)+'">'+
        ["true","false"].map(function(o){return '<option'+(String(!!v)===o?" selected":"")+'>'+o+'</option>'}).join("")+'</select></label>';
      var ro=f.readonly?" ro":"";
      var tag=(val.length>60||val.indexOf("\\n")>=0)?"textarea":"input";
      return '<label class="field'+ro+'"><span>'+esc(f.name)+' · '+esc(f.type)+(f.readonly?" · read-only":"")+'</span>'+
        (tag==="textarea"
          ? '<textarea data-f="'+esc(f.name)+'"'+(f.readonly?" disabled":"")+'>'+esc(val)+'</textarea>'
          : '<input data-f="'+esc(f.name)+'"'+(f.readonly?" disabled":"")+' value="'+esc(val)+'">')+
        '</label>';
    }).join("");
    document.getElementById("drawer").classList.add("open");
    document.getElementById("scrim").classList.add("open");
  }catch(e){ showErr(e.message) }
}
function closeDrawer(){document.getElementById("drawer").classList.remove("open");document.getElementById("scrim").classList.remove("open");state.doc=null}

async function saveDoc(){
  if(!state.doc)return;
  var patch={};
  Array.prototype.forEach.call(document.querySelectorAll("#dfields [data-f]"),function(el){
    if(el.disabled)return;
    var name=el.dataset.f, before=state.doc[name];
    var beforeStr=before==null?"":(typeof before==="object"?JSON.stringify(before,null,2):String(before));
    if(el.value!==beforeStr) patch[name]=el.value;
  });
  if(!Object.keys(patch).length){showOk("Nothing changed.");return}
  if(!confirm("Save "+Object.keys(patch).length+" change(s) to this "+state.model+"?\\n\\n"+Object.keys(patch).join(", ")))return;
  var btn=document.getElementById("dsave");btn.disabled=true;
  try{
    await api("/c/"+encodeURIComponent(state.model)+"/"+encodeURIComponent(state.doc._id),
              {method:"PATCH",body:JSON.stringify(patch)});
    showOk("Saved.");closeDrawer();await loadRows();
  }catch(e){ showErr(e.message) }finally{ btn.disabled=false }
}

async function deleteDoc(){
  if(!state.doc)return;
  if(!confirm("Permanently delete this "+state.model+"?\\n\\n"+state.doc._id+"\\n\\nThis cannot be undone."))return;
  try{
    await api("/c/"+encodeURIComponent(state.model)+"/"+encodeURIComponent(state.doc._id),{method:"DELETE"});
    showOk("Deleted.");closeDrawer();await loadRows();await loadCollections();
  }catch(e){ showErr(e.message) }
}

document.querySelector('nav button[data-tab="overview"]').onclick=function(){
  setTab("overview","Overview","Operations console");
  this.classList.add("active");
};

async function reload(){
  showErr("");
  try{
    await loadOverview();
    await loadCollections();
    if(state.model) await loadRows();
  }catch(e){ showErr(e.message) }
}
reload();

// Handlers are attached here rather than as inline onclick attributes: the
// app sets a Content-Security-Policy of script-src 'self', which blocks
// inline handlers exactly as it blocks an inline <script>. That CSP is why
// the previous console rendered its shell and then did nothing at all — no
// script ran, so it never made a single request.
document.getElementById("btn-refresh").onclick=reload;
document.getElementById("btn-search").onclick=search;
document.getElementById("prev").onclick=function(){pageBy(-1)};
document.getElementById("next").onclick=function(){pageBy(1)};
document.getElementById("scrim").onclick=closeDrawer;
document.getElementById("dsave").onclick=saveDoc;
document.getElementById("dcancel").onclick=closeDrawer;
document.getElementById("ddelete").onclick=deleteDoc;
`;

export function mountAdmin(app: Express, config: AdminConfig) {
  const guard = auth(config);

  app.get("/admin", guard, (_req, res) => res.type("html").send(page));

  /// Served as a file rather than inlined, so it satisfies the app-wide
  /// `script-src 'self'` from helmet instead of needing 'unsafe-inline'.
  app.get("/admin/admin.js", guard, (_req, res) =>
    res.type("application/javascript").set("Cache-Control", "no-store").send(script));

  app.get("/admin/api/overview", guard, wrap(async (_req, res) => {
    const User = mongoose.model("User"), Connection = mongoose.model("WhatsappConnection");
    const Publication = mongoose.model("Publication"), Payment = mongoose.model("Payment");
    const [users, connected, publications, published, revenue] = await Promise.all([
      User.countDocuments(), Connection.countDocuments({ status: "WORKING" }),
      Publication.countDocuments(), Publication.countDocuments({ status: "published" }),
      Payment.aggregate([{ $match: { status: "captured" } }, { $group: { _id: null, total: { $sum: "$amountPaise" } } }]),
    ]);
    res.json({
      users, connected, publications, published,
      revenuePaise: revenue[0]?.total || 0,
      billing: process.env.BILLING_ENABLED === "true" ? "enabled" : "disabled",
      activationFeePaise: Number(process.env.ACTIVATION_FEE_PAISE || 29900),
      messageFeePaise: Number(process.env.MESSAGE_FEE_PAISE || 50),
      mongo: mongoose.connection.readyState === 1 ? "ready" : "down",
      uptime: Math.round(process.uptime()),
    });
  }));

  /// Every registered model, discovered rather than listed, so a collection
  /// added later shows up without touching this file.
  app.get("/admin/api/collections", guard, wrap(async (_req, res) => {
    const names = mongoose.modelNames().sort();
    const rows = await Promise.all(names.map(async n => ({
      name: n,
      label: n.replace(/([a-z])([A-Z])/g, "$1 $2"),
      count: await mongoose.model(n).estimatedDocumentCount().catch(() => 0),
    })));
    res.json(rows);
  }));

  const modelOr404 = (name: unknown, res: Response) => {
    const key = String(name);
    if (!mongoose.modelNames().includes(key)) { res.status(404).json({ error: "Unknown collection: " + key }); return null; }
    return mongoose.model(key) as mongoose.Model<any>;
  };

  app.get("/admin/api/c/:model", guard, wrap(async (req, res) => {
    const model = modelOr404(req.params.model, res); if (!model) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 40);
    const q = String(req.query.q || "").trim();

    // Search every string field, plus _id when the term looks like one.
    // Escaped, because an admin pasting a customer's email that happens to
    // contain regex characters should search for it, not crash.
    let filter: any = {};
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const or: any[] = [];
      model.schema.eachPath((name: string, path: any) => {
        if (path.instance === "String" && !SECRET_FIELDS.has(name)) or.push({ [name]: { $regex: safe, $options: "i" } });
      });
      if (mongoose.isValidObjectId(q)) or.push({ _id: new mongoose.Types.ObjectId(String(q)) });
      filter = or.length ? { $or: or } : {};
    }

    const sortField = model.schema.path("createdAt") ? "createdAt" : "_id";
    const [total, rows] = await Promise.all([
      model.countDocuments(filter),
      model.find(filter).sort({ [sortField]: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);

    const fields = describe(model);
    // Show identifying columns first; the rest are on the record itself.
    const preferred = ["_id", "email", "name", "userId", "status", "billingStatus", "type", "kind",
                       "amountPaise", "balancePaise", "chatId", "phoneNumber", "sessionName", "createdAt"];
    const available = fields.map(f => f.name);
    const columns = preferred.filter(c => available.includes(c))
      .concat(available.filter(c => !preferred.includes(c))).slice(0, 9);

    res.json({
      total, page, pages: Math.max(1, Math.ceil(total / limit)),
      columns, fields,
      rows: redact(rows).map((r: any) => ({ ...r, _id: String(r._id) })),
    });
  }));

  app.get("/admin/api/c/:model/:id", guard, wrap(async (req, res) => {
    const model = modelOr404(req.params.model, res); if (!model) return;
    if (!mongoose.isValidObjectId(String(req.params.id))) return res.status(400).json({ error: "Not a valid id" });
    const doc = await model.findById(String(req.params.id)).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    res.json({ fields: describe(model), doc: { ...redact(doc), _id: String((doc as any)._id) } });
  }));

  app.patch("/admin/api/c/:model/:id", guard, wrap(async (req, res) => {
    const model = modelOr404(req.params.model, res); if (!model) return;
    if (!mongoose.isValidObjectId(String(req.params.id))) return res.status(400).json({ error: "Not a valid id" });

    const patch = req.body || {};
    const $set: any = {};
    for (const [k, v] of Object.entries(patch)) {
      // A redacted field must never be written back. Without this, opening a
      // user and pressing save would store the literal "•••• redacted" as
      // their password hash and lock them out permanently.
      if (SECRET_FIELDS.has(k)) return res.status(400).json({ error: `${k} cannot be edited here` });
      if (READONLY_FIELDS.has(k)) return res.status(400).json({ error: `${k} is read-only` });
      if (!model.schema.path(k)) return res.status(400).json({ error: `${k} is not a field on ${req.params.model}` });
      $set[k] = coerce(model, k, v);
    }
    if (!Object.keys($set).length) return res.status(400).json({ error: "Nothing to update" });

    // runValidators so enums and required fields are still enforced — the
    // admin can change a value, not put the document into a state the
    // application will choke on later.
    const doc = await model.findByIdAndUpdate(String(req.params.id), { $set }, { new: true, runValidators: true }).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });

    console.log(JSON.stringify({
      event: "admin.update", collection: req.params.model, id: req.params.id, fields: Object.keys($set),
    }));
    res.json({ ok: true, doc: { ...redact(doc), _id: String((doc as any)._id) } });
  }));

  app.delete("/admin/api/c/:model/:id", guard, wrap(async (req, res) => {
    const model = modelOr404(req.params.model, res); if (!model) return;
    if (!mongoose.isValidObjectId(String(req.params.id))) return res.status(400).json({ error: "Not a valid id" });
    const doc = await model.findByIdAndDelete(String(req.params.id)).lean();
    if (!doc) return res.status(404).json({ error: "Not found" });
    console.warn(JSON.stringify({ event: "admin.delete", collection: req.params.model, id: req.params.id }));
    res.json({ ok: true });
  }));
}
