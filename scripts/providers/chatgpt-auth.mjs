// Official Sign in with ChatGPT plan-usage flow for this locally hosted app.
// OAuth credentials live in the operating-system credential manager, never in
// config/settings.json, the browser, pipeline environment, or logs.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import keytar from "keytar";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = process.env.DATA_ROOT ? resolve(process.env.DATA_ROOT) : ROOT;
const SERVICE = `musical-explainers:chatgpt-plan:${createHash("sha256").update(DATA).digest("hex").slice(0, 16)}`;
const ACCOUNT = "primary";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_PATH = "/auth/callback";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const JWKS = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
const random = (n = 32) => randomBytes(n).toString("base64url");

export async function connectionStatus() {
  const raw = await keytar.getPassword(SERVICE, ACCOUNT);
  if (!raw) return { status: "disconnected", sharing: false };
  try {
    const c = JSON.parse(raw);
    if (c.disconnected) return { status: "disconnected", sharing: false };
    if (!c.scopes?.includes("chatgpt.tokens.use.direct")) return { status: "consent_required", sharing: false, account: c.email ?? null };
    if (c.reauth_required) return { status: "reauth_required", sharing: false, account: c.email ?? null };
    if (!c.refresh_token) return { status: "reauth_required", sharing: false, account: c.email ?? null };
    return { status: "connected", sharing: true, account: c.email ?? null };
  } catch { return { status: "reauth_required", sharing: false }; }
}

function hostId() {
  const path = join(DATA, "config", "chatgpt-host-id.json");
  try { return JSON.parse(readFileSync(path, "utf8")).hostId; } catch {
    const id = `urn:uuid:${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ hostId: id }) + "\n", { mode: 0o600 });
    return id;
  }
}

function openBrowser(url) {
  const [bin, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(bin, args, { detached: true, stdio: "ignore" });
  child.unref();
}

const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

export async function connectChatGPT() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const state = random();
  const nonce = random();
  const verifier = random(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const savedRaw = await keytar.getPassword(SERVICE, ACCOUNT);
  const saved = savedRaw ? JSON.parse(savedRaw) : null;
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  const timer = setTimeout(() => rejectCallback(new Error("ChatGPT sign-in timed out. Try connecting again.")), 10 * 60_000);
  server.on("request", (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
    if (url.searchParams.get("state") !== state) { res.writeHead(400).end("Sign-in state did not match."); rejectCallback(new Error("ChatGPT sign-in state did not match.")); return; }
    const error = url.searchParams.get("error");
    if (error) { res.writeHead(200, { "content-type": "text/html" }).end("Sign-in was cancelled. You can close this tab."); rejectCallback(new Error(error === "access_denied" ? "ChatGPT plan usage consent was declined. Enable plan usage and connect again." : `ChatGPT sign-in failed (${error}).`)); return; }
    const code = url.searchParams.get("code");
    const issuedClientId = url.searchParams.get("client_id") || (saved?.client_id && saved.client_id);
    if (!code || !issuedClientId || (saved?.client_id && issuedClientId !== saved.client_id)) {
      res.writeHead(400).end("ChatGPT registration was incomplete or changed."); rejectCallback(new Error("ChatGPT registration was incomplete or changed; try sign-in again.")); return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Connected</title><p>ChatGPT connection complete. You can close this tab and return to Musical Explainers.</p>");
    resolveCallback({ code, clientId: issuedClientId });
  });
  const params = new URLSearchParams({
    client_id: saved?.client_id ?? "dynamic_agent_client", response_type: "code", redirect_uri: redirectUri,
    scope: scopes, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge,
    ext_agent_host_id: hostId(),
    ...(!saved ? { agent_name_hint: "Musical Explainers" } : {}),
    ...(saved?.id_token ? { id_token_hint: saved.id_token } : {}),
    ...(saved?.email ? { login_hint: saved.email } : {}),
  });
  try {
    openBrowser(`https://auth.openai.com/api/accounts/authorize?${params}`);
    const { code, clientId } = await callback;
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
    const tokenResponse = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokens.error_description || tokens.error || "ChatGPT token exchange failed.");
    const { payload } = await jwtVerify(tokens.id_token, JWKS, { issuer: "https://auth.openai.com", audience: clientId, nonce });
    if (saved?.subject && saved.subject !== payload.sub) throw new Error("This sign-in selected a different ChatGPT account. Your existing connection was kept; try again with the saved account.");
    const granted = String(tokens.scope ?? "").split(/\s+/).filter(Boolean);
    const connection = {
      client_id: clientId, id_token: tokens.id_token, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, token_type: tokens.token_type,
      expires_at: Date.now() + Number(tokens.expires_in ?? 0) * 1000,
      scopes: granted, email: typeof payload.email === "string" ? payload.email : null,
      subject: payload.sub, saved_at: new Date().toISOString(),
    };
    if (!granted.includes("chatgpt.tokens.use.direct")) {
      if (!saved?.scopes?.includes("chatgpt.tokens.use.direct")) await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify(connection));
      throw new Error("Signed in, but ChatGPT plan usage consent was not granted. Enable plan usage and reconnect.");
    }
    await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify(connection));
    return connectionStatus();
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

export async function disconnectChatGPT() {
  let remoteRevocation = "not-needed";
  const raw = await keytar.getPassword(SERVICE, ACCOUNT);
  if (raw) try {
    const c = JSON.parse(raw);
    if (c.refresh_token && c.client_id) {
      const oidc = await fetch("https://auth.openai.com/.well-known/openid-configuration").then((r) => r.json());
      if (typeof oidc.revocation_endpoint === "string") {
        const form = new URLSearchParams({ token: c.refresh_token, token_type_hint: "refresh_token", client_id: c.client_id });
        const revoked = await fetch(oidc.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
        if (!revoked.ok) remoteRevocation = "unconfirmed";
        else remoteRevocation = "confirmed";
      } else remoteRevocation = "unconfirmed";
    }
  } catch { remoteRevocation = "unconfirmed"; }
  let retained = null;
  if (raw) try { const c = JSON.parse(raw); if (c.client_id) retained = JSON.stringify({ client_id: c.client_id, subject: c.subject, email: c.email ?? null, saved_at: new Date().toISOString(), disconnected: true }); } catch { /* Clear an unreadable record. */ }
  if (retained) await keytar.setPassword(SERVICE, ACCOUNT, retained);
  else await keytar.deletePassword(SERVICE, ACCOUNT);
  return { ...(await connectionStatus()), remoteRevocation };
}

export async function markChatGPTReauthenticationRequired() {
  const raw = await keytar.getPassword(SERVICE, ACCOUNT);
  if (raw) {
    try { await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify({ ...JSON.parse(raw), reauth_required: true })); } catch { /* Keep status safe if credentials are damaged. */ }
  }
}

export async function getChatGPTAccessToken() {
  const raw = await keytar.getPassword(SERVICE, ACCOUNT);
  if (!raw) throw new Error("ChatGPT is disconnected. Connect ChatGPT in Settings before starting this pipeline.");
  let c;
  try { c = JSON.parse(raw); } catch { throw new Error("ChatGPT credentials need to be reconnected in Settings."); }
  if (!c.scopes?.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage consent is required. Reconnect and approve plan usage in Settings.");
  if (c.reauth_required) throw new Error("ChatGPT authorization expired or was revoked. Reconnect ChatGPT in Settings.");
  if (!c.refresh_token) throw new Error("ChatGPT connection has expired. Reconnect in Settings.");
  if (c.expires_at <= Date.now() + 60_000) {
    const form = new URLSearchParams({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: c.refresh_token, resource: RESOURCE });
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const refreshed = await response.json();
    if (!response.ok) {
      if (["invalid_grant", "invalid_token"].includes(refreshed.error)) await markChatGPTReauthenticationRequired();
      throw new Error(response.status === 401 ? "ChatGPT connection expired. Reconnect in Settings." : `ChatGPT token refresh failed (${refreshed.error ?? response.status}).`);
    }
    c = { ...c, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token ?? c.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in ?? 0) * 1000, saved_at: new Date().toISOString() };
    await keytar.setPassword(SERVICE, ACCOUNT, JSON.stringify(c));
  }
  return c.access_token;
}
