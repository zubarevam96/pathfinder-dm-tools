"use strict";

// ---------------------------------------------------------------------------
// The account: signing in, and keeping a copy of this browser's data against it.
//
// Same contract as railway-sync.js, which it sits beside rather than replaces:
// self-contained, reaches localStorage by key exactly as the two pages do,
// imported by nothing, and a pull reloads afterwards because both pages read
// storage once at startup and hold live state in module-level variables.
//
// Both now start from the same place — a /link code from the bot — and still do
// different things with it. railway-sync.js redeems the code *in the browser*
// and keeps the token, because it goes on to call the bot's API as you. This
// one hands the code to our own server, which redeems it out of sight and keeps
// nothing here but a cookie the page cannot read.
//
// **There is no token in this file, and no password.** Not "no password yet" —
// the site has no password to have. Identity is a Telegram account the bot
// vouched for, and the only secret that ever reaches this page is an
// eight-character code that stops working the moment it is spent.
//
// Storage here is backup and restore of whole documents, not the name-by-name
// merge railway-sync.js does. The account store is this browser's copy kept
// somewhere durable — there is no second writer to reconcile with, and inventing
// a merge for one would be a way to lose data rather than protect it.
// ---------------------------------------------------------------------------

(() => {
  const CHARACTER_STORE = "pathfinder-dm-tools";
  const BATTLE_STORE = "pathfinder-dm-tools:battle";

  // railway-sync.js's key, read by name and never imported — the same way
  // telegram-message.js reaches it. That isolation is the point: neither file
  // can change how the other behaves, and a consumer would end it.
  const SYNC_TOKEN_KEY = "pathfinder-dm-tools:api-token";

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
    const { headers, ...rest } = options;
    const response = await fetch(path, {
      // The session cookie is the whole authentication story, so it has to go.
      credentials: "same-origin",
      // Merged, not replaced. Spreading `options` wholesale used to drop the
      // computed Content-Type the moment a caller passed a header of its own,
      // which is a bug that only appears on whichever call adds one first.
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(headers || {}),
      },
      ...rest,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.error || `The server answered ${response.status}.`);
      error.status = response.status;
      // Carried through so a refusal can say which account was refused — it is
      // the one thing whoever is reading it needs and cannot look up.
      error.telegram_id = payload?.telegram_id ?? null;
      throw error;
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

  // Why a signing-in browser might already be signed in elsewhere: ⇅ and 👤 ask
  // the same question — which Telegram person is this — and used to make people
  // answer it twice with two /link codes. If ⇅ has a token, this hands it to the
  // server, which checks it with the bot and starts a session from it.
  //
  // Tried once per page, and only when there is a token and no session. A refusal
  // is remembered so a browser whose owner is not on the whitelist doesn't fire a
  // 403 on every page load; a reload retries, which is what makes it self-healing
  // once somebody is added.
  let adoptRefusal = null;

  async function adoptSyncPairing() {
    if (account || !configured || adoptRefusal) return false;
    const token = read(SYNC_TOKEN_KEY);
    if (!token) return false;
    try {
      const result = await api("/auth/adopt", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      account = result?.user ?? null;
      return Boolean(account);
    } catch (error) {
      // 401 means ⇅'s token was revoked from /sessions and is stale — nothing to
      // say about it, since the code form below is the answer either way. A 403
      // is worth repeating: they are somebody, just not somebody allowed yet.
      adoptRefusal = error?.telegram_id ? error : null;
      return false;
    }
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
      // A browser that is paired for ⇅ but refused here has a different problem
      // from one that has never paired, and needs a different sentence: the code
      // form would "work" and change nothing.
      const refused = adoptRefusal
        ? `
        <p class="account-hint account-refused">
          You're paired with the bot as <strong>Telegram id ${escapeHtml(adoptRefusal.telegram_id)}</strong>,
          but that account isn't on this site's list yet. Ask the DM to add it —
          that id is what they need.
        </p>
      `
        : "";
      body.innerHTML = `
        ${refused}
        <p class="account-hint">
          Send <strong>/link</strong> to the bot in a private Telegram chat. It
          replies with an eight-character code, good for five minutes.
        </p>
        <form id="account-pair-form" class="account-field">
          <input type="text" id="account-code-input" placeholder="ABCD1234" maxlength="16"
                 autocomplete="off" spellcheck="false" />
          <button type="submit">Sign in</button>
        </form>
        <p class="account-hint">
          Signing in gives this browser's characters and battles somewhere to
          live that isn't this browser. Your Telegram account has to be on this
          site's list — ask the DM if it isn't.
        </p>
      `;
      body.querySelector("#account-pair-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const input = body.querySelector("#account-code-input");
        const code = input.value.trim();
        if (!code) return;
        run(async () => {
          setStatus("Signing in…");
          await api("/auth/pair", { method: "POST", body: JSON.stringify({ code }) });
          // Re-read rather than trusting the response: this is the same call
          // every page makes on load, so whatever it says here is exactly what
          // they will say, and a disagreement would show up now rather than as
          // a button in the wrong state on the next page.
          await loadAccount();
          renderBody();
          refreshButton();
          setStatus(`Signed in as ${who(account)}.`, "ok");
        });
      });
      return;
    }

    body.innerHTML = `
      <p class="account-who">Signed in as <strong>${escapeHtml(who(account))}</strong></p>
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
      // Only this browser. The token it was holding is dropped rather than
      // revoked at the bot — /sessions in Telegram is where somebody sees every
      // browser they have paired and picks, and signing out on a laptop should
      // not quietly sign out the phone as well.
      location.href = result?.next || "/";
    }));
  }

  // Telegram gives all three of these, any of them optionally: someone with no
  // handle and no display name is unusual but allowed, and the id is always
  // there. Falling through to it means this never renders "signed in as".
  function who(user) {
    if (!user) return "signed out";
    if (user.display_name) return user.display_name;
    if (user.username) return `@${user.username}`;
    return `Telegram ${user.telegram_id}`;
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
    button.title = account ? `Account — ${who(account)}` : "Account — signed out";
  }

  async function init() {
    const button = document.getElementById("account-btn");
    if (!button) return;
    buildDialog();
    await loadAccount();
    // Before the button is drawn, so a browser that ⇅ already paired shows as
    // signed in on first paint rather than flicking from signed-out to in.
    await adoptSyncPairing();
    refreshButton();
    button.addEventListener("click", () => {
      setStatus("");
      renderBody();
      dialog.showModal();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
