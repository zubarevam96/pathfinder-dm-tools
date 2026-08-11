"use strict";

// ---------------------------------------------------------------------------
// The personal info page.
//
// Deliberately separate from account.js: that file rides on every page and has
// to stay small and quiet, while this one only exists at /account/ and can
// afford to be a page. Neither imports the other; both talk to the same API.
//
// Nothing here handles a password. "Change password" is a link to the server,
// which redirects to Keycloak's own form and back — see /auth/password.
// ---------------------------------------------------------------------------

(() => {
  const statusEl = document.getElementById("account-page-status");
  const signedOut = document.getElementById("account-signed-out");
  const unconfigured = document.getElementById("account-unconfigured");
  const signedIn = document.getElementById("account-signed-in");
  const emailForm = document.getElementById("account-email-form");
  const emailInput = document.getElementById("account-email-input");
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
    const response = await fetch(path, {
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
    emailInput.value = user.email ?? "";
    telegramEl.textContent = user.telegram_id ? String(user.telegram_id) : "Not linked";
    renderStored(user.documents);
    show(signedIn);
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
      show(signedOut);
      return;
    }
    renderAccount(me.user);
  }

  emailForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    if (!email) return;
    setStatus("Saving…");
    const button = emailForm.querySelector("button");
    button.disabled = true;
    try {
      await api("/api/account/email", {
        method: "PUT",
        body: JSON.stringify({ email }),
      });
      setStatus("Email updated.", "ok");
      // Re-read rather than trusting the round trip: the sign-in service may
      // have normalised the address, and this page should show what it stored.
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

  // The password change comes back here with kc_action_status in the query.
  const params = new URLSearchParams(location.search);
  const action = params.get("kc_action_status");
  if (action) {
    setStatus(
      action === "success" ? "Password changed." : "Password was not changed.",
      action === "success" ? "ok" : "error"
    );
    history.replaceState(null, "", location.pathname);
  }
  const authError = params.get("auth_error");
  if (authError) {
    setStatus(authError, "error");
    history.replaceState(null, "", location.pathname);
  }

  load();
})();
