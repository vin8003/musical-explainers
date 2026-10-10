// Musical Explainers admin UI. Vanilla JS, no build step.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");

const S = {
  meta: { statuses: [], sceneKinds: [], modes: {} },
  route: { name: "videos" },
  video: null, // detail payload for the open video
  spec: null, // working copy in the spec editor
  specDirty: false,
  specRaw: false,
  logJobId: null,
  fresh: false,
};

// ---------- api ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}`;
  el.textContent = msg;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
}

// ---------- formatting ----------

const ago = (ms) => {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
const dur = (sec) => (sec == null ? "" : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`);
const elapsed = (a, b) => (a ? dur(((b ?? Date.now()) - a) / 1000) : "");

const STATUS_CLASS = { queued: "", scripting: "run", review: "hi", approved: "ok", scheduled: "ok", published: "ok", rejected: "bad", untracked: "warn" };
const pill = (text, cls = "", dot = false) => `<span class="pill ${cls}">${dot ? '<span class="dot"></span>' : ""}${esc(text)}</span>`;
const statusPill = (s) => pill(s, STATUS_CLASS[s] ?? "");

const STAGE_LABEL = {
  queued: "Waiting in queue", script: "Writing script", spec: "Loaded spec", factcheck: "Fact-checking",
  "factcheck-ok": "Fact-check passed", revise: "Revising flagged claims", audio: "Audio (stub)", saved: "Spec saved",
  "render-main": "Rendering main video", "render-short": "Rendering Short", done: "Done",
};
function jobPill(j) {
  if (!j) return "";
  if (j.state === "running") return pill(STAGE_LABEL[j.stage] ?? j.stage, "run spin", true);
  if (j.state === "queued") return pill("Queued", "run");
  if (j.state === "done") return pill("Finished", "ok");
  if (j.state === "failed") return pill("Failed", "bad");
  return pill("Cancelled", "warn");
}
function progressBar(p) {
  if (!p || !p.total) return "";
  const pct = Math.min(100, Math.round((p.done / p.total) * 100));
  return `<div class="small muted">${esc(p.what)} ${p.done}/${p.total} frames (${pct}%)</div><div class="progress"><div style="width:${pct}%"></div></div>`;
}

function stagesCells(v) {
  const spec = v.spec ? pill(`${v.spec.scenes} scenes · ${dur(v.spec.seconds)}`, "ok") : pill("No spec");
  let fc = pill("Not run");
  if (v.factcheck) {
    fc = v.factcheck.flagged
      ? pill(`${v.factcheck.flagged} flagged`, "bad")
      : pill(`${v.factcheck.claims} ok`, "ok");
    if (v.factcheck.stale) fc += " " + pill("spec changed", "warn");
  }
  let rd = pill("Not rendered");
  if (v.render) rd = pill(v.render.main && v.render.short ? "Main + Short" : v.render.main ? "Main only" : "Short only", v.render.stale ? "warn" : "ok") + (v.render.stale ? " " + pill("stale", "warn") : "");
  return { spec, fc, rd };
}

// ---------- routing ----------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "topics") return { name: "topics" };
  if (parts[0] === "jobs" && parts[1]) return { name: "job", id: Number(parts[1]) };
  if (parts[0] === "jobs") return { name: "jobs" };
  if (parts[0] === "video" && parts[1]) return { name: "video", slug: parts[1], tab: parts[2] ?? "overview" };
  return { name: "videos" };
}

async function render() {
  const prev = S.route;
  S.route = parseRoute();
  if (prev.name === "video" && (S.route.name !== "video" || S.route.slug !== prev.slug)) {
    S.spec = null;
    S.specDirty = false;
    S.logJobId = null;
  }
  $$(".top nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (S.route.name === "video" ? "videos" : S.route.name === "job" ? "jobs" : S.route.name)));
  try {
    if (S.route.name === "videos") await renderVideos();
    else if (S.route.name === "topics") await renderTopics();
    else if (S.route.name === "jobs") await renderJobs();
    else if (S.route.name === "job") await renderJob();
    else if (S.route.name === "video") await renderVideo();
  } catch (err) {
    app.innerHTML = `<div class="panel err">${esc(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("beforeunload", (e) => {
  if (S.specDirty) e.preventDefault();
});

// ---------- videos list ----------

async function renderVideos() {
  const videos = await api("/api/videos");
  const counts = {};
  for (const v of videos) counts[v.status] = (counts[v.status] ?? 0) + 1;
  const needsReview = videos.filter((v) => v.status === "review" && v.render);
  app.innerHTML = `
    <div class="pagehead">
      <div><h1>Videos</h1><div class="sub">Every topic in the backlog plus any spec on disk. ${Object.entries(counts).map(([k, n]) => `${n} ${esc(k)}`).join(" · ")}</div></div>
      <div class="row"><a href="#/topics"><button>Manage backlog</button></a></div>
    </div>
    ${needsReview.length ? `<div class="panel"><h3>Waiting for your approval</h3><div class="row">${needsReview.map((v) => `<a href="#/video/${esc(v.slug)}/review"><button class="primary">${esc(v.title)}</button></a>`).join("")}</div></div>` : ""}
    <div class="panel tablewrap">
      ${videos.length ? `<table>
        <thead><tr><th>Video</th><th>Status</th><th>Script</th><th>Fact-check</th><th>Render</th><th>Job</th><th></th></tr></thead>
        <tbody>${videos.map((v) => {
          const c = stagesCells(v);
          return `<tr>
            <td class="title"><a href="#/video/${esc(v.slug)}">${esc(v.title)}</a><div class="small muted mono">${esc(v.slug)}</div></td>
            <td>${statusPill(v.status)}</td>
            <td>${c.spec}</td><td>${c.fc}</td><td>${c.rd}</td>
            <td>${v.job ? jobPill(v.job) : v.lastJob ? jobPill(v.lastJob) + `<div class="small muted">${ago(v.lastJob.endedAt)}</div>` : ""}</td>
            <td><div class="row" style="justify-content:flex-end">
              <button class="sm" data-run="${esc(v.slug)}" ${v.job ? "disabled" : ""}>Run…</button>
              <a href="#/video/${esc(v.slug)}"><button class="sm ghost">Open</button></a>
            </div></td>
          </tr>`;
        }).join("")}</tbody></table>` : `<div class="empty">No topics yet. <a href="#/topics">Add one to the backlog</a>.</div>`}
    </div>`;
  bindRunButtons();
}

function bindRunButtons(root = app) {
  $$("[data-run]", root).forEach((b) => (b.onclick = () => runDialog(b.dataset.run)));
}

function runDialog(slug, preset = "full") {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <h2>Run pipeline</h2>
    <p class="muted small">Runs <code>npm run generate</code> for <b>${esc(slug)}</b> on this Mac, through your logged-in <code>claude</code> CLI. Jobs run one at a time.</p>
    ${Object.entries(S.meta.modes).map(([k, label]) => `<label class="check" style="margin:6px 0"><input type="radio" name="mode" value="${k}" ${k === preset ? "checked" : ""}/> ${esc(label)}</label><br/>`).join("")}
    <label class="check" style="margin:10px 0"><input type="checkbox" name="fresh"/> Write a fresh script (the current spec is moved to <code>out/archive/</code>)</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" value="cancel">Cancel</button><button class="primary" value="go">Start</button></div>`;
  document.body.append(dlg);
  const freshBox = $("[name=fresh]", dlg);
  const syncFresh = () => {
    const mode = $("[name=mode]:checked", dlg).value;
    freshBox.disabled = mode === "render";
    if (mode === "render") freshBox.checked = false;
  };
  $$("[name=mode]", dlg).forEach((r) => (r.onchange = syncFresh));
  syncFresh();
  dlg.addEventListener("close", () => dlg.remove());
  $("[value=cancel]", dlg).onclick = () => dlg.close();
  $("[value=go]", dlg).onclick = async () => {
    const mode = $("[name=mode]:checked", dlg).value;
    try {
      const job = await act(() => api(`/api/videos/${slug}/run`, { method: "POST", body: { mode, fresh: freshBox.checked } }));
      dlg.close();
      S.logJobId = job.id;
      location.hash = `#/video/${slug}/logs`;
      if (S.route.name === "video") render();
    } catch {}
  };
  dlg.showModal();
}

// ---------- backlog ----------

async function renderTopics() {
  const [backlog, videos] = await Promise.all([api("/api/topics"), api("/api/videos")]);
  const vmap = Object.fromEntries(videos.map((v) => [v.slug, v]));
  const topics = backlog.topics;
  const cats = [...new Set(topics.map((t) => t.category).filter(Boolean))];
  app.innerHTML = `
    <div class="pagehead">
      <div><h1>Backlog</h1><div class="sub">${topics.length} topics in <code>topics/backlog.json</code>. Order is priority: the top runs first.</div></div>
      <div class="row">
        <select id="fStatus" style="width:auto"><option value="">All statuses</option>${S.meta.statuses.map((s) => `<option>${s}</option>`).join("")}</select>
        <button class="primary" id="addTopic">Add topic</button>
      </div>
    </div>
    <div class="panel tablewrap">
      ${topics.length ? `<table>
        <thead><tr><th>#</th><th>Topic</th><th>Category</th><th>Status</th><th>Progress</th><th></th></tr></thead>
        <tbody>${topics.map((t, i) => {
          const v = vmap[t.slug];
          const c = v ? stagesCells(v) : null;
          return `<tr data-slug="${esc(t.slug)}" data-status="${esc(t.status)}">
            <td class="muted">${i + 1}</td>
            <td class="title"><a href="#/video/${esc(t.slug)}">${esc(t.title)}</a>
              <div class="small muted">${esc(t.angle)}</div>
              ${t.chorusIdea ? `<div class="small" style="color:var(--yellow)">♪ ${esc(t.chorusIdea)}</div>` : ""}</td>
            <td>${esc(t.category)}</td>
            <td><select class="statusSel" style="width:auto">${S.meta.statuses.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
            <td>${c ? `${c.spec} ${c.fc} ${c.rd}` : ""} ${v?.job ? jobPill(v.job) : ""}</td>
            <td><div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
              <button class="sm icon ghost" data-move="-1" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="sm icon ghost" data-move="1" title="Move down" ${i === topics.length - 1 ? "disabled" : ""}>↓</button>
              <button class="sm" data-edit>Edit</button>
              <button class="sm" data-run="${esc(t.slug)}" ${v?.job ? "disabled" : ""}>Run…</button>
              <button class="sm bad" data-del>Delete</button>
            </div></td>
          </tr>`;
        }).join("")}</tbody></table>` : `<div class="empty">The backlog is empty. Add a topic to get started.</div>`}
    </div>
    <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`;

  const fs = $("#fStatus");
  fs.value = S.topicFilter ?? "";
  const applyFilter = () => {
    S.topicFilter = fs.value;
    $$("tbody tr", app).forEach((tr) => (tr.hidden = Boolean(fs.value) && tr.dataset.status !== fs.value));
  };
  fs.onchange = applyFilter;
  applyFilter();
  $("#addTopic").onclick = () => topicDialog(null);
  bindRunButtons();
  $$("tbody tr", app).forEach((tr) => {
    const slug = tr.dataset.slug;
    const t = topics.find((x) => x.slug === slug);
    $(".statusSel", tr).onchange = (e) => act(() => api(`/api/topics/${slug}`, { method: "PUT", body: { status: e.target.value } }), "Status updated").then(renderTopics, renderTopics);
    $("[data-edit]", tr).onclick = () => topicDialog(t, Boolean(vmap[slug]?.spec));
    $("[data-del]", tr).onclick = () => confirmDialog(`Delete “${t.title}” from the backlog?`, "Its spec, sources and videos stay on disk.", "Delete", async () => {
      await act(() => api(`/api/topics/${slug}`, { method: "DELETE" }), "Topic deleted");
      renderTopics();
    });
    $$("[data-move]", tr).forEach((b) => (b.onclick = async () => {
      const slugs = topics.map((x) => x.slug);
      const i = slugs.indexOf(slug);
      const j = i + Number(b.dataset.move);
      [slugs[i], slugs[j]] = [slugs[j], slugs[i]];
      await act(() => api("/api/topics/reorder", { method: "POST", body: { slugs } }));
      renderTopics();
    }));
  });
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function topicDialog(t, slugLocked = false) {
  const isNew = !t;
  t = t ?? { title: "", slug: "", category: "", angle: "", chorusIdea: "", status: "queued", notes: "" };
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <h2>${isNew ? "Add topic" : "Edit topic"}</h2>
    <div class="field"><label>Title (phrased as the viewer's question)</label><input name="title" value="${esc(t.title)}" placeholder="Why is the sky blue?" required /></div>
    <div class="field"><label>Slug ${slugLocked ? "(locked: a spec already uses it)" : ""}</label><input name="slug" class="mono" value="${esc(t.slug)}" ${slugLocked ? "disabled" : ""} /></div>
    <div class="field"><label>Category</label><input name="category" list="cats" value="${esc(t.category)}" placeholder="biology, space, technology…" /></div>
    <div class="field"><label>Hook idea (first 5 seconds)</label><textarea name="angle" rows="2">${esc(t.angle)}</textarea></div>
    <div class="field"><label>Chorus idea (the line that teaches the concept)</label><input name="chorusIdea" value="${esc(t.chorusIdea)}" /></div>
    <div class="field"><label>Status</label><select name="status">${S.meta.statuses.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(t.notes)}</textarea></div>
    <div class="row" style="justify-content:flex-end"><button class="ghost" value="cancel">Cancel</button><button class="primary" value="save">${isNew ? "Add" : "Save"}</button></div>`;
  document.body.append(dlg);
  const title = $("[name=title]", dlg);
  const slugEl = $("[name=slug]", dlg);
  let slugTouched = !isNew;
  slugEl.oninput = () => (slugTouched = true);
  title.oninput = () => { if (!slugTouched) slugEl.value = slugify(title.value); };
  dlg.addEventListener("close", () => dlg.remove());
  $("[value=cancel]", dlg).onclick = () => dlg.close();
  $("[value=save]", dlg).onclick = async () => {
    const body = Object.fromEntries(["title", "category", "angle", "chorusIdea", "status", "notes"].map((k) => [k, $(`[name=${k}]`, dlg).value]));
    if (!slugLocked) body.slug = slugEl.value;
    try {
      if (isNew) await act(() => api("/api/topics", { method: "POST", body }), "Topic added");
      else await act(() => api(`/api/topics/${t.slug}`, { method: "PUT", body }), "Topic saved");
      dlg.close();
      render();
    } catch {}
  };
  dlg.showModal();
  title.focus();
}

function confirmDialog(title, text, okLabel, onOk) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
    <div class="row" style="justify-content:flex-end"><button class="ghost" value="cancel">Cancel</button><button class="bad" value="ok">${esc(okLabel)}</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  $("[value=cancel]", dlg).onclick = () => dlg.close();
  $("[value=ok]", dlg).onclick = async () => { dlg.close(); try { await onOk(); } catch {} };
  dlg.showModal();
}

// ---------- jobs ----------

async function renderJobs() {
  const jobs = await api("/api/jobs");
  app.innerHTML = `
    <div class="pagehead"><div><h1>Jobs</h1><div class="sub">Pipeline runs since the admin server started. One runs at a time; logs are also saved in <code>out/logs/</code>.</div></div></div>
    <div class="panel tablewrap">${jobs.length ? `<table>
      <thead><tr><th>#</th><th>Video</th><th>Mode</th><th>State</th><th>Started</th><th>Took</th><th></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td class="muted">${j.id}</td>
        <td class="title"><a href="#/video/${esc(j.slug)}">${esc(j.title)}</a></td>
        <td class="small">${esc(j.modeLabel)}${j.fresh ? " · fresh script" : ""}</td>
        <td>${jobPill(j)}${j.error ? `<div class="small err">${esc(j.error)}</div>` : ""}${progressBar(j.progress)}</td>
        <td class="small muted">${ago(j.startedAt ?? j.createdAt)}</td>
        <td class="small muted">${elapsed(j.startedAt, j.endedAt)}</td>
        <td><div class="row" style="justify-content:flex-end"><a href="#/jobs/${j.id}"><button class="sm">Log</button></a>
          ${j.state === "running" || j.state === "queued" ? `<button class="sm bad" data-cancel="${j.id}">Cancel</button>` : ""}</div></td>
      </tr>`).join("")}</tbody></table>` : `<div class="empty">No jobs yet. Start one from a video or the backlog.</div>`}</div>`;
  bindCancel();
}

function bindCancel(root = app) {
  $$("[data-cancel]", root).forEach((b) => (b.onclick = () => confirmDialog("Cancel this job?", "The running claude or render process is stopped. Files already written stay.", "Cancel job", async () => {
    await act(() => api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: "POST" }), "Cancelled");
    render();
  })));
}

async function renderJob() {
  const j = await api(`/api/jobs/${S.route.id}`);
  S.logJobId = j.id;
  app.innerHTML = `
    <div class="pagehead"><div><h1>Job ${j.id}: ${esc(j.title)}</h1><div class="sub">${esc(j.modeLabel)} · <a href="#/video/${esc(j.slug)}">open video</a></div></div>
      <div class="row" id="jobHead">${jobHeadHtml(j)}</div></div>
    <pre class="log" id="log"></pre>`;
  setLog(j.log);
  bindCancel();
}

const jobHeadHtml = (j) => `${jobPill(j)} <span class="muted small">${elapsed(j.startedAt, j.endedAt)}</span>
  ${j.state === "running" || j.state === "queued" ? `<button class="sm bad" data-cancel="${j.id}">Cancel</button>` : ""}
  <div style="min-width:220px">${progressBar(j.progress)}</div>`;

function setLog(text) {
  const el = $("#log");
  if (!el) return;
  el.textContent = cleanLog(text);
  el.scrollTop = el.scrollHeight;
}
function appendLogText(text) {
  const el = $("#log");
  if (!el) return;
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.textContent += cleanLog(text);
  if (stick) el.scrollTop = el.scrollHeight;
}
// Strip ANSI codes; keep only the last \r-overwritten segment of progress lines.
const cleanLog = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[^\n]*\r(?!\n)/g, "");

// ---------- video detail ----------

async function loadVideo(slug) {
  S.video = await api(`/api/videos/${slug}`);
  if (!S.specDirty) S.spec = S.video.specJson ? structuredClone(S.video.specJson) : null;
  return S.video;
}

async function renderVideo() {
  const { slug, tab } = S.route;
  const v = await loadVideo(slug);
  const tabs = [["overview", "Overview"], ["spec", "Spec"], ["factcheck", `Fact-check${v.factcheck?.flagged ? ` (${v.factcheck.flagged})` : ""}`], ["review", "Review"], ["logs", "Logs"]];
  app.innerHTML = `
    <div class="pagehead">
      <div><div class="small muted"><a href="#/videos">Videos</a> / <span class="mono">${esc(slug)}</span></div><h1>${esc(v.title)}</h1></div>
      <div class="row" id="vhead"></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/video/${esc(slug)}/${k}" class="${k === tab ? "active" : ""}">${esc(l)}</a>`).join("")}</nav>
    <div id="tab"></div>`;
  renderVideoHead();
  const body = $("#tab");
  if (tab === "spec") renderSpecTab(body);
  else if (tab === "factcheck") renderFactTab(body);
  else if (tab === "review") renderReviewTab(body);
  else if (tab === "logs") await renderLogsTab(body);
  else renderOverviewTab(body);
}

function renderVideoHead() {
  const v = S.video;
  const el = $("#vhead");
  if (!el) return;
  el.innerHTML = `${statusPill(v.status)} ${v.job ? jobPill(v.job) : ""}
    ${v.job ? `<button class="sm bad" data-cancel="${v.job.id}">Cancel job</button>` : `<button class="primary" data-run="${esc(v.slug)}">Run pipeline…</button>`}`;
  bindRunButtons(el);
  bindCancel(el);
}

function stepBox(name, cls, val, extra = "") {
  return `<div class="step ${cls}"><div class="name">${esc(name)}</div><div class="val">${val}</div>${extra}</div>`;
}

function renderOverviewTab(body) {
  const v = S.video;
  const j = v.job;
  const st = j?.stage ?? "";
  const running = (stages) => j && j.state === "running" && stages.includes(st);
  const fcCls = !v.factcheck ? "" : v.factcheck.flagged ? "bad" : v.factcheck.stale ? "warn" : "ok";
  body.innerHTML = `
    <div class="panel">
      <h3>Pipeline</h3>
      <div class="stepper">
        ${stepBox("1 · Topic", v.inBacklog ? "ok" : "warn", v.inBacklog ? "In backlog" : "Not in backlog")}
        ${stepBox("2 · Script", running(["script"]) ? "run" : v.spec ? "ok" : "", running(["script"]) ? "Writing…" : v.spec ? `${v.spec.scenes} scenes · ${dur(v.spec.seconds)}` : "Not written", v.spec ? `<div class="small muted">${ago(v.spec.at)}</div>` : "")}
        ${stepBox("3 · Fact-check", running(["factcheck", "revise", "spec"]) ? "run" : fcCls, running(["factcheck", "revise", "spec"]) ? (st === "revise" ? "Revising…" : "Checking…") : v.factcheck ? (v.factcheck.flagged ? `${v.factcheck.flagged} of ${v.factcheck.claims} flagged` : `${v.factcheck.claims} claims ok`) : "Not run", v.factcheck ? `<div class="small muted">${v.factcheck.stale ? "spec edited since · " : ""}${ago(v.factcheck.at)}</div>` : "")}
        ${stepBox("4–5 · Audio", running(["audio", "saved"]) ? "run" : v.spec ? "ok" : "", "Stub (silent)", `<div class="small muted">${v.spec ? `${esc(v.spec.bpm)} bpm` : ""}</div>`)}
        ${stepBox("7 · Render", running(["render-main", "render-short"]) ? "run" : !v.render ? "" : v.render.stale ? "warn" : "ok", running(["render-main", "render-short"]) ? (st === "render-main" ? "Main video…" : "Short…") : v.render ? `${v.render.main ? "Main" : ""}${v.render.main && v.render.short ? " + " : ""}${v.render.short ? "Short" : ""}` : "Not rendered", (v.render ? `<div class="small muted">${v.render.stale ? "spec edited since · " : ""}${ago(v.render.at)}</div>` : "") + (running(["render-main", "render-short"]) ? progressBar(j.progress) : ""))}
        ${stepBox("9 · Approval", { approved: "ok", rejected: "bad", review: "warn" }[v.status] ?? "", esc(v.status === "review" ? "Waiting for you" : v.status), v.review?.at ? `<div class="small muted">${ago(Date.parse(v.review.at))}</div>` : "")}
      </div>
    </div>
    <div class="grid2">
      <div class="panel">
        <h3>Run</h3>
        <p class="small muted">Each run calls <code>npm run generate</code>, which uses your local <code>claude</code> login (no API key). An existing spec is reused unless you ask for a fresh script.</p>
        <div class="row">
          <button class="primary" data-mode="full" ${j ? "disabled" : ""}>Full pipeline</button>
          <button data-mode="spec" ${j ? "disabled" : ""}>${v.spec ? "Re-run fact-check" : "Script + fact-check"}</button>
          <button data-mode="render" ${j || !v.spec ? "disabled" : ""}>Render only</button>
        </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" id="fresh" ${S.fresh ? "checked" : ""} ${v.spec ? "" : "disabled"}/> Fresh script (archive the current spec first)</label>
        ${j ? `<div style="margin-top:12px">${jobPill(j)} <a href="#/video/${esc(v.slug)}/logs">watch the log</a>${progressBar(j.progress)}</div>` : ""}
        ${!j && v.lastJob ? `<div style="margin-top:12px" class="small">Last run: ${jobPill(v.lastJob)} ${esc(v.lastJob.modeLabel)} · ${ago(v.lastJob.endedAt)} · <a href="#/jobs/${v.lastJob.id}">log</a>${v.lastJob.error ? `<div class="err">${esc(v.lastJob.error)}</div>` : ""}</div>` : ""}
      </div>
      <div class="panel">
        <h3>Topic</h3>
        ${v.topic ? `
          <div class="field"><label>Hook idea</label>${esc(v.topic.angle) || '<span class="muted">none</span>'}</div>
          <div class="field"><label>Chorus idea</label>${esc(v.topic.chorusIdea) || '<span class="muted">none</span>'}</div>
          <div class="field"><label>Category</label>${esc(v.topic.category) || '<span class="muted">none</span>'}</div>
          ${v.review?.notes ? `<div class="field"><label>Review notes</label>${esc(v.review.notes)}</div>` : ""}
          <a href="#/topics">Edit in backlog</a>`
        : `<p class="muted">This spec isn't in the backlog yet. Approving or rejecting it adds it.</p>`}
      </div>
    </div>`;
  $("#fresh", body).onchange = (e) => (S.fresh = e.target.checked);
  $$("[data-mode]", body).forEach((b) => (b.onclick = async () => {
    const fresh = S.fresh && b.dataset.mode !== "render";
    const go = async () => {
      const job = await act(() => api(`/api/videos/${v.slug}/run`, { method: "POST", body: { mode: b.dataset.mode, fresh } }), "Job started");
      S.fresh = false;
      S.logJobId = job.id;
      location.hash = `#/video/${v.slug}/logs`;
    };
    if (fresh) confirmDialog("Write a fresh script?", "The current spec is moved to out/archive/ and Claude writes a new one.", "Start", go);
    else go().catch(() => {});
  }));
}

// ----- spec editor -----

function specSeconds(spec) {
  if (!spec?.bpm || !Array.isArray(spec.scenes)) return null;
  return spec.scenes.reduce((n, s) => n + (Number(s.durationBeats) || 0), 0) * (60 / spec.bpm);
}

function renderSpecTab(body) {
  const v = S.video;
  if (!S.spec) {
    body.innerHTML = `<div class="panel empty">No spec yet. <button class="primary" data-run="${esc(v.slug)}">Run the script stage</button></div>`;
    bindRunButtons(body);
    return;
  }
  const spec = S.spec;
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <div class="grow small muted"><code>specs/${esc(v.slug)}.json</code> · ${spec.scenes?.length ?? 0} scenes · <span id="specDur">${dur(specSeconds(spec))}</span> at ${esc(spec.bpm)} bpm
          <span id="dirty" class="pill warn" ${S.specDirty ? "" : "hidden"}>unsaved</span></div>
        <button class="ghost sm" id="toggleRaw">${S.specRaw ? "Form editor" : "Raw JSON"}</button>
        <button class="ghost sm" id="revert" ${S.specDirty ? "" : "disabled"}>Revert</button>
        <button class="primary" id="saveSpec" ${S.specDirty ? "" : "disabled"}>Save spec</button>
      </div>
      <div id="specErr" class="err small"></div>
      <div id="specBody"></div>
    </div>
    <p class="small muted">After editing, re-run the fact-check (Overview › Re-run fact-check) and re-render so the video matches the spec.</p>`;
  const markDirty = () => {
    S.specDirty = true;
    $("#dirty").hidden = false;
    $("#saveSpec").disabled = false;
    $("#revert").disabled = false;
    $("#specDur").textContent = dur(specSeconds(S.spec));
  };
  const sb = $("#specBody");
  if (S.specRaw) {
    sb.innerHTML = `<textarea class="code" id="raw" spellcheck="false"></textarea>`;
    const raw = $("#raw");
    raw.value = JSON.stringify(spec, null, 2);
    raw.oninput = () => {
      try {
        S.spec = JSON.parse(raw.value);
        $("#specErr").textContent = "";
      } catch (e) {
        $("#specErr").textContent = `JSON error: ${e.message}`;
      }
      markDirty();
    };
  } else {
    renderSpecForm(sb, markDirty);
  }
  $("#toggleRaw").onclick = () => {
    if (S.specRaw && $("#specErr").textContent) return toast("Fix the JSON error first", true);
    S.specRaw = !S.specRaw;
    renderSpecTab(body);
  };
  $("#revert").onclick = () => {
    S.specDirty = false;
    S.spec = structuredClone(S.video.specJson);
    renderSpecTab(body);
  };
  $("#saveSpec").onclick = async () => {
    if ($("#specErr").textContent.startsWith("JSON")) return toast("Fix the JSON error first", true);
    try {
      await api(`/api/videos/${v.slug}/spec`, { method: "PUT", body: S.spec });
      toast("Spec saved");
      S.specDirty = false;
      await loadVideo(v.slug);
      renderSpecTab(body);
      renderVideoHead();
    } catch (e) {
      $("#specErr").textContent = e.message;
    }
  };
}

function renderSpecForm(sb, markDirty) {
  const spec = S.spec;
  const kinds = S.meta.sceneKinds;
  sb.innerHTML = `
    <div class="grid2" style="grid-template-columns: 3fr 1fr 1fr">
      <div class="field"><label>Title</label><input data-k="title" value="${esc(spec.title)}" /></div>
      <div class="field"><label>BPM</label><input data-k="bpm" type="number" min="40" max="240" value="${esc(spec.bpm)}" /></div>
      <div class="field"><label>Beat offset (ms)</label><input data-k="beatOffsetMs" type="number" value="${esc(spec.beatOffsetMs ?? "")}" placeholder="0" /></div>
    </div>
    <h3 style="margin-top:8px">Scenes</h3>
    <div id="scenes">${(spec.scenes ?? []).map((s, i) => `
      <div class="scene ${esc(s.kind)}" data-i="${i}">
        <div class="n">${i + 1}</div>
        <div><select data-s="kind">${kinds.map((k) => `<option ${k === s.kind ? "selected" : ""}>${k}</option>`).join("")}</select></div>
        <div class="texts">
          <input data-s="text" value="${esc(s.text)}" placeholder="Big on-screen phrase" />
          <textarea data-s="caption" rows="2" placeholder="Caption / narration line">${esc(s.caption ?? "")}</textarea>
        </div>
        <div><input data-s="durationBeats" type="number" min="1" step="1" value="${esc(s.durationBeats)}" title="Length in beats" /><div class="small muted" style="margin-top:4px">${((Number(s.durationBeats) || 0) * 60 / spec.bpm).toFixed(1)} s</div></div>
        <div class="acts">
          <button class="sm icon ghost" data-a="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="sm icon ghost" data-a="down" title="Move down" ${i === spec.scenes.length - 1 ? "disabled" : ""}>↓</button>
          <button class="sm icon bad" data-a="del" title="Delete scene">✕</button>
        </div>
      </div>`).join("")}</div>
    <button class="sm" id="addScene">+ Add scene</button>`;
  $$("[data-k]", sb).forEach((el) => (el.oninput = () => {
    const k = el.dataset.k;
    if (el.type === "number") {
      if (el.value === "" && k === "beatOffsetMs") delete spec[k];
      else spec[k] = Number(el.value);
    } else spec[k] = el.value;
    markDirty();
  }));
  $$(".scene", sb).forEach((row) => {
    const i = Number(row.dataset.i);
    $$("[data-s]", row).forEach((el) => (el.oninput = () => {
      const k = el.dataset.s;
      const scene = spec.scenes[i];
      if (k === "durationBeats") scene[k] = Number(el.value);
      else if (k === "caption" && !el.value) delete scene.caption;
      else scene[k] = el.value;
      if (k === "kind") row.className = `scene ${el.value}`;
      markDirty();
    }));
    $$("[data-a]", row).forEach((b) => (b.onclick = () => {
      const a = b.dataset.a;
      if (a === "del") spec.scenes.splice(i, 1);
      else {
        const j = i + (a === "up" ? -1 : 1);
        [spec.scenes[i], spec.scenes[j]] = [spec.scenes[j], spec.scenes[i]];
      }
      markDirty();
      renderSpecForm(sb, markDirty);
    }));
  });
  $("#addScene", sb).onclick = () => {
    spec.scenes = spec.scenes ?? [];
    spec.scenes.push({ kind: "beat", text: "", caption: "", durationBeats: 8 });
    markDirty();
    renderSpecForm(sb, markDirty);
  };
}

// ----- fact-check -----

function renderFactTab(body) {
  const v = S.video;
  const claims = v.sourcesJson?.claims ?? [];
  if (!v.sourcesJson) {
    body.innerHTML = `<div class="panel empty">No fact-check yet. ${v.spec ? `<button class="primary" id="runFc">Run fact-check</button>` : "Write the script first."}</div>`;
    const b = $("#runFc", body);
    if (b) b.onclick = () => act(() => api(`/api/videos/${v.slug}/run`, { method: "POST", body: { mode: "spec" } }), "Fact-check started").then((j) => { S.logJobId = j.id; location.hash = `#/video/${v.slug}/logs`; }, () => {});
    return;
  }
  const flagged = claims.filter((c) => c.verdict !== "ok");
  const filter = S.fcFilter ?? (flagged.length ? "flagged" : "all");
  const shown = filter === "flagged" ? flagged : claims;
  const lastJobFlags = v.lastJob?.flagged?.length && v.lastJob.state === "failed" ? v.lastJob.flagged : null;
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <div class="grow">${flagged.length ? pill(`${flagged.length} flagged`, "bad") : pill("All claims ok", "ok")} <span class="muted small">${claims.length} claims · <code>specs/${esc(v.slug)}.sources.json</code> · ${ago(v.factcheck.at)}</span>
          ${v.factcheck.stale ? pill("spec edited after this check", "warn") : ""}</div>
        <select id="fcFilter" style="width:auto"><option value="flagged">Flagged only</option><option value="all">All claims</option></select>
        <button class="sm" id="rerun" ${v.job ? "disabled" : ""}>Re-run fact-check</button>
      </div>
      ${lastJobFlags ? `<p class="small err">The last run stopped after the revise limit. Edit the spec to fix these, then re-run.</p>` : ""}
      ${shown.length ? shown.map((c) => `
        <div class="claim ${esc(c.verdict)}">
          <div class="row"><span class="c grow">${esc(c.claim)}</span>${pill(c.verdict, c.verdict === "ok" ? "ok" : c.verdict === "fix" ? "warn" : "bad")}</div>
          ${c.correction ? `<div class="corr small"><b>Correction:</b> ${esc(c.correction)}</div>` : ""}
          ${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ""}
          ${c.sources?.length ? `<ul>${c.sources.map((s) => `<li><a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(s)}</a></li>`).join("")}</ul>` : '<div class="small muted">No sources attached</div>'}
        </div>`).join("") : `<div class="empty">No flagged claims.</div>`}
    </div>`;
  $("#fcFilter", body).value = filter;
  $("#fcFilter", body).onchange = (e) => { S.fcFilter = e.target.value; renderFactTab(body); };
  $("#rerun", body).onclick = () => act(() => api(`/api/videos/${v.slug}/run`, { method: "POST", body: { mode: "spec" } }), "Fact-check started").then((j) => { S.logJobId = j.id; location.hash = `#/video/${v.slug}/logs`; }, () => {});
}

// ----- review / approval -----

function renderReviewTab(body) {
  const v = S.video;
  if (!v.render) {
    body.innerHTML = `<div class="panel empty">Nothing rendered yet. ${v.spec ? `<button class="primary" id="renderNow" ${v.job ? "disabled" : ""}>Render now</button>` : "Write the script first."}</div>`;
    const b = $("#renderNow", body);
    if (b) b.onclick = () => act(() => api(`/api/videos/${v.slug}/run`, { method: "POST", body: { mode: "render" } }), "Render started").then((j) => { S.logJobId = j.id; location.hash = `#/video/${v.slug}/logs`; }, () => {});
    return;
  }
  const bust = `?t=${Math.round(v.render.at)}`;
  const warnings = [];
  if (v.factcheck?.flagged) warnings.push(`${v.factcheck.flagged} fact-check claim(s) are still flagged.`);
  if (!v.factcheck) warnings.push("The fact-check has not run for this video.");
  if (v.factcheck?.stale) warnings.push("The spec changed after the last fact-check.");
  if (v.render.stale) warnings.push("The spec changed after this render; re-render to see the latest.");
  body.innerHTML = `
    ${warnings.length ? `<div class="panel" style="border-color:var(--orange)">${warnings.map((w) => `<div style="color:var(--orange)">⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
    <div class="videos">
      <div class="panel"><h3>Main video (16:9)</h3>${v.render.main ? `<video id="vmain" controls preload="metadata" src="/media/${esc(v.slug)}.mp4${bust}"></video>` : '<div class="empty">Not rendered</div>'}</div>
      <div class="panel"><h3>Short (9:16)</h3>${v.render.short ? `<video class="vertical" controls preload="metadata" src="/media/${esc(v.slug)}-short.mp4${bust}"></video>` : '<div class="empty">Not rendered</div>'}</div>
    </div>
    <div class="panel">
      <div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0">Your decision</h3>
        <span class="small muted">Playback speed</span>${[1, 1.5, 2].map((r) => `<button class="sm ghost" data-rate="${r}">${r}×</button>`).join("")}</div>
      <div class="small muted" style="margin-bottom:8px">Current: ${statusPill(v.status)} ${v.review?.at ? `${esc(v.review.decision)} ${ago(Date.parse(v.review.at))}` : ""}</div>
      <textarea id="notes" rows="3" placeholder="Notes (what to fix, if rejecting)">${esc(v.review?.notes ?? "")}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="good" data-decide="approved">Approve</button>
        <button class="bad" data-decide="rejected">Reject with notes</button>
        ${v.status === "approved" || v.status === "rejected" ? `<button class="ghost" data-decide="review">Back to review</button>` : ""}
        <span class="grow"></span>
        <button class="sm" id="rerender" ${v.job ? "disabled" : ""}>Re-render</button>
      </div>
    </div>`;
  $$("[data-rate]", body).forEach((b) => (b.onclick = () => $$("video", body).forEach((vid) => (vid.playbackRate = Number(b.dataset.rate)))));
  $$("video", body).forEach((vid) => vid.addEventListener("loadedmetadata", () => (vid.playbackRate = 2), { once: true }));
  $$("[data-decide]", body).forEach((b) => (b.onclick = async () => {
    const decision = b.dataset.decide;
    const notes = $("#notes", body).value;
    if (decision === "rejected" && !notes.trim()) return toast("Add a note saying what to fix", true);
    await act(() => api(`/api/videos/${v.slug}/review`, { method: "POST", body: { decision, notes } }), decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Moved back to review").catch(() => {});
    await loadVideo(v.slug);
    renderVideoHead();
    renderReviewTab(body);
  }));
  $("#rerender", body).onclick = () => act(() => api(`/api/videos/${v.slug}/run`, { method: "POST", body: { mode: "render" } }), "Render started").then((j) => { S.logJobId = j.id; location.hash = `#/video/${v.slug}/logs`; }, () => {});
}

// ----- logs -----

async function renderLogsTab(body) {
  const v = S.video;
  if (!v.jobs.length) {
    body.innerHTML = `<div class="panel empty">No runs for this video since the admin server started. Older logs are in <code>out/logs/</code>.</div>`;
    return;
  }
  if (!v.jobs.some((j) => j.id === S.logJobId)) S.logJobId = v.jobs[0].id;
  const j = await api(`/api/jobs/${S.logJobId}`);
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:10px">
        <select id="jobSel" style="width:auto">${v.jobs.map((x) => `<option value="${x.id}" ${x.id === j.id ? "selected" : ""}>#${x.id} · ${esc(x.modeLabel)} · ${esc(x.state)}</option>`).join("")}</select>
        <div class="row grow" id="jobHead">${jobHeadHtml(j)}</div>
      </div>
      ${j.flagged?.length ? `<div class="small" style="margin-bottom:8px">${pill(`${j.flagged.length} flagged in this run`, "warn")} <a href="#/video/${esc(v.slug)}/factcheck">see fact-check</a></div>` : ""}
      ${j.error ? `<div class="small err" style="margin-bottom:8px">${esc(j.error)}</div>` : ""}
      <pre class="log" id="log"></pre>
    </div>`;
  setLog(j.log);
  bindCancel(body);
  $("#jobSel", body).onchange = (e) => { S.logJobId = Number(e.target.value); renderLogsTab(body); };
}

// ---------- live updates ----------

let refreshTimer = null;
function softRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const r = S.route;
    if (r.name === "videos" || r.name === "jobs") return render();
    if (r.name === "topics" && !document.querySelector("dialog[open]")) return render();
    if (r.name === "video") {
      const before = S.video;
      await loadVideo(r.slug);
      renderVideoHead();
      const tab = $("#tab");
      if (!tab) return;
      if (r.tab === "overview") renderOverviewTab(tab);
      else if (r.tab === "factcheck" && before?.factcheck?.at !== S.video.factcheck?.at) renderFactTab(tab);
      else if (r.tab === "review" && (before?.render?.at !== S.video.render?.at || before?.status !== S.video.status)) renderReviewTab(tab);
      else if (r.tab === "spec" && !S.specDirty && before?.spec?.at !== S.video.spec?.at) renderSpecTab(tab);
    }
  }, 250);
}

function updateJobBadge(jobs) {
  const n = jobs.filter((j) => j.state === "running" || j.state === "queued").length;
  const b = $("#jobBadge");
  b.hidden = !n;
  b.textContent = n;
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => {
    $("#conn").classList.add("on");
    api("/api/jobs").then(updateJobBadge, () => {});
  });
  es.onerror = () => $("#conn").classList.remove("on");
  es.addEventListener("job", (e) => {
    const j = JSON.parse(e.data);
    api("/api/jobs").then(updateJobBadge, () => {});
    if ((S.route.name === "job" && S.route.id === j.id) || (S.route.name === "video" && S.route.tab === "logs" && S.logJobId === j.id)) {
      const h = $("#jobHead");
      if (h) { h.innerHTML = jobHeadHtml(j); bindCancel(h); }
      const opt = $(`#jobSel option[value="${j.id}"]`);
      if (opt) opt.textContent = `#${j.id} · ${j.modeLabel} · ${j.state}`;
    }
    if (S.route.name === "video" && S.route.tab === "logs" && S.route.slug === j.slug && !$("#log")) return render();
    if (S.route.name === "job" || (S.route.name === "video" && S.route.slug !== j.slug)) return;
    if (S.route.name === "video" && S.route.tab === "logs") {
      // A new job for this video: refresh the selector so it shows up.
      if (!$(`#jobSel option[value="${j.id}"]`)) { S.logJobId = j.id; return render(); }
      return loadVideo(S.route.slug).then(renderVideoHead);
    }
    softRefresh();
  });
  es.addEventListener("log", (e) => {
    const { id, text } = JSON.parse(e.data);
    if (S.logJobId === id && (S.route.name === "job" || (S.route.name === "video" && S.route.tab === "logs"))) appendLogText(text);
  });
  es.addEventListener("videos", () => {
    if (S.route.name === "video" && S.route.tab === "logs") return loadVideo(S.route.slug).then(renderVideoHead);
    if (S.route.name !== "job") softRefresh();
  });
}

// ---------- boot ----------

(async function boot() {
  try {
    S.meta = await api("/api/meta");
  } catch (err) {
    app.innerHTML = `<div class="panel err">Can't reach the admin server: ${esc(err.message)}</div>`;
    return;
  }
  if (S.meta.env?.warnings?.length) {
    const box = document.createElement("div");
    box.className = "panel";
    box.style.cssText = "border-color:var(--orange);max-width:1192px;margin:16px auto 0";
    box.innerHTML = S.meta.env.warnings.map((w) => `<div style="color:var(--orange)">⚠ ${esc(w)}</div>`).join("");
    app.before(box);
  }
  connect();
  render();
  setInterval(() => {
    // Keep "x min ago" and elapsed times fresh on list pages.
    if ((S.route.name === "videos" || S.route.name === "jobs") && !document.querySelector("dialog[open]")) render();
  }, 30000);
})();
