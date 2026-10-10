// Musical Explainers admin UI. Vanilla JS, no build step. All pipeline rules
// (validation, staleness, jobs, files) live on the server; this only shows
// them and sends requests.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");

const S = {
  meta: { statuses: [], stages: [], sections: [], visuals: {}, icons: [], modes: {} },
  route: { name: "videos" },
  video: null, // detail payload for the open video
  spec: null, // working copy in the storyboard editor
  specDirty: false,
  specRaw: false,
  openShot: null,
  logJobId: null,
  fresh: false,
  cand: null, // selected candidate on the review tab
  compare: null,
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
const pill = (text, cls = "", dot = false, title = "") => `<span class="pill ${cls}" ${title ? `title="${esc(title)}"` : ""}>${dot ? '<span class="dot"></span>' : ""}${esc(text)}</span>`;
const statusPill = (s) => pill(s, STATUS_CLASS[s] ?? "");

const STAGE_LABEL = { research: "Research", outline: "Outline", script: "Script", review: "Editorial review", factcheck: "Fact-check", direct: "Storyboard", assets: "Assets", audio: "Audio", render: "Render", qa: "Quality", package: "Package" };
const STAGE_HELP = {
  research: "Claude qualifies the topic, picks the strongest angle and builds a sourced research dossier (web search).",
  outline: "Per format: how the viewer's understanding changes, beat by beat, with the claims each beat rests on and planned lengths.",
  script: "Per format: Claude writes the landscape and the Short separately from the dossier and outline, to the configured duration.",
  review: "Per format: an independent editorial rubric (clarity, depth, examples, format fit...). Weak scripts are revised once, then fail.",
  factcheck: "Claude verifies every spoken and on-screen claim with web search; flagged text gets targeted revisions (max 2 rounds).",
  direct: "Claude directs each shot: visual system, labels, camera, transitions, accents.",
  assets: "Resolves illustrations and licensed files; renders optional Blender 3D clips.",
  audio: "Narration, composed music, sung chorus, SFX, ducking and -14 LUFS mix; measured length checked against the duration range.",
  render: "Remotion renders a new candidate (16:9 and 9:16). Old candidates are kept.",
  qa: "Checks the rendered files: streams, loudness, sampled frames, contact sheets.",
  package: "Thumbnail and YouTube metadata (chapters, sources, credits).",
};
const ST_CLASS = { fresh: "ok", stale: "warn", failed: "bad", missing: "" };
const ST_TEXT = { fresh: "up to date", stale: "out of date", failed: "failed", missing: "not done" };

function stagePill(v, st) {
  const s = v.stages?.[st];
  const running = v.job?.state === "running" && v.job.stage === st;
  if (running) return pill(STAGE_LABEL[st], "run spin", true, "Running now");
  if (!s) return pill(STAGE_LABEL[st], "", false, "Status is being computed");
  return pill(STAGE_LABEL[st], ST_CLASS[s.status], false, `${ST_TEXT[s.status]}: ${s.reason}`);
}

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
  return `<div class="small muted">${esc(p.what)} ${p.done}/${p.total} (${pct}%)</div><div class="progress"><div style="width:${pct}%"></div></div>`;
}

const AUDIO_TEXT = { full: "Full audio", partial: "Partial audio", silent: "Silent preview" };
const FAILURE_CLASS = { "content quality": "bad", "factual verification": "bad", configuration: "warn", "media duration": "warn", "rendered-media QA": "bad" };
const failurePill = (j) => (j?.failure ? pill(`failed: ${j.failure}`, FAILURE_CLASS[j.failure] ?? "bad") : "");
const FMT_SHORT = { main: "Landscape", short: "Short" };
const fmtRange = (d) => (d ? `${dur(d.targetSeconds ?? d.target)} (allowed ${dur(d.minSeconds ?? d.min)}–${dur(d.maxSeconds ?? d.max)})` : "");
const verdictPill = (v) => (v ? pill(v === "ok" ? "in range" : v === "off-target" ? "off target" : v === "short" ? "too short" : v === "long" ? "too long" : v, v === "ok" ? "ok" : v === "off-target" ? "warn" : "bad") : "");

const audioPill = (status) => (status ? pill(AUDIO_TEXT[status] ?? status, status === "full" ? "ok" : status === "partial" ? "warn" : "bad") : pill("No audio", "bad"));

// ---------- routing ----------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "topics") return { name: "topics" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "jobs" && parts[1]) return { name: "job", id: Number(parts[1]) };
  if (parts[0] === "jobs") return { name: "jobs" };
  if (parts[0] === "video" && parts[1]) return { name: "video", slug: parts[1], tab: parts[2] ?? "overview" };
  return { name: "videos" };
}

async function render() {
  const prev = S.route;
  const next = parseRoute();
  // Unsaved settings edits: ask before leaving the page.
  if (prev.name === "settings" && next.name !== "settings" && S.settingsDirty && !confirm("You have unsaved duration settings. Leave without saving?")) {
    history.replaceState(null, "", "#/settings");
    return;
  }
  if (next.name !== "settings") S.settingsDirty = false;
  S.route = next;
  if (prev.name === "video" && (S.route.name !== "video" || S.route.slug !== prev.slug)) {
    Object.assign(S, { spec: null, specDirty: false, specFormat: "main", logJobId: null, cand: null, compare: null, openShot: null });
  }
  $$(".top nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (S.route.name === "video" ? "videos" : S.route.name === "job" ? "jobs" : S.route.name)));
  try {
    if (S.route.name === "videos") await renderVideos();
    else if (S.route.name === "topics") await renderTopics();
    else if (S.route.name === "jobs") await renderJobs();
    else if (S.route.name === "job") await renderJob();
    else if (S.route.name === "video") await renderVideo();
    else if (S.route.name === "settings") await renderSettings();
  } catch (err) {
    app.innerHTML = `<div class="panel err">${esc(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("beforeunload", (e) => {
  if (S.specDirty || S.settingsDirty) e.preventDefault();
});

// ---------- videos list ----------

async function renderVideos() {
  const videos = await api("/api/videos");
  const counts = {};
  for (const v of videos) counts[v.status] = (counts[v.status] ?? 0) + 1;
  const needsReview = videos.filter((v) => v.status === "review" && v.render);
  app.innerHTML = `
    <div class="pagehead">
      <div><h1>Videos</h1><div class="sub">Every topic in the backlog plus any storyboard on disk. ${Object.entries(counts).map(([k, n]) => `${n} ${esc(k)}`).join(" · ")}</div></div>
      <div class="row"><a href="#/topics"><button>Manage backlog</button></a></div>
    </div>
    ${needsReview.length ? `<div class="panel"><h3>Waiting for your approval</h3><div class="row">${needsReview.map((v) => `<a href="#/video/${esc(v.slug)}/review"><button class="primary">${esc(v.title)}</button></a>`).join("")}</div></div>` : ""}
    <div class="panel tablewrap">
      ${videos.length ? `<table>
        <thead><tr><th>Video</th><th>Status</th><th>Pipeline</th><th>Sound</th><th>Job</th><th></th></tr></thead>
        <tbody>${videos.map((v) => `<tr>
            <td class="title"><a href="#/video/${esc(v.slug)}">${esc(v.title)}</a><div class="small muted mono">${esc(v.slug)}${v.spec ? ` · ${v.spec.shots} shots · ${dur(v.spec.seconds)}` : ""}</div></td>
            <td>${statusPill(v.status)}</td>
            <td><div class="chips">${S.meta.stages.map((st) => stagePill(v, st)).join("")}</div></td>
            <td>${v.audio ? audioPill(v.audio.main ?? v.audio.short) : pill("—")}</td>
            <td>${v.job ? jobPill(v.job) + progressBar(v.job.progress) : v.lastJob ? jobPill(v.lastJob) + `<div class="small muted">${ago(v.lastJob.endedAt)}</div>` : ""}</td>
            <td><div class="row" style="justify-content:flex-end">
              <button class="sm" data-run="${esc(v.slug)}" ${v.job ? "disabled" : ""}>Run…</button>
              <a href="#/video/${esc(v.slug)}"><button class="sm ghost">Open</button></a>
            </div></td>
          </tr>`).join("")}</tbody></table>` : `<div class="empty">No topics yet. <a href="#/topics">Add one to the backlog</a>.</div>`}
    </div>`;
  bindRunButtons();
}

function bindRunButtons(root = app) {
  $$("[data-run]", root).forEach((b) => (b.onclick = () => runDialog(b.dataset.run)));
}

function startJob(slug, body, okMsg = "Job started") {
  return act(() => api(`/api/videos/${slug}/run`, { method: "POST", body }), okMsg).then((job) => {
    S.logJobId = job.id;
    location.hash = `#/video/${slug}/logs`;
    if (S.route.name === "video") render();
    return job;
  });
}

function runDialog(slug, preset = "continue") {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `
    <h2>Run pipeline</h2>
    <p class="muted small">Runs <code>npm run pipeline</code> for <b>${esc(slug)}</b> on this Mac. Claude stages use your logged-in <code>claude</code> CLI. Stages that are already up to date are skipped. Jobs run one at a time.</p>
    ${Object.entries(S.meta.modes).map(([k, label]) => `<label class="check" style="margin:6px 0"><input type="radio" name="mode" value="${k}" ${k === preset ? "checked" : ""}/> ${esc(label)}</label><br/>`).join("")}
    <label class="check" style="margin:10px 0 0"><input type="checkbox" name="fresh"/> Re-plan and write fresh scripts (outline + script; storyboards archived first, research kept)</label><br/>
    <label class="check" style="margin:6px 0 0"><input type="checkbox" name="preview"/> Preview render (half resolution, faster; can't be approved)</label><br/>
    <label class="check" style="margin:6px 0 0"><input type="checkbox" name="visualReview"/> Ask Claude to inspect the rendered contact sheets (uses subscription)</label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="ghost" value="cancel">Cancel</button><button class="primary" value="go">Start</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  $("[value=cancel]", dlg).onclick = () => dlg.close();
  $("[value=go]", dlg).onclick = async () => {
    const body = { mode: $("[name=mode]:checked", dlg).value, fresh: $("[name=fresh]", dlg).checked, preview: $("[name=preview]", dlg).checked, visualReview: $("[name=visualReview]", dlg).checked };
    try {
      dlg.close();
      await startJob(slug, body);
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
        <thead><tr><th>#</th><th>Topic</th><th>Category</th><th>Status</th><th>Pipeline</th><th></th></tr></thead>
        <tbody>${topics.map((t, i) => {
          const v = vmap[t.slug];
          return `<tr data-slug="${esc(t.slug)}" data-status="${esc(t.status)}">
            <td class="muted">${i + 1}</td>
            <td class="title"><a href="#/video/${esc(t.slug)}">${esc(t.title)}</a>
              <div class="small muted">${esc(t.angle)}</div>
              ${t.chorusIdea ? `<div class="small" style="color:var(--yellow)">♪ ${esc(t.chorusIdea)}</div>` : ""}</td>
            <td>${esc(t.category)}</td>
            <td><select class="statusSel" style="width:auto">${S.meta.statuses.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
            <td><div class="chips">${v ? S.meta.stages.map((st) => stagePill(v, st)).join("") : ""}</div> ${v?.job ? jobPill(v.job) : ""}</td>
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
    $("[data-del]", tr).onclick = () => confirmDialog(`Delete “${t.title}” from the backlog?`, "Its storyboard, sources and renders stay on disk.", "Delete", async () => {
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
    <div class="field"><label>Slug ${slugLocked ? "(locked: a storyboard already uses it)" : ""}</label><input name="slug" class="mono" value="${esc(t.slug)}" ${slugLocked ? "disabled" : ""} /></div>
    <div class="field"><label>Category</label><input name="category" list="cats" value="${esc(t.category)}" placeholder="biology, space, technology…" /></div>
    <div class="field"><label>Hook idea (first 5 seconds)</label><textarea name="angle" rows="2">${esc(t.angle)}</textarea></div>
    <div class="field"><label>Chorus idea (the line that teaches the concept)</label><input name="chorusIdea" value="${esc(t.chorusIdea)}" /></div>
    <div class="field"><label>Status</label><select name="status">${S.meta.statuses.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes (passed to the script writer)</label><textarea name="notes" rows="2">${esc(t.notes)}</textarea></div>
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
      <thead><tr><th>#</th><th>Video</th><th>What</th><th>State</th><th>Started</th><th>Took</th><th></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td class="muted">${j.id}</td>
        <td class="title"><a href="#/video/${esc(j.slug)}">${esc(j.title)}</a></td>
        <td class="small">${esc(j.modeLabel)}${j.fresh ? " · fresh script" : ""}</td>
        <td>${jobPill(j)} ${failurePill(j)}${j.error ? `<div class="small err">${esc(j.error)}</div>` : ""}${progressBar(j.progress)}</td>
        <td class="small muted">${ago(j.startedAt ?? j.createdAt)}</td>
        <td class="small muted">${elapsed(j.startedAt, j.endedAt)}</td>
        <td><div class="row" style="justify-content:flex-end"><a href="#/jobs/${j.id}"><button class="sm">Log</button></a>
          ${j.state === "running" || j.state === "queued" ? `<button class="sm bad" data-cancel="${j.id}">Cancel</button>` : ""}</div></td>
      </tr>`).join("")}</tbody></table>` : `<div class="empty">No jobs yet. Start one from a video or the backlog.</div>`}</div>`;
  bindCancel();
}

function bindCancel(root = app) {
  $$("[data-cancel]", root).forEach((b) => (b.onclick = () => confirmDialog("Cancel this job?", "The running claude, render or Blender process is stopped. Finished stages and earlier candidates stay; the stopped stage is marked cancelled.", "Cancel job", async () => {
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

const jobSettingsHtml = (j) => (j.settings ? `<div class="small muted" style="flex-basis:100%">Durations for this job: ${["main", "short"].map((f) => `${FMT_SHORT[f]} ${esc(fmtRange(j.settings.settings.formats[f]))}`).join(" · ")}</div>` : "");
const jobHeadHtml = (j) => `${jobPill(j)} ${failurePill(j)} <span class="muted small">${elapsed(j.startedAt, j.endedAt)}</span>
  ${j.state === "running" || j.state === "queued" ? `<button class="sm bad" data-cancel="${j.id}">Cancel</button>` : ""}
  <div style="min-width:220px">${progressBar(j.progress)}</div>
  ${j.error ? `<div class="small err" style="flex-basis:100%">${esc(j.error)}${j.hint ? `<div class="muted">${esc(j.hint)}</div>` : ""}</div>` : ""}
  ${j.durations ? `<div class="small" style="flex-basis:100%;color:var(--orange)">${Object.entries(j.durations).map(([f, d]) => `${FMT_SHORT[f]}: measured ${dur(d.seconds)} (narration ${dur(d.narrationSeconds)}), allowed ${dur(d.minSeconds)}–${dur(d.maxSeconds)}`).join(" · ")}</div>` : ""}
  ${jobSettingsHtml(j)}`;

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
// Strip ANSI codes and machine lines; keep only the last \r-overwritten segment of progress lines.
const cleanLog = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[^\n]*\r(?!\n)/g, "").replace(/^@@ \{"event":"progress".*\n?/gm, "");

// ---------- video detail ----------

/** The storyboard being edited: the landscape one, or the independent Short one. */
const editedSpec = (v) => (S.specFormat === "short" ? v.shortSpecJson : v.specJson);

async function loadVideo(slug, fresh = false) {
  S.video = await api(`/api/videos/${slug}${fresh ? "?fresh=1" : ""}`);
  if (S.specFormat === "short" && !S.video.shortSpecJson) S.specFormat = "main";
  if (!S.specDirty) S.spec = editedSpec(S.video) ? structuredClone(editedSpec(S.video)) : null;
  return S.video;
}

const TABS = [["overview", "Overview"], ["research", "Research & review"], ["storyboard", "Storyboard"], ["factcheck", "Fact-check"], ["assets", "Assets & audio"], ["quality", "Quality"], ["review", "Review"], ["logs", "Logs"]];

async function renderVideo() {
  const { slug, tab } = S.route;
  const v = await loadVideo(slug);
  const tabs = TABS.map(([k, l]) => [k, k === "factcheck" && v.factcheck?.flagged ? `${l} (${v.factcheck.flagged})` : k === "quality" && v.render?.qa ? `${l} · ${v.render.qa.status}` : l]);
  app.innerHTML = `
    <div class="pagehead">
      <div><div class="small muted"><a href="#/videos">Videos</a> / <span class="mono">${esc(slug)}</span></div><h1>${esc(v.title)}</h1></div>
      <div class="row" id="vhead"></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/video/${esc(slug)}/${k}" class="${k === tab || (tab === "spec" && k === "storyboard") ? "active" : ""}">${esc(l)}</a>`).join("")}</nav>
    <div id="tab"></div>`;
  renderVideoHead();
  const body = $("#tab");
  if (tab === "storyboard" || tab === "spec") renderStoryboardTab(body);
  else if (tab === "factcheck") renderFactTab(body);
  else if (tab === "research") renderResearchTab(body);
  else if (tab === "assets") renderAssetsTab(body);
  else if (tab === "quality") renderQualityTab(body);
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

function renderOverviewTab(body) {
  const v = S.video;
  const j = v.job;
  const runs = v.stageRuns ?? {};
  const latest = v.candidates?.[0];
  const issues = [...(v.problems ?? []).map((p) => ({ cls: "bad", t: p })), ...(v.lint ?? []).map((p) => ({ cls: "warn", t: p }))];
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0">Pipeline</h3>
        ${v.checkpoint ? `<span class="small muted">Last successful stage: <b>${esc(STAGE_LABEL[v.checkpoint])}</b></span>` : ""}
        <button class="primary" id="continue" ${j ? "disabled" : ""} title="Runs every stage that is missing or out of date, in order">Continue production</button>
        <button id="freshBtn" ${j ? "disabled" : ""}>Fresh script…</button></div>
      <div class="stages">${S.meta.stages.map((st, i) => {
        const s = v.stages?.[st];
        const run = runs[st];
        const external = !j && run?.status === "running";
        const running = (j?.state === "running" && j.stage === st) || external;
        const cls = running ? "run" : s ? ST_CLASS[s.status] : "";
        return `<div class="stage ${cls}">
          <div class="row"><span class="n">${i + 1}</span><b class="grow">${STAGE_LABEL[st]}</b>${running ? pill("running", "run spin", true) : s ? pill(ST_TEXT[s.status], ST_CLASS[s.status]) : pill("…")}</div>
          <div class="small" title="${esc(STAGE_HELP[st])}">${esc(external ? "running in another process (e.g. a terminal)" : running ? (j.progress ? `${j.progress.what} ${j.progress.done}/${j.progress.total}` : "working…") : s?.reason ?? "")}</div>
          ${running && j ? progressBar(j.progress) : ""}
          ${run?.status === "failed" || run?.status === "cancelled" ? `<div class="small ${run.status === "failed" ? "err" : "muted"}">Last run ${esc(run.status)}${run.error?.message ? `: ${esc(run.error.message.slice(0, 220))}` : ""}${run.error?.hint ? `<div class="muted">${esc(run.error.hint)}</div>` : ""}</div>` : run?.endedAt ? `<div class="small muted">ran ${ago(Date.parse(run.endedAt))}${run.warnings?.length ? ` · ${run.warnings.length} warning(s)` : ""}</div>` : ""}
          <div class="row" style="margin-top:6px"><button class="sm" data-stage="${st}" ${j ? "disabled" : ""}>Run</button>${st === "render" ? `<button class="sm ghost" data-stage="render" data-preview="1" ${j ? "disabled" : ""}>Preview</button>` : ""}${st === "qa" ? `<button class="sm ghost" data-stage="qa" data-review="1" ${j ? "disabled" : ""} title="Also ask Claude to inspect the contact sheets">+ Claude review</button>` : ""}</div>
        </div>`;
      }).join("")}</div>
      ${j ? `<div style="margin-top:12px">${jobPill(j)} <a href="#/video/${esc(v.slug)}/logs">watch the log</a>${progressBar(j.progress)}</div>` : ""}
      ${!j && v.lastJob ? `<div style="margin-top:12px" class="small">Last run: ${jobPill(v.lastJob)} ${failurePill(v.lastJob)} ${esc(v.lastJob.modeLabel)} · ${ago(v.lastJob.endedAt)} · <a href="#/jobs/${v.lastJob.id}">log</a>${v.lastJob.error ? `<div class="err">${esc(v.lastJob.error)}${v.lastJob.hint ? `<div class="muted">${esc(v.lastJob.hint)}</div>` : ""}</div>` : ""}</div>` : ""}
    </div>
    ${formatsPanel(v)}
    ${issues.length ? `<div class="panel"><h3>Storyboard checks</h3>${issues.map((x) => `<div class="small ${x.cls === "bad" ? "err" : ""}" style="${x.cls === "warn" ? "color:var(--orange)" : ""}">${x.cls === "bad" ? "✕" : "⚠"} ${esc(x.t)}</div>`).join("")}</div>` : ""}
    <div class="grid2">
      <div class="panel">
        <h3>Latest candidate</h3>
        ${latest ? `<div class="row">${pill(latest.id, latest.approved ? "ok" : "")} ${latest.preview ? pill("preview", "warn") : ""} ${audioPill(latest.audio?.main ?? latest.audio?.short)} ${latest.qa ? pill(`QA ${latest.qa.status}`, latest.qa.status === "pass" ? "ok" : latest.qa.status === "warn" ? "warn" : "bad") : pill("QA not run")}</div>
          <div class="small muted" style="margin-top:6px">${esc(latest.qa?.summary ?? "")}</div>
          <div class="row" style="margin-top:8px"><a href="#/video/${esc(v.slug)}/review"><button class="sm">Review</button></a><a href="#/video/${esc(v.slug)}/quality"><button class="sm ghost">Quality report</button></a></div>`
        : v.render?.legacy ? `<p class="small muted">Only an old-format render exists (before candidates). <a href="#/video/${esc(v.slug)}/review">Watch it</a> or run the pipeline to make a candidate.</p>` : `<p class="muted small">Nothing rendered yet.</p>`}
        ${v.approved ? `<p class="small" style="margin-top:8px">Approved: <b>${esc(v.approved)}</b> (kept even when newer renders exist)</p>` : ""}
      </div>
      <div class="panel">
        <h3>Topic</h3>
        ${v.topic ? `
          <div class="field"><label>Hook idea</label>${esc(v.topic.angle) || '<span class="muted">none</span>'}</div>
          <div class="field"><label>Chorus idea</label>${esc(v.topic.chorusIdea) || '<span class="muted">none</span>'}</div>
          ${v.specJson?.brief?.learningGoal ? `<div class="field"><label>Learning goal</label>${esc(v.specJson.brief.learningGoal)}</div>` : ""}
          ${v.review?.notes ? `<div class="field"><label>Review notes</label>${esc(v.review.notes)}</div>` : ""}
          <a href="#/topics">Edit in backlog</a>`
        : `<p class="muted">This storyboard isn't in the backlog yet. Approving or rejecting it adds it.</p>`}
      </div>
    </div>`;
  $("#continue", body).onclick = () => startJob(v.slug, { mode: "continue" }).catch(() => {});
  $("#freshBtn", body).onclick = () => confirmDialog("Write fresh scripts?", "The current storyboards are archived to out/<slug>/archive/, then Claude re-plans both outlines from the research dossier and writes new landscape and Short scripts, and the pipeline continues from there. Approved renders are kept.", "Start", () => startJob(v.slug, { mode: "continue", fresh: true }));
  $$("[data-stage]", body).forEach((b) => (b.onclick = () => startJob(v.slug, { mode: "stage", stage: b.dataset.stage, preview: Boolean(b.dataset.preview), visualReview: Boolean(b.dataset.review) }).catch(() => {})));
}

/** Per cut: configured target/range, script estimate, measured narration and final length, editorial verdict. */
function formatsPanel(v) {
  const F = v.formats;
  if (!F) return "";
  const run = v.lastRunSettings?.formats;
  const row = (f) => {
    const x = F[f];
    if (!x) return "";
    const snap = run?.[f];
    const changed = snap && (snap.targetSeconds !== x.target || snap.minSeconds !== x.min || snap.maxSeconds !== x.max);
    return `<tr>
      <td><b>${esc(FMT_SHORT[f])}</b><div class="small muted">${f === "main" ? "16:9" : "9:16"}${x.ownScript ? "" : " · no own script yet"}</div></td>
      <td>${dur(x.target)}<div class="small muted">${dur(x.min)}–${dur(x.max)}</div>${changed ? `<div class="small" style="color:var(--orange)">last run used ${esc(fmtRange(snap))}</div>` : ""}</td>
      <td>${x.estimate ? `${dur(x.estimate.seconds)} ${verdictPill(x.estimate.verdict)}<div class="small muted">${x.estimate.spokenWords} spoken + ${x.estimate.sungWords} sung words</div>` : "—"}</td>
      <td>${x.narrationSeconds != null ? dur(x.narrationSeconds) : "—"}</td>
      <td>${x.audioSeconds != null ? `${dur(x.audioSeconds)} ${verdictPill(x.audioVerdict)}` : "—"}</td>
      <td>${x.finalSeconds != null ? dur(x.finalSeconds) : "—"}</td>
      <td>${x.review ? `${pill(x.review.pass ? `passed ${x.review.average}` : `failed ${x.review.average}`, x.review.pass ? "ok" : "bad")}${x.review.pass ? "" : `<div class="small err">${esc([...x.review.blocking, ...x.review.reasons].slice(0, 3).join("; "))}</div>`}` : pill("not reviewed")}</td>
    </tr>`;
  };
  return `<div class="panel tablewrap"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">Formats and duration</h3><a class="small" href="#/settings">Duration settings</a></div>
    <table class="small"><thead><tr><th>Cut</th><th>Target / allowed</th><th>Script estimate</th><th>Narration (measured)</th><th>Soundtrack (measured)</th><th>Final video</th><th>Editorial review</th></tr></thead>
    <tbody>${["main", "short"].map(row).join("")}</tbody></table>
    <div class="small muted" style="margin-top:6px">Estimates use the configured delivery rate and the real timeline (bars, sung chorus). Measured lengths come from the audio stage and the rendered file.</div></div>`;
}

// ----- research & editorial review -----

function renderResearchTab(body) {
  const v = S.video;
  const r = v.research;
  const outlines = v.outline?.formats ?? {};
  const reviews = v.editorialReview?.formats ?? {};
  if (!r) {
    body.innerHTML = `<div class="panel empty">No research dossier yet. Videos are now researched before any script is written. <button class="primary" id="runRes" ${v.job ? "disabled" : ""}>Run research</button></div>`;
    $("#runRes", body).onclick = () => startJob(v.slug, { mode: "stage", stage: "research" }).catch(() => {});
    return;
  }
  const q = r.qualification;
  const cls = { supported: "ok", qualified: "warn", insufficient: "bad", excluded: "bad" };
  const rubric = S.meta.rubric ?? {};
  const reviewHtml = (f) => {
    const x = reviews[f];
    if (!x) return `<div class="small muted">Not reviewed yet.</div>`;
    return `<div class="row">${pill(x.verdict.pass ? "PASS" : "FAIL", x.verdict.pass ? "ok" : "bad")} <span class="small muted">average ${x.verdict.average} · ${ago(Date.parse(x.at))} · ${x.history.length} round(s)</span></div>
      <p class="small">${esc(x.summary)}</p>
      ${x.verdict.reasons.length ? `<div class="small err">${x.verdict.reasons.map(esc).join("<br>")}</div>` : ""}
      <table class="small"><tbody>${Object.keys(rubric).map((k) => `<tr><td title="${esc(rubric[k])}">${esc(k)}</td><td>${"●".repeat(x.scores[k] ?? 0)}${"○".repeat(5 - (x.scores[k] ?? 0))} ${x.scores[k] ?? "?"}</td></tr>`).join("")}</tbody></table>
      ${x.blocking.length ? `<div class="small err" style="margin-top:6px"><b>Blocking:</b> ${x.blocking.map((b) => esc(`${b.shot ? b.shot + ": " : ""}${b.problem}`)).join("<br>")}</div>` : ""}
      ${x.findings.length ? `<details style="margin-top:6px"><summary class="small">${x.findings.length} finding(s)</summary>${x.findings.map((f) => `<div class="small" style="margin:4px 0">${pill(f.severity ?? "", f.severity === "major" ? "bad" : "warn")} <b>${esc(f.shot ?? "")}</b> [${esc(f.criterion ?? "")}] ${esc(f.problem)}<div class="muted">Fix: ${esc(f.fix)}</div></div>`).join("")}</details>` : ""}`;
  };
  const outlineHtml = (f) => {
    const o = outlines[f];
    if (!o) return `<div class="small muted">No outline yet.</div>`;
    return `<div class="small"><b>Opening:</b> ${esc(o.openingQuestion)}</div>
      <div class="small"><b>Understanding:</b> ${esc(o.understandingChange)}</div>
      <div class="small muted">${esc(o.structure)} · ${o.beats.length} beats · planned ${dur(o.beats.reduce((n, b) => n + b.seconds, 0))} · fit: ${esc(o.fit.verdict)} (${esc(o.fit.note)})</div>
      ${f === "short" && o.coreInsight ? `<div class="small"><b>Core insight:</b> ${esc(o.coreInsight)}</div>` : ""}
      <ol class="small" style="margin:6px 0 0 18px;padding:0">${o.beats.map((b) => `<li><b>${esc(b.role)}</b> ${esc(b.point)} <span class="muted">${dur(b.seconds)} · ${esc((b.claimIds ?? []).join(", "))}</span></li>`).join("")}</ol>
      <div class="small" style="margin-top:4px"><b>Conclusion:</b> ${esc(o.conclusion)}</div>
      ${o.chorus ? `<div class="small" style="color:var(--yellow)">♪ ${esc(o.chorus.line)} <span class="muted">(${esc(o.chorus.reinforces)})</span></div>` : ""}
      ${o.longFormOnly?.length ? `<div class="small muted">Long-form only: ${esc(o.longFormOnly.join("; "))}</div>` : ""}`;
  };
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:8px"><h3 class="grow" style="margin:0">Topic qualification</h3>${pill(q.verdict, q.verdict === "proceed" ? "ok" : q.verdict === "narrow" ? "warn" : "bad")} <span class="small muted"><code>specs/${esc(v.slug)}.research.json</code> · ${ago(Date.parse(r.at))}</span>
        <button class="sm" data-stage="research" ${v.job ? "disabled" : ""}>Re-run research</button></div>
      <div><b>${esc(q.centralQuestion)}</b></div>
      <div class="small">Angle: ${esc(q.selectedAngle)} <span class="muted">— ${esc(q.reason)}</span></div>
      <div class="small muted">Supports about ${q.supportedMinutes.min}–${q.supportedMinutes.max} min without padding · Short insight: ${esc(q.shortInsight)}</div>
      <div class="small muted">${Object.entries(q.scores).map(([k, n]) => `${esc(k)} ${n}/5`).join(" · ")}</div>
      ${q.angles?.length > 1 ? `<details><summary class="small">Angles compared (${q.angles.length})</summary>${q.angles.map((a) => `<div class="small" style="margin:4px 0"><b>${esc(a.angle)}</b> ${pill(a.evidence ?? "")}<div class="muted">+ ${esc(a.strengths)} · − ${esc(a.weaknesses)}</div></div>`).join("")}</details>` : ""}
    </div>
    <div class="panel">
      <h3>Thesis and mechanism</h3>
      <div><b>${esc(r.thesis.statement)}</b></div>
      <div class="small">Mental model: ${esc(r.thesis.mentalModel)} <span class="muted">(${esc(r.thesis.claimIds.join(", "))})</span></div>
      <p class="small">${esc(r.mechanism)}</p>
      ${r.misconceptions.map((m) => `<div class="small">✕ ${esc(m.misconception)} → ✓ ${esc(m.correction)}</div>`).join("")}
      <details style="margin-top:6px"><summary class="small">Examples, insights, uncertainties</summary>
        ${r.examples.map((e) => `<div class="small">• [${esc(e.kind ?? "")}] ${esc(e.description)}${e.caveat ? ` <span class="muted">(caveat: ${esc(e.caveat)})</span>` : ""}</div>`).join("")}
        <div class="small" style="margin-top:6px"><b>Insights (most valuable first)</b></div>${r.insights.map((x) => `<div class="small">${esc(x.insight)}</div>`).join("")}
        ${r.uncertainties.length ? `<div class="small" style="margin-top:6px"><b>Uncertainties</b></div>${r.uncertainties.map((x) => `<div class="small muted">${esc(x)}</div>`).join("")}` : ""}
        <div class="small muted" style="margin-top:6px">${esc(r.sourceQuality)}</div>
      </details>
    </div>
    <div class="grid2">
      ${["main", "short"].map((f) => `<div class="panel"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">${esc(FMT_SHORT[f])} outline</h3><button class="sm ghost" data-stage="outline" ${v.job ? "disabled" : ""}>Re-plan</button></div>${outlineHtml(f)}</div>`).join("")}
    </div>
    <div class="grid2">
      ${["main", "short"].map((f) => `<div class="panel"><div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">${esc(FMT_SHORT[f])} editorial review</h3><button class="sm ghost" data-stage="review" ${v.job ? "disabled" : ""}>Re-review</button></div>${reviewHtml(f)}</div>`).join("")}
    </div>
    <div class="panel"><h3>Claims (${r.claims.length})</h3>
      ${r.claims.map((c) => `<div class="claim ${c.status === "supported" ? "ok" : c.status === "qualified" ? "fix" : "cut"}">
        <div class="row"><span class="c grow">${esc(c.text)}</span>${pill(c.id)}${pill(c.status, cls[c.status])}</div>
        ${c.qualification ? `<div class="small corr">Qualification: ${esc(c.qualification)}</div>` : ""}${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ""}
        ${c.sources?.length ? `<ul>${c.sources.map((s) => `<li class="small"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a> ${pill(s.kind)} ${pill(s.accessed === "fetched" ? "opened" : "search result only", s.accessed === "fetched" ? "ok" : "warn")}<div class="muted">${esc(s.passage)} — supports: ${esc(s.supports)}</div></li>`).join("")}</ul>` : ""}
      </div>`).join("")}
    </div>`;
  $$("[data-stage]", body).forEach((b) => (b.onclick = () => startJob(v.slug, { mode: "stage", stage: b.dataset.stage }).catch(() => {})));
}

// ----- settings: video formats and duration -----

let settingsSchema = null;
const loadSettingsSchema = async () => (settingsSchema ??= await import("/schema/settings.mjs"));

async function renderSettings() {
  const [data, schema] = await Promise.all([api("/api/settings"), loadSettingsSchema()]);
  S.settings = data;
  const eff = data.settings;
  const mmss = (sec) => ({ m: Math.floor(sec / 60), s: Math.round(sec % 60) });
  const durInput = (f, k, label, help) => {
    const v = mmss(eff.formats[f][k]);
    return `<div class="field"><label for="${f}-${k}-m">${label}</label>
      <div class="row dur" style="flex-wrap:nowrap"><input id="${f}-${k}-m" data-f="${f}" data-k="${k}" data-u="m" type="number" min="0" step="1" inputmode="numeric" value="${v.m}" aria-label="${label} minutes" /><span class="small muted">min</span>
      <input id="${f}-${k}-s" data-f="${f}" data-k="${k}" data-u="s" type="number" min="0" max="59" step="1" inputmode="numeric" value="${v.s}" aria-label="${label} seconds" /><span class="small muted">sec</span></div>
      <div class="small muted">${help}</div></div>`;
  };
  const card = (f) => `<div class="panel" data-format="${f}">
      <div class="row" style="margin-bottom:8px"><h3 class="grow" style="margin:0">${esc(data.labels[f])}</h3><button class="sm ghost" data-reset="${f}">Reset to defaults</button></div>
      ${durInput(f, "targetSeconds", "Target duration", "What scripts are written for.")}
      <div class="grid2" style="gap:8px">${durInput(f, "minSeconds", "Minimum", "Shorter fails.")}${durInput(f, "maxSeconds", "Maximum", "Longer fails.")}</div>
      <div class="small muted">Default: ${esc(fmtRange(data.defaults.formats[f]))}</div>
      <div class="err small" data-err="${f}"></div>
    </div>`;
  app.innerHTML = `
    <div class="pagehead"><div><h1>Settings</h1><div class="sub">Saved in <code>${esc(data.path)}</code>. New jobs take a snapshot when they start; running and finished jobs keep the settings they started with.</div></div></div>
    <div class="panel"><h3>In effect now</h3>
      <div class="row">${["main", "short"].map((f) => `<span>${esc(data.labels[f])}: <b>${esc(fmtRange(eff.formats[f]))}</b></span>`).join(" · ")} · <span>Narration ${eff.narration.wordsPerMinute} wpm, tolerance ±${Math.round(eff.narration.targetTolerance * 100)}%</span></div>
      <div class="small muted">Source: ${esc(data.source === "defaults" ? "built-in defaults (nothing saved yet)" : data.source === "file" ? "saved settings" : "saved settings, with defaults for missing parts")}${data.at ? ` · saved ${ago(data.at)}` : ""}</div>
      ${data.warnings.map((w) => `<div class="small" style="color:var(--orange)">⚠ ${esc(w)}</div>`).join("")}
    </div>
    <form id="settingsForm" novalidate>
      <h2>Video formats and duration <span id="setDirty" class="pill warn" hidden>unsaved</span></h2>
      <div class="grid2">${card("main")}${card("short")}</div>
      <div class="panel">
        <h3>Runtime estimation</h3>
        <div class="grid2" style="gap:8px">
          <div class="field"><label for="wpm">Narration delivery rate (words per minute)</label><input id="wpm" type="number" min="60" max="300" step="1" value="${eff.narration.wordsPerMinute}" /><div class="small muted">Used to estimate a script's runtime before audio exists. The audio stage reports the measured rate, so you can calibrate this.</div></div>
          <div class="field"><label for="tol">Target tolerance (%)</label><input id="tol" type="number" min="1" max="100" step="1" value="${Math.round(eff.narration.targetTolerance * 100)}" /><div class="small muted">Inside the allowed range but further than this from the target is flagged as a warning, not a failure.</div></div>
        </div>
        <div class="err small" data-err="narration"></div>
      </div>
      <div id="setErr" class="err small" role="alert"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="ghost" id="setRevert" disabled>Discard changes</button><button type="submit" class="primary" id="setSave" disabled>Save settings</button></div>
    </form>`;
  const form = $("#settingsForm");
  const read = () => {
    const num = (el) => (el.value.trim() === "" ? NaN : Number(el.value));
    const out = { formats: { main: {}, short: {} }, narration: { wordsPerMinute: num($("#wpm")), targetTolerance: num($("#tol")) / 100 } };
    const unitErrors = [];
    for (const f of ["main", "short"])
      for (const k of ["targetSeconds", "minSeconds", "maxSeconds"]) {
        const m = num($(`[data-f=${f}][data-k=${k}][data-u=m]`, form));
        const sec = num($(`[data-f=${f}][data-k=${k}][data-u=s]`, form));
        if (!(m >= 0) || !(sec >= 0) || sec > 59 || !Number.isInteger(m) || !Number.isInteger(sec)) unitErrors.push(`${data.labels[f]}: ${k.replace("Seconds", "")} needs whole minutes and 0-59 seconds`);
        out.formats[f][k] = m * 60 + sec;
      }
    return { out, unitErrors };
  };
  const check = () => {
    const { out, unitErrors } = read();
    const problems = [...unitErrors, ...schema.validateSettings(out)];
    for (const f of ["main", "short"]) $(`[data-err=${f}]`, form).textContent = problems.filter((x) => x.startsWith(data.labels[f])).join(" · ");
    $("[data-err=narration]", form).textContent = problems.filter((x) => /rate|tolerance/i.test(x)).join(" · ");
    $("#setSave").disabled = !S.settingsDirty || problems.length > 0;
    return { out, problems };
  };
  const dirty = () => {
    S.settingsDirty = true;
    $("#setDirty").hidden = false;
    $("#setRevert").disabled = false;
    check();
  };
  $$("input", form).forEach((el) => (el.oninput = dirty));
  $$("[data-reset]", form).forEach((b) => (b.onclick = () => {
    const f = b.dataset.reset;
    for (const k of ["targetSeconds", "minSeconds", "maxSeconds"]) {
      const v = mmss(data.defaults.formats[f][k]);
      $(`[data-f=${f}][data-k=${k}][data-u=m]`, form).value = v.m;
      $(`[data-f=${f}][data-k=${k}][data-u=s]`, form).value = v.s;
    }
    dirty();
    toast(`${data.labels[f]} reset to the defaults; save to apply`);
  }));
  $("#setRevert").onclick = () => { S.settingsDirty = false; renderSettings(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { out, problems } = check();
    if (problems.length) return toast("Fix the highlighted values first", true);
    $("#setSave").disabled = true;
    try {
      await api("/api/settings", { method: "PUT", body: out });
      S.settingsDirty = false;
      toast("Settings saved. New jobs will use them.");
      renderSettings();
    } catch (err) {
      $("#setErr").textContent = `Not saved: ${err.message}`;
      toast(`Not saved: ${err.message}`, true);
      $("#setSave").disabled = false;
    }
  };
  check();
}

// ----- storyboard editor -----

const fieldsFor = {
  title: ["kicker", "title", "subtitle", "icon"],
  kinetic: ["style", "lines", "emphasis"],
  character: ["say", "prop"],
};

function renderStoryboardTab(body) {
  const v = S.video;
  if (!S.spec) {
    body.innerHTML = `<div class="panel empty">No storyboard yet. <button class="primary" data-stage-run="script">Write the script</button></div>`;
    $("[data-stage-run]", body).onclick = () => startJob(v.slug, { mode: "direct" }).catch(() => {});
    return;
  }
  const spec = S.spec;
  const tl = S.specFormat === "short" ? v.timelineShort : v.timeline;
  const latestQa = v.candidates?.find((c) => v.qa?.[c.id]);
  const frames = latestQa ? v.qa[latestQa.id].frames.filter((f) => f.format === (S.specFormat === "short" ? "short" : "main") && f.pct === 0.5) : [];
  const thumb = (id) => frames.find((f) => f.shot === id);
  const selected = new Set(S.selectedShots ?? []);
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        ${v.shortSpecJson ? `<select id="specFmt" style="width:auto" title="Each format has its own storyboard"><option value="main" ${S.specFormat !== "short" ? "selected" : ""}>Landscape (16:9)</option><option value="short" ${S.specFormat === "short" ? "selected" : ""}>Short (9:16)</option></select>` : ""}
        <div class="grow small muted"><code>specs/${esc(v.slug)}${S.specFormat === "short" ? ".short" : ""}.json</code> · storyboard v${esc(v.specRawVersion ?? 2)} · ${spec.shots?.length ?? 0} shots · ${esc(spec.music?.bpm)} bpm ${esc(spec.music?.key ?? "")} ${esc(spec.music?.mode ?? "")} · world ${esc(spec.world ?? "night")} · ${spec.direction?.status === "directed" ? pill("directed", "ok") : pill("draft: not directed yet", "warn")}
          <span id="dirty" class="pill warn" ${S.specDirty ? "" : "hidden"}>unsaved</span></div>
        <button class="ghost sm" id="toggleRaw">${S.specRaw ? "Shot editor" : "Raw JSON"}</button>
        <button class="ghost sm" id="validate">Validate</button>
        <button class="ghost sm" id="revert" ${S.specDirty ? "" : "disabled"}>Revert</button>
        <button class="primary" id="saveSpec" ${S.specDirty ? "" : "disabled"}>Save</button>
      </div>
      <div id="specErr" class="err small"></div>
      <div id="specLint" class="small" style="color:var(--orange)"></div>
      <div id="specBody"></div>
    </div>
    <div class="panel">
      <h3>Targeted regeneration</h3>
      <p class="small muted">Select shots above, then redirect them with Claude (optionally with notes), or render quick half-resolution previews of just those shots. The rest of the storyboard is kept.</p>
      <textarea id="redirectNotes" rows="2" placeholder="Notes for the director, e.g. 'use a comparison instead; fewer labels'"></textarea>
      <div class="row" style="margin-top:8px"><span class="small muted grow" id="selCount">${selected.size} shot(s) selected</span>
        <button id="redirect" ${v.job || !selected.size ? "disabled" : ""}>Redirect selected shots</button>
        <button id="previewShots" ${v.job || !selected.size ? "disabled" : ""}>Preview selected shots</button></div>
    </div>`;
  const markDirty = () => {
    S.specDirty = true;
    $("#dirty").hidden = false;
    $("#saveSpec").disabled = false;
    $("#revert").disabled = false;
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
    sb.innerHTML = `<div class="shots">${spec.shots.map((s, i) => {
      const t = tl?.shots?.find((x) => x.id === s.id);
      const th = thumb(s.id);
      return `<div class="shot sec-${esc(s.section)} ${S.openShot === s.id ? "open" : ""}" data-id="${esc(s.id)}">
        <div class="shot-head">
          <input type="checkbox" class="sel" ${selected.has(s.id) ? "checked" : ""} title="Select for targeted regeneration" />
          <span class="n">${i + 1}</span>
          ${th && latestQa ? `<img class="thumb" src="/media/${esc(v.slug)}/c/${esc(latestQa.id)}/qa/${esc(th.file)}" loading="lazy" />` : `<div class="thumb ph">${esc(s.visual?.type)}</div>`}
          <div class="grow">
            <div><b>${esc(s.headline ?? s.lyric ?? s.visual?.title ?? s.id)}</b> ${pill(s.visual?.type ?? "?", s.visual?.type === "scene3d" ? "hi" : "")} ${pill(s.section)} ${s.short ? pill("in Short", "run") : ""} ${s.mascot ? pill("mascot") : ""} ${s.camera?.move && s.camera.move !== "static" ? pill(s.camera.move) : ""}</div>
            <div class="small muted">${esc(s.narration ?? (s.lyric ? `♪ ${s.lyric}` : ""))}</div>
            <div class="small muted">${t ? `${(t.startFrame / 30).toFixed(1)}s · ${t.bars} bars · ${t.transition}` : ""}${s.purpose ? ` · ${esc(s.purpose)}` : ""}</div>
          </div>
          <button class="sm ghost" data-toggle>${S.openShot === s.id ? "Close" : "Edit"}</button>
        </div>
        ${S.openShot === s.id ? shotEditor(s) : ""}
      </div>`;
    }).join("")}</div>`;
    $$(".shot", sb).forEach((row) => {
      const id = row.dataset.id;
      const shot = spec.shots.find((x) => x.id === id);
      $("[data-toggle]", row).onclick = () => { S.openShot = S.openShot === id ? null : id; renderStoryboardTab(body); };
      $(".sel", row).onchange = (e) => {
        const set = new Set(S.selectedShots ?? []);
        e.target.checked ? set.add(id) : set.delete(id);
        S.selectedShots = [...set];
        $("#selCount").textContent = `${set.size} shot(s) selected`;
        $("#redirect").disabled = $("#previewShots").disabled = Boolean(v.job) || !set.size;
      };
      $$("[data-f]", row).forEach((el) => (el.oninput = () => {
        const k = el.dataset.f;
        const val = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? undefined : Number(el.value)) : el.value;
        if (val === "" || val === undefined || val === false) delete shot[k];
        else shot[k] = val;
        markDirty();
      }));
      const vis = $("[data-visual]", row);
      if (vis) vis.oninput = () => {
        try {
          shot.visual = JSON.parse(vis.value);
          $("#specErr").textContent = "";
          markDirty();
        } catch (e) {
          $("#specErr").textContent = `Shot ${id} visual: JSON error: ${e.message}`;
        }
      };
    });
  }
  const fmtSel = $("#specFmt");
  if (fmtSel) fmtSel.onchange = () => {
    if (S.specDirty) { fmtSel.value = S.specFormat ?? "main"; return toast("Save or revert your edits first", true); }
    S.specFormat = fmtSel.value;
    S.spec = editedSpec(v) ? structuredClone(editedSpec(v)) : null;
    S.openShot = null;
    renderStoryboardTab(body);
  };
  $("#toggleRaw").onclick = () => {
    if (S.specRaw && $("#specErr").textContent) return toast("Fix the JSON error first", true);
    S.specRaw = !S.specRaw;
    renderStoryboardTab(body);
  };
  $("#revert").onclick = () => {
    S.specDirty = false;
    S.spec = structuredClone(editedSpec(S.video));
    renderStoryboardTab(body);
  };
  $("#validate").onclick = async () => {
    const r = await act(() => api(`/api/videos/${v.slug}/validate`, { method: "POST", body: S.spec }));
    $("#specErr").textContent = r.problems.join("\n");
    $("#specLint").innerHTML = r.lint.map((l) => `⚠ ${esc(l)}`).join("<br>");
    if (r.ok) toast(r.lint.length ? `Valid, with ${r.lint.length} suggestion(s)` : "Valid");
  };
  $("#saveSpec").onclick = async () => {
    if ($("#specErr").textContent.includes("JSON")) return toast("Fix the JSON error first", true);
    try {
      const r = await api(`/api/videos/${v.slug}/spec${S.specFormat === "short" ? "?format=short" : ""}`, { method: "PUT", body: S.spec });
      toast("Storyboard saved (previous version archived)");
      S.specDirty = false;
      await loadVideo(v.slug, true);
      renderStoryboardTab(body);
      $("#specLint").innerHTML = (r.lint ?? []).map((l) => `⚠ ${esc(l)}`).join("<br>");
      renderVideoHead();
    } catch (e) {
      $("#specErr").textContent = e.message;
    }
  };
  $("#redirect").onclick = () => {
    if (S.specDirty) return toast("Save or revert your edits first", true);
    startJob(v.slug, { mode: "stage", stage: "direct", shots: S.selectedShots, notes: $("#redirectNotes").value }).catch(() => {});
  };
  $("#previewShots").onclick = () => {
    if (S.specDirty) return toast("Save or revert your edits first", true);
    startJob(v.slug, { mode: "stage", stage: "render", shots: S.selectedShots, preview: true }).catch(() => {});
  };
}

function shotEditor(s) {
  const opt = (list, cur) => list.map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
  return `<div class="shot-edit">
    <div class="grid3">
      <div class="field"><label>Section</label><select data-f="section">${opt(S.meta.sections, s.section)}</select></div>
      <div class="field"><label>Min bars</label><input data-f="minBars" type="number" min="1" max="16" value="${esc(s.minBars ?? "")}" placeholder="auto" /></div>
      <div class="field"><label>Transition in</label><select data-f="transition"><option value="">auto</option>${opt(["cut", "fade", "wipe", "push", "zoom"], s.transition)}</select></div>
    </div>
    <div class="field"><label>Headline (max ~5 words)</label><input data-f="headline" value="${esc(s.headline ?? "")}" /></div>
    <div class="field"><label>Narration (spoken; changing it re-runs the fact-check and audio)</label><textarea data-f="narration" rows="2">${esc(s.narration ?? "")}</textarea></div>
    <div class="field"><label>Lyric (sung)</label><input data-f="lyric" value="${esc(s.lyric ?? "")}" /></div>
    <div class="field"><label>Purpose (editorial, not rendered)</label><input data-f="purpose" value="${esc(s.purpose ?? "")}" /></div>
    <label class="check"><input type="checkbox" data-f="short" ${s.short ? "checked" : ""}/> Include in the vertical Short</label>
    <div class="field" style="margin-top:10px"><label>Visual (JSON; type is one of ${esc(Object.keys(S.meta.visuals).join(", "))})</label><textarea class="code" data-visual rows="10" style="min-height:180px">${esc(JSON.stringify(s.visual, null, 2))}</textarea>
      <div class="small muted">${esc(S.meta.visuals[s.visual?.type] ?? "")}</div></div>
  </div>`;
}

// ----- fact-check -----

function renderFactTab(body) {
  const v = S.video;
  const claims = v.sourcesJson?.claims ?? [];
  if (!v.sourcesJson) {
    body.innerHTML = `<div class="panel empty">No fact-check yet. ${v.spec ? `<button class="primary" id="runFc">Run fact-check</button>` : "Write the script first."}</div>`;
    const b = $("#runFc", body);
    if (b) b.onclick = () => startJob(v.slug, { mode: "stage", stage: "factcheck" }).catch(() => {});
    return;
  }
  const flagged = claims.filter((c) => c.verdict !== "ok");
  const filter = S.fcFilter ?? (flagged.length ? "flagged" : "all");
  const shown = filter === "flagged" ? flagged : claims;
  const fc = v.stages?.factcheck;
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <div class="grow">${flagged.length ? pill(`${flagged.length} flagged`, "bad") : pill("All claims ok", "ok")} <span class="muted small">${claims.length} claims (narration, lyrics, headlines and diagram labels) · <code>specs/${esc(v.slug)}.sources.json</code> · ${ago(v.factcheck.at)}</span>
          ${fc?.status === "stale" ? pill(fc.reason, "warn") : ""}</div>
        <select id="fcFilter" style="width:auto"><option value="flagged">Flagged only</option><option value="all">All claims</option></select>
        <button class="sm" id="rerun" ${v.job ? "disabled" : ""}>Check new text</button>
      </div>
      <p class="small muted">Only new or edited text is sent to Claude; text that already passed keeps its verdict and sources.</p>
      ${shown.length ? shown.map((c) => `
        <div class="claim ${esc(c.verdict)}">
          <div class="row"><span class="c grow">${esc(c.claim)}</span>${c.shot ? pill(c.shot) : ""}${pill(c.verdict, c.verdict === "ok" ? "ok" : c.verdict === "fix" ? "warn" : "bad")}</div>
          ${c.correction ? `<div class="corr small"><b>Correction:</b> ${esc(c.correction)}</div>` : ""}
          ${c.note ? `<div class="small muted">${esc(c.note)}</div>` : ""}
          ${c.sources?.length ? `<ul>${c.sources.map((s) => (typeof s === "string" ? { url: s } : s)).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>${s.passage ? `<div class="small muted">${esc(s.passage)}</div>` : ""}</li>`).join("")}</ul>` : '<div class="small muted">No sources attached</div>'}
        </div>`).join("") : `<div class="empty">No flagged claims.</div>`}
    </div>`;
  $("#fcFilter", body).value = filter;
  $("#fcFilter", body).onchange = (e) => { S.fcFilter = e.target.value; renderFactTab(body); };
  $("#rerun", body).onclick = () => startJob(v.slug, { mode: "stage", stage: "factcheck" }).catch(() => {});
}

// ----- assets & audio -----

function renderAssetsTab(body) {
  const v = S.video;
  const a = v.assets;
  const m = v.audioManifest;
  const env = S.meta.env?.tools;
  const clips = Object.entries(a?.clips ?? {});
  body.innerHTML = `
    <div class="grid2">
      <div class="panel">
        <h3>Audio</h3>
        ${m ? `
          <div class="row">${Object.entries(m.formats).map(([f, t]) => `${f === "main" ? "16:9" : "9:16"} ${audioPill(t.status)}`).join(" ")} ${v.stages?.audio?.status === "stale" ? pill("out of date", "warn") : ""}</div>
          <table class="kv small" style="margin-top:10px">
            <tr><td>Narration</td><td>${esc(m.providers.voice)}</td></tr>
            <tr><td>Music</td><td>${esc(m.providers.music === "synth" ? "built-in composer (local, original)" : m.providers.music)}</td></tr>
            <tr><td>Sung chorus</td><td>${esc(m.providers.vocals === "chant" ? "pitched speech on the beat (local)" : m.providers.vocals)}</td></tr>
            ${Object.entries(m.formats).map(([f, t]) => `<tr><td>${f}</td><td>${dur(t.seconds)} · ${t.loudness ? `${t.loudness.I} LUFS, peak ${t.loudness.TP} dBTP` : "loudness unknown"} · ${Object.entries(t.has).filter(([, x]) => x).map(([k]) => k).join(", ")}</td></tr>`).join("")}
          </table>
          ${m.warnings?.length ? m.warnings.map((w) => `<div class="small" style="color:var(--orange)">⚠ ${esc(w)}</div>`).join("") : ""}
          <div style="margin-top:10px">${Object.entries(m.formats).map(([f, t]) => `<label>Final mix (${f === "main" ? "16:9" : "9:16"})</label><audio controls preload="none" src="/media/${esc(v.slug)}/gen/${esc(String(t.src).split("/").pop())}"></audio>`).join("")}
          <label style="margin-top:8px">Music only</label><audio controls preload="none" src="/media/${esc(v.slug)}/audio/music-main.wav"></audio></div>
          <details style="margin-top:8px"><summary class="small muted">Licences and provenance</summary>${m.licenses.map((l) => `<div class="small">${esc(l)}</div>`).join("")}</details>`
        : `<p class="muted small">No audio yet. Videos are only marked finished with audio; without it a render is a silent preview.</p>`}
        <div class="small muted" style="margin-top:10px">Voice available: macOS say ${env?.voice?.say ? "yes" : "no"}, ElevenLabs ${env?.voice?.elevenlabs ? "key set" : "not configured"} (optional, paid). Selected: <b>${esc(env?.voice?.selected ?? "?")}</b></div>
        <div class="row" style="margin-top:10px"><button class="sm" data-stage="audio" ${v.job ? "disabled" : ""}>Rebuild audio</button></div>
      </div>
      <div class="panel">
        <h3>Assets</h3>
        ${a ? `
          <div class="small">${a.builtins.length} built-in illustrations: <span class="muted">${esc(a.builtins.join(", "))}</span></div>
          <div class="small" style="margin-top:6px">${a.items.length ? a.items.map((i) => `<div>${pill(i.status, i.status === "ok" ? "ok" : i.required ? "bad" : "warn")} <b>${esc(i.id)}</b> ${i.required ? "required" : "optional"} · ${esc(i.license ?? "no licence")} · shots ${esc(i.shots.join(", "))}</div>`).join("") : "No external files used."}</div>
          ${a.missingRequired ? `<div class="err small" style="margin-top:6px">${a.missingRequired} required asset(s) missing: add the file under public/ and an entry with licence and source in assets/manifest.json.</div>` : ""}`
        : `<p class="muted small">Not resolved yet.</p>`}
        <h3 style="margin-top:14px">3D clips (optional Blender backend)</h3>
        <div class="small">Blender: ${env?.blender?.available ? `${esc(env.blender.version)} ${env.blender.enabled ? pill("enabled", "ok") : pill("disabled (BLENDER=off)", "warn")}` : pill("not installed", "warn")}</div>
        ${clips.length ? clips.map(([id, c]) => Object.entries(c).map(([f, x]) => `<div class="small" style="margin-top:6px">${pill(x.status, x.status === "fallback" ? "warn" : "ok")} <b>${esc(id)}</b> (${f}) ${x.renderSeconds ? `rendered in ${dur(x.renderSeconds)}` : ""} ${x.reason ? `<span class="muted">${esc(x.reason.slice(0, 200))}</span>` : ""}
          ${x.src ? `<video controls muted preload="none" src="/media/${esc(v.slug)}/3d/${esc(x.src.split("/").pop())}" style="margin-top:4px;max-height:200px"></video>` : ""}</div>`).join("")).join("") : `<div class="small muted">No shot uses a 3D scene.</div>`}
        <div class="row" style="margin-top:10px"><button class="sm" data-stage="assets" ${v.job ? "disabled" : ""}>Re-resolve assets / re-render 3D</button></div>
      </div>
    </div>`;
  $$("[data-stage]", body).forEach((b) => (b.onclick = () => startJob(v.slug, { mode: "stage", stage: b.dataset.stage }).catch(() => {})));
}

// ----- quality -----

function renderQualityTab(body) {
  const v = S.video;
  const cands = (v.candidates ?? []).filter((c) => v.qa?.[c.id]);
  if (!cands.length) {
    body.innerHTML = `<div class="panel empty">No quality report yet. ${v.candidates?.length ? `<button class="primary" data-stage="qa">Run QA on the latest candidate</button>` : "Render a candidate first."}</div>`;
    const b = $("[data-stage]", body);
    if (b) b.onclick = () => startJob(v.slug, { mode: "stage", stage: "qa" }).catch(() => {});
    return;
  }
  const id = S.qaCand && v.qa[S.qaCand] ? S.qaCand : cands[0].id;
  const r = v.qa[id];
  const sev = { fail: 0, warn: 1, info: 2 };
  const findings = [...r.findings].sort((a, b) => sev[a.severity] - sev[b.severity]);
  body.innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:10px">
        <select id="qaCand" style="width:auto">${cands.map((c) => `<option value="${esc(c.id)}" ${c.id === id ? "selected" : ""}>${esc(c.id)}${c.preview ? " (preview)" : ""} · ${esc(v.qa[c.id].status)}</option>`).join("")}</select>
        <span class="grow">${pill(r.status.toUpperCase(), r.status === "pass" ? "ok" : r.status === "warn" ? "warn" : "bad")} <span class="small muted">${esc(r.summary)}</span></span>
        <button class="sm" data-stage="qa" ${v.job ? "disabled" : ""}>Re-run QA</button>
        <button class="sm ghost" data-stage="qa" data-review="1" ${v.job ? "disabled" : ""}>+ Claude review</button>
      </div>
      <table class="small">
        <thead><tr><th></th><th>Check</th><th>Where</th><th>Finding</th><th>Fix belongs to</th></tr></thead>
        <tbody>${findings.map((f) => `<tr><td>${pill(f.severity, f.severity === "fail" ? "bad" : f.severity === "warn" ? "warn" : "")}</td><td class="mono">${esc(f.check)}</td><td>${esc([f.format, f.shot, f.at != null ? `${f.at.toFixed(1)}s` : ""].filter(Boolean).join(" · "))}</td><td>${esc(f.message)}</td><td>${esc(f.owner ?? "")}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No findings.</td></tr>`}</tbody>
      </table>
    </div>
    ${r.review ? `<div class="panel"><h3>Claude's review of the frames</h3><p>${esc(r.review.overall)} ${pill(`teaches: ${r.review.teaches}`, r.review.teaches === "yes" ? "ok" : "warn")}</p>
      <details><summary class="small muted">What it inspected</summary>${r.review.inspected.map((x) => `<div class="small">${esc(x)}</div>`).join("")}</details></div>` : ""}
    <div class="panel"><h3>Media</h3><table class="small"><tbody>${Object.entries(r.media).map(([f, m]) => `<tr><td>${f}</td><td>${m.width}x${m.height} · ${m.fps} fps · ${m.seconds.toFixed(2)}s (timeline ${m.expectedSeconds.toFixed(2)}s) · ${esc(m.video)} · audio ${esc(m.audio ?? "none")}${m.loudness ? ` · ${m.loudness.I} LUFS` : ""}</td></tr>`).join("")}</tbody></table></div>
    ${Object.entries(r.sheets).map(([f, s]) => `<div class="panel"><h3>Contact sheet · ${f === "main" ? "16:9" : "9:16"}</h3><a href="/media/${esc(v.slug)}/c/${esc(id)}/qa/${esc(s)}" target="_blank"><img class="sheet" src="/media/${esc(v.slug)}/c/${esc(id)}/qa/${esc(s)}" /></a></div>`).join("")}
    <div class="panel"><h3>Frames per shot (15% · 50% · 90%)</h3>
      <div class="framegrid">${groupFrames(r.frames.filter((f) => f.format === "main")).map(([shot, fs]) => `<div><div class="small"><b>${fs[0].index + 1}. ${esc(shot)}</b> <span class="muted">${esc(fs[0].type)}</span></div><div class="row">${fs.map((f) => `<img src="/media/${esc(v.slug)}/c/${esc(id)}/qa/${esc(f.file)}" loading="lazy" />`).join("")}</div></div>`).join("")}</div></div>`;
  $("#qaCand", body).onchange = (e) => { S.qaCand = e.target.value; renderQualityTab(body); };
  $$("[data-stage]", body).forEach((b) => (b.onclick = () => startJob(v.slug, { mode: "stage", stage: "qa", visualReview: Boolean(b.dataset.review) }).catch(() => {})));
}

function groupFrames(frames) {
  const m = new Map();
  for (const f of frames) m.set(f.shot, [...(m.get(f.shot) ?? []), f]);
  return [...m.entries()];
}

// ----- review / approval -----

function candidateMedia(v, c, format) {
  if (!c) return "";
  return c.files[format] ? `<video ${format === "short" ? 'class="vertical"' : ""} controls preload="metadata" src="/media/${esc(v.slug)}/c/${esc(c.id)}/${format}.mp4"></video>` : '<div class="empty">Not rendered</div>';
}

function renderReviewTab(body) {
  const v = S.video;
  const cands = (v.candidates ?? []).filter((c) => c.files.main || c.files.short);
  if (!cands.length) {
    if (v.render?.legacy) {
      body.innerHTML = `<div class="panel" style="border-color:var(--orange)"><div style="color:var(--orange)">⚠ This is an old-format render made before candidates, storyboards and audio. Run the pipeline to make a reviewable candidate.</div></div>
        <div class="videos"><div class="panel"><h3>Main video (16:9)</h3>${v.render.main ? `<video controls preload="metadata" src="/media/${esc(v.slug)}.mp4"></video>` : ""}</div>
        <div class="panel"><h3>Short (9:16)</h3>${v.render.short ? `<video class="vertical" controls preload="metadata" src="/media/${esc(v.slug)}-short.mp4"></video>` : ""}</div></div>`;
      return;
    }
    body.innerHTML = `<div class="panel empty">Nothing rendered yet. ${v.spec ? `<button class="primary" id="renderNow" ${v.job ? "disabled" : ""}>Continue production</button>` : "Write the script first."}</div>`;
    const b = $("#renderNow", body);
    if (b) b.onclick = () => startJob(v.slug, { mode: "continue" }).catch(() => {});
    return;
  }
  const c = cands.find((x) => x.id === S.cand) ?? cands[0];
  const cmp = S.compare ? cands.find((x) => x.id === S.compare) : null;
  const qa = v.qa?.[c.id];
  const warnings = [];
  if (c.preview) warnings.push("This is a half-resolution preview: it can't be approved.");
  if (!c.audio || Object.values(c.audio).some((s) => s !== "full")) warnings.push(`Audio: ${Object.entries(c.audio ?? {}).map(([f, s]) => `${f} ${AUDIO_TEXT[s] ?? s}`).join(", ") || "silent"}.`);
  if (v.factcheck?.flagged) warnings.push(`${v.factcheck.flagged} fact-check claim(s) are still flagged.`);
  if (v.stages?.factcheck?.status === "stale") warnings.push("Some on-screen or spoken text hasn't been fact-checked yet.");
  if (c.id === cands[0].id && v.stages?.render?.status === "stale") warnings.push(`This candidate is out of date: ${v.stages.render.reason}.`);
  if (!qa) warnings.push("QA hasn't run on this candidate.");
  else if (qa.status === "fail") warnings.push(`QA failed: ${qa.summary}`);
  const pkg = v.package?.[c.id];
  body.innerHTML = `
    <div class="panel">
      <div class="row">
        <label class="small" style="margin:0">Candidate</label>
        <select id="candSel" style="width:auto">${cands.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.id)}${x.preview ? " · preview" : ""}${x.approved ? " · APPROVED" : x.review ? ` · ${x.review.decision}` : ""}</option>`).join("")}</select>
        <label class="small" style="margin:0 0 0 12px">Compare with</label>
        <select id="cmpSel" style="width:auto"><option value="">nothing</option>${cands.filter((x) => x.id !== c.id).map((x) => `<option value="${esc(x.id)}" ${x.id === S.compare ? "selected" : ""}>${esc(x.id)}${x.approved ? " · APPROVED" : ""}</option>`).join("")}</select>
        <span class="grow"></span>${audioPill(c.audio?.main ?? c.audio?.short)} ${qa ? pill(`QA ${qa.status}`, qa.status === "pass" ? "ok" : qa.status === "warn" ? "warn" : "bad") : ""}
      </div>
    </div>
    ${warnings.length ? `<div class="panel" style="border-color:var(--orange)">${warnings.map((w) => `<div style="color:var(--orange)">⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
    ${cmp ? `<div class="grid2">
        <div class="panel"><h3>${esc(c.id)}</h3>${candidateMedia(v, c, "main")}</div>
        <div class="panel"><h3>${esc(cmp.id)} ${cmp.approved ? pill("approved", "ok") : ""}</h3>${candidateMedia(v, cmp, "main")}</div>
      </div><div class="small muted" style="margin:-8px 0 12px">Players are linked: play, pause and seek together.</div>`
    : `<div class="videos">
        <div class="panel"><h3>Main video (16:9)</h3>${candidateMedia(v, c, "main")}</div>
        <div class="panel"><h3>Short (9:16)</h3>${candidateMedia(v, c, "short")}</div>
      </div>`}
    <div class="panel">
      <div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0">Your decision on ${esc(c.id)}</h3>
        <span class="small muted">Playback speed</span>${[1, 1.5, 2].map((r) => `<button class="sm ghost" data-rate="${r}">${r}×</button>`).join("")}</div>
      <div class="small muted" style="margin-bottom:8px">Topic: ${statusPill(v.status)} ${v.review?.at ? `${esc(v.review.decision)} ${ago(Date.parse(v.review.at))}` : ""} ${c.review ? `· this candidate: ${esc(c.review.decision)} ${ago(Date.parse(c.review.at))}` : ""}</div>
      <textarea id="notes" rows="3" placeholder="Notes (what to fix, if rejecting). They are passed to the script writer on a fresh script.">${esc(c.review?.notes ?? v.review?.notes ?? "")}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="good" data-decide="approved" ${c.preview ? "disabled" : ""}>Approve this candidate</button>
        <button class="bad" data-decide="rejected">Reject with notes</button>
        ${v.status === "approved" || v.status === "rejected" ? `<button class="ghost" data-decide="review">Back to review</button>` : ""}
        <span class="grow"></span>
        <button class="sm" id="rerender" ${v.job ? "disabled" : ""}>Render a new candidate</button>
      </div>
    </div>
    ${pkg ? `<div class="panel"><h3>Package</h3><div class="row" style="align-items:flex-start"><img src="/media/${esc(v.slug)}/c/${esc(c.id)}/package/thumbnail.png" style="width:320px;border-radius:8px" />
      <div class="grow"><div><b>${esc(pkg.title)}</b></div><pre class="small" style="white-space:pre-wrap;max-height:240px;overflow:auto">${esc(pkg.description)}</pre><div class="small muted">Tags: ${esc(pkg.tags.join(", "))}</div><div class="small" style="color:var(--orange)">${esc(pkg.upload.note)}</div></div></div></div>` : ""}`;
  $("#candSel", body).onchange = (e) => { S.cand = e.target.value; renderReviewTab(body); };
  $("#cmpSel", body).onchange = (e) => { S.compare = e.target.value || null; renderReviewTab(body); };
  const vids = $$("video", body);
  $$("[data-rate]", body).forEach((b) => (b.onclick = () => vids.forEach((vid) => (vid.playbackRate = Number(b.dataset.rate)))));
  vids.forEach((vid) => vid.addEventListener("loadedmetadata", () => (vid.playbackRate = 2), { once: true }));
  if (cmp && vids.length === 2) linkPlayers(vids[0], vids[1]);
  $$("[data-decide]", body).forEach((b) => (b.onclick = async () => {
    const decision = b.dataset.decide;
    const notes = $("#notes", body).value;
    if (decision === "rejected" && !notes.trim()) return toast("Add a note saying what to fix", true);
    await act(() => api(`/api/videos/${v.slug}/review`, { method: "POST", body: { decision, notes, candidate: c.id } }), decision === "approved" ? "Approved" : decision === "rejected" ? "Rejected" : "Moved back to review").catch(() => {});
    await loadVideo(v.slug);
    renderVideoHead();
    renderReviewTab(body);
  }));
  $("#rerender", body).onclick = () => startJob(v.slug, { mode: "continue" }).catch(() => {});
}

function linkPlayers(a, b) {
  let busy = false;
  const sync = (src, dst) => {
    src.addEventListener("play", () => { if (!busy) { busy = true; dst.play(); busy = false; } });
    src.addEventListener("pause", () => { if (!busy) { busy = true; dst.pause(); busy = false; } });
    src.addEventListener("seeked", () => { if (!busy && Math.abs(dst.currentTime - src.currentTime) > 0.3) { busy = true; dst.currentTime = src.currentTime; busy = false; } });
  };
  sync(a, b);
  sync(b, a);
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
      <div class="chips" id="jobStages" style="margin-bottom:8px">${jobStagesHtml(j)}</div>
      ${j.flagged?.length ? `<div class="small" style="margin-bottom:8px">${pill(`${j.flagged.length} flagged in this run`, "warn")} <a href="#/video/${esc(v.slug)}/factcheck">see fact-check</a></div>` : ""}
      <pre class="log" id="log"></pre>
    </div>`;
  setLog(j.log);
  bindCancel(body);
  $("#jobSel", body).onchange = (e) => { S.logJobId = Number(e.target.value); renderLogsTab(body); };
}

const jobStagesHtml = (j) => Object.entries(j.stages ?? {}).map(([st, x]) => pill(`${STAGE_LABEL[st] ?? st}: ${x.cached ? "cached" : x.status}`, x.status === "done" ? "ok" : x.status === "running" ? "run spin" : x.status === "failed" ? "bad" : "warn", x.status === "running", x.summary ?? x.error ?? "")).join("");

// ---------- live updates ----------

let refreshTimer = null;
function softRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const r = S.route;
    if (document.querySelector("dialog[open]")) return;
    if (r.name === "videos" || r.name === "jobs" || r.name === "topics") return render();
    if (r.name === "video") {
      await loadVideo(r.slug);
      renderVideoHead();
      const tab = $("#tab");
      if (!tab) return;
      if (r.tab === "overview") renderOverviewTab(tab);
      else if (r.tab === "factcheck") renderFactTab(tab);
      else if (r.tab === "research") renderResearchTab(tab);
      else if (r.tab === "assets") renderAssetsTab(tab);
      else if (r.tab === "quality") renderQualityTab(tab);
      else if ((r.tab === "storyboard" || r.tab === "spec") && !S.specDirty && !S.openShot) renderStoryboardTab(tab);
    }
  }, 300);
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
      const st = $("#jobStages");
      if (st) st.innerHTML = jobStagesHtml(j);
      const opt = $(`#jobSel option[value="${j.id}"]`);
      if (opt) opt.textContent = `#${j.id} · ${j.modeLabel} · ${j.state}`;
    }
    if (S.route.name === "video" && S.route.tab === "logs" && S.route.slug === j.slug && !$("#log")) return render();
    if (S.route.name === "job" || (S.route.name === "video" && S.route.slug !== j.slug)) return;
    if (S.route.name === "video" && S.route.tab === "logs") {
      if (!$(`#jobSel option[value="${j.id}"]`)) { S.logJobId = j.id; return render(); }
      return loadVideo(S.route.slug).then(renderVideoHead);
    }
    if (S.route.name === "video" && S.route.tab === "overview") return softRefresh();
    if (S.route.name === "videos") softRefresh();
  });
  es.addEventListener("log", (e) => {
    const { id, text } = JSON.parse(e.data);
    if (S.logJobId === id && (S.route.name === "job" || (S.route.name === "video" && S.route.tab === "logs"))) appendLogText(text);
  });
  const onVideos = () => {
    if (S.route.name === "video" && (S.route.tab === "logs" || S.route.tab === "review")) return loadVideo(S.route.slug).then(renderVideoHead);
    if (S.route.name !== "job") softRefresh();
  };
  es.addEventListener("videos", onVideos);
  es.addEventListener("settings", () => { if (S.route.name === "settings" && !S.settingsDirty) renderSettings(); });
  es.addEventListener("status", onVideos);
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
  setInterval(async () => {
    // Keep "x min ago" fresh on list pages, and tool availability current.
    if ((S.route.name === "videos" || S.route.name === "jobs") && !document.querySelector("dialog[open]")) render();
    if (!S.meta.env?.tools) S.meta = await api("/api/meta").catch(() => S.meta);
  }, 30000);
})();
