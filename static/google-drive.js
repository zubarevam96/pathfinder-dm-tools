"use strict";

// ---------------------------------------------------------------------------
// Google Drive backup and restore.
//
// This is a BACKUP layer, not a sync layer, and the distinction is the whole
// design. localStorage stays the single source of truth: every render path in
// app.js and battle-helper.js reads it synchronously, and both hold their live
// state in module-level variables loaded once at startup. Nothing here writes
// to storage behind a running page — a restore rewrites localStorage and then
// reloads, because the alternative is a page whose in-memory battles disagree
// with the ones on disk.
//
// It is also entirely self-contained: no other file imports from it and it
// imports from none. It reaches localStorage by key, exactly as the two pages
// do, so adding it could not change how either of them behaves.
//
// The site is static (GitHub Pages, no server), so this uses Google Identity
// Services' browser token flow. There is no client secret involved — for this
// flow there is none to have — and the client ID is public by design. What
// keeps it yours is the authorized-origins list on the Google Cloud client.
//
// Scope is drive.file and nothing else: the app can only ever see files it
// created itself. It cannot read the rest of your Drive, and asking for a
// wider scope to save one API call would be a bad trade with someone else's
// documents.
// ---------------------------------------------------------------------------

(() => {
  const GIS_SRC = "https://accounts.google.com/gsi/client";
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const FOLDER_NAME = "Pathfinder DM Tools";

  // Paste your own OAuth client ID here to have it committed with the app, or
  // leave it empty and enter it in the dialog — that copy lives in this
  // browser's localStorage. Either way it is not a secret.
  const DEFAULT_CLIENT_ID = "";
  const CLIENT_ID_KEY = "pathfinder-dm-tools:google-client-id";

  // Remembers only that a grant was given once — never a token. It's what
  // lets a return visit reconnect without asking, and gating on it is
  // deliberate: someone who has never connected must not have a third-party
  // script loaded and a request sent to Google on every page load just in
  // case they might one day press the button.
  const CONNECTED_KEY = "pathfinder-dm-tools:google-connected";

  // The two stores the app keeps, and how to describe one to a human. Both are
  // backed up as whole blobs rather than field by field: a partial backup that
  // silently drops a key the app grows later is worse than no backup.
  const STORES = [
    {
      storageKey: "pathfinder-dm-tools",
      fileName: "characters.json",
      label: "Characters",
      summarize(data) {
        const characters = data?.characters?.length ?? 0;
        const groups = data?.groups?.length ?? 0;
        return `${characters} character${characters === 1 ? "" : "s"}, ${groups} group${groups === 1 ? "" : "s"}`;
      },
    },
    {
      storageKey: "pathfinder-dm-tools:battle",
      fileName: "battles.json",
      label: "Battles",
      summarize(data) {
        const battles = data?.battles?.length ?? 0;
        return `${battles} battle${battles === 1 ? "" : "s"}`;
      },
    },
  ];

  // Access tokens live in memory only, never in localStorage. They expire in
  // about an hour, and a token sitting in storage is a credential surviving
  // every tab close for no benefit — the flow can silently re-issue one.
  let accessToken = null;
  let tokenExpiresAt = 0;
  let tokenClient = null;
  let gisPromise = null;

  let dialog = null;
  let statusEl = null;
  let busy = false;

  // -------------------------------------------------------------------------
  // Config

  function clientId() {
    let stored = "";
    try {
      stored = localStorage.getItem(CLIENT_ID_KEY) ?? "";
    } catch {
      stored = "";
    }
    return (stored || DEFAULT_CLIENT_ID).trim();
  }

  function wasConnected() {
    try {
      return localStorage.getItem(CONNECTED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function rememberConnected(yes) {
    try {
      if (yes) localStorage.setItem(CONNECTED_KEY, "1");
      else localStorage.removeItem(CONNECTED_KEY);
    } catch {
      // Storage disabled: auto-reconnect just won't happen. Everything else
      // still works, one click at a time.
    }
  }

  // Throws rather than swallowing a failed write. Silently ignoring it looks
  // exactly like the app refusing the ID — you type it, press Save, and the
  // setup screen comes straight back with no reason given — which is the one
  // failure mode that leaves someone with nothing to act on.
  function setClientId(value) {
    try {
      if (value) localStorage.setItem(CLIENT_ID_KEY, value.trim());
      else localStorage.removeItem(CLIENT_ID_KEY);
    } catch (error) {
      throw new Error("This browser wouldn't let the app save the client ID (private window, or site data is blocked).");
    }
    // The ID identifies the whole OAuth client, so a token issued under the
    // old one is meaningless now — and so is the memory of having granted
    // anything, which was a grant to a different client.
    accessToken = null;
    tokenExpiresAt = 0;
    tokenClient = null;
    rememberConnected(false);
  }

  // -------------------------------------------------------------------------
  // Google Identity Services

  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => {
        if (window.google?.accounts?.oauth2) resolve();
        else reject(new Error("Google Identity Services loaded but is missing oauth2."));
      });
      // Offline, or blocked by an extension or a content blocker. This is a
      // normal state for a local-first app, not a crash: everything else on
      // the page keeps working.
      script.addEventListener("error", () => {
        gisPromise = null;
        reject(new Error("Couldn't reach Google. Check your connection, or whether an extension is blocking accounts.google.com."));
      });
      document.head.appendChild(script);
    });
    return gisPromise;
  }

  // Wraps the callback-based token client in a promise. MUST be reached from a
  // user gesture: requesting a token can open a popup, and a browser will
  // block one that isn't traceable to a click.
  async function requestToken({ silent } = {}) {
    const id = clientId();
    if (!id) throw new Error("No Google client ID set yet.");
    await loadGis();

    return new Promise((resolve, reject) => {
      if (!tokenClient) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: id,
          scope: SCOPE,
          callback: () => {},
        });
      }
      tokenClient.callback = (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        accessToken = response.access_token;
        // Expire a minute early so a request can't set off mid-flight.
        tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000;
        rememberConnected(true);
        refreshButton();
        resolve(accessToken);
      };
      tokenClient.error_callback = (error) => {
        // The user closing the consent popup is a decision, not a failure.
        reject(new Error(error?.type === "popup_closed"
          ? "Sign-in cancelled."
          : error?.message || "Sign-in failed."));
      };
      tokenClient.requestAccessToken({ prompt: silent ? "" : "consent" });
    });
  }

  async function withToken() {
    if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
    try {
      // prompt: "" reuses an existing grant without showing the consent screen
      // again — the second backup of a session shouldn't ask twice.
      return await requestToken({ silent: true });
    } catch {
      // No grant yet, or it was revoked from the Google account page. Ask
      // properly. Still inside the click that started all this, so the popup
      // is traceable to a gesture and won't be blocked — which is why
      // "Back up now" works without pressing "Connect" first.
      return requestToken();
    }
  }

  function isConnected() {
    return Boolean(accessToken) && Date.now() < tokenExpiresAt;
  }

  async function disconnect() {
    const token = accessToken;
    accessToken = null;
    tokenExpiresAt = 0;
    rememberConnected(false);
    refreshButton();
    if (token && window.google?.accounts?.oauth2) {
      // Revoking is what actually ends the grant. Dropping the variable alone
      // would leave the app authorized on the Google account forever.
      await new Promise((resolve) => window.google.accounts.oauth2.revoke(token, resolve));
    }
  }

  // -------------------------------------------------------------------------
  // Drive REST

  async function driveFetch(url, options = {}) {
    const token = await withToken();
    const response = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = "";
      try {
        detail = JSON.parse(body)?.error?.message ?? "";
      } catch {
        detail = "";
      }
      throw new Error(`Drive said ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response;
  }

  const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

  // Drive treats a name as a label, not a key — two folders can share one — so
  // this takes the first match rather than assuming uniqueness. Under
  // drive.file the query only ever sees files this app created, which is what
  // stops it adopting some unrelated folder of the same name.
  async function findOrCreateFolder() {
    const query = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const response = await driveFetch(`${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id,name)`);
    const found = (await response.json()).files ?? [];
    if (found.length) return found[0].id;

    const created = await driveFetch(DRIVE_FILES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    return (await created.json()).id;
  }

  async function findFile(folderId, fileName) {
    const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
    const response = await driveFetch(`${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime)`);
    return ((await response.json()).files ?? [])[0] ?? null;
  }

  // Updating an existing file rather than creating a second one is what keeps
  // the folder from filling with copies — and what makes "restore" mean
  // something definite.
  async function writeFile(folderId, fileName, text) {
    const existing = await findFile(folderId, fileName);
    if (existing) {
      await driveFetch(`${DRIVE_UPLOAD}/${existing.id}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      return;
    }

    // A create needs metadata (name, parent) and content in one request, which
    // Drive only accepts as multipart with an explicit boundary.
    const boundary = `pf2e-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`;
    const metadata = { name: fileName, parents: [folderId], mimeType: "application/json" };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      text,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async function readFile(fileId) {
    const response = await driveFetch(`${DRIVE_FILES}/${fileId}?alt=media`);
    return response.text();
  }

  // -------------------------------------------------------------------------
  // Backup and restore

  function localText(storageKey) {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }

  function describe(text, store) {
    if (text == null) return "nothing stored";
    try {
      return store.summarize(JSON.parse(text));
    } catch {
      return "unreadable";
    }
  }

  async function backup() {
    const folderId = await findOrCreateFolder();
    const written = [];
    for (const store of STORES) {
      const text = localText(store.storageKey);
      // Nothing local means nothing to write. Writing "{}" would turn an empty
      // browser into an instruction to wipe the good copy on the next restore.
      if (text == null) continue;
      await writeFile(folderId, store.fileName, text);
      written.push(`${store.label} (${describe(text, store)})`);
    }
    if (!written.length) throw new Error("Nothing stored in this browser yet, so there's nothing to back up.");
    return written;
  }

  // Reads both sides WITHOUT writing anything, so the confirmation step can
  // show what a restore would actually replace. Overwriting a session's work
  // should take a look first, not a leap.
  async function inspect() {
    const folderId = await findOrCreateFolder();
    const rows = [];
    for (const store of STORES) {
      const remote = await findFile(folderId, store.fileName);
      const remoteText = remote ? await readFile(remote.id) : null;
      rows.push({
        store,
        remoteText,
        remoteSummary: remote ? describe(remoteText, store) : "not backed up yet",
        remoteTime: remote?.modifiedTime ? new Date(remote.modifiedTime) : null,
        localSummary: describe(localText(store.storageKey), store),
      });
    }
    return rows;
  }

  function applyRestore(rows) {
    let restored = 0;
    for (const row of rows) {
      if (row.remoteText == null) continue;
      try {
        // Parse before writing. A truncated upload would otherwise land in
        // localStorage and take the app down on its next load, with the good
        // copy already gone.
        JSON.parse(row.remoteText);
      } catch {
        throw new Error(`${row.store.label} on Drive isn't valid JSON — nothing was changed.`);
      }
      localStorage.setItem(row.store.storageKey, row.remoteText);
      restored += 1;
    }
    return restored;
  }

  // -------------------------------------------------------------------------
  // UI
  //
  // The dialog is built here rather than duplicated into both pages' HTML:
  // there is one definition, so the two pages can't drift apart. It's created
  // once at startup and never re-rendered, so the client-ID input keeps what's
  // being typed — the same rule the roster's add-object form follows.

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.id = "drive-dialog";
    dialog.innerHTML = `
      <h2>Google Drive backup</h2>
      <div id="drive-status" class="drive-status"></div>
      <div id="drive-body" class="drive-body"></div>
      <div class="dialog-actions">
        <button type="button" id="drive-close">Close</button>
      </div>
    `;
    document.body.appendChild(dialog);
    statusEl = dialog.querySelector("#drive-status");
    dialog.querySelector("#drive-close").addEventListener("click", () => dialog.close());
    renderBody();
  }

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.className = `drive-status${kind ? ` ${kind}` : ""}`;
  }

  function renderBody() {
    const body = dialog.querySelector("#drive-body");
    const id = clientId();

    if (!id) {
      body.innerHTML = `
        <p class="drive-hint">
          One-time setup. This needs a Google OAuth client ID of your own — the app
          can't ship one, because a client ID only works from origins its owner has
          authorized. In
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a>:
          enable the <strong>Drive API</strong>, configure the consent screen, then create
          credentials of type <strong>OAuth client ID</strong> &rarr;
          <strong>Web application</strong>.
        </p>
        <p class="drive-hint">
          Add <code>${escapeHtml(location.origin)}</code> to that client's
          <strong>authorized JavaScript origins</strong> — this page's origin exactly.
          Add every origin you open the app from; <code>localhost</code> and
          <code>127.0.0.1</code> count as different ones. The ID is not a secret.
        </p>
        <form id="drive-id-form" class="drive-id-form">
          <input type="text" id="drive-id-input" placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com" autocomplete="off" spellcheck="false" />
          <button type="submit">Save</button>
        </form>
      `;
      body.querySelector("#drive-id-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const value = body.querySelector("#drive-id-input").value.trim();
        if (!value) return;
        // A client ID always ends in this. Checking is worth it because the
        // alternative feedback is an opaque Google error much later, after
        // the setup screen has already been dismissed.
        if (!value.endsWith(".apps.googleusercontent.com")) {
          setStatus("That doesn't look like a client ID — it should end in .apps.googleusercontent.com", "error");
          return;
        }
        try {
          setClientId(value);
        } catch (error) {
          setStatus(error.message, "error");
          return;
        }
        setStatus("Client ID saved.", "ok");
        renderBody();
      });
      return;
    }

    body.innerHTML = `
      <div class="drive-actions">
        <button type="button" id="drive-connect">${isConnected() ? "Disconnect" : "Connect to Drive"}</button>
        <button type="button" id="drive-backup">Back up now</button>
        <button type="button" id="drive-restore">Restore from Drive</button>
      </div>
      <p class="drive-hint">
        Backs up to <strong>${FOLDER_NAME}</strong> in your Drive, as
        <code>characters.json</code> and <code>battles.json</code>. This app can only
        see files it created there.
        <button type="button" id="drive-forget-id" class="drive-link">Change client ID</button>
      </p>
      <div id="drive-detail" class="drive-detail"></div>
    `;

    body.querySelector("#drive-connect").addEventListener("click", () => run(async () => {
      if (isConnected()) {
        await disconnect();
        setStatus("Disconnected.", "ok");
      } else {
        await requestToken();
        setStatus("Connected to Google Drive.", "ok");
      }
      renderBody();
    }));

    body.querySelector("#drive-backup").addEventListener("click", () => run(async () => {
      setStatus("Backing up…");
      const written = await backup();
      setStatus(`Backed up ${written.join(" and ")}.`, "ok");
      renderBody();
    }));

    body.querySelector("#drive-restore").addEventListener("click", () => run(async () => {
      setStatus("Reading Drive…");
      const rows = await inspect();
      setStatus("");
      showRestoreConfirm(rows);
    }));

    body.querySelector("#drive-forget-id").addEventListener("click", () => {
      try {
        setClientId("");
      } catch (error) {
        setStatus(error.message, "error");
        return;
      }
      setStatus("");
      renderBody();
    });
  }

  function showRestoreConfirm(rows) {
    const detail = dialog.querySelector("#drive-detail");
    const anything = rows.some((row) => row.remoteText != null);
    const table = rows.map((row) => `
      <li>
        <strong>${escapeHtml(row.store.label)}</strong>
        <span class="drive-compare">
          <span>Drive: ${escapeHtml(row.remoteSummary)}${row.remoteTime ? ` · ${escapeHtml(formatTime(row.remoteTime))}` : ""}</span>
          <span>This browser: ${escapeHtml(row.localSummary)}</span>
        </span>
      </li>
    `).join("");

    detail.innerHTML = `
      <ul class="drive-compare-list">${table}</ul>
      ${anything ? `
        <p class="drive-warn">Restoring replaces what's in this browser. The page reloads afterwards.</p>
        <div class="drive-actions">
          <button type="button" id="drive-restore-confirm" class="danger">Replace local data</button>
          <button type="button" id="drive-restore-cancel">Cancel</button>
        </div>
      ` : `<p class="drive-hint">Nothing has been backed up to Drive yet.</p>`}
    `;

    if (!anything) return;
    detail.querySelector("#drive-restore-cancel").addEventListener("click", () => {
      detail.innerHTML = "";
    });
    detail.querySelector("#drive-restore-confirm").addEventListener("click", () => run(async () => {
      const count = applyRestore(rows);
      setStatus(`Restored ${count} file${count === 1 ? "" : "s"}. Reloading…`, "ok");
      // Both pages read localStorage once at startup and keep their state in
      // module-level variables, so a reload is the only honest way to make the
      // page agree with what was just written underneath it.
      setTimeout(() => location.reload(), 600);
    }));
  }

  // One guard for every async action, so two clicks can't run two Drive
  // conversations at once and interleave their writes.
  async function run(task) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
    try {
      await task();
    } catch (error) {
      setStatus(error?.message ?? String(error), "error");
    } finally {
      busy = false;
      dialog.querySelectorAll("button").forEach((btn) => { btn.disabled = false; });
    }
  }

  function formatTime(date) {
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  // -------------------------------------------------------------------------
  // Reconnecting without asking
  //
  // What other apps look like they're doing — "it opened a Google window by
  // itself" — is almost never an auto-opened popup. A popup not traceable to
  // a click is blocked by every browser, so a page that tried would just fail
  // silently on load. What they actually do is the SILENT path: once consent
  // has been given, a token can be re-issued through a hidden iframe with no
  // window at all. The visible result is an app that's simply connected when
  // you arrive, which is better than one that throws a window at you.
  //
  // The consent screen itself always needs a real click, the first time. That
  // isn't a limitation to engineer around — it's the part where the user
  // agrees, and a browser will not let a page fake it.

  function refreshButton() {
    const button = document.getElementById("drive-btn");
    if (!button) return;
    const on = isConnected();
    button.classList.toggle("connected", on);
    button.title = on ? "Google Drive — connected" : "Google Drive backup";
  }

  // Fire-and-forget on page load. Failures are deliberately invisible: a
  // revoked grant or a browser blocking third-party cookies is not something
  // to interrupt someone with before they've asked for anything, and the
  // button still works by hand.
  async function autoConnect() {
    if (!clientId() || !wasConnected()) return;
    try {
      await requestToken({ silent: true });
    } catch {
      // Left as-is on purpose. Notably, the silent path rides Google's
      // session cookie in a third-party context, so it can fail under
      // Safari's ITP or Chrome's third-party cookie restrictions even though
      // the grant is perfectly valid — which is what the escalation below is
      // for.
    }
    refreshButton();
  }

  // Opening the dialog IS a click, so a popup here is allowed. Someone who
  // connected before shouldn't have to press "Connect" again for something
  // they already agreed to, so this escalates to the visible flow when the
  // silent one didn't take.
  function reconnectOnOpen() {
    if (isConnected() || !clientId() || !wasConnected()) return;
    run(async () => {
      await withToken();
      setStatus("Connected to Google Drive.", "ok");
      renderBody();
      refreshButton();
    });
  }

  function init() {
    const button = document.getElementById("drive-btn");
    if (!button) return;
    buildDialog();
    refreshButton();
    autoConnect();
    button.addEventListener("click", () => {
      renderBody();
      dialog.showModal();
      reconnectOnOpen();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
