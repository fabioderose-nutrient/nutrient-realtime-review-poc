// End-to-end check of the real-time review with several browsers.
//
// Each user runs in its own Playwright browser context (separate cookies and
// storage, like separate computers). The script checks that a comment thread
// started by one reviewer appears live in the other reviewer's browser, that
// a reply typed in the comment UI comes back, that the collaboration
// permissions of each role hold, and that review status changes are pushed to
// every browser.
//
//   node live-sync.mjs                 run the checks
//   node live-sync.mjs --screenshots   also write docs/screenshots/*.png
//
// The app (server/) and Document Engine must be running. The script starts a
// new review round first: it deletes every annotation on the document.

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const BASE = process.env.APP_URL || `http://localhost:${process.env.APP_PORT || 4310}`;
const SHOTS = process.argv.includes("--screenshots") ? join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots") : null;

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function post(path, body, jwt) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function openAs(browser, userId, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${userId}] page error: ${e.message}`));
  await page.goto(`${BASE}/?user=${userId}`);
  await page.waitForFunction(() => window.reviewInstance, null, { timeout: 90000 });
  return page;
}

// Polls a function in the page until it returns a truthy value. Returns the
// elapsed time in ms, or -1 on timeout.
async function waitInPage(page, fn, arg, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn, arg)) return Date.now() - start;
    await page.waitForTimeout(50);
  }
  return -1;
}

const threadHasComments = async ({ rootId, count }) =>
  (await window.reviewInstance.getComments()).filter((c) => c.rootId === rootId).size >= count;

// Starts a comment thread on a phrase: a highlight marked as thread root plus
// the first comment, created together and saved to Document Engine.
async function startThread(page, phrase, text) {
  return page.evaluate(
    async ({ phrase, text }) => {
      const instance = window.reviewInstance;
      const hit = (await instance.search(phrase)).first();
      const rootId = NutrientViewer.generateInstantId();
      const highlight = new NutrientViewer.Annotations.HighlightAnnotation({
        id: rootId,
        pageIndex: hit.pageIndex,
        rects: hit.rectsOnPage,
        boundingBox: NutrientViewer.Geometry.Rect.union(hit.rectsOnPage),
        isCommentThreadRoot: true,
      });
      const comment = new NutrientViewer.Comment({ rootId, pageIndex: hit.pageIndex, text: { format: "plain", value: text } });
      await instance.ensureChangesSaved(await instance.create([highlight, comment]));
      return rootId;
    },
    { phrase, text }
  );
}

// Replies through the viewer UI, the way a user does: open the thread from
// the panel, type in the comment editor, press Save.
async function replyInUi(page, rootId, text) {
  await page.click(`#threads li[data-root="${rootId}"]`);
  const editor = page.locator('[contenteditable="true"][aria-label="Editing Area"]');
  await editor.click();
  await editor.pressSequentially(text, { delay: 5 });
  await page.locator('.PSPDFKit-Container button[aria-label="Save"]').click();
}

async function rootFlags(page, rootId) {
  return page.evaluate(async (rootId) => {
    const instance = window.reviewInstance;
    for (let p = 0; p < instance.totalPageCount; p++) {
      const a = (await instance.getAnnotations(p)).find((x) => x.id === rootId);
      if (a) return { isEditable: a.isEditable, isDeletable: a.isDeletable, canReply: a.canReply, creatorName: a.creatorName };
    }
    return null;
  }, rootId);
}

// Tries to change and to delete an annotation; returns what was refused.
async function tryToModify(page, rootId) {
  return page.evaluate(async (rootId) => {
    const instance = window.reviewInstance;
    let annotation = null;
    for (let p = 0; p < instance.totalPageCount && !annotation; p++) {
      annotation = (await instance.getAnnotations(p)).find((x) => x.id === rootId);
    }
    const result = {};
    try {
      await instance.ensureChangesSaved(await instance.update(annotation.set("color", NutrientViewer.Color.RED)));
      result.update = "accepted";
    } catch (e) {
      result.update = `refused: ${e?.message ?? e}`;
    }
    try {
      await instance.ensureChangesSaved(await instance.delete(rootId));
      result.delete = "accepted";
    } catch (e) {
      result.delete = `refused: ${e?.message ?? e}`;
    }
    return result;
  }, rootId);
}

// Creates a note through the API, which bypasses the read-only toolbar. The
// viewer adds it locally, then Document Engine refuses to store it.
async function tryToCreateNote(page) {
  return page.evaluate(async () => {
    const instance = window.reviewInstance;
    const note = new NutrientViewer.Annotations.NoteAnnotation({
      pageIndex: 0,
      text: { format: "plain", value: "Observer note" },
      boundingBox: new NutrientViewer.Geometry.Rect({ left: 40, top: 40, width: 32, height: 32 }),
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("not saved after 5 s")), 5000));
    try {
      await Promise.race([instance.create(note).then((created) => instance.ensureChangesSaved(created)), timeout]);
      return "saved";
    } catch (e) {
      return `not saved: ${e.message ?? e}`;
    }
  });
}

const hasObserverNote = async () =>
  (await window.reviewInstance.getAnnotations(0)).some((a) => a.text?.value === "Observer note");

async function reviewText(page, name) {
  return page.locator("#reviews li", { hasText: name }).locator(".badge").innerText();
}

// ---------------------------------------------------------------------------

const author = await post("/api/session", { userId: "elena" });
const reset = await post("/api/reset", {}, author.jwt);
console.log(`New review round: ${reset.deletedAnnotations} annotations deleted, reviews reset.`);

const browser = await chromium.launch();
const side = { width: 1100, height: 880 };
const legal = await openAs(browser, "daniel", side);
const finance = await openAs(browser, "priya", side);

// Presence: each browser lists the other user as online (Instant connected clients).
const presence = await waitInPage(legal, () => document.querySelector("#presence")?.textContent.includes("Priya Raman"));
check("Legal reviewer sees the finance reviewer online", presence >= 0);

// 1. Daniel (legal) starts a thread on the liability cap.
const legalText =
  "Liability cap of 150% of annual fees is above our standard. Please align it with the template: 100% of the fees paid in the previous 12 months.";
const rootId = await startThread(legal, "150% of the fees paid or payable in that year", legalText);
const seenByFinance = await waitInPage(finance, threadHasComments, { rootId, count: 1 });
check("Thread started by the legal reviewer appears in the finance reviewer's browser", seenByFinance >= 0, `${seenByFinance} ms after save`);
const listedByFinance = await waitInPage(finance, (id) => !!document.querySelector(`#threads li[data-root="${id}"]`), rootId);
check("Thread appears in the finance reviewer's thread list", listedByFinance >= 0);

// 2. Priya (finance) replies in the comment UI.
const financeText = "Agreed from finance. 100% of annual fees still covers the maximum Service Credits of 25% per month.";
await replyInUi(finance, rootId, financeText);
const replySeen = await waitInPage(legal, threadHasComments, { rootId, count: 2 });
check("Reply typed by the finance reviewer appears in the legal reviewer's browser", replySeen >= 0, `${replySeen} ms`);
const replyAuthor = await legal.evaluate(
  async (id) => (await window.reviewInstance.getComments()).filter((c) => c.rootId === id).sortBy((c) => c.createdAt).last()?.creatorName,
  rootId
);
check("Reply carries the finance reviewer's name", replyAuthor === "Priya Raman", replyAuthor);

// 3. Priya starts her own thread on the payment terms.
const paymentRoot = await startThread(finance, "within 45 days of receipt", "45 days is acceptable if the 6% cap on yearly increases in 3.4 stays.");
const paymentSeen = await waitInPage(legal, threadHasComments, { rootId: paymentRoot, count: 1 });
check("Second thread syncs the other way", paymentSeen >= 0, `${paymentSeen} ms`);

// 4. Permissions from the JWT.
const financeOnLegal = await rootFlags(finance, rootId);
check(
  "Reviewer cannot edit or delete another reviewer's annotation, but can reply",
  financeOnLegal && !financeOnLegal.isEditable && !financeOnLegal.isDeletable && financeOnLegal.canReply,
  JSON.stringify(financeOnLegal)
);
const financeOnOwn = await rootFlags(finance, paymentRoot);
check("Reviewer can edit and delete their own annotation", financeOnOwn?.isEditable && financeOnOwn?.isDeletable, JSON.stringify(financeOnOwn));
const attempt = await tryToModify(finance, rootId);
check("Changing or deleting another reviewer's annotation is refused", attempt.update.startsWith("refused") && attempt.delete.startsWith("refused"), JSON.stringify(attempt));
const stillThere = await rootFlags(legal, rootId);
check("The legal reviewer's highlight is unchanged", !!stillThere);

const observer = await openAs(browser, "tom", { width: 1440, height: 900 });
const observerSees = await waitInPage(observer, threadHasComments, { rootId, count: 2 });
check("Observer sees the thread with its reply", observerSees >= 0);
const observerFlags = await rootFlags(observer, rootId);
check("Observer cannot edit, delete or reply", observerFlags && !observerFlags.isEditable && !observerFlags.isDeletable && !observerFlags.canReply, JSON.stringify(observerFlags));
const refusals = [];
observer.on("response", (r) => r.status() === 403 && refusals.push(r.url()));
const observerCreate = await tryToCreateNote(observer);
check("Document Engine refuses an annotation pushed by the observer", observerCreate.startsWith("not saved") && refusals.length > 0, `${observerCreate}, ${refusals.length} HTTP 403`);
check("Observer has no review buttons", await observer.locator("#review-form").isHidden());

const authorPage = await openAs(browser, "elena", { width: 1440, height: 900 });
await waitInPage(authorPage, threadHasComments, { rootId, count: 2 });
check("The observer's note never reaches the author's browser", !(await authorPage.evaluate(hasObserverNote)));
await observer.reload();
await observer.waitForFunction(() => window.reviewInstance, null, { timeout: 90000 });
await waitInPage(observer, threadHasComments, { rootId, count: 2 });
check("The observer's note is gone after a reload: it was never stored", !(await observer.evaluate(hasObserverNote)));
const authorFlags = await rootFlags(authorPage, rootId);
check("Author can edit, delete and reply to every annotation", authorFlags?.isEditable && authorFlags?.isDeletable && authorFlags?.canReply, JSON.stringify(authorFlags));

// 5. Review status, pushed to every browser.
await legal.fill("#review-note", "Liability cap must come down to 100% of annual fees (clause 5.2).");
await legal.click('#review-form button[data-status="changes_requested"]');
const changesSeen = await waitInPage(finance, () => document.querySelector("#reviews")?.textContent.includes("Changes requested"));
check("Request for changes appears live in the finance reviewer's browser", changesSeen >= 0, `${changesSeen} ms`);
await finance.fill("#review-note", "Fees and payment terms approved.");
await finance.click('#review-form button[data-status="approved"]');
const approvedSeen = await waitInPage(legal, () => /Priya Raman[\s\S]*Approved/.test(document.querySelector("#reviews")?.textContent ?? ""));
check("Approval appears live in the legal reviewer's browser", approvedSeen >= 0, `${approvedSeen} ms`);
await waitInPage(authorPage, () => document.querySelector("#overall")?.textContent.includes("Changes requested"));
check("Author sees the contract status", (await authorPage.locator("#overall").innerText()).includes("Changes requested"));
check("Author sees each reviewer's status", (await reviewText(authorPage, "Daniel Okafor")) === "Changes requested" && (await reviewText(authorPage, "Priya Raman")) === "Approved");
const observerReview = await fetch(`${BASE}/api/reviews/me`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${(await post("/api/session", { userId: "tom" })).jwt}` },
  body: JSON.stringify({ status: "approved" }),
});
check("Server refuses a review from the observer", observerReview.status === 403, `HTTP ${observerReview.status}`);

// 6. Screenshots.
if (SHOTS) {
  const { mkdirSync } = await import("fs");
  mkdirSync(SHOTS, { recursive: true });
  for (const page of [legal, finance, authorPage, observer]) {
    await page.click(`#threads li[data-root="${rootId}"]`);
    await page.evaluate(() => {
      document.activeElement?.blur();
      document.getElementById("panel").scrollTop = 0;
    });
    await page.mouse.move(5, 300);
  }
  // Side by side: the two reviewers with the review panel hidden, at 100% zoom.
  for (const page of [legal, finance]) {
    await page.click("#panel-btn");
    await page.evaluate(() => window.reviewInstance.setViewState((v) => v.set("zoom", 1)));
    // openThread() is the app function behind a click in the thread list.
    await page.evaluate((id) => openThread(id, Number(document.querySelector(`#threads li[data-root="${id}"]`).dataset.page)), rootId);
  }
  await legal.waitForTimeout(2500);
  // The two reviewers side by side, scaled into one 1600 px wide image.
  const [left, right] = await Promise.all([legal.screenshot(), finance.screenshot()]);
  const composer = await browser.newPage({ viewport: { width: 1600, height: Math.round((side.height * 799) / side.width) } });
  await composer.setContent(`<body style="margin:0;display:flex;background:#9aa0aa;gap:2px">
    <img style="width:799px" src="data:image/png;base64,${left.toString("base64")}">
    <img style="width:799px" src="data:image/png;base64,${right.toString("base64")}"></body>`);
  await composer.screenshot({ path: join(SHOTS, "01-two-reviewers-live.png") });
  await authorPage.screenshot({ path: join(SHOTS, "02-author-review-status.png") });
  await observer.screenshot({ path: join(SHOTS, "03-observer-read-only.png") });
  console.log(`Screenshots written to ${SHOTS}`);
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
