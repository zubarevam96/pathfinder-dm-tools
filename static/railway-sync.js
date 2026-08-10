"use strict";

// ---------------------------------------------------------------------------
// Campaign sync — stores characters and battles on the DM assistant bot's
// service instead of in this browser alone.
//
// It replaced a Google Drive backup and kept that file's shape, which is worth
// keeping: localStorage stays the single source of truth, every render path
// stays synchronous, nothing writes to storage behind a running page, and a
// pull reloads afterwards because both pages read storage once at startup and
// hold live state in module-level variables.
//
// What is NOT the same: this is not a blob backup. Characters are the *same
// rows* the Telegram bot reads — a character imported in chat and one opened
// here are one character. Battles are still opaque; the bot stores them and
// reads nothing inside them.
//
// Identity is Telegram. `/link` in a private chat with the bot gives an
// eight-character code, good for five minutes and one browser; this exchanges
// it for a token that identifies the person behind any browser they pair.
// ---------------------------------------------------------------------------

(() => {
  const BASE_KEY = "pathfinder-dm-tools:api-base";
  const TOKEN_KEY = "pathfinder-dm-tools:api-token";
  // The server's updated_at for each battle we last saw, so a PUT can echo it
  // back. Without it every push after the first is a 409.
  const VERSIONS_KEY = "pathfinder-dm-tools:api-battle-versions";

  const CHARACTER_STORE = "pathfinder-dm-tools";
  const BATTLE_STORE = "pathfinder-dm-tools:battle";

  // A path, not a URL: the site is served by app.py, which forwards /sync/* to
  // the bot over Railway's private network. Same origin, so there is no CORS,
  // nothing to configure, and no address to ask anyone for.
  //
  // It stays overridable because one deployment doesn't have the proxy — a
  // copy served straight off GitHub Pages, where /sync/* is a 404. Pointing
  // that at the bot's public domain still works, if the bot has one.
  const DEFAULT_BASE = "/sync";

  let dialog = null;
  let statusEl = null;
  let busy = false;
  let person = null;
  // Set only by the "server address" control. Without it the form would be
  // unreachable, since a default means apiBase() is never empty.
  let editingBase = false;

  // -------------------------------------------------------------------------
  // Config and storage

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
    } catch (error) {
      throw new Error("This browser wouldn't let the app save (private window, or site data is blocked).");
    }
  }

  function apiBase() {
    return (read(BASE_KEY) || DEFAULT_BASE).trim().replace(/\/+$/, "");
  }

  function token() {
    return read(TOKEN_KEY);
  }

  function readJson(key, fallback) {
    const raw = read(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  //
  // The API answers failures two ways: json_error() sends {error}, while
  // aiohttp's own HTTPException sends the plain text "401: Sign in first…".
  // Both are read here so a caller never has to care which it got.

  async function api(path, { method = "GET", body, auth = true } = {}) {
    const base = apiBase();
    if (!base) throw new Error("No server address set yet.");
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const bearer = token();
      if (!bearer) throw new Error("Not paired with the bot yet.");
      headers.Authorization = `Bearer ${bearer}`;
    }

    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // fetch() rejects for a network failure and for a CORS rejection alike,
      // and the browser deliberately won't say which. Name both.
      throw new Error("Couldn't reach the server. It may be down, or this origin may not be in its WEB_CORS_ORIGINS.");
    }

    const text = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.error
        ?? text.replace(/^\d{3}:\s*/, "")
        ?? "";
      const error = new Error(message || `Server said ${response.status}.`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  // -------------------------------------------------------------------------
  // Pairing

  async function pair(code) {
    const label = `${navigator.platform || "browser"} · ${new Date().toLocaleDateString()}`;
    const result = await api("/auth/pair", {
      method: "POST",
      auth: false,
      body: { code: code.trim(), label },
    });
    write(TOKEN_KEY, result.token);
    person = result.person;
    return person;
  }

  async function whoami() {
    if (!token() || !apiBase()) {
      person = null;
      return null;
    }
    try {
      person = (await api("/auth/me")).person;
    } catch (error) {
      // 401 means the token was revoked from /sessions. Drop it rather than
      // letting every later call fail the same way.
      if (error.status === 401) write(TOKEN_KEY, null);
      person = null;
    }
    return person;
  }

  function signOut() {
    write(TOKEN_KEY, null);
    person = null;
  }

  // -------------------------------------------------------------------------
  // Characters
  //
  // Timestamps come in two units and MUST be normalised before they are
  // compared. This app writes `savedAt` as Date.now() / 1000 — Unix *seconds*
  // — while the server writes `updated_at` as an ISO string. Comparing them
  // raw doesn't throw; it just silently decides the same side is newer every
  // time, which is the worst possible failure for a sync.
  function toSeconds(value) {
    if (value == null) return 0;
    if (typeof value === "number") return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed / 1000;
  }

  function localCharacters() {
    const store = readJson(CHARACTER_STORE, {});
    return Array.isArray(store.characters) ? store.characters : [];
  }

  // The server matches on owner + case-insensitive name, so the client has to
  // agree exactly or the two will disagree about what "the same character" is.
  function nameKey(name) {
    return String(name ?? "").trim().toLowerCase();
  }

  async function pushCharacters() {
    const mine = localCharacters().filter((entry) => entry?.data?.build);
    const result = { created: 0, updated: 0, keptRemote: 0, failed: [] };

    for (const entry of mine) {
      const body = { build: entry.data, pathbuilder_id: entry.sourceId ?? null };
      try {
        await api("/characters", { method: "POST", body });
        result.created += 1;
      } catch (error) {
        // 409 is the documented "you already have one with that name", and it
        // carries the id. The server never merges by itself; deciding is this
        // side's job.
        if (error.status !== 409 || !error.payload?.character_id) {
          result.failed.push(`${entry.name}: ${error.message}`);
          continue;
        }
        const id = error.payload.character_id;
        try {
          const remote = (await api(`/characters/${id}`)).character;
          if (toSeconds(remote.updated_at) > toSeconds(entry.savedAt)) {
            result.keptRemote += 1;
            continue;
          }
          await api(`/characters/${id}/build`, { method: "PUT", body });
          result.updated += 1;
        } catch (inner) {
          result.failed.push(`${entry.name}: ${inner.message}`);
        }
      }
    }
    return result;
  }

  // Never deletes. A character present only in this browser stays, and one
  // present only on the server is added — a sync that can delete is a sync
  // that can lose a party.
  function mergeCharacters(remote) {
    const store = readJson(CHARACTER_STORE, {});
    const characters = Array.isArray(store.characters) ? store.characters : [];
    const byName = new Map(characters.map((entry) => [nameKey(entry.name), entry]));
    let added = 0;
    let updated = 0;

    for (const row of remote) {
      if (!row.build) continue;
      const existing = byName.get(nameKey(row.name));
      if (!existing) {
        characters.push({
          id: (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replaceAll("-", ""),
          name: row.name,
          sourceId: row.pathbuilder_id ?? null,
          link: null,
          data: row.build,
          groupId: null,
          savedAt: toSeconds(row.updated_at),
        });
        added += 1;
        continue;
      }
      if (toSeconds(row.updated_at) <= toSeconds(existing.savedAt)) continue;
      existing.data = row.build;
      existing.sourceId = row.pathbuilder_id ?? existing.sourceId ?? null;
      existing.savedAt = toSeconds(row.updated_at);
      updated += 1;
    }

    store.characters = characters;
    write(CHARACTER_STORE, JSON.stringify(store));
    return { added, updated };
  }

  // -------------------------------------------------------------------------
  // Battles

  function localBattles() {
    const store = readJson(BATTLE_STORE, {});
    return Array.isArray(store.battles) ? store.battles : [];
  }

  async function pushBattles() {
    const versions = readJson(VERSIONS_KEY, {});
    const result = { stored: 0, conflicts: [], dropped: 0, failed: [] };

    for (const battle of localBattles()) {
      const body = {
        name: battle.name,
        state: battle.state,
        eventLog: battle.eventLog ?? [],
        cursor: battle.cursor ?? -1,
        updated_at: versions[battle.id] ?? null,
      };
      try {
        const saved = await api(`/battles/${encodeURIComponent(battle.id)}`, { method: "PUT", body });
        versions[battle.id] = saved.battle.updated_at;
        result.stored += 1;
        result.dropped += saved.events_dropped ?? 0;
      } catch (error) {
        // A 409 means another browser wrote this battle since we last read it.
        // Reported, never merged and never overwritten — the whole point of the
        // server enforcing this is that neither side guesses.
        if (error.status === 409) result.conflicts.push(battle.name);
        else result.failed.push(`${battle.name}: ${error.message}`);
      }
    }
    write(VERSIONS_KEY, JSON.stringify(versions));
    return result;
  }

  // activeBattleId is deliberately not touched: which battle is open is a
  // preference of this browser, not a fact about the fight.
  function mergeBattles(remote) {
    const store = readJson(BATTLE_STORE, {});
    const battles = Array.isArray(store.battles) ? store.battles : [];
    const versions = readJson(VERSIONS_KEY, {});
    const byId = new Map(battles.map((battle) => [battle.id, battle]));
    let added = 0;
    let updated = 0;

    for (const row of remote) {
      const incoming = {
        id: row.id,
        name: row.name,
        state: row.state,
        eventLog: row.eventLog ?? [],
        cursor: row.cursor ?? -1,
      };
      versions[row.id] = row.updated_at;
      const existing = byId.get(row.id);
      if (!existing) {
        battles.push(incoming);
        added += 1;
        continue;
      }
      Object.assign(existing, incoming);
      updated += 1;
    }

    store.battles = battles;
    if (!store.activeBattleId && battles.length) store.activeBattleId = battles[0].id;
    write(BATTLE_STORE, JSON.stringify(store));
    write(VERSIONS_KEY, JSON.stringify(versions));
    return { added, updated };
  }

  // -------------------------------------------------------------------------
  // UI

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.id = "sync-dialog";
    dialog.innerHTML = `
      <h2>Campaign sync</h2>
      <div id="sync-status" class="sync-status"></div>
      <div id="sync-body" class="sync-body"></div>
      <div class="dialog-actions">
        <button type="button" id="sync-close">Close</button>
      </div>
    `;
    document.body.appendChild(dialog);
    statusEl = dialog.querySelector("#sync-status");
    dialog.querySelector("#sync-close").addEventListener("click", () => dialog.close());
  }

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.className = `sync-status${kind ? ` ${kind}` : ""}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function renderBody() {
    const body = dialog.querySelector("#sync-body");

    if (editingBase || !apiBase()) {
      const override = read(BASE_KEY) ?? "";
      body.innerHTML = `
        <p class="sync-hint">
          Normally blank: this site forwards <code>/sync/</code> to the bot itself,
          so there is nothing to set. Fill it in only when the site is served from
          somewhere without that proxy — then give the bot's own address, e.g.
          <code>https://something.up.railway.app</code>.
        </p>
        <form id="sync-base-form" class="sync-form">
          <input type="text" id="sync-base-input" placeholder="${escapeHtml(DEFAULT_BASE)}" value="${escapeHtml(override)}" autocomplete="off" spellcheck="false" />
          <button type="submit">Save</button>
        </form>
      `;
      body.querySelector("#sync-base-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const value = body.querySelector("#sync-base-input").value.trim();
        try {
          // Empty clears the override and falls back to the built-in path,
          // which is how someone undoes a wrong address without knowing what
          // the right one was.
          write(BASE_KEY, value || null);
        } catch (error) {
          setStatus(error.message, "error");
          return;
        }
        editingBase = false;
        setStatus(value ? "Server address saved." : "Back to this site's own proxy.", "ok");
        person = null;
        renderBody();
        run(async () => { await whoami(); renderBody(); refreshButton(); });
      });
      return;
    }

    if (!person) {
      body.innerHTML = `
        <p class="sync-hint">
          Send <strong>/link</strong> to the bot in a private Telegram chat. It
          replies with an eight-character code, good for five minutes and for one
          browser. Paste it here.
        </p>
        <form id="sync-pair-form" class="sync-form">
          <input type="text" id="sync-code-input" placeholder="ABCD1234" maxlength="16" autocomplete="off" spellcheck="false" />
          <button type="submit">Pair</button>
        </form>
        <p class="sync-hint">
          <button type="button" id="sync-forget-base" class="sync-link">Change server address</button>
        </p>
      `;
      body.querySelector("#sync-pair-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const code = body.querySelector("#sync-code-input").value.trim();
        if (!code) return;
        run(async () => {
          setStatus("Pairing…");
          const who = await pair(code);
          setStatus(`Paired as ${who.display_name || who.username || who.telegram_id}.`, "ok");
          renderBody();
          refreshButton();
        });
      });
      body.querySelector("#sync-forget-base").addEventListener("click", () => {
        editingBase = true;
        setStatus("");
        renderBody();
      });
      return;
    }

    const who = person.display_name || person.username || `Telegram ${person.telegram_id}`;
    body.innerHTML = `
      <p class="sync-hint">Signed in as <strong>${escapeHtml(who)}</strong>.</p>
      <div class="sync-actions">
        <button type="button" id="sync-push">Send to server</button>
        <button type="button" id="sync-pull">Get from server</button>
        <button type="button" id="sync-out">Sign out</button>
      </div>
      <p class="sync-hint">
        Characters are the same ones the bot knows: matched by name, newest wins,
        and nothing is ever deleted on either side. Battles are stored here and
        read by nothing.
        <button type="button" id="sync-base-edit" class="sync-link">Server address</button>
      </p>
      <div id="sync-detail" class="sync-detail"></div>
    `;

    body.querySelector("#sync-base-edit").addEventListener("click", () => {
      editingBase = true;
      setStatus("");
      renderBody();
    });

    body.querySelector("#sync-push").addEventListener("click", () => run(async () => {
      setStatus("Sending…");
      const characters = await pushCharacters();
      const battles = await pushBattles();
      const parts = [
        `${characters.created} character${characters.created === 1 ? "" : "s"} created`,
        `${characters.updated} updated`,
        `${battles.stored} battle${battles.stored === 1 ? "" : "s"} stored`,
      ];
      if (characters.keptRemote) parts.push(`${characters.keptRemote} left alone (server's copy is newer)`);
      if (battles.dropped) parts.push(`${battles.dropped} old log entries trimmed by the server`);
      setStatus(`${parts.join(", ")}.`, "ok");
      showProblems([...characters.failed, ...battles.conflicts.map((n) => `${n}: changed elsewhere — get from server first`), ...battles.failed]);
    }));

    body.querySelector("#sync-pull").addEventListener("click", () => run(async () => {
      setStatus("Fetching…");
      const characters = (await api("/characters")).characters ?? [];
      const battles = (await api("/battles")).battles ?? [];
      const c = mergeCharacters(characters);
      const b = mergeBattles(battles);
      setStatus(`${c.added} character${c.added === 1 ? "" : "s"} added, ${c.updated} updated; ${b.added} battle${b.added === 1 ? "" : "s"} added, ${b.updated} updated. Reloading…`, "ok");
      // Both pages read localStorage once at startup and keep live state in
      // module-level variables, so a reload is the only honest way to make the
      // page agree with what was just written underneath it.
      setTimeout(() => location.reload(), 800);
    }));

    body.querySelector("#sync-out").addEventListener("click", () => {
      signOut();
      setStatus("Signed out. The token is gone from this browser; /sessions in Telegram revokes it on the server.", "ok");
      renderBody();
      refreshButton();
    });
  }

  function showProblems(problems) {
    const detail = dialog.querySelector("#sync-detail");
    if (!detail) return;
    detail.innerHTML = problems.length
      ? `<ul class="sync-problems">${problems.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
      : "";
  }

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

  function refreshButton() {
    const button = document.getElementById("sync-btn");
    if (!button) return;
    button.classList.toggle("connected", Boolean(person));
    button.title = person ? "Campaign sync — paired" : "Campaign sync";
  }

  // The Google Drive backup this replaced left two keys behind in the browsers
  // that used it. Nothing reads them any more, so they're only untidy — but
  // one is an OAuth client ID, and a feature that's gone shouldn't keep hold of
  // it. Safe to delete this whole function once the browsers have come round.
  function forgetDriveKeys() {
    write("pathfinder-dm-tools:google-client-id", null);
    write("pathfinder-dm-tools:google-connected", null);
  }

  function init() {
    const button = document.getElementById("sync-btn");
    if (!button) return;
    try { forgetDriveKeys(); } catch { /* a blocked store has nothing to clear */ }
    buildDialog();
    refreshButton();
    // Resolves the stored token on load so the button can show paired state
    // without opening anything. Failures are silent by design: an expired
    // session is not worth interrupting someone who hasn't asked for anything.
    whoami().then(refreshButton);
    button.addEventListener("click", () => {
      setStatus("");
      renderBody();
      dialog.showModal();
      if (!person && token()) run(async () => { await whoami(); renderBody(); refreshButton(); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
