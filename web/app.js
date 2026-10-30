// Real-time contract review PoC - browser side.
//
// The viewer connects to Document Engine with the JWT of the selected user
// (`instant: true`). Annotations and comment threads are synced live between
// every browser that has the document open. What each user may do comes from
// the collaboration permissions in their JWT. The review status comes from the
// Node server and is pushed with server-sent events.

const state = { user: null, users: [], session: null, instance: null };

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STATUS_LABELS = { pending: "Pending", approved: "Approved", changes_requested: "Changes requested", in_review: "In review" };

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.session) headers.Authorization = `Bearer ${state.session.jwt}`;
  const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// ---------------------------------------------------------------------------
// User picker
// ---------------------------------------------------------------------------

async function init() {
  const { users, document: doc } = await api("/api/users");
  state.users = users;
  $("doc-title").textContent = doc.title;
  const requested = new URLSearchParams(location.search).get("user");
  let remembered = null;
  try {
    remembered = localStorage.getItem("review-user");
  } catch {
    // storage blocked: fall back to the first user
  }
  const userId = users.some((u) => u.id === requested) ? requested : users.some((u) => u.id === remembered) ? remembered : users[0].id;

  const select = $("user-select");
  select.innerHTML = users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)} - ${escapeHtml(u.roleLabel)}</option>`).join("");
  select.value = userId;
  // Switching user signs in again with a new JWT: reload with ?user=.
  select.addEventListener("change", () => {
    const url = new URL(location.href);
    url.searchParams.set("user", select.value);
    location.href = url.toString();
  });
  try {
    localStorage.setItem("review-user", userId);
  } catch {
    // ignore
  }

  state.session = await api("/api/session", { method: "POST", body: JSON.stringify({ userId }) });
  state.user = state.session.user;
  renderMe();
  listenToReviews();
  await loadViewer();
}

function renderMe() {
  const u = state.user;
  $("me").innerHTML = `
    <div class="me-name">${escapeHtml(u.name)}</div>
    <div class="me-title">${escapeHtml(u.title)} <span class="role role-${u.role}">${escapeHtml(u.roleLabel)}</span></div>
    <ul class="perms">${u.summary.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
  $("review-form").hidden = !u.reviewer;
  $("author-tools").hidden = u.role !== "author";
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

async function loadViewer() {
  const { session } = state;
  const hidden = new Set(["document-editor", "document-crop", "export-pdf", "signature", "image", "link", "multi-annotations-selection"]);
  const toolbarItems = [];
  for (const item of NutrientViewer.defaultToolbarItems) {
    if (hidden.has(item.type)) continue;
    toolbarItems.push(item);
    // The comment tool places a comment marker anywhere on the page.
    if (item.type === "note") toolbarItems.push({ type: "comment" });
  }

  const instance = await NutrientViewer.load({
    container: "#viewer",
    serverUrl: session.serverUrl,
    documentId: session.documentId,
    authPayload: { jwt: session.jwt },
    instant: true,
    licenseKey: session.licenseKey || undefined,
    // Viewer assets (WebAssembly, fonts, translations) from the same CDN version as the script tag.
    baseUrl: "https://cdn.cloud.pspdfkit.com/pspdfkit-web@1.24.0/",
    toolbarItems,
    initialViewState: new NutrientViewer.ViewState({
      commentDisplay: NutrientViewer.CommentDisplay.FLOATING,
    }),
  });
  state.instance = instance;
  window.reviewInstance = instance; // handy in the console and for the sync test

  // Display name on new annotations and comments. Permissions do not rely on
  // it: Document Engine uses the user_id of the JWT as the creator.
  instance.setAnnotationCreatorName(state.user.name);

  instance.addEventListener("comments.change", renderThreads);
  instance.addEventListener("annotations.change", renderThreads);
  instance.addEventListener("instant.connectedClients.change", renderPresence);
  renderPresence(instance.connectedClients);
  renderThreads();
}

function renderPresence(clients) {
  const ids = new Set([...clients.values()].map((c) => c.userId).filter(Boolean));
  const chips = state.users
    .filter((u) => ids.has(u.id))
    .map((u) => `<span class="chip${u.id === state.user.id ? " self" : ""}" title="${escapeHtml(u.roleLabel)}">${escapeHtml(u.name)}</span>`);
  $("presence").innerHTML = chips.length ? `<span class="muted">Online</span> ${chips.join("")}` : "";
}

const plainText = (text) => {
  const value = typeof text === "string" ? text : text?.value ?? "";
  const div = document.createElement("div");
  div.innerHTML = value;
  return div.textContent.trim();
};

let renderQueued = false;
function renderThreads() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(async () => {
    renderQueued = false;
    const instance = state.instance;
    if (!instance) return;
    const comments = (await instance.getComments()).toArray();
    const threads = new Map();
    for (const c of comments) {
      if (!threads.has(c.rootId)) threads.set(c.rootId, []);
      threads.get(c.rootId).push(c);
    }
    const list = [...threads.entries()]
      .map(([rootId, items]) => {
        items.sort((a, b) => a.createdAt - b.createdAt);
        return { rootId, items, pageIndex: items[0].pageIndex };
      })
      .sort((a, b) => a.pageIndex - b.pageIndex || a.items[0].createdAt - b.items[0].createdAt);
    $("thread-count").textContent = list.length ? `(${list.length})` : "";
    $("threads").innerHTML = list.length
      ? list
          .map(({ rootId, items, pageIndex }) => {
            const first = items[0];
            const replies = items.length - 1;
            return `<li data-root="${escapeHtml(rootId)}" data-page="${pageIndex}">
              <div class="thread-meta">${escapeHtml(first.creatorName || "Unknown")} - page ${pageIndex + 1}${replies ? ` - ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}</div>
              <div class="thread-text">${escapeHtml(plainText(first.text))}</div>
            </li>`;
          })
          .join("")
      : `<li class="empty">No comments yet.${state.user.canWrite ? " Select text and choose Comment, or use the comment tool." : ""}</li>`;
    for (const li of $("threads").querySelectorAll("li[data-root]")) {
      li.addEventListener("click", () => openThread(li.dataset.root, Number(li.dataset.page)));
    }
  }, 50);
}

// Opens a comment thread: jump to its root annotation and select it.
async function openThread(rootId, pageIndex) {
  const instance = state.instance;
  const annotations = await instance.getAnnotations(pageIndex);
  const root = annotations.find((a) => a.id === rootId);
  if (!root) return;
  instance.jumpToRect(pageIndex, root.boundingBox);
  instance.setSelectedAnnotations(NutrientViewer.Immutable.List([rootId]));
}

// ---------------------------------------------------------------------------
// Review status
// ---------------------------------------------------------------------------

function listenToReviews() {
  const source = new EventSource("/api/reviews/stream");
  source.addEventListener("reviews", (e) => renderReviews(JSON.parse(e.data)));
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function renderReviews(summary) {
  $("overall").innerHTML = `Contract: <span class="badge status-${summary.overall}">${STATUS_LABELS[summary.overall]}</span>`;
  $("reviews").innerHTML = summary.reviews
    .map(
      (r) => `<li class="${r.userId === state.user?.id ? "mine" : ""}">
        <div class="review-head">
          <span>${escapeHtml(r.name)} <span class="muted">${escapeHtml(r.roleLabel)}</span></span>
          <span class="badge status-${r.status}">${STATUS_LABELS[r.status]}</span>
        </div>
        ${r.note ? `<div class="review-note">${escapeHtml(r.note)}</div>` : ""}
        ${r.updatedAt ? `<div class="muted small">${formatTime(r.updatedAt)}</div>` : ""}
      </li>`
    )
    .join("");
  const mine = summary.reviews.find((r) => r.userId === state.user?.id);
  if (mine && document.activeElement !== $("review-note")) $("review-note").value = mine.note || "";
}

for (const button of document.querySelectorAll("#review-form button")) {
  button.addEventListener("click", async () => {
    try {
      await api("/api/reviews/me", {
        method: "PUT",
        body: JSON.stringify({ status: button.dataset.status, note: $("review-note").value }),
      });
    } catch (err) {
      alert(err.message);
    }
  });
}

$("panel-btn").addEventListener("click", () => {
  const hidden = $("layout").classList.toggle("panel-hidden");
  $("panel-btn").textContent = hidden ? "Show panel" : "Hide panel";
});

$("reset-btn").addEventListener("click", async () => {
  if (!confirm("Delete every annotation and comment and set all reviews back to pending?")) return;
  try {
    await api("/api/reset", { method: "POST" });
  } catch (err) {
    alert(err.message);
  }
});

init().catch((err) => {
  console.error(err);
  $("viewer").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
});
