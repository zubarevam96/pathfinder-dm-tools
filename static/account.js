"use strict";

// ---------------------------------------------------------------------------
// The account: signing in, and keeping a copy of this browser's data against it.
//
// Same contract as railway-sync.js, which it sits beside rather than replaces:
// self-contained, reaches localStorage by key exactly as the two pages do,
// imported by nothing, and a pull reloads afterwards because both pages read
// storage once at startup and hold live state in module-level variables.
//
// The two answer different questions. railway-sync.js asks "which Telegram
// person is this", and its answer unifies a character with one the bot imported.
// This asks "which account on this site is this", which is the way in for
// somebody who has never spoken to the bot. They will meet at users.telegram_id
// when something can prove they are the same person; until then, keeping both
// is the honest arrangement.
//
// **There is no token in this file, and no password.** The server runs the
// OpenID Connect flow and hands back an HttpOnly cookie the page cannot read,
// so there is nothing here for a script on this page to steal. Passwords are
// only ever typed on Keycloak's own origin.
//
// Storage here is backup and restore of whole documents, not the name-by-name
// merge railway-sync.js does. The account store is this browser's copy kept
// somewhere durable — there is no second writer to reconcile with, and inventing
// a merge for one would be a way to lose data rather than protect it.
// ---------------------------------------------------------------------------

(() => {
  const CHARACTER_STORE = "pathfinder-dm-tools";
  const BATTLE_STORE = "pathfinder-dm-tools:battle";

  // What the server will accept, and which localStorage key each one is.
  const DOCUMENTS = [
    { name: "characters", storageKey: CHARACTER_STORE, label: "Characters" },
    { name: "battles", storageKey: BATTLE_STORE, label: "Battles" },
  ];

  let dialog = null;
  let statusEl = null;
  let busy = false;
  let account = null;
  let configured = false;

  // -------------------------------------------------------------------------
  // Storage and the server

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      throw new Error("This browser wouldn't let the app save (private window, or site data is blocked).");
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      // The session cookie is the whole authentication story, so it has to go.
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `The server answered ${response.status}.`);
    }
    return payload;
  }

  async function loadAccount() {
    try {
      const me = await api("/api/account/me");
      configured = Boolean(me?.configured);
      account = me?.user ?? null;
    } catch {
      // A site with no server in front of it (or one that's down) is not an
      // error worth showing on a page that otherwise works entirely offline.
      configured = false;
      account = null;
    }
    return account;
  }

  // -------------------------------------------------------------------------
  // Backup and restore

  function localBody(storageKey) {
    return read(storageKey) ?? "{}";
  }

  async function pushAll() {
    for (const document_ of DOCUMENTS) {
      await api(`/api/account/data/${document_.name}`, {
        method: "PUT",
        body: JSON.stringify({ body: localBody(document_.storageKey) }),
      });
    }
  }

  async function pullAll() {
    // Fetched into memory first, and only then written. A restore that failed
    // half way would otherwise leave characters from the account beside battles
    // from this browser, which is a state neither page knows how to be in.
    const fetched = [];
    for (const document_ of DOCUMENTS) {
      const stored = await api(`/api/account/data/${document_.name}`);
      if (typeof stored?.body === "string") {
        try {
          JSON.parse(stored.body);
        } catch {
          throw new Error(`${document_.label} on the account isn't valid JSON — nothing was changed.`);
        }
        fetched.push({ document: document_, body: stored.body });
      }
    }
    if (!fetched.length) throw new Error("This account has nothing stored yet.");
    for (const row of fetched) write(row.document.storageKey, row.body);
    return fetched.length;
  }

  // -------------------------------------------------------------------------
  // Dialog

  function buildDialog() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.id = "account-dialog";
    dialog.innerHTML = `
      <h2>Account</h2>
      <div id="account-status" class="account-status"></div>
      <div id="account-body" class="account-body"></div>
      <div class="dialog-actions">
        <button type="button" id="account-close">Close</button>
      </div>
    `;
    document.body.appendChild(dialog);
    statusEl = dialog.querySelector("#account-status");
    dialog.querySelector("#account-close").addEventListener("click", () => dialog.close());
  }

  function setStatus(message, kind = "") {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `account-status${kind ? ` ${kind}` : ""}`;
  }

  function renderBody() {
    const body = dialog.querySelector("#account-body");

    if (!configured) {
      body.innerHTML = `
        <p class="account-hint">
          This copy of the site has no sign-in configured, so there is no account
          to store anything against. Everything still works — the data lives in
          this browser, as it always has.
        </p>
      `;
      return;
    }

    if (!account) {
      body.innerHTML = `
        <div class="account-actions">
          <a class="account-button" href="/auth/login?next=${encodeURIComponent(location.pathname)}">Sign in</a>
        </div>
        <p class="account-hint">
          Accounts are created by the site's administrator — there is no public
          sign-up. Signing in gives this browser's characters and battles
          somewhere to live that isn't this browser.
        </p>
      `;
      return;
    }

    body.innerHTML = `
      <p class="account-who">Signed in as <strong>${escapeHtml(account.email ?? "an account with no address")}</strong></p>
      <div class="account-actions">
        <button type="button" id="account-push">Send to account</button>
        <button type="button" id="account-pull">Get from account</button>
      </div>
      <div id="account-detail" class="account-detail">${storedSummary()}</div>
      <p class="account-hint">
        <a class="account-link" href="/account/">Personal info</a> &middot;
        <button type="button" id="account-signout" class="account-link">Sign out</button>
      </p>
    `;

    body.querySelector("#account-push").addEventListener("click", () => run(async () => {
      setStatus("Sending…");
      await pushAll();
      await loadAccount();
      renderBody();
      setStatus("Sent. This browser's data is stored on the account.", "ok");
    }));

    body.querySelector("#account-pull").addEventListener("click", () => run(async () => {
      const yes = confirm(
        "Replace this browser's characters and battles with what's stored on the account?\n\n" +
        "The page reloads afterwards."
      );
      if (!yes) return;
      setStatus("Fetching…");
      await pullAll();
      setStatus("Restored. Reloading…", "ok");
      location.reload();
    }));

    body.querySelector("#account-signout").addEventListener("click", () => run(async () => {
      const result = await api("/auth/logout", { method: "POST" });
      // The server has already dropped the session; this only tells Keycloak,
      // so a failure to arrive there is not a failure to sign out here.
      location.href = result?.next || "/";
    }));
  }

  function storedSummary() {
    const stored = account?.documents ?? {};
    const rows = DOCUMENTS.map((document_) => {
      const entry = stored[document_.name];
      if (!entry) return `<li>${document_.label}: <span class="account-muted">nothing stored</span></li>`;
      const count = entry.count == null ? "" : `${entry.count} · `;
      return `<li>${document_.label}: ${count}${formatTime(entry.updated_at)}</li>`;
    }).join("");
    return `<ul class="account-stored">${rows}</ul>`;
  }

  async function run(work) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
    try {
      await work();
    } catch (error) {
      setStatus(error?.message ?? String(error), "error");
    } finally {
      busy = false;
      dialog.querySelectorAll("button").forEach((btn) => { btn.disabled = false; });
    }
  }

  // -------------------------------------------------------------------------

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function formatTime(seconds) {
    if (!seconds) return "saved";
    return new Date(seconds * 1000).toLocaleString();
  }

  function refreshButton() {
    const button = document.getElementById("account-btn");
    if (!button) return;
    // Hidden rather than disabled where there is no sign-in at all: a control
    // that can never do anything is noise, and this site is meant to keep
    // working with no server-side identity behind it.
    button.hidden = !configured;
    button.classList.toggle("connected", Boolean(account));
    button.title = account ? `Account — ${account.email ?? "signed in"}` : "Account — signed out";
  }

  // A failed sign-in comes back as a query parameter on a top-level navigation,
  // because the callback is a redirect and has nowhere else to say it.
  function showRedirectError() {
    const params = new URLSearchParams(location.search);
    const message = params.get("auth_error");
    if (!message) return;
    params.delete("auth_error");
    const query = params.toString();
    history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    buildDialog();
    renderBody();
    setStatus(message, "error");
    dialog.showModal();
  }

  async function init() {
    const button = document.getElementById("account-btn");
    if (!button) return;
    buildDialog();
    await loadAccount();
    refreshButton();
    showRedirectError();
    button.addEventListener("click", () => {
      setStatus("");
      renderBody();
      dialog.showModal();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
