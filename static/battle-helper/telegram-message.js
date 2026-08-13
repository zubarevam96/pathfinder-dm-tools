"use strict";

// ---------------------------------------------------------------------------
// Tell the table — sends a line from the battle helper into a campaign's
// Telegram chats, through the DM assistant bot.
//
// The browser cannot do this itself and should not be able to: the Telegram
// token lives in the bot's process, and a second holder of it is a second
// thing that can leak. So this asks the bot's POST /messages, which addresses
// a *campaign* — a campaign can answer in several chats and topics, and the
// bot delivers to all of them — and refuses any campaign the sender is not a
// member of.
//
// Identity is the same pairing railway-sync.js uses: `/link` in a private chat
// with the bot, one token per browser. This file reads the same two keys and
// deliberately does not import from that one, which stays self-contained on
// purpose — nothing it does can change how the pages behave, and that property
// is worth more than the thirty lines of fetch plumbing saved by sharing.
// Nothing goes the other way either: railway-sync.js does not know this exists.
//
// Every message the bot posts carries the sender's name. That is the bot's
// rule rather than this file's, and it is the reason a paired browser cannot
// be used to put unattributed words in front of somebody else's table.
// ---------------------------------------------------------------------------

(() => {
  // The same keys railway-sync.js writes. Read-only here: pairing and
  // unpairing are that file's, and doing either from two places is how a
  // browser ends up half-paired.
  const BASE_KEY = "pathfinder-dm-tools:api-base";
  const TOKEN_KEY = "pathfinder-dm-tools:api-token";
  // Which table was picked last. A preference of this browser, so it lives
  // beside the other browser-local settings rather than on the server.
  const LAST_CAMPAIGN_KEY = "pathfinder-dm-tools:last-campaign";

  const DEFAULT_BASE = "/sync";

  // Matches MESSAGE_CHARACTERS in the bot's web/messages.py. Kept here so the
  // counter and the textarea agree with what the server will accept; a
  // mismatch shows up as a 400 after the message is written, which is the
  // worst moment to find out.
  const MAX_CHARACTERS = 1000;

  let dialog = null;
  let statusEl = null;
  let campaigns = null; // null until fetched, then an array
  let busy = false;

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // A blocked store costs a remembered preference and nothing else.
    }
  }

  function apiBase() {
    return (read(BASE_KEY) || DEFAULT_BASE).trim().replace(/\/+$/, "");
  }

  function paired() {
    return Boolean(read(TOKEN_KEY));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  // The bot answers failures two ways — {error} from json_error(), and
  // aiohttp's own "404: No such campaign." text — so both are read here.
  async function api(path, { method = "GET", body } = {}) {
    const bearer = read(TOKEN_KEY);
    if (!bearer) throw new Error("This browser isn't paired with the bot yet.");
    const headers = { Authorization: `Bearer ${bearer}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetch(`${apiBase()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Couldn't reach the bot. It may be down.");
    }

    const text = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.error ?? text.replace(/^\d{3}:\s*/, "") ?? "");
      error.status = response.status;
      if (!error.message) error.message = `The bot said ${response.status}.`;
      throw error;
    }
    return payload;
  }

  // -------------------------------------------------------------------------
  // UI

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.id = "tell-dialog";
    dialog.innerHTML = `
      <h2>Tell the table</h2>
      <div id="tell-status" class="sync-status"></div>
      <div id="tell-body" class="sync-body"></div>
      <div class="dialog-actions">
        <button type="button" id="tell-close">Close</button>
      </div>
    `;
    document.body.appendChild(dialog);
    statusEl = dialog.querySelector("#tell-status");
    dialog.querySelector("#tell-close").addEventListener("click", () => dialog.close());
  }

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.className = `sync-status${kind ? ` ${kind}` : ""}`;
  }

  function renderBody() {
    const body = dialog.querySelector("#tell-body");

    if (!paired()) {
      // Deliberately not a second pairing form: one place pairs a browser, and
      // it is the ⇅ Sync dialog. Two would be two things to keep in step.
      body.innerHTML = `
        <p class="sync-hint">
          Pair this browser with the bot first — open <strong>⇅ Sync</strong> and
          paste the code <strong>/link</strong> gives you in a private Telegram chat.
        </p>
      `;
      return;
    }

    if (campaigns === null) {
      body.innerHTML = `<p class="sync-hint">Looking up your tables…</p>`;
      return;
    }

    if (!campaigns.length) {
      body.innerHTML = `
        <p class="sync-hint">
          You aren't in any campaigns the bot knows about. Run <strong>/init</strong>
          in the chat you play in, and it becomes a table this can post to.
        </p>
      `;
      return;
    }

    const last = read(LAST_CAMPAIGN_KEY);
    const options = campaigns.map((campaign) => {
      // A campaign with no chat linked is real and listed everywhere else in
      // the bot, so it is shown rather than hidden — but it has nowhere to
      // deliver to, and saying so beats a 409 after the message is typed.
      const mute = campaign.chats ? "" : " (no chat linked)";
      const selected = String(campaign.id) === last ? " selected" : "";
      return `<option value="${campaign.id}"${campaign.chats ? "" : " disabled"}${selected}>`
        + `${escapeHtml(campaign.name)}${mute}</option>`;
    }).join("");

    body.innerHTML = `
      <form id="tell-form" class="tell-form">
        <label class="tell-field">
          <span>Table</span>
          <select id="tell-campaign">${options}</select>
        </label>
        <label class="tell-field">
          <span>Message</span>
          <textarea id="tell-text" rows="4" maxlength="${MAX_CHARACTERS}"
                    placeholder="Round 3 — Vex is up, then the goblins."></textarea>
        </label>
        <div class="tell-row">
          <span id="tell-count" class="tell-count"></span>
          <button type="submit">Send</button>
        </div>
      </form>
      <p class="sync-hint">
        Goes to every chat that table answers in, in the bot's voice and under
        your name. Ctrl+Enter sends.
      </p>
    `;

    const form = body.querySelector("#tell-form");
    const text = body.querySelector("#tell-text");
    const count = body.querySelector("#tell-count");

    const showCount = () => {
      const left = MAX_CHARACTERS - text.value.length;
      count.textContent = left > 200 ? "" : `${left} character${left === 1 ? "" : "s"} left`;
    };
    text.addEventListener("input", showCount);
    showCount();

    // Ctrl+Enter, because Enter inside a textarea is a newline and a DM
    // writing two lines should not have to reach for the mouse. The battle
    // helper's own shortcuts already stand down for a textarea.
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(body.querySelector("#tell-campaign").value, text);
    });
  }

  function send(campaignId, textarea) {
    const message = textarea.value.trim();
    if (!message) {
      setStatus("Nothing to send yet.", "error");
      return;
    }
    run(async () => {
      setStatus("Sending…");
      const result = await api("/messages", {
        method: "POST",
        body: { campaign_id: Number(campaignId), text: message },
      });
      write(LAST_CAMPAIGN_KEY, String(campaignId));
      const chats = `${result.delivered} chat${result.delivered === 1 ? "" : "s"}`;
      setStatus(
        result.failed
          ? `Sent to ${chats}; ${result.failed} wouldn't take it.`
          : `Sent to ${chats}.`,
        result.failed ? "error" : "ok",
      );
      // Cleared only on success, so a message that failed is still there to
      // try again with rather than retyped from memory.
      textarea.value = "";
      textarea.dispatchEvent(new Event("input"));
    });
  }

  async function loadCampaigns() {
    if (!paired()) return;
    campaigns = (await api("/campaigns")).campaigns ?? [];
  }

  async function run(task) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await task();
    } catch (error) {
      setStatus(error?.message ?? String(error), "error");
    } finally {
      busy = false;
      dialog.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  function init() {
    const button = document.getElementById("tell-btn");
    if (!button) return;
    buildDialog();
    button.addEventListener("click", () => {
      setStatus("");
      // Re-read every time: a browser paired through the ⇅ Sync dialog since
      // this one was last opened has to be noticed, and the two files share
      // nothing but the key that says so.
      campaigns = null;
      renderBody();
      dialog.showModal();
      if (paired()) {
        run(async () => {
          await loadCampaigns();
          renderBody();
        });
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
