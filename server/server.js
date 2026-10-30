// Real-time contract review PoC - Node server.
//
// - Uploads the sample contract to Nutrient Document Engine once.
// - Signs one JWT per demo user. The JWT carries the user id and the
//   Document Engine collaboration permissions of the user's role, so
//   Document Engine itself enforces who may view, edit, delete and reply.
// - Stores the review status of each reviewer (approve / request changes)
//   and pushes every change to the open browsers with server-sent events.
//
// Annotations and comments never pass through this server: the browsers sync
// them with Document Engine directly through Nutrient Instant.

import express from "express";
import jwt from "jsonwebtoken";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PORT = Number(process.env.APP_PORT || 4310);
const DOCUMENT_ENGINE_PORT = process.env.DOCUMENT_ENGINE_PORT || "5310";
// URL the server uses for the Document Engine API.
const DE_URL = process.env.DE_URL || `http://localhost:${DOCUMENT_ENGINE_PORT}`;
// URL the browser uses to reach Document Engine (Instant sync).
const DE_EXTERNAL_URL = process.env.DE_EXTERNAL_URL || `http://localhost:${DOCUMENT_ENGINE_PORT}`;
// Written to keys/app.env by scripts/generate-keys.sh.
const API_TOKEN = process.env.DE_API_TOKEN;
if (!API_TOKEN) {
  console.error("DE_API_TOKEN is not set: run scripts/generate-keys.sh, then npm start.");
  process.exit(1);
}
// Web SDK license key. Empty = evaluation mode.
const WEB_SDK_LICENSE_KEY = process.env.WEB_SDK_LICENSE_KEY || "";
const JWT_PRIVATE_KEY = readFileSync(process.env.JWT_PRIVATE_KEY_PATH || join(ROOT, "keys", "jwt-private.pem"), "utf8");
const JWT_PUBLIC_KEY = readFileSync(process.env.JWT_PUBLIC_KEY_PATH || join(ROOT, "keys", "jwt-public.pem"), "utf8");

const DOCUMENT_ID = "master-services-agreement";
const DOCUMENT_FILE = join(ROOT, "documents", "master-services-agreement.pdf");
const DOCUMENT_TITLE = "Master Services Agreement (draft v0.4)";
const REVIEWS_FILE = join(ROOT, "data", "reviews.json");

// ---------------------------------------------------------------------------
// Roles and users
// ---------------------------------------------------------------------------

// `permissions` grants document access. "write" is what allows creating
// annotations and comments at all. `collaboration` holds the Document Engine
// collaboration permissions (<content type>:<action>:<scope>): with them set,
// everything that is not listed is denied.
const ROLES = {
  author: {
    label: "Author",
    reviewer: false,
    permissions: ["read-document", "write", "download"],
    collaboration: [
      "annotations:view:all",
      "annotations:edit:all",
      "annotations:delete:all",
      "comments:view:all",
      "comments:edit:all",
      "comments:delete:all",
      "comments:reply:all",
    ],
    summary: [
      "Sees every annotation and comment",
      "Edits and deletes anyone's annotations and comments",
      "Replies to every thread",
      "Reads the review status of each reviewer",
    ],
  },
  reviewer: {
    label: "Reviewer",
    reviewer: true,
    permissions: ["read-document", "write"],
    collaboration: [
      "annotations:view:all",
      "annotations:edit:self",
      "annotations:delete:self",
      "comments:view:all",
      "comments:edit:self",
      "comments:delete:self",
      "comments:reply:all",
    ],
    summary: [
      "Sees every annotation and comment",
      "Adds annotations and comment threads",
      "Edits and deletes only their own annotations and comments",
      "Replies to every thread",
      "Approves the contract or requests changes",
    ],
  },
  observer: {
    label: "Observer",
    reviewer: false,
    permissions: ["read-document"],
    collaboration: ["annotations:view:all", "comments:view:all"],
    summary: ["Sees every annotation and comment", "Cannot add, change, delete or reply"],
  },
};

// Fictitious users. `id` becomes the JWT user_id, so Document Engine records
// it as the creator of everything the user adds.
const USERS = [
  { id: "elena", name: "Elena Marsh", title: "Head of Procurement", role: "author" },
  { id: "daniel", name: "Daniel Okafor", title: "Legal counsel", role: "reviewer", area: "Legal" },
  { id: "priya", name: "Priya Raman", title: "Finance manager", role: "reviewer", area: "Finance" },
  { id: "tom", name: "Tom Lindqvist", title: "Internal audit", role: "observer" },
];

function publicUser(user) {
  const role = ROLES[user.role];
  const roleLabel = user.area ? `${user.area} reviewer` : role.label;
  return { ...user, roleLabel, reviewer: role.reviewer, canWrite: role.permissions.includes("write"), summary: role.summary };
}

const findUser = (id) => USERS.find((u) => u.id === id);

// ---------------------------------------------------------------------------
// Document Engine
// ---------------------------------------------------------------------------

async function de(path, options = {}) {
  return fetch(`${DE_URL}${path}`, {
    ...options,
    headers: { Authorization: `Token token=${API_TOKEN}`, ...(options.headers || {}) },
  });
}

async function waitForDocumentEngine() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetch(`${DE_URL}/healthcheck`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (attempt === 1) console.log(`[setup] Waiting for Document Engine at ${DE_URL} ...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Document Engine is not reachable at ${DE_URL}. Did you run docker compose up -d?`);
}

async function ensureDocument() {
  const info = await de(`/api/documents/${DOCUMENT_ID}/document_info`);
  if (info.ok) {
    console.log(`[setup] Document "${DOCUMENT_ID}" already in Document Engine.`);
    return;
  }
  const form = new FormData();
  form.append("file", new Blob([readFileSync(DOCUMENT_FILE)], { type: "application/pdf" }), "contract.pdf");
  form.append("document_id", DOCUMENT_ID);
  form.append("title", DOCUMENT_TITLE);
  const res = await de("/api/documents", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  console.log(`[setup] Uploaded "${DOCUMENT_ID}" to Document Engine.`);
}

// The viewer JWT. Document Engine verifies it with the public key from
// keys/document-engine.env and applies its permissions to every request and
// every Instant change of this user.
function signViewerToken(user) {
  const role = ROLES[user.role];
  return jwt.sign(
    {
      document_id: DOCUMENT_ID,
      user_id: user.id,
      permissions: role.permissions,
      collaboration_permissions: role.collaboration,
    },
    JWT_PRIVATE_KEY,
    { algorithm: "RS256", expiresIn: "8h" }
  );
}

// Reads the user back from a viewer JWT sent by the browser. The same token
// proves who is asking when a reviewer changes their review status.
function userFromRequest(req) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const claims = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] });
    return findUser(claims.user_id) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Review status, stored in data/reviews.json
// ---------------------------------------------------------------------------

const STATUSES = ["pending", "approved", "changes_requested"];

function loadReviews() {
  const saved = existsSync(REVIEWS_FILE) ? JSON.parse(readFileSync(REVIEWS_FILE, "utf8")) : {};
  return Object.fromEntries(
    USERS.filter((u) => ROLES[u.role].reviewer).map((u) => [u.id, saved[u.id] ?? { status: "pending", note: "", updatedAt: null }])
  );
}

let reviews = loadReviews();

function saveReviews() {
  mkdirSync(dirname(REVIEWS_FILE), { recursive: true });
  writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

function reviewSummary() {
  const list = Object.entries(reviews).map(([userId, review]) => {
    const user = publicUser(findUser(userId));
    return { userId, name: user.name, roleLabel: user.roleLabel, ...review };
  });
  let overall = "in_review";
  if (list.some((r) => r.status === "changes_requested")) overall = "changes_requested";
  else if (list.every((r) => r.status === "approved")) overall = "approved";
  return { overall, reviews: list };
}

// Server-sent events: every open browser gets the new review status at once.
const streams = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(payload);
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, "web")));

app.get("/api/users", (req, res) => {
  res.json({ users: USERS.map(publicUser), document: { id: DOCUMENT_ID, title: DOCUMENT_TITLE } });
});

// Signs in a demo user: returns the viewer configuration with that user's JWT.
// A real application would do this after its own authentication.
app.post("/api/session", (req, res) => {
  const user = findUser(req.body?.userId);
  if (!user) return res.status(404).json({ error: "Unknown user." });
  res.json({
    user: publicUser(user),
    jwt: signViewerToken(user),
    documentId: DOCUMENT_ID,
    serverUrl: `${DE_EXTERNAL_URL}/`,
    licenseKey: WEB_SDK_LICENSE_KEY,
  });
});

app.get("/api/reviews", (req, res) => res.json(reviewSummary()));

app.put("/api/reviews/me", (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Missing or invalid token." });
  if (!ROLES[user.role].reviewer) return res.status(403).json({ error: `${publicUser(user).roleLabel}s do not review.` });
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}.` });
  reviews[user.id] = { status, note: String(req.body?.note ?? "").slice(0, 500), updatedAt: new Date().toISOString() };
  saveReviews();
  const summary = reviewSummary();
  broadcast("reviews", summary);
  console.log(`[review] ${user.name}: ${status}`);
  res.json(summary);
});

app.get("/api/reviews/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`event: reviews\ndata: ${JSON.stringify(reviewSummary())}\n\n`);
  streams.add(res);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    streams.delete(res);
  });
});

// Starts the review again: deletes every annotation (comment threads go with
// their root annotation) and resets the review status. Author only.
app.post("/api/reset", async (req, res) => {
  const user = userFromRequest(req);
  if (!user || user.role !== "author") return res.status(403).json({ error: "Only the author can reset the review." });
  const list = await de(`/api/documents/${DOCUMENT_ID}/annotations`, { headers: { Accept: "application/json" } }).then((r) => r.json());
  const ids = (list?.data?.annotations ?? []).map((a) => a.id);
  for (const id of ids) await de(`/api/documents/${DOCUMENT_ID}/annotations/${id}`, { method: "DELETE" });
  reviews = Object.fromEntries(Object.keys(reviews).map((id) => [id, { status: "pending", note: "", updatedAt: null }]));
  saveReviews();
  broadcast("reviews", reviewSummary());
  console.log(`[reset] ${user.name} deleted ${ids.length} annotations and reset the review status.`);
  res.json({ deletedAnnotations: ids.length });
});

// Errors as JSON, for the browser and the test script.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: String(err.message || err) });
});

await waitForDocumentEngine();
await ensureDocument();
app.listen(PORT, () => console.log(`Real-time review PoC on http://localhost:${PORT}`));
