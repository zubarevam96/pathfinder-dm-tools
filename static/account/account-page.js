"use strict";

// ---------------------------------------------------------------------------
// The personal info page.
//
// Deliberately separate from account.js: that file rides on every page and has
// to stay small and quiet, while this one only exists at /account/ and can
// afford to be a page. Neither imports the other; both talk to the same API.
//
// Nothing here handles a password, because the site has none to handle. Signing
// in is an eight-character code from the bot, spent by the server — see
// /auth/pair — and what comes back is a cookie this page cannot read.
// ---------------------------------------------------------------------------

(() => {
  const statusEl = document.getElementById("account-page-status");
  const signedOut = document.getElementById("account-signed-out");
  const unconfigured = document.getElementById("account-unconfigured");
  const signedIn = document.getElementById("account-signed-in");
  const pairForm = document.getElementById("account-pair-form");
  const codeInput = document.getElementById("account-code-input");
  const telegramEl = document.getElementById("account-telegram");
  const storedEl = document.getElementById("account-stored");
  const signOutButton = document.getElementById("account-page-signout");

  const DOCUMENTS = [
    { name: "characters", label: "Characters" },
    { name: "battles", label: "Battles" },
  ];

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.className = `account-status${kind ? ` ${kind}` : ""}`;
  }

  async function api(path, options = {}) {
    const { headers, ...rest } = options;
    const response = await fetch(path, {
      credentials: "same-origin",
      // Merged rather than replaced: spreading `options` wholesale drops the
      // computed Content-Type as soon as a caller passes a header of its own.
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
      error.telegram_id = payload?.telegram_id ?? null;
      throw error;
    }
    return payload;
  }

  function show(section) {
    for (const element of [signedOut, unconfigured, signedIn]) {
      element.hidden = element !== section;
    }
  }

  function renderStored(documents) {
    storedEl.innerHTML = DOCUMENTS.map((document_) => {
      const entry = documents?.[document_.name];
      if (!entry) {
        return `<li>${document_.label}: <span class="account-muted">nothing stored</span></li>`;
      }
      const count = entry.count == null ? "" : `${entry.count} · `;
      const size = `${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
      return `<li>${document_.label}: ${count}${size} · ${formatTime(entry.updated_at)}</li>`;
    }).join("");
  }

  function formatTime(seconds) {
    if (!seconds) return "saved";
    return new Date(seconds * 1000).toLocaleString();
  }

  function renderAccount(user) {
    telegramEl.textContent = describe(user);
    renderStored(user.documents);
    show(signedIn);
  }

  // Name, handle and id are each optional except the last. Showing all three
  // that exist is deliberate on this page: it is the one place somebody checks
  // that the account they are signed into is the account the bot knows, and the
  // id is the only part of that which cannot be renamed out from under them.
  function describe(user) {
    const parts = [];
    if (user.display_name) parts.push(user.display_name);
    if (user.username) parts.push(`@${user.username}`);
    parts.push(`id ${user.telegram_id}`);
    return parts.join(" · ");
  }

  async function load() {
    let me;
    try {
      me = await api("/api/account/me");
    } catch (error) {
      setStatus(error.message, "error");
      show(unconfigured);
      return;
    }
    if (!me.configured) {
      show(unconfigured);
      return;
    }
    if (!me.user) {
      const adopted = await adoptSyncPairing();
      if (adopted) return;
      show(signedOut);
      return;
    }
    renderAccount(me.user);
  }

  // The same deference account.js does, for the same reason: ⇅ and 👤 ask which
  // Telegram person this is, and a browser that has already answered should not
  // be asked again. Read by key, never importing railway-sync.js.
  const SYNC_TOKEN_KEY = "pathfinder-dm-tools:api-token";

  async function adoptSyncPairing() {
    let token = null;
    try {
      token = localStorage.getItem(SYNC_TOKEN_KEY);
    } catch {
      token = null;
    }
    if (!token) return false;
    try {
      const result = await api("/auth/adopt", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result?.user) return false;
      renderAccount(result.user);
      return true;
    } catch (error) {
      // A 403 names the account that was refused, which is the id the DM needs
      // in order to add them. A 401 only means ⇅'s token went stale, and the
      // code form on the signed-out card is already the answer to that.
      if (error?.telegram_id) {
        setStatus(
          `You're paired with the bot as Telegram id ${error.telegram_id}, but that ` +
            "account isn't on this site's list yet. Ask the DM to add that id.",
          "error"
        );
      }
      return false;
    }
  }

  pairForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (!code) return;
    setStatus("Signing in…");
    const button = pairForm.querySelector("button");
    button.disabled = true;
    try {
      await api("/auth/pair", { method: "POST", body: JSON.stringify({ code }) });
      codeInput.value = "";
      setStatus("Signed in.", "ok");
      // Re-read rather than trusting the round trip, so this page shows the same
      // answer every other page will get from /api/account/me.
      await load();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  signOutButton.addEventListener("click", async () => {
    signOutButton.disabled = true;
    try {
      const result = await api("/auth/logout", { method: "POST" });
      location.href = result?.next || "/";
    } catch (error) {
      setStatus(error.message, "error");
      signOutButton.disabled = false;
    }
  });

  load();
})();
