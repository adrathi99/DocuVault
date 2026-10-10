import express from "express";
import pdf from "pdf-parse/lib/pdf-parse.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---- Config (loaded from .env via node --env-file=.env) ----
const {
  WHATSAPP_TOKEN = "",
  PHONE_NUMBER_ID = "",
  VERIFY_TOKEN = "change-me",
  GRAPH_VERSION = "v21.0",
  PORT = 3000,

  // LLM: "openai" (Groq, default) or "ollama" (local fallback)
  LLM_MODE = "openai",
  OLLAMA_URL = "http://localhost:11434/api/chat",
  OLLAMA_MODEL = "llama3.2",
  OPENAI_BASE_URL = "https://api.groq.com/openai/v1",
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "openai/gpt-oss-20b",

  // DocuVault storage: "local" now, "oracle" once tenancy is wired (Phase 4)
  VAULT_DIR = "./vault-data",
  STORAGE_BACKEND = "local",

  SESSION_SECRET = "",

  // Public base URL (ngrok stable domain now, Oracle VM native https later — never hardcode)
  PUBLIC_BASE_URL = "https://saxophone-dismiss-trapping.ngrok-free.dev",
} = process.env;
const WT = process.env.WELCOME_TEMPLATE || "hello_world";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const CONF = { mode: LLM_MODE, url: LLM_MODE === "openai" ? OPENAI_BASE_URL : OLLAMA_URL, model: LLM_MODE === "openai" ? OPENAI_MODEL : OLLAMA_MODEL };

// ---- LLM prompts ----
const DESCRIBE_PROMPT = `You identify documents. Given extracted text from a PDF, reply with ONLY valid JSON (no markdown, no extra text) shaped like:
{"title": "short proper filename-like title, 3-8 words, Title Case, no extension, e.g. Imagica Theme Park Booking 2026", "description": "one short sentence: whose document, type, organization, year/date", "keywords": ["6-10 lowercase search keywords, e.g. health, report, apollo, 2025, blood-test"], "docType": "report|bill|letter|certificate|statement|other", "org": "organization or sender or null", "year": "year or date found or null"}`;

const RERANK_PROMPT = `You match a user's document request against their saved documents. Reply with ONLY the best matching document id (e.g. DV-0003) or the word NONE if nothing matches. No other text.`;

const app = express();
app.set("trust proxy", true); // honor X-Forwarded-Proto/For from ngrok (and later Oracle LB/Caddy)
app.use(express.json({ limit: "2mb" }));
app.use(express.static("."));

// ---- In-memory state ----
const seen = new Set();            // WhatsApp message ids already handled
const sessions = new Map();        // phone -> { stage, stagingPath, fileName, sha, analysis, updatedAt }
const SESSION_TTL_MS = 15 * 60 * 1000;

// ---- Storage backend interface: put(key, buffer) / get(key) / delete(key) ----
const OBJECTS_DIR = path.join(VAULT_DIR, "objects");
const STAGING_DIR = path.join(VAULT_DIR, "staging");
const META_FILE = path.join(VAULT_DIR, "metadata.json");

const LocalBackend = {
  async put(key, buffer) {
    const full = path.join(OBJECTS_DIR, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
  },
  async get(key) {
    return fs.readFile(path.join(OBJECTS_DIR, key));
  },
  async delete(key) {
    await fs.rm(path.join(OBJECTS_DIR, key), { force: true });
  },
};

// Oracle backend lands here in Phase 4 (same 3 methods via oci-sdk).
// Selected at startup in initStorage() below (oracle when OCI creds are present, else local).
let backend = LocalBackend;

async function initStorage() {
  if (STORAGE_BACKEND !== "oracle") {
    console.log(`storage: local @ ${VAULT_DIR}`);
    return;
  }
  const ociCommon = await import("oci-common");
  const os = await import("oci-objectstorage");
  const region = ociCommon.Region.fromRegionId(process.env.OCI_REGION || "ap-mumbai-1");
  let provider;
  if (process.env.OCI_USE_INSTANCE_PRINCIPAL === "true") {
    provider = await new ociCommon.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    console.log("storage: oracle via instance principal (VM role, no keys)");
  } else {
    const { OCI_TENANCY = "", OCI_USER = "", OCI_FINGERPRINT = "", OCI_PRIVATE_KEY = "" } = process.env;
    if (!OCI_TENANCY || !OCI_USER || !OCI_FINGERPRINT || !OCI_PRIVATE_KEY)
      throw new Error("oracle backend needs OCI_TENANCY/OCI_USER/OCI_FINGERPRINT/OCI_PRIVATE_KEY (or OCI_USE_INSTANCE_PRINCIPAL=true)");
    provider = new ociCommon.SimpleAuthenticationDetailsProvider(
      OCI_TENANCY, OCI_USER, OCI_FINGERPRINT,
      OCI_PRIVATE_KEY.replace(/\\n/g, "\n"), null, region
    );
    console.log("storage: oracle via API key");
  }
  const client = new os.ObjectStorageClient({ authenticationDetailsProvider: provider });
  client.region = region;
  let namespace = process.env.OCI_NAMESPACE || "";
  if (!namespace) namespace = (await client.getNamespace({})).value;
  const bucket = process.env.OCI_BUCKET || "docuvault";
  const prefix = (process.env.OCI_PREFIX || "docuvault/").replace(/^\//, "");
  console.log(`storage: oracle bucket ${namespace}/${bucket} prefix ${prefix}`);
  backend = {
    async put(key, buffer) {
      await client.putObject({
        namespaceName: namespace, bucketName: bucket, objectName: prefix + key,
        putObjectBody: buffer, contentLength: buffer.length, contentType: "application/pdf",
      });
    },
    async get(key) {
      const res = await client.getObject({ namespaceName: namespace, bucketName: bucket, objectName: prefix + key });
      const chunks = [];
      for await (const c of res.value) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      return Buffer.concat(chunks);
    },
    async delete(key) {
      await client.deleteObject({ namespaceName: namespace, bucketName: bucket, objectName: prefix + key });
    },
  };
}

// ---- Metadata index: { users: { <phone>: [ {id, objectName, sha, description, keywords, docType, org, year, note, fileName, savedAt} ] } } ----
let meta = { users: {} };
async function loadMeta() {
  try {
    meta = JSON.parse(await fs.readFile(META_FILE, "utf8"));
    if (!meta.users) meta = { users: {} };
  } catch { meta = { users: {} }; }
}
async function saveMeta() {
  await fs.mkdir(VAULT_DIR, { recursive: true });
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2));
}
function docsFor(phone) {
  if (!meta.users[phone]) meta.users[phone] = [];
  return meta.users[phone];
}
function nextDocId(phone) {
  const docs = docsFor(phone);
  let max = 0;
  for (const d of docs) {
    const m = /^DV-(\d+)$/.exec(d.id || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `DV-${String(max + 1).padStart(4, "0")}`;
}

// ---- LLM ----
async function callLLM(messages, maxTokens = 400) {
  if (CONF.mode === "openai") {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    const res = await fetch(`${CONF.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: CONF.model, messages, max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim();
  }
  const res = await fetch(CONF.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CONF.model, messages, stream: false, options: { num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return (data.message?.content || "").trim();
}

function parseJsonReply(text) {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/g, "").trim();
  try { return JSON.parse(clean); } catch { /* try brace extraction below */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]); // throws if truly unparseable
  throw new Error("no JSON object in reply");
}

// Tolerant extractor: full JSON → brace block → individual "key":"value" salvage (handles truncation).
function extractAnalysis(text, fileName) {
  try { return parseJsonReply(text); } catch { /* salvage below */ }
  const grab = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "s"));
    return m ? m[1].replace(/\\"/g, '"') : null;
  };
  const description = grab("description");
  if (description) {
    const kwm = text.match(/"keywords"\s*:\s*\[([\s\S]*?)(?:\]|$)/);
    const keywords = kwm ? [...kwm[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(0, 12) : [];
    return {
      title: grab("title") || fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").slice(0, 60) || "Untitled document",
      description, keywords,
      docType: grab("docType") || "other", org: grab("org"), year: grab("year"),
    };
  }
  throw new Error("no JSON object in reply");
}

// ---- WhatsApp send helpers ----
async function sendText(to, body) {
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: body.slice(0, 4096) } }),
  });
  if (!res.ok) { console.error("sendText failed:", res.status, await res.text()); return false; }
  console.log(`[out] to=${to} body="${body.slice(0, 80)}"`);
  return true;
}

async function uploadMedia(buffer, filename, mime = "application/pdf") {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`media upload HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function sendDocument(to, buffer, filename, caption) {
  const mediaId = await uploadMedia(buffer, filename);
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename, caption: (caption || "").slice(0, 1024) },
    }),
  });
  if (!res.ok) throw new Error(`sendDocument HTTP ${res.status}: ${await res.text()}`);
  console.log(`[out] to=${to} document="${filename}"`);
}

async function downloadMedia(mediaId) {
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!metaRes.ok) throw new Error(`media meta HTTP ${metaRes.status}`);
  const metaJson = await metaRes.json();
  const binRes = await fetch(metaJson.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!binRes.ok) throw new Error(`media download HTTP ${binRes.status}`);
  return Buffer.from(await binRes.arrayBuffer());
}

// ---- Keyword matching (layer 1-2 of retrieval) ----
const STOPWORDS = new Set("a,an,the,my,me,give,show,send,fetch,get,find,please,from,of,for,to,with,that,this,doc,document,file,pdf,and,or,is,are,was,i,want,need,look,looking,latest".split(","));
function tokensOf(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
}
function scoreDoc(queryTokens, queryRaw, entry) {
  const hay = `${entry.title || ""} ${entry.description} ${(entry.keywords || []).join(" ")} ${entry.note || ""} ${entry.docType || ""} ${entry.org || ""} ${entry.year || ""}`.toLowerCase();
  const hayTokens = new Set(hay.replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
  let score = 0;
  for (const t of queryTokens) if (hayTokens.has(t)) score += 1;
  for (const kw of entry.keywords || []) {
    if (kw.includes(" ") && queryRaw.toLowerCase().includes(kw.toLowerCase())) score += 2; // exact phrase bonus
  }
  const yearMatch = queryRaw.match(/\b(19|20)\d{2}\b/);
  if (yearMatch && entry.year && entry.year.includes(yearMatch[0])) score += 3; // year match weighs most
  return score;
}

// ---- Conversation handlers ----
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return String(iso || "").slice(0, 10); }
}
function docLine(d) {
  return `• ${d.title || "Untitled document"} (stored ${fmtDate(d.savedAt)})`;
}
function getSession(phone) {
  const s = sessions.get(phone);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(phone);
    fs.rm(s.stagingPath, { force: true }).catch(() => {});
    return null;
  }
  return s;
}

async function handleTextMessage(from, body) {
  const text = (body || "").trim();
  const lower = text.toLowerCase();

  // Active save-flow / disambiguation session takes priority
  const sess = getSession(from);
  if (sess) {
    if (sess.stage === "awaiting-note") return handleNote(from, text, sess);
    if (sess.stage === "awaiting-confirm") return handleConfirm(from, text, sess);
    if (sess.stage === "awaiting-pick") return handlePick(from, text, sess);
  }

  if (/^(hi|hey|hello|yo|howdy)\b/.test(lower) && text.length < 20)
    return sendText(from, "Hi! I'm DocuVault. Send me a PDF to store it, or describe a document and I'll fetch it — e.g. “give me my health report from 2025”.");
  if (lower === "help")
    return sendText(from, "📄 *DocuVault help*\n\n📥 Send a PDF → I'll describe it, then ask to save it.\n🔍 Describe a saved doc → I'll send it back.\n🗂️ *LIST* → show your saved documents.\n❌ *CANCEL* → drop the current step.");
  if (lower === "cancel") {
    sessions.delete(from);
    return sendText(from, "Cancelled. Send a PDF to store, or describe a document to fetch.");
  }
  if (lower === "list") {
    const docs = docsFor(from);
    if (!docs.length) return sendText(from, "Your DocuVault is empty. Send me a PDF to store your first document.");
    return sendText(from, `Your DocuVault (${docs.length}):\n${docs.map(docLine).join("\n")}`.slice(0, 4000));
  }

  // Otherwise: retrieval query
  return handleRetrieval(from, text);
}

async function handleRetrieval(from, query) {
  const docs = docsFor(from);
  if (!docs.length)
    return sendText(from, "Your DocuVault is empty. Send me a PDF and I'll store it for you.");

  const queryTokens = tokensOf(query);
  const scored = docs
    .map((d) => ({ entry: d, score: scoreDoc(queryTokens, query, d) }))
    .sort((a, b) => b.score - a.score);
  const viable = scored.filter((s) => s.score >= 2).slice(0, 3);
  if (!viable.length) {
    const docs = docsFor(from);
    return sendText(from, `I couldn't find that in your DocuVault. You have:\n${docs.map(docLine).join("\n")}`.slice(0, 4000));
  }

  // LLM rerank over shortlist (or single candidate straight through)
  let pick = viable[0].entry;
  if (viable.length > 1) {
    const candidates = viable.map((v) => `${v.entry.id}: ${v.entry.title || v.entry.description} — ${v.entry.description} [${(v.entry.keywords || []).join(", ")}]`).join("\n");
    try {
      const verdict = await callLLM([
        { role: "system", content: RERANK_PROMPT },
        { role: "user", content: `Request: "${query}"\nCandidates:\n${candidates}` },
      ], 500);
      const id = verdict.trim().toUpperCase();
      const found = viable.find((v) => v.entry.id === id);
      if (found) {
        pick = found.entry;
      } else if (id !== "NONE") {
        const lines = viable.map((v, i) => `${i + 1}) ${v.entry.title || "Untitled document"} (stored ${fmtDate(v.entry.savedAt)})`);
        sessions.set(from, { stage: "awaiting-pick", options: viable.map((v) => v.entry.id), updatedAt: Date.now() });
        return sendText(from, `I found a few close matches — reply with the number:\n${lines.join("\n")}`);
      } else {
        return sendText(from, "None of your saved documents match that closely. Try rephrasing, or LIST to see everything.");
      }
    } catch (err) {
      console.error("rerank failed, using top keyword hit:", err.message);
    }
  }

  await serveDoc(from, pick);
}

async function serveDoc(from, pick) {
  try {
    const bytes = await backend.get(pick.objectName);
    await sendDocument(from, bytes, pick.fileName || "document.pdf", `${pick.title || "Your document"}: ${pick.description}`);
    console.log(`[vault] served ${pick.id} to=${from}`);
  } catch (err) {
    console.error("serve failed:", err);
    await sendText(from, `Found it (${pick.title || "your document"} — stored ${fmtDate(pick.savedAt)}) but couldn't fetch the file right now. Please try again in a bit.`);
  }
}

async function handlePick(from, text, sess) {
  const n = parseInt(text.trim(), 10);
  const entry = Number.isInteger(n) && n >= 1 && n <= sess.options.length
    ? docsFor(from).find((d) => d.id === sess.options[n - 1])
    : null;
  sessions.delete(from);
  if (!entry) {
    await sendText(from, "No problem — describe the document again and I'll search fresh.");
    return;
  }
  await serveDoc(from, entry);
}

async function handleDocumentMessage(from, msg) {
  const fileName = msg.document?.filename || "document.pdf";
  const mime = msg.document?.mime_type || "";
  const isPdf = mime === "application/pdf" || /\.pdf$/i.test(fileName);
  if (!isPdf) {
    await sendText(from, "DocuVault only stores PDFs right now. Please send a PDF document.");
    return;
  }
  await sendText(from, "Reading your PDF…");
  let buf;
  try {
    buf = await downloadMedia(msg.document.id);
  } catch (err) {
    console.error("download failed:", err);
    await sendText(from, "I couldn't download that file from WhatsApp. Please try sending it again.");
    return;
  }

  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  // Duplicate check
  const existing = docsFor(from).find((d) => d.sha === sha);
  if (existing) {
    await sendText(from, `That's already in your DocuVault:\n*${existing.title || "Untitled document"}* (stored ${fmtDate(existing.savedAt)})`);
    return;
  }

  await fs.mkdir(STAGING_DIR, { recursive: true });
  const stagingPath = path.join(STAGING_DIR, `${from}-${Date.now()}.pdf`);
  await fs.writeFile(stagingPath, buf);

  const data = await pdf(buf);
  const text = (data.text || "").slice(0, 14000);
  if (!text.trim()) {
    await fs.rm(stagingPath, { force: true });
    await sendText(from, "I couldn't find readable text in that PDF (it may be a scan). DocuVault needs readable PDFs.");
    return;
  }

  let analysis;
  let rawReply = "";
  const describeCall = () => callLLM([
    { role: "system", content: DESCRIBE_PROMPT },
    { role: "user", content: `Identify this PDF. Extracted text:\n\n${text}` },
  ], 1500);
  try {
    rawReply = await describeCall();
    if (!rawReply.trim()) {
      console.log("[vault] empty describe reply, retrying once");
      rawReply = await describeCall();
    }
    analysis = extractAnalysis(rawReply, fileName);
  } catch (err) {
    console.error("describe failed:", err.message, "| raw:", rawReply.slice(0, 300));
    await fs.rm(stagingPath, { force: true });
    await sendText(from, "I couldn't analyze that PDF right now. Please try again in a bit.");
    return;
  }

  sessions.set(from, { stage: "awaiting-note", stagingPath, fileName, sha, analysis, updatedAt: Date.now() });
  console.log(`[vault] analyzed for=${from} title="${analysis.title}"`);
  await sendText(from, `Here's what I found:\n*${analysis.title || "Untitled document"}*\n${analysis.description}\n\nWant to add any extra note for finding it later? (e.g. “mom's policy”) — or reply SKIP.`);
}

async function handleNote(from, text, sess) {
  if (text.toLowerCase() !== "skip") {
    sess.analysis.note = text.slice(0, 300);
    const extra = tokensOf(text);
    sess.analysis.keywords = [...new Set([...(sess.analysis.keywords || []), ...extra])].slice(0, 14);
  }
  sess.stage = "awaiting-confirm";
  sess.updatedAt = Date.now();
  sessions.set(from, sess);
  await sendText(from, `*${sess.analysis.title || "Untitled document"}*\n${sess.analysis.description}${sess.analysis.note ? `\nNote: ${sess.analysis.note}` : ""}\n\nSave this to DocuVault? Reply YES or NO.`);
}

async function handleConfirm(from, text, sess) {
  const lower = text.toLowerCase();
  if (!/^(yes|y|save|no|n|cancel)$/.test(lower)) {
    await sendText(from, "Please reply YES to save or NO to discard.");
    return;
  }
  if (/^(no|n|cancel)$/.test(lower)) {
    sessions.delete(from);
    await fs.rm(sess.stagingPath, { force: true }).catch(() => {});
    await sendText(from, "Discarded — not saved. Send another PDF anytime.");
    return;
  }
  try {
    const buf = await fs.readFile(sess.stagingPath);
    const id = nextDocId(from);
    const objectName = `${from}/${sess.sha}.pdf`;
    await backend.put(objectName, buf);
    docsFor(from).push({
      id, objectName, sha: sess.sha,
      title: sess.analysis.title || "Untitled document",
      description: sess.analysis.description || "Untitled document",
      keywords: sess.analysis.keywords || [],
      docType: sess.analysis.docType || "other",
      org: sess.analysis.org || null,
      year: sess.analysis.year || null,
      note: sess.analysis.note || null,
      fileName: sess.fileName, savedAt: new Date().toISOString(),
    });
    await saveMeta();
    await fs.rm(sess.stagingPath, { force: true }).catch(() => {});
    sessions.delete(from);
    console.log(`[vault] saved ${id} for=${from}`);
    await sendText(from, `Saved to DocuVault ✅\n*${sess.analysis.title || "Untitled document"}*\n${sess.analysis.description}\nStored on ${fmtDate(new Date().toISOString())}.\n\nLater, just ask — e.g. “give me my ${sess.analysis.docType} from ${sess.analysis.year || "that year"}”.`);
  } catch (err) {
    console.error("save failed:", err);
    await sendText(from, "Couldn't save that right now (storage hiccup). Your file is staged — reply YES to retry or NO to discard.");
  }
}

// ---- Webhook ----
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log(`[http] GET /webhook mode=${mode} token=${token}`);
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || seen.has(msg.id)) return;
    seen.add(msg.id);
    const from = msg.from;
    console.log(`[in] ${new Date().toISOString()} from=${from} type=${msg.type}`);

    if (msg.type === "text" && msg.text?.body) {
      console.log(`[in] text="${msg.text.body.slice(0, 120)}"`);
      await handleTextMessage(from, msg.text.body);
      return;
    }
    if (msg.type === "document") {
      await handleDocumentMessage(from, msg);
      return;
    }
    // Interactive replies (numbered disambiguation may arrive as button/list replies)
    if (msg.type === "interactive") {
      const reply = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
      if (reply) {
        await handleTextMessage(from, reply);
        return;
      }
    }
    await sendText(from, "DocuVault here — send me a PDF to store, or describe a saved document and I'll fetch it. Reply HELP for options.");
  } catch (err) {
    console.error("webhook error:", err);
  }
});

// ---- Signup: sends a WhatsApp welcome (hello_world template) to a new number ----
app.post("/signup", async (req, res) => {
  const phone = normPhone(req.body?.from);
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!phone) return res.status(400).json({ error: "invalid phone (10-15 digits)" });
  const welcome = `🎉 Hi${name ? " " + name : ""}! Welcome to *DocuVault* 📄\nYour AI Document Store — send any PDF and I'll keep it safe.\n\n📌 *How it works:*\n1️⃣ Send a PDF → I'll describe it\n2️⃣ Reply *YES* to save it\n3️⃣ Ask anytime — e.g. "give me my health report from 2025"\n\nType *HELP* for options. Happy storing! 🗂️`;
  // Idempotency: ignore repeat signups within 2 minutes (double-taps, retries)
  try {
    const arr = JSON.parse(await fs.readFile(path.join(VAULT_DIR, "signups.json"), "utf8"));
    const last = arr.filter((s) => s.phone === phone).pop();
    if (last && Date.now() - new Date(last.at).getTime() < 120000) return res.json({ ok: true });
  } catch {}
  // Exactly ONE message: plain text when possible, else a single template (never both)
  if (await sendText(phone, welcome)) return doneSignup(res, phone, name);
  const tpl = { name: WT, language: { code: "en_US" } };
  if (WT !== "hello_world") tpl.components = [{ type: "body", parameters: [{ type: "text", text: name || "there" }] }];
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "template", template: tpl }),
  });
  if (!r.ok) {
    const errText = await r.text();
    console.error("signup send failed:", r.status, errText);
    if (errText.includes("131030"))
      return res.status(502).json({ error: "That number isn't registered as a test recipient yet — add it in Meta → WhatsApp → API Setup (you'll get an OTP there), then sign up again." });
    return res.status(502).json({ error: "could not message that number right now" });
  }
  return doneSignup(res, phone, name);
});

async function doneSignup(res, phone, name) {
  try {
    const f = path.join(VAULT_DIR, "signups.json");
    let arr = [];
    try { arr = JSON.parse(await fs.readFile(f, "utf8")); } catch {}
    arr.push({ phone, name: name || null, at: new Date().toISOString() });
    await fs.writeFile(f, JSON.stringify(arr, null, 2));
  } catch {}
  console.log(`[signup] welcome sent to=${phone} name="${name}"`);
  res.json({ ok: true });
}

// ---- UI login: OTP over WhatsApp + stateless HMAC session tokens ----
if (!SESSION_SECRET) console.warn("WARNING: SESSION_SECRET not set — UI logins will die on restart. Set it in .env.");
const otps = new Map(); // phone -> { code, exp, attempts, lastReq }
const OTP_TTL_MS = 3 * 60 * 1000;
const OTP_REQ_GAP_MS = 30 * 1000;
const UI_TTL_MS = 24 * 3600 * 1000;

function normPhone(s) {
  const digits = String(s || "").replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
function signToken(phone, exp) {
  return crypto.createHmac("sha256", SESSION_SECRET || "ephemeral").update(`${phone}|${exp}`).digest("hex");
}
// Token format: phone.exp.sig — bound to the phone, so ?from= must match.
function authPhone(req) {
  try {
    const raw = String(req.headers["x-authtoken"] || req.query.token || "");
    const [phone, expStr, sig] = raw.split(".");
    const exp = parseInt(expStr, 10);
    if (!phone || !exp || !sig || exp < Date.now()) return null;
    const want = signToken(phone, exp);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    const claimed = normPhone(req.query.from || req.body?.from);
    if (claimed && claimed !== phone) return null;
    return phone;
  } catch { return null; }
}

app.post("/otp/request", async (req, res) => {
  const phone = normPhone(req.body?.from);
  if (!phone) return res.status(400).json({ error: "invalid phone (10-15 digits)" });
  const prev = otps.get(phone);
  if (prev && Date.now() - prev.lastReq < OTP_REQ_GAP_MS)
    return res.status(429).json({ error: "code just sent — wait 30 seconds before retrying" });
  const code = String(crypto.randomInt(1000, 10000));
  const exp = Date.now() + OTP_TTL_MS;
  otps.set(phone, { code, exp, attempts: 0, lastReq: Date.now() });
  try {
    await sendText(phone, `Your DocuVault login code is ${code}. Valid 3 minutes. Never share it.`);
    console.log(`[otp] code sent to=${phone}`);
    res.json({ ok: true, exp });
  } catch (err) {
    console.error("otp send failed:", err.message);
    res.status(502).json({ error: "could not send code via WhatsApp — is this number registered?" });
  }
});

app.post("/otp/verify", (req, res) => {  const phone = normPhone(req.body?.from);
  const code = String(req.body?.code || "").trim();
  const rec = phone ? otps.get(phone) : null;
  if (!rec) return res.status(400).json({ error: "no code requested — request one first" });
  if (rec.exp < Date.now()) { otps.delete(phone); return res.status(400).json({ error: "code expired — request a new one" }); }
  rec.attempts += 1;
  if (rec.attempts > 5) { otps.delete(phone); return res.status(429).json({ error: "too many tries — request a new code" }); }
  if (rec.code !== code) return res.status(401).json({ error: "wrong code" });
  otps.delete(phone);
  const exp = Date.now() + UI_TTL_MS;
  res.json({ ok: true, token: `${phone}.${exp}.${signToken(phone, exp)}`, exp });
});

// Simple JSON listing for the DocuVault web UI (auth required)
app.get("/docs", (req, res) => {
  const phone = authPhone(req);
  if (!phone) return res.status(401).json({ error: "login required" });
  res.json({ docs: docsFor(phone) });
});

// Serve a saved PDF (auth required; inline view by default, attachment with ?download=1)
app.get("/pdf", async (req, res) => {
  try {
    const phone = authPhone(req);
    if (!phone) return res.status(401).send("login required");
    const id = String(req.query.id || "").toUpperCase();
    if (!id) return res.status(400).send("pass ?id=DV-0001");
    const entry = docsFor(phone).find((d) => d.id === id);
    if (!entry) return res.status(404).send("document not found");
    const bytes = await backend.get(entry.objectName);
    const safeName = `${(entry.title || entry.id).replace(/[^a-z0-9]+/gi, "_").slice(0, 60) || entry.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${safeName}"`);
    res.send(bytes);
  } catch (err) {
    console.error("pdf serve failed:", err.message);
    res.status(500).send("could not fetch file");
  }
});

await fs.mkdir(OBJECTS_DIR, { recursive: true });
await loadMeta();
try {
  await initStorage();
} catch (err) {
  console.error("storage init failed, staying on local:", err.message);
  backend = LocalBackend;
}
app.listen(PORT, "0.0.0.0", () => {
  console.log(`DocuVault server listening on http://0.0.0.0:${PORT}`);
  console.log(`Public webhook: ${PUBLIC_BASE_URL.replace(/\/$/, "")}/webhook`);
  console.log(`Webhook: /webhook  (LLM: ${CONF.mode} -> ${CONF.url}, model ${CONF.model} | storage: ${STORAGE_BACKEND})`);
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) console.warn("WARNING: WHATSAPP_TOKEN / PHONE_NUMBER_ID not set — sends will fail.");
  if (!VERIFY_TOKEN || VERIFY_TOKEN === "change-me") console.warn("WARNING: VERIFY_TOKEN is default — Meta verification will accept 'change-me'. Set a real token in .env.");
});
