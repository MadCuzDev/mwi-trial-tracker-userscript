// ==UserScript==
// @name         MWI Trial Tracker
// @namespace    http://tampermonkey.net/
// @version      1.36.2
// @description  Tracks and optimizes trials  on milkywayidle.
// @author       MadCuzDev, Rhohydronian
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      mwitrials.ddns.net
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config (persisted via GM storage, editable from the panel or the
  // Tampermonkey menu). The only built-in default is the hosted backend
  // URL — the character fields have NO defaults on purpose: the identity
  // is normally detected live from the game (init_character_data), and
  // anything the user typed in the Settings view is what they chose.
  // The hosted backend sits behind Nginx + Let's Encrypt at
  // https://mwitrials.ddns.net (Express itself only listens on
  // 127.0.0.1:3001). Both the hosted host and localhost are allowed via
  // @connect, so point apiBase at http://localhost:3001 in the panel/menu
  // to test against a local server (or any other host listed in @connect).
  // ---------------------------------------------------------------------
  const DEFAULTS = {
    apiBase: "https://mwitrials.ddns.net"
  };

  // ---------------------------------------------------------------------
  // localStorage mirror of the GM store.
  //
  // The unofficial Android app (McPeyen's "webview-gm" backbone) persists
  // GM values in SQLite keyed by (script name, script namespace, key), with
  // a FOREIGN KEY ON DELETE CASCADE back to the script row. On every app
  // start AND every onResume, ScriptSyncManager.syncScripts() re-adds each
  // enabled script, and ScriptStoreSQLite.add() is deleteScript +
  // insertScript — so the script row is deleted and re-created, and the
  // cascade wipes EVERY stored GM value. Anything GM_setValue wrote (FAB /
  // panel position, the checkboxes, the API base) is therefore gone the
  // moment the app relaunches, so the script falls back to defaults: "save
  // it, reboot, and it's back to default — even the button position."
  //
  // The same app enables domStorageEnabled on its WebView, and localStorage
  // is keyed by ORIGIN (https://www.milkywayidle.com) — not by script
  // identity — so it survives that cascade untouched. We mirror every value
  // written to GM storage into localStorage (stl.-prefixed keys) and read
  // the mirror first, falling back to GM storage. In Tampermonkey
  // localStorage is also origin-scoped exactly like here, so this is safe
  // and invisible on the desktop. Access is lazy and guarded: localStorage
  // can be absent or throw before the page origin is established or in
  // unusual sandbox setups, in which case there is simply no mirror and GM
  // storage carries on alone.
  const LOCAL_STORAGE_PREFIX = "stl.";
  function pageLocalStorage() {
    try {
      const win = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
      return (win && win.localStorage) ? win.localStorage : null;
    } catch (e) {
      return null;
    }
  }
  function localGet(key) {
    const ls = pageLocalStorage();
    if (!ls) return null;
    let raw;
    try {
      raw = ls.getItem(LOCAL_STORAGE_PREFIX + key);
    } catch (e) {
      return null;
    }
    if (raw === null) return null;
    // Legacy corrupt object: before JSON-encoding, object values (the drag
    // positions) were coerced to "[object Object]" by setItem and are
    // unreadable. Treat that sentinel as "not stored" so the read falls back
    // to GM storage (or the default) instead of returning a junk string
    if (raw === "[object Object]") return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      // Not JSON (a raw scalar string written before JSON-encoding) — return
      // it as-is rather than dropping the value.
      return raw;
    }
  }
  function localSet(key, value) {
    const ls = pageLocalStorage();
    if (!ls) return;
    try {
      // JSON-encode so object values (the drag positions) round-trip intact.
      // localStorage is string-only; a bare object would be coerced to
      // "[object Object]" and become unreadable. Primitives are unaffected:
      // JSON.stringify(true)→"true", (5)→"5", ("abc")→"\"abc\"" — each is
      // restored to its original value by JSON.parse on read.
      ls.setItem(LOCAL_STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* localStorage unavailable (private mode / quota / no DOM) — ignore */
    }
  }
  function localClear(key) {
    const ls = pageLocalStorage();
    if (!ls) return;
    try {
      ls.removeItem(LOCAL_STORAGE_PREFIX + key);
    } catch (e) {
      /* ignore */
    }
  }
  // Read a persisted value from the localStorage mirror first, then from GM
  // storage. `def` is returned only when neither source has a value. (On the
  // Android app the GM copy is wiped on every relaunch, so the mirror is the
  // value that actually survives.)
  function stlGetValue(key, def) {
    const v = localGet(key);
    if (v !== null) return v;
    return GM_getValue(key, def);
  }
  // Write to both the GM store and the localStorage mirror.
  function stlSetValue(key, value) {
    GM_setValue(key, value);
    localSet(key, value);
  }

  // One-shot migration for installs that persisted the old plain-HTTP
  // endpoint before v1.24.0 moved the ledger behind
  // https://mwitrials.ddns.net (the old IP no longer serves the ledger at
  // all). GM storage outranks DEFAULTS, so a stored legacy value would
  // keep shadowing the new default forever — rewrite it in place on load.
  // Idempotent: once rewritten the value no longer matches, so this is a
  // no-op on every subsequent load (and on fresh installs, which have no
  // stored value at all).
  function migrateLegacyApiBase() {
    const LEGACY_API_BASE = "http://23.95.188.114:3001";
    const stored = stlGetValue("apiBase");
    if (
      typeof stored === "string" &&
      stored.replace(/\/+$/, "") === LEGACY_API_BASE
    ) {
      stlSetValue("apiBase", DEFAULTS.apiBase);
    }
  }
  migrateLegacyApiBase();

  // The version of this userscript, sent as X-Stl-Version on every request so
  // the ledger can show each member what version they are running (and the
  // Members page can flag anyone not on the latest). Keep in lockstep with
  // the @version metadata above — bump BOTH on every release (even tiny ones;
  // the third digit is for super-small changes), or the member list will show
  // the wrong "latest" comparison.
  const SCRIPT_VERSION = "1.36.2";

  // All 17 MWI skills: the 10 skilling skills plus the 7 combat stats.
  // `icon` is rendered next to each skill in the roster overlay header and
  // the manual-entry panel. Combat ids match the game's `/skills/<id>`
  // HRIDs, so matchSkillByHrid picks them up from pulled profiles.
  const SKILLS = [
    { id: "milking", label: "Milking", icon: "\uD83D\uDC04" },
    { id: "foraging", label: "Foraging", icon: "\uD83C\uDF44" },
    { id: "woodcutting", label: "Woodcutting", icon: "\uD83C\uDF33" },
    { id: "cheesesmithing", label: "Cheesesmithing", icon: "\uD83D\uDD28" },
    { id: "crafting", label: "Crafting", icon: "\u2692\uFE0F" },
    { id: "tailoring", label: "Tailoring", icon: "\uD83E\uDDF5" },
    { id: "cooking", label: "Cooking", icon: "\uD83E\uDDD1\u200D\uD83C\uDF73" },
    { id: "brewing", label: "Brewing", icon: "\u2615" },
    { id: "alchemy", label: "Alchemy", icon: "\u2697\uFE0F" },
    { id: "enhancing", label: "Enhancing", icon: "\u2728" },
    { id: "stamina", label: "Stamina", icon: "\u2764\uFE0F" },
    { id: "intelligence", label: "Intelligence", icon: "\uD83E\uDDE0" },
    { id: "attack", label: "Attack", icon: "\u2694\uFE0F" },
    { id: "defense", label: "Defense", icon: "\uD83D\uDEE1\uFE0F" },
    { id: "melee", label: "Melee", icon: "\u270A" },
    { id: "ranged", label: "Ranged", icon: "\uD83C\uDFF9" },
    { id: "magic", label: "Magic", icon: "\uD83E\uDE84" }
  ];

  // Auto-sync cadence (v1.26.0): the logged-in character is pushed to the
  // ledger on game (re)open and then at most once every 30 minutes while the
  // page stays open. Fixed interval, not configurable (see the panel toggle
  // below for opt-out). The cooldown state lives in GM storage so reloads
  // and tab re-opens within the window can't re-trigger a push.
  const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

  // Clear a GM key the way a fresh install never had it: DELETE it. Storing
  // null instead is not equivalent — some GM backends hand back the stored
  // null (or the string "null"), which is truthy and would shadow the
  // DEFAULTS fallback (v1.28.0 reset bug: apiBase read back as "null").
  // Fall back to storing null on backends without GM_deleteValue so the key
  // at least no longer holds its previous value; the reads below treat a
  // stored null / "null" as "not stored" anyway.
  function clearStoredValue(key) {
    if (typeof GM_deleteValue === "function") {
      GM_deleteValue(key);
    } else {
      GM_setValue(key, null);
    }
    // Drop the localStorage mirror too, so "Reset to default" (and the
    // per-key clears) can't be shadowed by a stale mirrored value on the
    // next read.
    localClear(key);
  }

  function cfgGet() {
    // A stored null, or the strings "null" / "undefined" (left behind by
    // reset/delete runs — the Android webview-gm bridge is string-only and
    // can hand back the literal "undefined"), or a blank value, means "not
    // stored" — fall back to the default instead of shadowing it. (v1.28.0
    // bug: read back as "null"; v1.29.1 follow-up: read back as "undefined",
    // which produced URLs like "undefined/api/roster/..."; a blank value —
    // e.g. the Send/menu save paths persisting an emptied field — would
    // produce relative "/api/..." URLs.) We return the trimmed value so a
    // stray space can never split the host from the path.
    const storedApiBase = stlGetValue("apiBase");
    const raw = {
      apiBase:
        typeof storedApiBase === "string" &&
        storedApiBase !== "null" &&
        storedApiBase !== "undefined" &&
        storedApiBase.trim() !== ""
          ? storedApiBase.trim()
          : DEFAULTS.apiBase,
      // v1.28.0: no seed defaults — empty until the game reports the
      // logged-in character (init_character_data) or the user types a
      // value in the Settings view.
      characterId: stlGetValue("characterId", null),
      characterName: stlGetValue("characterName", null),
      hideUpdateFab: stlGetValue("hideUpdateFab", false),
      // FAB position lock: true (default) = pinned bottom-right, not
      // draggable; false = free to drag anywhere. Old installs have no
      // value stored, so they default to locked.
      fabLocked: stlGetValue("fabLocked", true),
      fabPosition: stlGetValue("fabPosition", null),
      // Panel (window) position lock: true (default) = title bar can't drag
      // the panel around; false = free to drag by the title. Same
      // defensive default-true pattern as fabLocked — a fresh install (or
      // an old one with no stored value) comes up locked.
      panelLocked: stlGetValue("panelLocked", true),
      panelPosition: stlGetValue("panelPosition", null),
      overlayPosition: stlGetValue("overlayPosition", null),
      overlayPillPosition: stlGetValue("overlayPillPosition", null),
      // Per-player auto-sync (v1.26.0): ON by default — the logged-in
      // character is pushed on game open and every 30 minutes unless the
      // user opts out via the panel checkbox. Same defensive default-true
      // pattern as fabLocked: a fresh install gets no stored value at all,
      // so GM_getValue returns the `true` default and coercion keeps it on.
      autoSyncEnabled: stlGetValue("autoSyncEnabled", true)
    };
    // The Android app's GM storage is string-only: numbers and booleans come
    // back as strings ("12345", "true", "false"). Left raw, a string like
    // "false" is truthy (which would hide the FAB) and a string ID would
    // fail `Number.isInteger()` checks. Coerce the typed fields back to real
    // types so behaviour matches Tampermonkey. characterId becomes null when
    // the stored value isn't a real number (v1.28.0: no seed default).
    const idNum = parseInt(raw.characterId, 10);
    raw.characterId = Number.isNaN(idNum) ? null : idNum;
    raw.hideUpdateFab = raw.hideUpdateFab === true || raw.hideUpdateFab === "true";
    raw.fabLocked = !(raw.fabLocked === false || raw.fabLocked === "false");
    raw.panelLocked = !(raw.panelLocked === false || raw.panelLocked === "false");
    // Inverted check: ON unless the stored value is explicitly false or the
    // string "false" (Android webview-gm string-only storage).
    raw.autoSyncEnabled =
      !(raw.autoSyncEnabled === false || raw.autoSyncEnabled === "false");
    return raw;
  }
  function cfgSet(partial) {
    if (partial.apiBase !== undefined) stlSetValue("apiBase", partial.apiBase);
    if (partial.characterId !== undefined) stlSetValue("characterId", partial.characterId);
    if (partial.characterName !== undefined) stlSetValue("characterName", partial.characterName);
    if (partial.hideUpdateFab !== undefined) stlSetValue("hideUpdateFab", partial.hideUpdateFab);
    if (partial.fabLocked !== undefined) stlSetValue("fabLocked", partial.fabLocked);
    if (partial.panelLocked !== undefined) stlSetValue("panelLocked", partial.panelLocked);
    if (partial.fabPosition !== undefined) stlSetValue("fabPosition", partial.fabPosition);
    if (partial.panelPosition !== undefined) stlSetValue("panelPosition", partial.panelPosition);
    if (partial.overlayPosition !== undefined) stlSetValue("overlayPosition", partial.overlayPosition);
    if (partial.overlayPillPosition !== undefined) stlSetValue("overlayPillPosition", partial.overlayPillPosition);
    if (partial.autoSyncEnabled !== undefined) stlSetValue("autoSyncEnabled", partial.autoSyncEnabled);
  }

  // ---------------------------------------------------------------------
  // Per-browser character identity.
  //
  // GM storage is shared across every character you log in to in this
  // browser, so a single stored characterId/characterName pair goes stale
  // the moment you switch characters in-game. Whenever the game tells us
  // who we are (init_character_data — direct WebSocket, or the Toolasha
  // snapshot of the same message), remember it here;
  // `resolveCharacter()` always returns the freshest known identity,
  // falling back to the configured (or default) values.
  // ---------------------------------------------------------------------
  function rememberCharacter(id, name) {
    const idNum = Number(id);
    if (Number.isInteger(idNum) && idNum > 0) {
      stlSetValue("detectedCharacterId", idNum);
    }
    if (typeof name === "string" && name.trim()) {
      stlSetValue("detectedCharacterName", name.trim());
    }
    // Keep the in-memory detection in sync so the panel/login UI updates
    // without waiting for the next GM_getValue round-trip.
    if (Number.isInteger(idNum) && idNum > 0) detectedCharacterId = idNum;
    if (typeof name === "string" && name.trim()) detectedCharacterName = name.trim();
  }

  // The character this browser is acting as, most recent first:
  //   1. last identity captured from the game (this page load),
  //   2. last identity captured on any previous load of this browser,
  //   3. the configured value (which may itself be empty — v1.28.0 removed
  //      the seed defaults for character ID/name).
  // Name resolution mirrors the ID resolution so the two never disagree
  // (e.g. detected ID + configured name).
  function resolveCharacter() {
    const cfg = cfgGet();
    // GM storage is string-only on the Android app bridge, so coerce the
    // persisted ID back to a number (same treatment as cfgGet()).
    const storedId = parseInt(stlGetValue("detectedCharacterId", null), 10);
    const id =
      detectedCharacterId !== null
        ? detectedCharacterId
        : (!Number.isNaN(storedId) && storedId > 0 ? storedId : cfg.characterId);
    const name =
      detectedCharacterName !== null
        ? detectedCharacterName
        : (stlGetValue("detectedCharacterName", "") || cfg.characterName);
    return { characterId: id, characterName: name };
  }

  // ---------------------------------------------------------------------
  // Auto-detection of skill levels from the game's WebSocket traffic.
  //
  // KEY POINT: this userscript runs inside the Tampermonkey sandbox, whose
  // `window` is NOT the page's real window. The game opens its socket with
  // the PAGE's native WebSocket, so patching sandbox `window.WebSocket`
  // never sees a single message. We therefore hook through `unsafeWindow`
  // (the real page window):
  //   1. Hook the getter of `MessageEvent.prototype.data` on the page
  //      prototype — every socket message passes through it, including
  //      sockets created before/without our constructor wrapper.
  //   2. As a secondary path, wrap the page's `WebSocket` constructor so
  //      sockets created after document-start also get a message listener.
  //
  // Known MWI message shapes (observed in traffic, same as Toolasha's
  // data manager):
  //   - init_character_data: { character: { id, name, ... },
  //                            characterSkills: [ { skillHrid, level,
  //                            experience }, ... ] }
  //   - skills_updated:      { characterSkills: [ full replacement array ] }
  //   - action_completed:    { endCharacterSkills: [ partial array; each
  //                            entry carries `level` only when it changed ] }
  //
  // Fallback: the game also renders every skill level in the left nav
  // sidebar, so `readLevelsFromSidebar()` can fill any gaps by reading
  // the DOM (stable `svg[aria-label="navigationBar.<name>"]` icons).
  // ---------------------------------------------------------------------
  const detectedLevels = {};
  let detectedCharacterId = null;
  let detectedCharacterName = null;

  // The most recent optimizer plan from the ledger backend (fetched from
  // GET /api/trials/plans/latest on every sweep). The trial highlight
  // follows this character's assignment in that plan — no plan, or not
  // assigned, means no highlight. Kept across fetch failures.
  let latestPlan = null;
  let planFetchInFlight = false;
  // v1.36.1: plan fetch state, so a FAILED fetch is distinguishable from a
  // confirmed "no plan" (404). "unknown" = never fetched successfully this
  // load (the default — a wedged/broken transport leaves it here), "none" =
  // confirmed 404 (no optimizer run), "ready" = a plan is loaded. When the
  // panel is open and this is still "unknown" after a fetch attempt, the
  // highlight path paints a "ledger unreachable" notice instead of saying
  // nothing (2026-10-20: on the Android app the GM bridge can drop its
  // ontimeout callback, so the plan promise hung forever, planFetchInFlight
  // wedged true, and every later sweep silently skipped — no highlight AND
  // no "sit out" notice. gmRequest now carries a JS-side deadline race, and
  // sweep() force-releases a flag held far beyond the deadline).
  let planState = "unknown";
  let planFetchAttempted = false;
  let planFetchStartedAt = 0;
  const TRIAL_HEADING = "skilling trial";
  // A planFetchInFlight flag held longer than this is a wedged promise (no
  // GM callback fired, not even ontimeout). sweep() force-releases it so one
  // lost callback can't silence the plan refresh for the rest of the page
  // load. ~2.5x the 8 s request timeout + the JS-side deadline race, so a
  // healthy-but-slow fetch can never trip it.
  const PLAN_FETCH_FORCE_RELEASE_MS = 20000;

  // In-game "update available" reminder: the newest script version the ledger
  // reports (GET /api/config → latestScriptVersion), fetched at startup and on
  // each panel open. A banner + a dot on the FAB appear while this script is
  // older than that, unless the user dismissed THIS specific version.
  let updateLatest = null;
  let updateFetchInFlight = false;

  // v1.29.0: trial highlight + panel observation state. Declared here
  // (near the other plan state, well above the startup block) instead of
  // next to the functions that use it: on a late page load the startup
  // block runs sweep() synchronously, and sweep() reaches into these
  // variables — declared later in the file that would be a let-TDZ
  // ReferenceError that kills the whole script.
  // appliedHighlight: the card the highlight is currently painted on
  // (plus the assignment that produced it), so a re-run can skip all DOM
  // work when nothing changed — required for the MutationObserver path,
  // where our own writes must not re-trigger the observer (infinite loop).
  let appliedHighlight = null; // { label, pts, card } | null
  let appliedNoTrialNotice = null; // panel the "no suitable trial" notice is painted on
  const HIGHLIGHT_RETRY_MS = 500;
  const TRIALS_TAB_MARKER = '[class*="GuildPanel_trialsTab__"]';
  let trialPanelWatcher = null; // document-level mount/unmount observer
  let trialPanelObserver = null; // panel-level re-render observer
  let trialPanelTarget = null; // the panel element currently observed
  let highlightRetryTimer = null;
  let highlightRetryCount = 0;
  let highlightRetryPanel = null;

  const GAME_WS_MARKERS = ["api.milkywayidle.com/ws", "api-test.milkywayidle.com/ws"];

  // ---------------------------------------------------------------------
  // Guild roster (Pull / Push).
  //
  // The game exposes two things over the same socket we already hook:
  //   1. The guild member list. It arrives in `guild_characters_updated`
  //      (fired when the in-game Guild panel is opened) and is also
  //      embedded in the `init_character_data` guild object at login.
  //   2. Per-member skill levels. There is no bulk endpoint — we request
  //      each member one at a time by sending
  //          { type: "view_profile", viewProfileData: { characterName } }
  //      and the game answers with a `profile_shared` message that carries
  //      that member's full `characterSkills` array. (Same protocol the
  //      "One-Click Guild Member Info" userscript uses.)
  //
  // `gameSocket` is a reference to the live game socket we can call
  // `.send()` on. We capture it from whichever hook path sees the game's
  // WebSocket first.
  // ---------------------------------------------------------------------
  let gameSocket = null;
  let guildName = null;
  let guildMembers = []; // [{ characterId, characterName, role }]
  // v1.34.0: the numeric guild ID of the captured in-game guild, read from
  // the player's OWN init_character_data guild object (the same field the
  // SFTB guild's export script gates on). Sent as X-Stl-Guild-Id on every
  // request so the ledger can verify membership from the player's own game
  // data — no full-guild roster re-push needed when membership changes.
  let detectedGuildId = null;
  // This week's two combat-trial encounters, as the game reports them
  // (guildWeeklyTrialSet.combatHrids, e.g. ["/guild_combat/badger",
  // "/guild_combat/swarm"]). Captured from the guild_updated /
  // guild_characters_updated messages and pushed to the ledger so the Combat
  // Dashboard can name the two teams after this week's monsters. null until
  // the game tells us (it arrives once the Guild panel is open or on login).
  let combatTrialHrids = null;
  let combatTrialsSent = false; // one-time push flag (per page load)
  // This week's skilling-trial skills, as the game reports them
  // (guildWeeklyTrialSet.skillHrids, e.g. ["/guild_skilling/milking",
  // "/guild_skilling/alchemy", …]). Same messages as the combat set, pushed to
  // the ledger so the Skilling Dashboard auto-selects this week's 4 trial
  // skills. null until the game tells us.
  let skillingTrialHrids = null;
  // The game's raw `currentTrialsData` string (JSON) from the same guild
  // message — its `skilling.parties` key order is the in-game panel order, used
  // to reindex skillingTrialHrids so the Skilling Dashboard mirrors it. null
  // until a guild message carrying it is seen.
  let skillingCurrentTrialsData = null;
  // v1.36.0: this week's trial panel order as read from the in-game Guild →
  // Trials DOM — { skilling: [skill labels top→bottom], combat: [trial names
  // top→bottom] } — captured whenever the panel is observed (the game renders
  // the tiles in its static sortIndex order, which the raw
  // guildWeeklyTrialSet.skillHrids array does NOT reflect, and which a
  // userscript cannot otherwise obtain: the sortIndex table rides in the
  // binary init_client_data frame). Cached so the push path can reorder
  // without the panel being open. null until the panel is seen.
  let panelTrialOrder = null;
  let lastSkillingPush = null; // hrid array last pushed for skilling (panel-order self-correction)
  let lastCombatPush = null; // hrid array last pushed for combat (panel-order self-correction)
  // The game's STATIC guild-trial detail table (per-trial sortIndex/kind),
  // which the game feeds to ci.initialize() from its init_client_data login
  // frame. We capture it best-effort from that WS frame (see
  // captureGuildTrialDetails) when it arrives as a parseable string. The
  // table is week-INDEPENDENT (static content shipped with the game build),
  // so one capture is enough for the whole session. It is a PRIMARY order
  // source; when it isn't captured the push path confirms the order via the
  // Guild → Trials DOM read (skilling+combat) or currentTrialsData (skilling
  // only) instead, and otherwise HOLDS the push rather than storing a raw
  // (unconfirmed) order. null until captured.
  let guildTrialDetailMap = null;
  let skillingTrialsSent = false; // one-time push flag (per page load)
  let pulledProfiles = {}; // characterId (or name when no ID available) -> { characterId, characterName, totalLevel, skills: {skillId: level} }
  // Full normalized profiles for the Weekly Skilling Trial optimizer (v1.6.0):
  // keyed by the same key as pulledProfiles, carries loadouts/buffMaps/labShop
  // plus a raw snapshot for debugging when a field is missing.
  let pulledProfilesFull = {};
  let ownProfileRaw = null; // raw init_character_data payload, kept for re-capture on fresh pulls
  let clientDataSent = false; // one-time itemDetailMap push flag (per page load)
  let pullState = { running: false, paused: false, fetched: 0, total: 0, aborted: false };
  let overlayEl = null;
  let overlayBuilt = false;
  let overlayState = { minimized: false };

  const PROFILE_FETCH = {
    delayMs: 1000, // gap between member requests
    timeoutMs: 5000, // wait this long for a single member's profile_shared
    maxRetries: 2 // re-send the view_profile request on timeout
  };

  function isGameSocket(socket) {
    try {
      const url = String((socket && socket.url) || "");
      return GAME_WS_MARKERS.some((m) => url.includes(m));
    } catch (e) {
      return false;
    }
  }

  // Map a skillHrid like "/skills/milking" to one of our SKILLS by exact
  // match on the last path segment (case-insensitive). Exact match avoids
  // false positives the old substring heuristic could produce.
  function matchSkillByHrid(hrid) {
    if (typeof hrid !== "string") return null;
    const segment = hrid.split("/").pop().toLowerCase();
    return SKILLS.find((s) => s.id === segment) || null;
  }

  // Ingest a `characterSkills` / `endCharacterSkills` array. In the
  // action_completed partial array an entry's `level` is only present when
  // that skill's whole level changed, so we only store real numbers.
  function ingestSkills(skills) {
    if (!Array.isArray(skills)) return;
    for (const entry of skills) {
      if (!entry || typeof entry !== "object") continue;
      const skill = matchSkillByHrid(entry.skillHrid);
      if (!skill) continue;
      if (typeof entry.level === "number" && Number.isFinite(entry.level)) {
        detectedLevels[skill.id] = entry.level;
      }
    }
  }

  // Type-aware dispatch for a parsed game message. Unknown types are
  // ignored — the game sends a lot of unrelated traffic.
  function handleGameMessage(data) {
    if (!data || typeof data !== "object") return;
    switch (data.type) {
      case "init_character_data":
        if (data.character && typeof data.character === "object") {
          // Always take the latest identity: the game re-sends init data on
          // every (re)load and on character switch, and stale values here
          // are exactly what makes the tracker act as the wrong character.
          rememberCharacter(data.character.id, data.character.name);
          // The character is now known — enable the ledger-login confirm
          // button if the panel is open.
          refreshLoginUi();
        }
        ingestSkills(data.characterSkills);
        // v1.6.0: snapshot our own trial profile (loadouts, buff maps, lab
        // shop) for the Weekly Skilling Trial optimizer.
        ingestOwnProfile(data);
        // Capture this week's skilling/combat trials from the login payload too
        // (best-effort). The game usually reports the weekly set via the guild
        // panel messages (guild_updated / guild_characters_updated), but when it
        // is also present on init_character_data we capture it immediately so a
        // fresh login + "Sync Character" pushes it without first opening the
        // in-game Guild panel. No-op when the payload doesn't include it.
        captureCombatTrials(data);
        captureSkillingTrials(data);
        // v1.26.0: game (re)open — auto-sync if enabled and due (cooldown
        // dedupes the init re-send on character switch / reload).
        maybeAutoSync();
        break;
      case "skills_updated":
        ingestSkills(data.characterSkills);
        break;
      case "action_completed":
        ingestSkills(data.endCharacterSkills);
        break;
      case "guild_characters_updated":
        handleGuildCharactersUpdated(data);
        captureCombatTrials(data);
        captureSkillingTrials(data);
        break;
      case "guild_updated":
        captureCombatTrials(data);
        captureSkillingTrials(data);
        break;
      case "profile_shared":
        ingestProfileResponse(data);
        break;
      case "init_client_data":
        // The static guild-trial table (per-trial sortIndex/kind) rides in
        // this login frame — it's the source the game uses to sort the
        // Guild → Trials panel. Capturing it lets us order this week's
        // trials exactly like the game does, with no panel/UI interaction.
        captureGuildTrialDetails(data);
        break;
      default:
        break;
    }
    // Guild object embedded in init_character_data (login) — capture the
    // roster even if the user never opens the Guild panel.
    if (data.type === "init_character_data") {
      const guild = data.guild || data.myGuild || data.guildInfo || (data.characterData && data.characterData.guild);
      if (guild && typeof guild === "object") {
        // v1.34.0: the player's OWN guild ID from their own init data —
        // this is what the server's push gate verifies against the
        // admin-configured expected guild ID (defensive across field
        // naming: the game's export script uses `guild.id`).
        const gid = guild.id || guild.guildId || guild.guild_id;
        const gidNum = Number(gid);
        if (Number.isInteger(gidNum) && gidNum > 0) {
          detectedGuildId = gidNum;
        }
        const members = extractMembers(guild);
        if (members.length > 0) {
          ingestGuildRoster(members, guild.name || guild.guildName || null);
        }
      }
    }
  }

  const processedMessageEvents = new WeakSet();

  // Deferred message queue: raw strings are pushed as they arrive and
  // drained in idle time, so parsing/handling never runs synchronously
  // inside the game's own message dispatch. `profile_shared` stays on a
  // fast path (handled inline) because the Pull flow awaits it.
  const messageQueue = [];
  let drainScheduled = false;

  function deferWork(callback, timeoutMs) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(callback, { timeout: timeoutMs });
    } else {
      setTimeout(callback, 0);
    }
  }

  function queueRawMessage(raw) {
    messageQueue.push(raw);
    if (drainScheduled) return;
    drainScheduled = true;
    deferWork(drainMessageQueue, 2000);
  }

  function drainMessageQueue() {
    drainScheduled = false;
    let raw;
    while ((raw = messageQueue.shift()) !== undefined) {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        continue; // Not JSON — not a game state message.
      }
      try {
        handleGameMessage(data);
      } catch (e) {
        // Never let a parsing bug break the game's own socket handling.
      }
    }
  }

  function processSocketMessage(event, socket) {
    // Only track game-socket events so the dedupe set stays bounded by
    // the game's own traffic (never other sockets' events).
    if (!isGameSocket(socket)) return;

    // Dedupe: the same MessageEvent can be observed through both our
    // constructor listener and the data-getter hook. Must happen BEFORE
    // reading event.data — the getter hook re-enters this function.
    if (processedMessageEvents.has(event)) return;
    processedMessageEvents.add(event);

    let raw;
    try {
      raw = event.data;
    } catch (e) {
      return;
    }
    if (typeof raw !== "string" || !raw) return;

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return; // Not JSON — not a game state message.
    }
    if (data && data.type === "profile_shared") {
      try {
        handleGameMessage(data);
      } catch (e) {
        /* never break the game */
      }
      return;
    }
    queueRawMessage(raw);
  }

  // Keep a reference to the live game socket so the Pull flow can send
  // `view_profile` requests. We only care about sockets that are actually
  // open and sendable; a closed socket is dropped so the next (re)connect
  // re-captures a fresh one.
  function rememberGameSocket(socket) {
    if (!socket) return;
    try {
      if (typeof socket.send !== "function") return;
      if (socket.readyState !== 0 && socket.readyState !== 1) return; // CONNECTING/OPEN
      gameSocket = socket;
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------
  // Guild roster ingestion (Pull / Push).
  //
  // Two message types carry what we need (shapes taken from the
  // "One-Click Guild Member Info" userscript, verified against the game):
  //   - guild_characters_updated:
  //       { guildCharacterMap: { [charId]: { role, joinTime, ... } },
  //         guildSharableCharacterMap: { [charId]: { name, isOnline } } }
  //     Fired when the Guild panel is opened.
  //   - init_character_data: the guild object (and its members) is embedded
  //     here at login, so we capture the roster without requiring the user
  //     to open the panel.
  //   - profile_shared: one member's full profile, in response to our
  //     view_profile request. Carries characterSkills: [{skillHrid, level}].
  // ---------------------------------------------------------------------

  // Normalise a member entry (array item or object value) into our shape.
  function normalizeMember(key, value) {
    if (!value || typeof value !== "object") return null;
    const id = value.characterId || value.id || value.character_id || key;
    const name = value.characterName || value.name || value.username || value.playerName;
    if (id === undefined || id === null || !name) return null;
    return {
      characterId: Number(id),
      characterName: String(name),
      role: value.role || value.guildRole || value.rank || "member"
    };
  }

  // Extract a member list from whatever guild-shaped object we're given.
  function extractMembers(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed.map((m) => normalizeMember(null, m)).filter(Boolean);
    for (const key of ["members", "guildMembers", "guild", "guildData"]) {
      if (parsed[key]) {
        const sub = parsed[key];
        if (Array.isArray(sub)) return sub.map((m) => normalizeMember(null, m)).filter(Boolean);
        if (typeof sub === "object") {
          return Object.entries(sub).map(([k, v]) => normalizeMember(k, v)).filter(Boolean);
        }
      }
    }
    return [];
  }

  // Merge a fresh roster into state. We union by characterId so partial
  // updates (login object vs panel-open message) don't drop members.
  function ingestGuildRoster(members, name) {
    if (!Array.isArray(members) || members.length === 0) return;
    if (name) guildName = name;
    const byId = new Map(guildMembers.map((m) => [m.characterId, m]));
    for (const m of members) {
      if (!m || m.characterId === null || m.characterId === undefined) continue;
      byId.set(m.characterId, m);
    }
    guildMembers = [...byId.values()];
    // Refresh any open overlay so the roster count stays accurate.
    if (overlayEl && overlayEl.classList.contains("stl-overlay-open")) renderOverlay();
  }

  function handleGuildCharactersUpdated(data) {
    const charMap = data.guildCharacterMap || {};
    const sharableMap = data.guildSharableCharacterMap || {};
    const members = [];
    for (const charId of Object.keys(charMap)) {
      const charData = charMap[charId];
      const sharable = sharableMap[charId] || {};
      if (!charData) continue;
      const name = sharable.name || charData.name || `ID:${charId}`;
      members.push({
        characterId: Number(charId),
        characterName: String(name),
        role: charData.role || "member"
      });
    }
    ingestGuildRoster(members, data.guildName || null);
  }

  // Parse one member's skill levels out of a profile_shared payload.
  // Profiles are stored keyed by numeric characterId (resolved from the
  // payload) so two members can never overwrite each other's entry; when
  // no ID is available the name is used as the key instead.
  function ingestProfileResponse(data) {
    const raw = data.profile || data.profileSharedData || data.profileData || data;
    const sharable = raw && raw.sharableCharacter ? raw.sharableCharacter : {};
    const id =
      (sharable && sharable.id) ||
      (raw && raw.character && typeof raw.character === "object" && raw.character.id) ||
      (raw && raw.characterId) ||
      null;
    let name = (sharable && sharable.name) || raw.characterName || raw.name;
    if (!name) {
      // Recover the name from the captured roster when we have the ID.
      const member = id !== null ? guildMembers.find((m) => m.characterId === Number(id)) : null;
      name = member ? member.characterName : `ID:${id}`;
    }

    let characterSkills = raw.characterSkills;
    if (!Array.isArray(characterSkills) && characterSkills && typeof characterSkills === "object") {
      characterSkills = Object.values(characterSkills);
    }
    const skills = {};
    let totalLevel;
    if (Array.isArray(characterSkills)) {
      for (const sk of characterSkills) {
        if (!sk) continue;
        const hrid = sk.skillHrid || sk.hrid || sk.skill_hrid || sk.id || sk.skillId;
        if (!hrid) continue;
        const segment = String(hrid).split("/").pop().toLowerCase();
        if (segment === "total_level") {
          if (typeof sk.level === "number") totalLevel = sk.level;
          continue;
        }
        const skill = SKILLS.find((s) => s.id === segment);
        if (skill && typeof sk.level === "number" && Number.isFinite(sk.level)) {
          skills[skill.id] = sk.level;
        }
      }
    }
    if (totalLevel === undefined) {
      totalLevel = sharable.totalLevel ?? raw.totalLevel ?? sharable.total_level ?? raw.total_level;
    }

    const characterId = id !== null && id !== undefined ? Number(id) : null;
    const fallbackId = (guildMembers.find((m) => m.characterName === name) || {}).characterId || null;
    const finalId = characterId !== null ? characterId : fallbackId;
    const key = finalId !== null ? finalId : name;
    // v1.35.1: equipped abilities from the pull's raw, so the roster overlay
    // can show them. A guild pull's sharable raw carries `equippedAbilities`
    // (slots 1–5); our own init raw carries `characterAbilities` instead, so
    // fall back to its equipped entries (slotNumber > 0).
    let equippedRaw = raw && raw.equippedAbilities;
    if (!Array.isArray(equippedRaw) && raw && Array.isArray(raw.characterAbilities)) {
      equippedRaw = raw.characterAbilities.filter((a) => a && Number(a.slotNumber) > 0);
    }
    const abilities = [];
    if (Array.isArray(equippedRaw)) {
      for (const a of equippedRaw) {
        if (!a || !a.abilityHrid) continue;
        abilities.push({
          hrid: a.abilityHrid,
          level: typeof a.level === "number" ? a.level : 0,
          slot: Number(a.slotNumber) > 0 ? Number(a.slotNumber) : null
        });
      }
      abilities.sort((x, y) => (x.slot === null ? 99 : x.slot) - (y.slot === null ? 99 : y.slot));
    }
    pulledProfiles[key] = {
      characterId: finalId,
      characterName: name,
      totalLevel: typeof totalLevel === "number" ? totalLevel : null,
      skills,
      abilities
    };
    // v1.6.0: keep the full normalized trial profile too.
    const full = normalizeMemberProfile(raw, name, finalId);
    full.skills = skills;
    pulledProfilesFull[key] = full;
    pullState.fetched = Object.keys(pulledProfiles).length;
    if (overlayEl && overlayEl.classList.contains("stl-overlay-open")) renderOverlay();
  }

  // ---------------------------------------------------------------------
  // v1.6.0 — full trial profile capture (Weekly Skilling Trial optimizer)
  //
  // On top of skill levels, the optimizer needs each member's:
  //   - loadouts (equipment per skill, no consumables)
  //   - non-equipment buff maps (house/achievement/community/mooPass)
  //   - labirynth shop levels (permanent upgrades)
  //   - per-skill loadout selection (characterSetting)
  //
  // Exact field names vary between game versions, so every extractor is
  // tolerant: it tries the known shapes and falls back to {} / null when
  // nothing matches. The full raw profile is kept under `raw` so a
  // missing field can be diagnosed later without re-pulling.
  // ---------------------------------------------------------------------

  const PASCAL_SKILL_LABELS = SKILLS.map((s) => s.id.charAt(0).toUpperCase() + s.id.slice(1));

  // Parse a wearable reference like
  // "loadouts/123::/items/456::3" -> { itemHrid: "/items/456", enhancementLevel: 3 }.
  // The real game format (characterLoadoutMap.wearableMap values) is the same
  // "::" separator but the item part is found by prefix, not position — the
  // loadout-id part is not always first, and the enhancement part is absent
  // for unenhanced items.
  function parseWearableReference(ref) {
    if (typeof ref !== "string" || !ref) return null;
    const parts = ref.split("::");
    const itemPart = parts.find((p) => p.startsWith("/items/"));
    if (!itemPart) return null;
    const last = parts[parts.length - 1];
    const enhancementLevel = last.startsWith("/") ? 0 : parseInt(last, 10);
    return {
      itemHrid: itemPart,
      enhancementLevel: Number.isFinite(enhancementLevel) ? enhancementLevel : 0
    };
  }

  // Normalize one loadout object (shape-tolerant) into the ledger's shape:
  // { loadoutId, name, actionTypeHrid, isDefault,
  //   equipment: [{ slot, itemHrid, enhancementLevel }] }.
  // `fallbackId` is the key of the loadout inside characterLoadoutMap — the
  // real entries are keyed by id and the id is what per-skill settings
  // (characterSetting.labyrinthLoadout<Pascal>) point at.
  function normalizeLoadout(rawLo, fallbackId) {
    if (!rawLo || typeof rawLo !== "object") return null;
    const rawId =
      rawLo.id ?? rawLo.loadoutId ?? rawLo.loadout_id ?? fallbackId ?? null;
    const loadoutId = rawId === null ? null : Number(rawId);
    const name = typeof rawLo.name === "string" && rawLo.name ? rawLo.name : null;
    const actionTypeHrid =
      rawLo.actionTypeHrid || rawLo.actionType || rawLo.action_type || rawLo.actionTypeHrids || null;
    const isDefault = !!rawLo.isDefault;
    // Equipment may be an array, a slot->reference map, or a slot->object map.
    // The real game field is `wearableMap`: locationHrid -> wearable reference
    // ("loadouts/N::/items/X::E"), exactly what parseWearableReference expects.
    const equipment = [];
    const source =
      rawLo.wearableMap || rawLo.equipment || rawLo.equipmentMap || rawLo.items || null;
    if (Array.isArray(source)) {
      source.forEach((entry, i) => {
        if (!entry) return;
        let parsed = null;
        let slot = null;
        if (typeof entry === "string") {
          parsed = parseWearableReference(entry);
          slot = entry.split("::")[0] || null;
        } else if (typeof entry === "object") {
          slot = entry.slot || entry.slotId || entry.equipmentSlot || null;
          const ref = entry.reference || entry.wearableReference || entry.value || entry.item || null;
          parsed = typeof ref === "string"
            ? parseWearableReference(ref)
            : (entry.itemHrid
              ? { itemHrid: String(entry.itemHrid), enhancementLevel: Number(entry.enhancementLevel) || 0 }
              : null);
        }
        if (parsed) equipment.push({ slot: slot || "slot" + i, ...parsed });
      });
    } else if (source && typeof source === "object") {
      for (const [slot, value] of Object.entries(source)) {
        const parsed = typeof value === "string"
          ? parseWearableReference(value)
          : (value && value.itemHrid
            ? { itemHrid: String(value.itemHrid), enhancementLevel: Number(value.enhancementLevel) || 0 }
            : null);
        if (parsed) equipment.push({ slot, ...parsed });
      }
    }
    return {
      loadoutId,
      name,
      actionTypeHrid: typeof actionTypeHrid === "string" ? actionTypeHrid : null,
      isDefault,
      equipment
    };
  }

  // Extract a member's loadouts from a profile payload.
  // `characterLoadoutMap` is the real in-game field (an id-keyed object,
  // present in both init_character_data and profile_shared.profile); the
  // map key is the loadout id, so it's passed as the id fallback. The
  // *Dict variant is how the game renames *Map fields in its React state.
  function extractLoadouts(raw) {
    if (!raw || typeof raw !== "object") return [];
    const candidates = [
      raw.characterLoadoutMap,
      raw.characterLoadoutDict,
      raw.loadouts,
      raw.loadoutData,
      raw.equipmentLoadouts,
      raw.characterLoadouts,
      raw.loadoutList
    ];
    for (const cand of candidates) {
      if (Array.isArray(cand)) return cand.map(normalizeLoadout).filter(Boolean);
      if (cand && typeof cand === "object" && !Array.isArray(cand)) {
        const entries = Object.entries(cand);
        if (entries.length > 0) {
          return entries
            .map(([key, value]) => normalizeLoadout(value, key))
            .filter(Boolean);
        }
      }
    }
    return [];
  }

  // Extract the non-equipment buff maps the trial model sums
  // (house/achievement/community/mooPass). Each maps actionType -> buffs[].
  function extractBuffMaps(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const key of ["house", "achievement", "community", "mooPass"]) {
      const map = raw[key] ?? raw[key + "Buffs"] ?? raw["buff" + key];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        out[key] = map;
      }
    }
    return out;
  }

  // Extract labirynth shop levels (permanent upgrades).
  function extractLabShop(raw) {
    const out = {
      labyrinthSkillingEfficiencyLevel: 0,
      labyrinthSkillActionSpeedLevel: 0,
      labyrinthSkillingSuccessLevel: 0,
      labyrinthSkillingDoubleProgressLevel: 0
    };
    if (!raw || typeof raw !== "object") return out;
    const shop = raw.labShop || raw.labyrinthShop || raw.labShopData || raw;
    for (const key of Object.keys(out)) {
      const v = shop && shop[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
    return out;
  }

  // Extract per-skill loadout selection (characterSetting keys like
  // "labyrinthLoadoutAlchemy" -> loadout id).
  function extractCharacterSetting(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    const setting = raw.characterSetting || raw.settings || null;
    if (!setting || typeof setting !== "object" || Array.isArray(setting)) return out;
    for (const pascal of PASCAL_SKILL_LABELS) {
      const key = "labyrinthLoadout" + pascal;
      const v = setting[key];
      if (v !== undefined && v !== null) out[key] = v;
    }
    return out;
  }

  // Build the normalized trial profile from a raw profile payload
  // (init_character_data or profile_shared).
  function normalizeMemberProfile(raw, name, characterId) {
    return {
      characterId: characterId === null ? null : Number(characterId),
      name: name || `ID:${characterId}`,
      skills: {}, // filled by callers from characterSkills
      loadouts: extractLoadouts(raw),
      buffMaps: extractBuffMaps(raw),
      labShop: extractLabShop(raw),
      characterSetting: extractCharacterSetting(raw),
      capturedAt: Date.now(),
      raw
    };
  }

  // Snapshot our own profile from init_character_data.
  function ingestOwnProfile(data) {
    if (detectedCharacterId === null) return;
    ownProfileRaw = data;
    const name = detectedCharacterName || cfgGet().characterName;
    const full = normalizeMemberProfile(data, name, detectedCharacterId);
    // normalizeMemberProfile leaves skills as {} ("filled by callers"). For
    // our OWN profile the authoritative source is the live skill levels we
    // just ingested (detectedLevels), which ingestSkills populated from the
    // same message's characterSkills. Without this the own profile was pushed
    // with empty skills, so the ledger kept whatever stale levels were last
    // synced and the optimizer planned against outdated values.
    full.skills = Object.assign({}, detectedLevels);
    pulledProfilesFull[detectedCharacterId] = full;
  }

  function attachSocketMessageListener(socket) {
    if (!socket || socket.__stlHooked) return;
    try {
      socket.__stlHooked = true;
      if (isGameSocket(socket)) rememberGameSocket(socket);
      socket.addEventListener("message", (event) => {
        if (!isGameSocket(socket)) return;
        try {
          processSocketMessage(event, socket);
        } catch (e) {
          // Swallow — never break the game.
        }
      });
    } catch (e) {
      // Non-standard socket or frozen object; the data-getter hook below
      // still covers it.
      try { socket.__stlHooked = false; } catch (e2) { /* ignore */ }
    }
  }

  function patchPageWebSocket() {
    const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

    // --- 1. Hook MessageEvent.prototype.data (primary, covers all sockets)
    let pageMessageEvent = null;
    try {
      pageMessageEvent = pageWindow.MessageEvent;
    } catch (e) {
      /* fall through */
    }
    if (!pageMessageEvent || !pageMessageEvent.prototype) return false;

    try {
      const dataProperty = Object.getOwnPropertyDescriptor(pageMessageEvent.prototype, "data");
      if (!dataProperty || !dataProperty.get || !dataProperty.configurable) return false;
      const originalGet = dataProperty.get;
      dataProperty.get = function hookedGetData() {
        const socket = this && this.currentTarget;
        const message = originalGet.call(this);
        if (socket && isGameSocket(socket)) {
          attachSocketMessageListener(socket); // keep constructor-path sockets working
          try {
            processSocketMessage(this, socket);
          } catch (e) {
            // Never break the game's message reading.
          }
        }
        return message;
      };
      Object.defineProperty(pageMessageEvent.prototype, "data", dataProperty);
      return true;
    } catch (e) {
      return false;
    }
  }

  function patchPageWebSocketConstructor() {
    const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    let OriginalWebSocket = null;
    try {
      OriginalWebSocket = pageWindow.WebSocket;
    } catch (e) {
      return false;
    }
    if (!OriginalWebSocket) return false;

    // Only wrap genuine native constructors; if some other library already
    // wrapped it, leave it alone (its wrapper may have its own hooks).
    let isNative = false;
    try {
      isNative = /\[native code\]/.test(Function.prototype.toString.call(OriginalWebSocket));
    } catch (e) {
      isNative = false;
    }
    if (!isNative) return false;

    try {
      let currentWebSocket = OriginalWebSocket;
      function wrapConstructor(ctor) {
        if (!/\[native code\]/.test(Function.prototype.toString.call(ctor))) return;
        class HookedWebSocket extends ctor {
          constructor(...args) {
            super(...args);
            attachSocketMessageListener(this);
          }
        }
        currentWebSocket = HookedWebSocket;
      }
      wrapConstructor(OriginalWebSocket);
      Object.defineProperty(pageWindow, "WebSocket", {
        configurable: true,
        get() {
          return currentWebSocket;
        },
        set(next) {
          wrapConstructor(next);
        }
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Install both hooks at document-start, before the game connects.
  const dataHookOk = patchPageWebSocket();
  const ctorHookOk = patchPageWebSocketConstructor();

  // ---------------------------------------------------------------------
  // Toolasha adoption: if the Toolasha userscript is also active it
  // stores the last init_character_data payload on the page. When we
  // missed the init message ourselves (e.g. the script was installed
  // after login), we adopt its copy and feed it through the normal
  // handler — recovering our own skills, character id/name, and the
  // embedded guild roster without waiting for a reconnect.
  // ---------------------------------------------------------------------
  function readToolashaCharacterData() {
    try {
      const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
      const data =
        pageWindow.Toolasha &&
        pageWindow.Toolasha.Core &&
        pageWindow.Toolasha.Core.dataManager &&
        pageWindow.Toolasha.Core.dataManager.characterData;
      if (data && typeof data === "object" && data.type === "init_character_data") return data;
    } catch (e) {
      /* Toolasha not present */
    }
    return null;
  }

  function adoptToolashaData() {
    if (detectedCharacterId !== null) return false; // already have init data
    const data = readToolashaCharacterData();
    if (!data) return false;
    try {
      handleGameMessage(data);
    } catch (e) {
      /* ignore — adoption is best-effort */
    }
    const ok =
      detectedCharacterId !== null || Object.keys(detectedLevels).length > 0;
    if (ok) maybeAutoSync(); // v1.26.0: identity adopted → sync if due
    return ok;
  }

  function pollForToolashaData(maxMs, intervalMs) {
    const deadline = Date.now() + maxMs;
    (function tick() {
      if (adoptToolashaData()) return;
      if (Date.now() >= deadline) return;
      setTimeout(tick, intervalMs);
    })();
  }

  // Give Toolasha a moment to boot, then retry until we have init data or
  // the window elapses (30s max).
  pollForToolashaData(30000, 500);

  // ---------------------------------------------------------------------
  // DOM fallback: the game renders each skill's level in the left nav
  // sidebar (the same place Toolasha reads from). Rows are located via the
  // icon's stable aria-label, never by position. Used to fill any skills
  // the WebSocket hook hasn't captured yet.
  // ---------------------------------------------------------------------
  function readLevelsFromSidebar() {
    let icons = null;
    try {
      // Locate rows via the icons' stable aria-labels (never by position).
      // Matched case-insensitively so label casing can't break the lookup.
      icons = document.querySelectorAll('svg[aria-label^="navigationBar."]');
    } catch (e) {
      return;
    }
    if (!icons || icons.length === 0) return;

    const seenRows = new Set();
    icons.forEach((icon) => {
      try {
        const label = String(icon.getAttribute("aria-label") || "");
        const name = label.replace(/^navigationBar\./, "").toLowerCase();
        const skill = SKILLS.find((s) => s.id === name);
        if (!skill || detectedLevels[skill.id] !== undefined) return;

        const row = icon.closest('[class*="NavigationBar_nav__"]');
        if (!row || seenRows.has(row)) return;
        seenRows.add(row);

        const levelEl = row.querySelector('[class*="NavigationBar_level"]');
        if (!levelEl) return;
        const level = parseInt(levelEl.textContent, 10);
        if (!Number.isNaN(level)) detectedLevels[skill.id] = level;
      } catch (e) {
        // Sidebar not rendered yet / markup changed — skip this row.
      }
    });
  }

  // Periodic sidebar sweep: cheap (a handful of querySelectors), and it
  // also covers a page reload mid-session where the WebSocket hooks may
  // have missed the init message.
  // The character ID this browser is acting as — see resolveCharacter():
  // the last identity the game revealed, else the configured one.
  function resolveCharacterId() {
    return resolveCharacter().characterId;
  }

  // Is this character (resolved id, else configured name) present in the
  // captured in-game guild roster? Id match first, case-insensitive name
  // match as fallback (the roster is the source of truth for membership).
  function isInGuildRoster() {
    if (guildMembers.length === 0) return false;
    const { characterId, characterName } = resolveCharacter();
    if (Number.isInteger(characterId) && characterId > 0) {
      return guildMembers.some((m) => m.characterId === characterId);
    }
    const name = String(characterName || "").toLowerCase();
    if (!name) return false;
    return guildMembers.some((m) => String(m.characterName || "").toLowerCase() === name);
  }

  // Guild gate for push operations (Push button + Pull auto-push). Returns
  // null when the push is allowed, otherwise a reason string.
  // v1.33.0: the "push regardless of guild" escape hatch is gone — the ledger
  // enforces membership server-side and no one (site admins included) can
  // bypass it (v1.35.0), so the local gate is purely informational (it keeps
  // the user from firing a push the server would 403 anyway).
  // v1.34.0: the player's OWN guild ID (detectedGuildId, from
  // init_character_data) is the primary membership signal — the server
  // verifies it against the admin-configured expected guild ID. So a
  // captured guild ID alone is enough to allow the push (no full roster
  // needed); the roster check still applies when only the roster was
  // captured (e.g. the game's init guild object lacked an id).
  function pushGuildGate() {
    if (Number.isInteger(detectedGuildId) && detectedGuildId > 0) return null;
    if (guildMembers.length === 0) {
      return "Push blocked — no guild info captured yet. Open the in-game Guild panel once (or reload the page) so your membership can be verified.";
    }
    if (!isInGuildRoster()) {
      const g = guildName ? ` (${guildName})` : "";
      return `Push blocked — this character is not in the captured guild roster${g}. Only guild members can push to the ledger (site admins included).`;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Own-character push gate (v1.27.0) — for "Sync Character" + auto-sync.
  //
  // pushGuildGate() above is for the FULL guild pull/push and hard-blocks
  // when no roster is captured. That is the wrong mechanism for a single
  // character's own push: the in-memory roster (guildMembers) is empty until
  // THIS session opens the Guild panel, so it would block a perfectly valid
  // own push. Instead the live-guild source of truth is the ledger's
  // persistent snapshot (GET /api/roster/live) — the same data the Members
  // page compares against for its "not in the live guild" warning. Any
  // member's Pull refreshes it, so it stays authoritative even when this
  // session captured nothing.
  //
  // The gate returns a reason string when the push should be blocked, else
  // null. v1.33.0: the "push regardless of guild" escape hatch is gone — the
  // ledger enforces membership server-side and no one (site admins included)
  // can bypass it (v1.35.0). The local gate still ALLOWS the push when the
  // roster is unknown (no snapshot yet, or the ledger is unreachable) — it
  // only blocks on a definitive "not in the guild" answer, mirroring the
  // server.
  // ---------------------------------------------------------------------

  // Shared membership test: id match first, case-insensitive name fallback
  // (mirrors isInGuildRoster's semantics). Works on any roster of
  // {characterId, name|characterName} entries.
  function memberInRoster(roster, characterId, characterName) {
    if (!Array.isArray(roster) || roster.length === 0) return false;
    if (Number.isInteger(characterId) && characterId > 0) {
      const hit = roster.some(
        (m) => m && Number(m.characterId) === characterId
      );
      if (hit) return true;
    }
    const name = String(characterName || "").toLowerCase();
    if (!name) return false;
    return roster.some(
      (m) =>
        m &&
        String(m.name || m.characterName || "").toLowerCase() === name
    );
  }

  // Pure decision for the gate — kept free of browser globals so the Node
  // harness (server/test-guild-gate.mjs) can load and unit-test it verbatim.
  // roster: the live-guild members, or null when unknown.
  // v1.33.0: the allowPushOutsideGuild escape hatch is gone — the server now
  // enforces membership and no one (site admins included) can bypass it
  // (v1.35.0).
  function evaluateOwnSyncGate(roster, characterId, characterName) {
    if (!Array.isArray(roster) || roster.length === 0) {
      return null; // unknown roster -> allow (no hard "no roster" block here)
    }
    if (memberInRoster(roster, characterId, characterName)) return null;
    return "Sync blocked \u2014 this character is not in the live guild roster. Only guild members can sync to the ledger (site admins included).";
  }

  // Fetch the ledger's live-guild snapshot. Resolves null when there is no
  // snapshot yet or the ledger is unreachable (both mean "unknown").
  async function fetchLiveGuildRoster(apiBase) {
    let res;
    try {
      res = await gmRequest("GET", `${apiBase}/api/roster/live`);
    } catch (err) {
      return null; // transport failure / timeout -> unknown
    }
    if (res.status === 200) {
      try {
        const data = JSON.parse(res.responseText);
        return Array.isArray(data.members) ? data.members : [];
      } catch (err) {
        return null;
      }
    }
    return null; // 404 (no snapshot) or any other status -> unknown
  }

  // The gate for own-character pushes. See the banner above.
  async function ownSyncGate(apiBase, characterId, characterName) {
    const roster = await fetchLiveGuildRoster(apiBase);
    return evaluateOwnSyncGate(roster, characterId, characterName);
  }

  function sweep() {
    readLevelsFromSidebar();
    // Belt-and-suspenders (2026-10-20): if the in-flight plan fetch has been
    // held far beyond the request timeout, its promise never settled (the
    // bridge lost every callback, even the JS-side deadline). Force-release
    // the guard so the next refreshLatestPlan() call below runs instead of
    // early-returning for the rest of the page load.
    // __STL_PLAN_FORCE_RELEASE_MS is a test knob (test-highlight.mjs):
    // shrinks the threshold so the harness can force-release a wedged
    // fetch in milliseconds. Never set in production.
    const forceReleaseMs =
      (typeof window !== "undefined" && Number(window.__STL_PLAN_FORCE_RELEASE_MS) > 0)
        ? Number(window.__STL_PLAN_FORCE_RELEASE_MS)
        : PLAN_FETCH_FORCE_RELEASE_MS;
    if (
      planFetchInFlight &&
      planFetchStartedAt > 0 &&
      Date.now() - planFetchStartedAt > forceReleaseMs
    ) {
      planFetchInFlight = false;
    }
    // Fire the plan fetch, then highlight with whatever we have now (the
    // next sweep picks up a fresh plan; the send flow also re-applies so
    // it reflects right away).
    refreshLatestPlan(cfgGet().apiBase.replace(/\/$/, ""));
    applyTrialHighlight();
    // v1.29.0: keep the panel observation alive. The document-level
    // watcher (installed below, idempotently) attaches to the trials
    // panel the moment the user opens it — instant highlight instead of
    // waiting for the next sweep — and detaches when it unmounts. The
    // sweep also re-checks directly as the safety net (e.g. if the
    // watcher failed to install or the panel was open before load).
    installTrialPanelWatcher();
    observeTrialPanel(findTrialPanel());
    // v1.36.0: safety net for the panel-order cache — the sweep keeps it
    // fresh even if the panel stayed mounted (unchanged) across weeks.
    refreshPanelTrialOrder();
    // v1.26.0: periodic auto-sync gate — cheap no-op unless due.
    maybeAutoSync();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      sweep();
      setInterval(sweep, 15000);
    }, { once: true });
  } else {
    sweep();
    setInterval(sweep, 15000);
  }

  // ---------------------------------------------------------------------
  // Trial highlight: on the game's "Skilling Trial" panel, highlight the
  // trial that the ledger's most recent optimizer run assigned this
  // character to (considering only the trials currently listed on the
  // panel). React re-renders can drop the highlight, so it is re-applied
  // on every periodic sweep.
  // ---------------------------------------------------------------------
  // Fetch the most recent optimizer plan from the ledger backend. A 404
  // (no optimizer run yet) clears the plan so the highlight is hidden;
  // any other failure keeps the last known-good plan. planState records
  // WHETHER we have ever reached a verdict, so a silently wedged fetch
  // (see the note on planState above) can be surfaced instead of looking
  // identical to "no plan yet".
  async function refreshLatestPlan(apiBase) {
    if (planFetchInFlight) return;
    if (!apiBase) return;
    planFetchInFlight = true;
    planFetchStartedAt = Date.now();
    try {
      const res = await gmRequest("GET", `${apiBase}/api/trials/plans/latest`);
      planFetchAttempted = true;
      if (res.status === 404) {
        latestPlan = null;
        planState = "none";
        return;
      }
      if (res.status !== 200) {
        // Non-200/404: treat as "no verdict" — keep last known plan, and if
        // we never had one, mark the state so the notice can explain.
        if (latestPlan === null) planState = "unknown";
        else planState = "ready";
        return;
      }
      let body;
      try {
        body = JSON.parse(res.responseText);
      } catch (e) {
        return; // keep previous latestPlan + planState
      }
      if (body && body.assignments && typeof body.assignments === "object") {
        latestPlan = body;
        planState = "ready";
      } else {
        latestPlan = null;
        planState = "none";
      }
    } catch (e) {
      // Backend unreachable (or the JS-side deadline race fired because the
      // bridge lost its callbacks) — keep previous latestPlan. planState
      // stays "unknown" until a fetch actually succeeds or 404s, which is
      // what applyTrialHighlight uses to paint the "ledger unreachable"
      // notice instead of failing silently.
      planFetchAttempted = true;
      if (latestPlan === null) planState = "unknown";
      else planState = "ready";
    } finally {
      planFetchInFlight = false;
      // v1.29.0: reflect the freshly-fetched plan immediately if the
      // trials panel is on screen (e.g. the user just opened it and the
      // panel observer is still in its retry sequence). No-op when the
      // assignment didn't change — applyTrialHighlight is idempotent —
      // and the retry schedule is left alone (it self-terminates).
      applyTrialHighlight();
    }
  }

  // Compare two dotted version strings segment-wise as numbers (1.36.0 <
  // 1.37.0, 2.0 > 10.0 is false because 2 < 10). Missing segments count as 0.
  // Returns -1 (a is older), 0 (equal), or 1 (a is newer). Pure — safe to
  // reuse in tests.
  function compareScriptVersions(a, b) {
    const pa = String(a || "").split(".").map((s) => parseInt(s, 10) || 0);
    const pb = String(b || "").split(".").map((s) => parseInt(s, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }

  // Idempotently show/hide the update banner + FAB dot. Shows only while this
  // build is strictly older than `updateLatest` AND the user hasn't dismissed
  // that specific version. Re-running on every fetch keeps it in sync.
  function renderUpdateReminder() {
    const banner = document.getElementById("stl-update-banner");
    const dot = document.getElementById("stl-fab-update-dot");
    const dismissed = stlGetValue("stlDismissedUpdateVersion", null);
    const outdated =
      updateLatest != null &&
      compareScriptVersions(SCRIPT_VERSION, updateLatest) < 0 &&
      dismissed !== updateLatest;
    if (banner) {
      if (outdated) {
        banner.querySelector(".stl-update-msg").textContent =
          `Update available — v${updateLatest} is out (you're on v${SCRIPT_VERSION}). Update the script to get the latest features.`;
        banner.hidden = false;
      } else {
        banner.hidden = true;
      }
    }
    if (dot) dot.hidden = !outdated;
  }

  // Fetch the ledger's notion of the newest script version and update the
  // reminder UI. Never throws: a transport failure or missing field just
  // means "no reminder" (we only nag when we have a real newer version).
  async function checkForUpdate(apiBase) {
    if (updateFetchInFlight) return;
    if (!apiBase) return;
    updateFetchInFlight = true;
    try {
      const res = await gmRequest("GET", `${apiBase}/api/config`);
      if (res.status === 200) {
        let body;
        try {
          body = JSON.parse(res.responseText);
        } catch (e) {
          body = null;
        }
        if (body && typeof body.latestScriptVersion === "string") {
          updateLatest = body.latestScriptVersion;
        }
      }
    } catch (e) {
      // Unreachable — leave the current reminder state alone.
    } finally {
      updateFetchInFlight = false;
      renderUpdateReminder();
    }
  }

  // Locate the "Skilling Trial" heading element itself.
  function findTrialHeading() {
    const headings = document.querySelectorAll("div,span,h1,h2,h3,h4,p,li");
    for (const el of headings) {
      if (el.closest && el.closest("#stl-panel")) continue; // never our own panel
      const text = (el.textContent || "").trim().toLowerCase();
      if (text.length > TRIAL_HEADING.length + 12) continue;
      if (text === TRIAL_HEADING || text.startsWith(TRIAL_HEADING + " ")) return el;
    }
    return null;
  }

  function findTrialPanel() {
    // Locate the panel heading by exact text, then walk up to the nearest
    // ancestor that also contains at least two known trial names.
    const heading = findTrialHeading();
    if (!heading) return null;

    let node = heading;
    while (node && node !== document.body) {
      const txt = (node.textContent || "").toLowerCase();
      const hits = SKILLS.filter((s) => txt.includes(s.label.toLowerCase())).length;
      if (hits >= 2) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Find the leaf element inside the panel that holds exactly the trial's
  // name (the game renders each trial's name in its own text node).
  function findTrialNameEl(panel, label) {
    const nodes = panel.querySelectorAll("div,span,p,li,h3,h4,strong,b");
    for (const el of nodes) {
      if (el.children.length > 0) continue;
      if ((el.textContent || "").trim() === label) return el;
    }
    for (const el of nodes) {
      if (el.children.length > 0) continue;
      if ((el.textContent || "").trim().toLowerCase().startsWith(label.toLowerCase())) return el;
    }
    return null;
  }

  // Does this element paint its own visible box (solid/gradient background
  // or a border)? Used to find the card's actual visual box to surround.
  function paintedBox(el) {
    let cs = null;
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      cs = win.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!cs) return false;
    try {
      const bg = cs.backgroundColor || "";
      const hasBg = bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)";
      const hasGradient = (cs.backgroundImage || "none") !== "none";
      const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
      return hasBg || hasGradient || hasBorder;
    } catch (e) {
      return false;
    }
  }

  // Find the visual card for a trial: start at the nearest ancestor of the
  // name that carries the sign-up status text, then climb to the closest
  // ancestor that paints its own box — that is the element whose edges we
  // want to surround. Falls back to the status row if nothing paints.
  function findTrialCard(panel, nameEl) {
    let row = nameEl;
    let found = false;
    for (let i = 0; i < 6 && row && row !== panel; i++) {
      const t = (row.textContent || "").toLowerCase();
      if (t.includes("signed up") || /\bpts\b/.test(t)) {
        found = true;
        break;
      }
      row = row.parentElement;
    }
    if (!found || !row || row === panel) return null;

    let node = row;
    while (node && node !== panel) {
      if (paintedBox(node)) return node;
      node = node.parentElement;
    }
    return row;
  }

  // Remove every mark this script painted (class + badge). Deliberately
  // does NOT touch the "no suitable trial" notice — that element's
  // lifecycle is owned entirely by applyNoTrialNotice() (show/hide), so
  // an assigned→unassigned transition never wipes the notice in the same
  // pass that shows it.
  function clearTrialHighlightMarks() {
    document.querySelectorAll(".stl-trial-best").forEach((el) => el.classList.remove("stl-trial-best"));
    document.querySelectorAll(".stl-trial-badge").forEach((el) => el.remove());
  }

  // The trial the latest optimizer run put this character in (at most
  // one — the optimizer assigns each member to at most 1 skill). Returns
  // the matching SKILLS entry, or null when there is no plan, the
  // character is unresolved, or the character is in NO assignment array
  // (unassigned — or excluded, which leaves the same trace).
  function findAssignedTrialSkill() {
    const characterId = resolveCharacterId();
    if (!latestPlan || characterId === null || characterId === undefined) return null;
    const assignments = latestPlan.assignments || {};
    for (const skill of SKILLS) {
      const entries = assignments[skill.id];
      if (!Array.isArray(entries)) continue;
      // entries are member objects ({ characterId, name, ... }) from the
      // optimizer; tolerate a raw id too, just in case.
      if (entries.some((entry) => {
        const cid = (entry && typeof entry === "object") ? entry.characterId : entry;
        return Number(cid) === characterId;
      })) {
        return skill;
      }
    }
    return null;
  }

  // Panel notice for two distinct failure states, painted at the top of
  // the trials panel so it is visible as soon as the panel opens:
  //   (a) "sit out" — the latest optimizer run exists but this character is
  //       in no assignment (excluded members surface the same way: they are
  //       skipped before assignment, so they are simply absent from every
  //       assignments[skill] array);
  //   (b) "ledger unreachable" (2026-10-20) — the plan fetch never reached
  //       a verdict (planState "unknown" after an attempt). Before this, a
  //       wedged/broken network looked exactly like "no plan yet" and said
  //       NOTHING; now the panel tells the player why there is no
  //       highlight. A confirmed 404 (planState "none") paints no notice —
  //       there genuinely is no run to sit out of.
  // Idempotent: re-running with the same panel/message touches no DOM.
  function applyNoTrialNotice(preferredPanel, bestSkill) {
    const characterId = resolveCharacterId();
    const unreachable =
      planState === "unknown" && planFetchAttempted && characterId != null;
    const shouldShow =
      unreachable || (latestPlan !== null && bestSkill === null);
    const message = unreachable
      ? "Ledger unreachable \u2014 can't load the optimizer plan. The highlight will appear once the ledger is back."
      : "No suitable trial found \u2014 sit this round out or ask a general.";
    const existing = document.getElementById("stl-trial-notice");
    if (shouldShow) {
      const panel =
        (preferredPanel && preferredPanel.isConnected) ? preferredPanel : findTrialPanel();
      if (!panel) {
        // Panel not mounted yet — drop the stale-anchor record; a later
        // sweep/observer pass will paint it as soon as the panel exists.
        if (appliedNoTrialNotice) {
          appliedNoTrialNotice = null;
          if (existing) existing.remove();
        }
        return;
      }
      if (existing && existing.isConnected) {
        if (existing.parentElement === panel) {
          // Same panel: only touch the DOM if the message changed (the
          // unreachable ↔ sit-out transition repaints in place).
          if (existing.textContent === message) return;
          existing.textContent = message;
          appliedNoTrialNotice = panel;
          return;
        }
        existing.remove();
      }
      const notice = document.createElement("div");
      notice.id = "stl-trial-notice";
      notice.className = "stl-trial-notice";
      notice.textContent = message;
      panel.insertBefore(notice, panel.firstChild);
      appliedNoTrialNotice = panel;
    } else if (existing) {
      // Assigned (or no plan / confirmed 404): the notice must go.
      existing.remove();
      appliedNoTrialNotice = null;
    }
  }

  function applyTrialHighlight(preferredPanel) {
    const bestSkill = findAssignedTrialSkill();
    // Keep the "no suitable trial" notice in sync with the same state.
    applyNoTrialNotice(preferredPanel, bestSkill);

    if (!bestSkill) {
      // Nothing to highlight (no plan yet, character switched, or not
      // assigned): clear any stale mark and remember the empty state.
      if (appliedHighlight) {
        clearTrialHighlightMarks();
        appliedHighlight = null;
      }
      return false;
    }

    const perSkill = (latestPlan.meta && latestPlan.meta.perSkill) || {};
    const pts = perSkill[bestSkill.id] && perSkill[bestSkill.id].points;

    // Idempotent fast path: the same card still carries the mark and the
    // assignment is unchanged → touch no DOM at all. This is what keeps
    // the MutationObserver from looping on our own writes.
    if (
      appliedHighlight &&
      appliedHighlight.label === bestSkill.label &&
      appliedHighlight.pts === pts &&
      appliedHighlight.card &&
      appliedHighlight.card.isConnected &&
      appliedHighlight.card.classList.contains("stl-trial-best") &&
      appliedHighlight.card.querySelector(".stl-trial-badge")
    ) {
      return true;
    }

    // Preferred panel (from the observer) saves the document-wide heading
    // search; fall back to locating it when it is missing or stale.
    const panel =
      (preferredPanel && preferredPanel.isConnected) ? preferredPanel : findTrialPanel();
    if (!panel) {
      if (appliedHighlight) appliedHighlight = null; // card went away with the panel
      return false;
    }

    const nameEl = findTrialNameEl(panel, bestSkill.label);
    // The card is the element that actually paints the trial's visible box.
    const card = nameEl ? findTrialCard(panel, nameEl) : null;
    if (!card) {
      if (appliedHighlight) appliedHighlight = null;
      return false;
    }

    // Something changed (new card, new assignment, or the mark was dropped
    // by a re-render): clear stale marks, then repaint.
    clearTrialHighlightMarks();
    card.classList.add("stl-trial-best");
    const badge = document.createElement("span");
    badge.className = "stl-trial-badge";
    badge.textContent =
      Number.isFinite(pts) && pts > 0
        ? "\u2605 Optimizer pick \u00b7 " + pts + " pts"
        : "\u2605 Optimizer pick";
    card.appendChild(badge);
    appliedHighlight = { label: bestSkill.label, pts: pts, card: card };
    return true;
  }

  // ---------------------------------------------------------------------
  // Trial panel observation (v1.29.0): the sweep above only re-applies the
  // highlight every 15 s, so the recommended-trial card on the guild ->
  // trials panel could stay un-highlighted for up to half a minute after
  // the user clicks it open. Two observers close that gap while the sweep
  // stays as the safety net (and keeps fetching fresh plans):
  //   1. A document-level childList observer (subtree) catches the panel
  //      MOUNTING — we can't watch an element before it exists — and
  //      re-attaches to it. It also notices when the panel unmounts. It
  //      bails out cheaply: only mutation batches that add or remove
  //      nodes, and only when the game's CSS-module trials-tab marker is
  //      in the DOM, run the (more expensive) findTrialPanel().
  //   2. A panel-level observer catches React re-renders inside the panel
  //      (which can drop our class/badge) and re-applies immediately.
  // The observers never fetch; they re-apply with whatever plan the sweep
  // already cached (latestPlan). Re-application is idempotent — see the
  // appliedHighlight fast path in applyTrialHighlight — so our own badge
  // writes cannot loop the panel observer. The panel-level observer is
  // torn down as soon as the panel unmounts; the document observer stays
  // armed (one lightweight callback, no per-mutation work) so the next
  // open is covered too. The retry timers cover the case where the panel
  // mounts before the plan fetch resolves, or the tiles land a batch
  // after the heading.
  // ---------------------------------------------------------------------
  function runHighlightRetry() {
    highlightRetryTimer = null;
    if (!highlightRetryPanel || !highlightRetryPanel.isConnected) return;
    // applyTrialHighlight is idempotent: it only touches the DOM when the
    // highlight actually changed, so repeated ticks stay cheap.
    applyTrialHighlight(highlightRetryPanel);
    if (highlightRetryCount++ < 6) {
      highlightRetryTimer = setTimeout(runHighlightRetry, HIGHLIGHT_RETRY_MS);
    } else {
      highlightRetryCount = 0;
      highlightRetryPanel = null;
    }
  }

  function scheduleHighlightRetry(panel) {
    if (highlightRetryTimer !== null) return;
    // The panel can mount in several batches (heading first, then the
    // trial tiles), and the plan may not have resolved yet (the first
    // fetch can still be in flight). Retry a few times over ~3 s so the
    // card is found as soon as it exists; the idempotent fast path keeps
    // the later ticks no-ops once the highlight is in place.
    highlightRetryCount = 0;
    highlightRetryPanel = panel;
    highlightRetryTimer = setTimeout(runHighlightRetry, HIGHLIGHT_RETRY_MS);
  }

  // Read the in-game Guild → Trials panel's current order straight from the
  // DOM. The game renders each week's trial tiles in the static sortIndex
  // order (top→bottom) that the raw guildWeeklyTrialSet.skillHrids array does
  // NOT reflect — and that order's source table (guildTrialDetailMap) rides in
  // the binary init_client_data frame, which a userscript cannot decode. The
  // DOM is the one faithful, readable source. Tiles only exist while the
  // Trials tab is the active guild tab, so this returns null otherwise.
  // Returns { skilling: [skill labels], combat: [trial names] } (each in
  // top→bottom order), or null when no tiles are present.
  function readTrialPanelOrder() {
    if (!document.querySelector(TRIALS_TAB_MARKER)) return null;
    const tiles = document.querySelectorAll('div[class*="GuildPanel_trialTile"]');
    if (!tiles || tiles.length === 0) return null;
    const skillLabelSet = {};
    for (const s of SKILLS) skillLabelSet[s.label.toLowerCase()] = true;
    const skilling = [];
    const combat = [];
    for (const tile of tiles) {
      // Each tile renders the trial/skill name in its own leaf text node;
      // it also contains "N pts" and "N/M signed up" (and an icon), which we
      // skip. Take the first plausible leaf name.
      const nodes = tile.querySelectorAll("div, span");
      let name = null;
      for (const el of nodes) {
        if (el.children.length > 0) continue;
        const t = (el.textContent || "").trim();
        if (!t || t.length > 24) continue;
        if (/signed up/.test(t) || /\d+\s*pts/.test(t) || /\d+\s*\/\s*\d+/.test(t)) continue;
        name = t;
        break;
      }
      if (!name) continue;
      if (skillLabelSet[name.toLowerCase()]) skilling.push(name);
      else if (/^trial\b/i.test(name)) combat.push(name);
    }
    if (skilling.length === 0 && combat.length === 0) return null;
    return { skilling: skilling, combat: combat };
  }

  // Re-read the panel order and, only when a non-null result comes back,
  // refresh the cached copy. Called from the sweep, the panel watcher, and
  // the push path (fresh read at push time). A null read (Trials tab not the
  // active guild tab) leaves the previous cache intact.
  // retrigger=false is used by the explicit push path (which pushes the
  // order itself, so it must not also fire the self-correction re-push).
  function refreshPanelTrialOrder(retrigger) {
    const order = readTrialPanelOrder();
    if (order) panelTrialOrder = order;
    if (retrigger !== false) maybeRepushPanelOrder();
    return order;
  }

  // True when the panel names and the game hrids cover exactly the same set
  // of trials (hrid tail vs normalized panel name) — i.e. the on-screen panel
  // shows THIS week's trials. Guards the self-correction against a stale panel
  // (previous week's order) being open across a week rollover.
  function panelOrderMatches(hrids, panelNames) {
    if (!Array.isArray(hrids) || hrids.length === 0) return false;
    if (!Array.isArray(panelNames) || panelNames.length === 0) return false;
    const tailOf = (s) => String(s).split("/").pop().toLowerCase();
    const hridTails = {};
    for (const h of hrids) hridTails[tailOf(h)] = true;
    const nameToks = {};
    for (const n of panelNames) nameToks[panelNameToken(n)] = true;
    const a = Object.keys(hridTails);
    const b = Object.keys(nameToks);
    if (a.length !== b.length) return false;
    for (const t of a) if (!nameToks[t]) return false;
    return true;
  }

  function hridArraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // v1.36.0 self-correction: when the order was not yet confirmed at the
  // initial push (login / sync), that push was HELD — nothing was stored. As
  // soon as the Trials tab is on screen (watcher/sweep cache its order),
  // push in the true panel order — but only when the visible panel shows
  // this week's trials. The push functions re-run on every sync and simply
  // hold again until the order is confirmed, so nothing raw is ever stored.
  // Members' pushes are guild-wide upserts server-side, so this quietly
  // corrects the dashboards. Best-effort: failures are ignored.
  async function maybeRepushPanelOrder() {
    if (!panelTrialOrder) return;
    try {
      // This runs from the top-level sweep/observer path (not the overlay
      // builder), so use the top-level config accessor — the overlay-scoped
      // currentApiBase const is NOT visible here.
      const apiBase = cfgGet().apiBase.replace(/\/$/, "");
      if (skillingTrialHrids && skillingTrialHrids.length > 0
        && panelTrialOrder.skilling.length > 0
        && panelOrderMatches(skillingTrialHrids, panelTrialOrder.skilling)) {
        const ordered = reorderHridsToPanelOrder(skillingTrialHrids, panelTrialOrder.skilling);
        if (ordered.length > 0 && !hridArraysEqual(ordered, lastSkillingPush)) {
          const res = await gmRequest("POST", `${apiBase}/api/skilling-trials`, { skillHrids: ordered });
          if (res.status === 200) {
            lastSkillingPush = ordered;
            skillingTrialsSent = true;
          }
        }
      }
      if (combatTrialHrids && combatTrialHrids.length > 0
        && panelTrialOrder.combat.length > 0
        && panelOrderMatches(combatTrialHrids, panelTrialOrder.combat)) {
        const ordered = reorderHridsToPanelOrder(combatTrialHrids, panelTrialOrder.combat);
        if (ordered.length > 0 && !hridArraysEqual(ordered, lastCombatPush)) {
          const res = await gmRequest("POST", `${apiBase}/api/combat-trials`, { combatHrids: ordered });
          if (res.status === 200) {
            lastCombatPush = ordered;
            combatTrialsSent = true;
          }
        }
      }
    } catch (e) { /* best-effort — never throw from a sweep/observer path */ }
  }

  // Normalize a panel name to a lowercase match token: a skilling label
  // ("Cooking" -> "cooking") or a combat trial name ("Trial Badger" ->
  // "badger"). Matches the tail segment of the corresponding game hrid
  // ("/guild_skilling/cooking", "/guild_combat/badger").
  function panelNameToken(name) {
    let n = String(name || "").trim();
    if (/^trial\s+/i.test(n)) n = n.replace(/^trial\s+/i, "");
    return n.toLowerCase();
  }

  // Reorder a raw game hrid array into the in-game panel order (the
  // panelNames list, top→bottom). Matching is by hrid tail vs the normalized
  // panel name token, so it works for both skilling (label == hrid tail) and
  // combat ("Trial X" -> "x" hrid tail). Any captured hrid absent from the
  // panel order is appended (in raw order) so nothing is lost. Returns the
  // original array unchanged when there is no panel order or nothing matched
  // (callers treat a fully-matched reorder as the confirmation that the
  // panel really shows this week's trials — see panelOrderMatches).
  function reorderHridsToPanelOrder(hrids, panelNames) {
    if (!Array.isArray(hrids) || hrids.length === 0) return hrids;
    if (!Array.isArray(panelNames) || panelNames.length === 0) return hrids;
    const tailOf = (s) => String(s).split("/").pop().toLowerCase();
    const hridByToken = {};
    for (const h of hrids) hridByToken[tailOf(h)] = h;
    const out = [];
    const seen = {};
    for (const name of panelNames) {
      const tok = panelNameToken(name);
      if (hridByToken[tok] && !seen[tok]) { out.push(hridByToken[tok]); seen[tok] = true; }
    }
    if (out.length === 0) return hrids;
    for (const h of hrids) {
      const t = tailOf(h);
      if (!seen[t]) { out.push(h); seen[t] = true; }
    }
    return out;
  }

  // (Re)attach the panel-level observer to the currently-mounted trials
  // panel. Called from the document-level watcher when the panel mounts
  // and from the sweep as the fallback. Pass null to detach (the panel
  // unmounted). No-op when the observation already matches — the sweep
  // calls this every 15 s and re-attaching would needlessly reset the
  // retry sequence.
  function observeTrialPanel(panel) {
    if (trialPanelTarget === panel) return;
    if (trialPanelObserver) {
      trialPanelObserver.disconnect();
      trialPanelObserver = null;
    }
    trialPanelTarget = panel;
    if (!panel || !panel.isConnected) return;
    try {
      trialPanelObserver = new MutationObserver(() => {
        // Any change inside the panel (React re-render, sign-up state
        // update, our own badge) is a chance to (re)apply the highlight.
        // applyTrialHighlight touches the DOM only when something
        // actually changed, so this cannot loop.
        applyTrialHighlight(panel);
      });
      trialPanelObserver.observe(panel, { childList: true, subtree: true });
    } catch (e) {
      trialPanelObserver = null; // observer unsupported — sweep still covers it
    }
    scheduleHighlightRetry(panel);
    // v1.36.0: cache the panel order for the trial push (best-effort — a
    // read failure just leaves the previous cache in place).
    refreshPanelTrialOrder();
  }

  function installTrialPanelWatcher() {
    if (trialPanelWatcher || typeof MutationObserver !== "function" || !document.body) return;
    try {
      trialPanelWatcher = new MutationObserver((records) => {
        // Cheap bail-outs — findTrialPanel() walks every heading's
        // textContent and is far too expensive to run on every mutation
        // batch of an idle game (timers, toasts, socket-driven updates):
        //   1. only act when nodes were added or removed (attribute and
        //      characterData changes cannot mount/unmount the panel);
        //   2. only act when the game's CSS-module trials-tab marker is
        //      in the DOM at all (it sits on the guild panel root, so it
        //      is present whenever the trials panel is on screen).
        let relevant = false;
        for (const r of records) {
          if (
            (r.addedNodes && r.addedNodes.length) ||
            (r.removedNodes && r.removedNodes.length)
          ) {
            relevant = true;
            break;
          }
        }
        if (!relevant) return;
        if (!document.querySelector(TRIALS_TAB_MARKER)) return;
        const panel = findTrialPanel();
        if (panel !== trialPanelTarget) {
          // Mounted (or the container element swapped): attach + catch up
          // right away. Unmounted: just drop the target; the sweep will
          // also re-check within 15 s.
          observeTrialPanel(panel);
        }
      });
      trialPanelWatcher.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      trialPanelWatcher = null; // observer unsupported — sweep still covers it
    }
  }

  // ---------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------
  function gmRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      // The promise settles AT MOST ONCE. Every GM callback funnels through
      // `settle`, which ignores late/lost duplicates — the webview-gm bridge
      // can dispatch callbacks out of order or, worse, drop them entirely
      // (its ontimeout dispatch goes through view.post → evaluateJavascript,
      // which the WebView can swallow while paused/backgrounded — the exact
      // bug that wedged the plan fetch and killed the mobile highlight on
      // 2026-10-20).
      // The GM bridge's own `timeout` is only as reliable as that dispatch,
      // so we ALSO race a setTimeout in OUR OWN JS context (2026-10-20): a
      // frozen WebView pauses both, but a JS timer resumes and fires
      // immediately when the player opens the game again — worst case the
      // request rejects a few seconds after returning to the app, instead of
      // hanging for the rest of the page load. A late onload/onerror/ontimeout
      // that arrives after the deadline is simply ignored.
      // Test knob (userscript/test-highlight.mjs, same pattern as the
      // server's STL_LATEST_VERSION env var): a positive __STL_PLAN_TIMEOUT_MS
      // on window shrinks the deadline so the harness can exercise it in
      // milliseconds. Never set in production.
      const TIMEOUT_MS =
        (typeof window !== "undefined" && Number(window.__STL_PLAN_TIMEOUT_MS) > 0)
          ? Number(window.__STL_PLAN_TIMEOUT_MS)
          : 8000;
      let done = false;
      const settle = (fn, value) => {
        if (done) return;
        done = true;
        fn(value);
      };
      // X-Stl-Client marks this as the in-game userscript. v1.33.0: also
      // declare WHO is pushing (X-Stl-Character-Id / X-Stl-Character-Name,
      // from resolveCharacter()) so the ledger can verify the pusher
      // server-side. v1.34.0: also declare WHICH GUILD the pusher's game
      // reported (X-Stl-Guild-Id, from their own init_character_data guild
      // object) so the ledger can verify membership from the player's own
      // game data — the live-guild snapshot is no longer required. The old
      // X-Stl-Client header is spoofable and grants no write access by
      // itself. v1.34.1: also declare which version of this script is
      // running (X-Stl-Version, from SCRIPT_VERSION) so the ledger can
      // record each member's version and the Members page can flag anyone
      // not on the latest.
      const identity = resolveCharacter();
      const baseHeaders = { "X-Stl-Client": "userscript" };
      if (identity && identity.characterId != null) {
        baseHeaders["X-Stl-Character-Id"] = String(identity.characterId);
      }
      if (identity && identity.characterName) {
        baseHeaders["X-Stl-Character-Name"] = identity.characterName;
      }
      if (Number.isInteger(detectedGuildId) && detectedGuildId > 0) {
        baseHeaders["X-Stl-Guild-Id"] = String(detectedGuildId);
      }
      if (SCRIPT_VERSION) {
        baseHeaders["X-Stl-Version"] = SCRIPT_VERSION;
      }
      const headers = body
        ? { "Content-Type": "application/json", ...baseHeaders }
        : { ...baseHeaders };
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => settle(resolve, res),
        onerror: (err) => {
          // The webview-gm Android bridge delivers NON-200 HTTP responses to
          // onerror (it only ever calls onload for HTTP 200), passing a
          // response-like object: {status, statusText, responseText, ...}.
          // If that object carries a real HTTP status, resolve with it so
          // callers' status handling (the 404 -> POST roster fallback, the
          // "no plans yet" 404 clear) still works in-app.
          if (err && typeof err === "object" && Number(err.status) > 0) {
            settle(resolve, err);
            return;
          }
          // Genuine transport failure (connection refused, DNS, or the phone
          // simply can't reach this host): no HTTP status at all. Surface a
          // readable message that NAMES the host we dialed. The #1 cause of
          // "everything fails" in-app is a stale apiBase — e.g. a leftover
          // http://localhost:3001 from local testing (where "localhost" is the
          // phone itself) or the retired plain-HTTP IP — and showing the URL
          // makes that obvious instead of a bare "no HTTP response".
          const detail =
            (err &&
              typeof err === "object" &&
              (err.statusText || err.responseText || err.message)) ||
            "no HTTP response";
          settle(
            reject,
            new Error(
              `${detail} (tried ${url} — if that host looks wrong, set the ` +
                "panel's API base to https://mwitrials.ddns.net)"
            )
          );
        },
        ontimeout: () => settle(reject, new Error("Request timed out")),
        timeout: TIMEOUT_MS
      });
      // JS-side deadline race (2026-10-20): if the bridge never calls ANY
      // callback — its ontimeout can be lost when the WebView is paused —
      // our own timer rejects the request so callers (and the
      // planFetchInFlight guard in refreshLatestPlan) can never wedge. The
      // GM-side timeout is kept too; whichever fires first wins.
      try {
        setTimeout(() => settle(reject, new Error(`Request timed out (JS-side deadline, ${TIMEOUT_MS} ms)`)), TIMEOUT_MS);
      } catch (e) {
        // Timer API unavailable — the GM-side timeout still applies.
      }
    });
  }

  async function upsertSkill(apiBase, skillId, characterId, name, level) {
    const putRes = await gmRequest(
      "PUT",
      `${apiBase}/api/roster/${skillId}/${characterId}`,
      { name, level }
    );
    if (putRes.status === 200) return { ok: true };
    if (putRes.status === 404) {
      const postRes = await gmRequest(
        "POST",
        `${apiBase}/api/roster/${skillId}`,
        { characterId, name, level }
      );
      if (postRes.status === 201) return { ok: true };
      return { ok: false, error: `POST ${postRes.status}: ${postRes.responseText}` };
    }
    return { ok: false, error: `PUT ${putRes.status}: ${putRes.responseText}` };
  }

  // ---------------------------------------------------------------------
  // Guild roster actions: Pull / Push
  // ---------------------------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // True when we have a live, sendable game socket.
  function socketReady() {
    try {
      return !!gameSocket && typeof gameSocket.send === "function" && gameSocket.readyState === 1;
    } catch (e) {
      return false;
    }
  }

  // True once a pulled profile exists for this member (by ID, or by name
  // when the payload didn't carry an ID).
  function hasPulledProfile(member) {
    return !!(pulledProfiles[member.characterId] || pulledProfiles[member.characterName]);
  }

  // Request one member's profile over the game socket and resolve as soon as
  // the matching profile_shared arrives (or after timeout + retries).
  function requestMemberProfile(member) {
    const characterName = member.characterName;
    return new Promise((resolve) => {
      let attempts = 0;

      function tryRequest() {
        attempts++;
        const msg = {
          type: "view_profile",
          viewProfileData: { characterName },
          ts: Date.now()
        };
        try {
          gameSocket.send(JSON.stringify(msg));
        } catch (e) {
          if (attempts <= PROFILE_FETCH.maxRetries) {
            setTimeout(tryRequest, 500);
          } else {
            resolve(false);
          }
          return;
        }

        const timeout = setTimeout(() => {
          if (attempts <= PROFILE_FETCH.maxRetries) {
            tryRequest();
          } else {
            resolve(hasPulledProfile(member));
          }
        }, PROFILE_FETCH.timeoutMs);

        const check = setInterval(() => {
          if (hasPulledProfile(member)) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve(true);
          }
        }, 250);
        // Hard-stop the poller well past the timeout window.
        setTimeout(() => clearInterval(check), PROFILE_FETCH.timeoutMs + 2000);
      }

      tryRequest();
    });
  }

  // Pull every guild member's live skill levels. Requires the roster to have
  // been captured (login or Guild panel) and a live game socket.
  async function pullAllMembers() {
    if (pullState.running) return;
    if (guildMembers.length === 0) {
      return "No guild members captured yet — open the in-game Guild panel once so the roster loads, then Pull again.";
    }
    if (!socketReady()) {
      return "Game connection isn't ready. Reload the page (with the script loaded before login) and try again.";
    }

    // Fresh pull: clear previous profiles so re-fetch actually re-requests.
    // Re-seed our own profile (captured at login) so it survives the clear;
    // the loop will overwrite it if our own profile is also fetched. Seed the
    // live skill levels (detectedLevels, kept fresh by skills_updated /
    // action_completed) so the re-seeded profile never carries empty skills —
    // otherwise the auto-push would overwrite the ledger's stored levels with
    // an empty object and the optimizer would fall back to stale data.
    pulledProfiles = {};
    pulledProfilesFull = {};
    if (ownProfileRaw && detectedCharacterId !== null) {
      const own = normalizeMemberProfile(
        ownProfileRaw, detectedCharacterName || cfgGet().characterName, detectedCharacterId
      );
      own.skills = Object.assign({}, detectedLevels);
      pulledProfilesFull[detectedCharacterId] = own;
    }
    pullState = { running: true, paused: false, fetched: 0, total: guildMembers.length, aborted: false };

    // Hide the game's profile popup while we bulk-fetch, to avoid flicker.
    const hideStyleId = "stl-hide-profile-modal";
    let hideStyle = document.getElementById(hideStyleId);
    if (!hideStyle) {
      hideStyle = document.createElement("style");
      hideStyle.id = hideStyleId;
      hideStyle.textContent = ".SharableProfile_modalContainer__6Q2JL, .SharableProfile_modal__2OmCQ { display: none !important; }";
      document.head.appendChild(hideStyle);
    }

    renderOverlay();
    const members = [...guildMembers];
    try {
      for (let i = 0; i < members.length; i++) {
        if (pullState.aborted) break;
        while (pullState.paused && !pullState.aborted) await sleep(300);
        if (pullState.aborted) break;
        await requestMemberProfile(members[i]);
        pullState.fetched = Object.keys(pulledProfiles).length;
        renderOverlay(); // keeps the progress text + minimized pill live
        if (i + 1 < members.length) await sleep(PROFILE_FETCH.delayMs);
      }
    } finally {
      if (hideStyle) hideStyle.remove();
      pullState.running = false;
      pullState.paused = false;
      renderOverlay();
    }
    const ok = Object.keys(pulledProfiles).length;
    let message = `Pulled ${ok}/${members.length} member profiles.`;

    // Best-effort auto-push so the trial optimizer has data without extra
    // clicks — guild members only (see pushGuildGate); the server now
    // enforces membership, so there is no local bypass.
    const gate = pushGuildGate();
    if (gate) {
      message += ` ${gate}`;
    } else {
      try {
        const apiBase = currentApiBase();
        // Live roster FIRST: the server gates all writes against this
        // snapshot, so it has to land before the other pushes.
        message += ` ${await pushLiveRoster(apiBase)}`;
        const cdMsg = await pushClientData(apiBase);
        if (cdMsg) message += ` ${cdMsg}`;
        const ctMsg = await pushCombatTrials(apiBase);
        if (ctMsg) message += ` ${ctMsg}`;
        const stMsg = await pushSkillingTrials(apiBase);
        if (stMsg) message += ` ${stMsg}`;
        message += ` ${await pushPulledProfiles(apiBase)}`;
        message += ` ${await pushPulledRoster(apiBase)}`;
      } catch (e) {
        message += ` (auto-push failed: ${e && e.message ? e.message : e})`;
      }
    }
    return message;
  }

  // Push the pulled roster to the ledger backend via POST /api/roster/sync.
  async function pushPulledRoster(apiBase) {
    const members = Object.values(pulledProfiles);
    if (members.length === 0) return "Nothing to push — Pull members first.";
    // Profiles already carry their numeric characterId when the payload
    // provided one; fall back to name matching against the captured roster
    // for the rare name-keyed entries.
    const idByName = new Map(guildMembers.map((m) => [m.characterName, m.characterId]));
    const payload = {
      members: members
        .map((p) => {
          const characterId = p.characterId || idByName.get(p.characterName);
          if (!characterId) return null;
          return { characterId, name: p.characterName, levels: p.skills };
        })
        .filter(Boolean)
    };
    if (payload.members.length === 0) {
      return "No pulled profiles matched a captured roster ID — Pull again from a fresh roster.";
    }
    const res = await gmRequest("POST", `${apiBase}/api/roster/sync`, payload);
    if (res.status === 200) {
      const body = JSON.parse(res.responseText);
      return `Pushed ${body.members} members (${body.levelRows} level rows) to the ledger.`;
    }
    return `Push failed (${res.status}): ${res.responseText}`;
  }

  // Push a NON-destructive snapshot of the captured in-game guild roster to
  // the ledger (POST /api/roster/live). Unlike /cull this only stores the
  // roster — it never deletes ledger characters. The members page compares
  // the ledger against this snapshot to flag anyone no longer in the guild.
  async function pushLiveRoster(apiBase) {
    const members = guildMembers
      .map((m) => ({
        characterId: m.characterId,
        name: m.characterName,
        role: m.role || "member"
      }))
      .filter((m) => Number.isInteger(m.characterId) && m.characterId > 0 && m.name);
    if (members.length === 0) return "No guild roster captured — nothing to snapshot.";
    const res = await gmRequest("POST", `${apiBase}/api/roster/live`, {
      guildName,
      members
    });
    if (res.status === 200) {
      const body = JSON.parse(res.responseText);
      return `Snapshot of ${body.members} live guild members saved.`;
    }
    return `Live roster push failed (${res.status}): ${res.responseText}`;
  }

  // ---------------------------------------------------------------------
  // v1.6.0 — full trial profile + client data push (Weekly Skilling Trial)
  // ---------------------------------------------------------------------

  // The game exposes its static client data (item details, etc.) through a
  // page-level `localStorageUtil` global. We run sandboxed, so reach it via
  // unsafeWindow. Returns the itemDetailMap or null when unavailable.
  function readItemDetailMap() {
    try {
      const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
      const util = pageWindow.localStorageUtil;
      if (util && typeof util.getInitClientData === "function") {
        const clientData = util.getInitClientData();
        if (clientData && typeof clientData.itemDetailMap === "object") {
          return clientData.itemDetailMap;
        }
      }
    } catch (e) {
      /* game API not present yet */
    }
    return null;
  }

  // Push the captured itemDetailMap to the ledger (one-time per page load).
  async function pushClientData(apiBase) {
    if (clientDataSent) return null;
    const itemDetailMap = readItemDetailMap();
    if (!itemDetailMap || Object.keys(itemDetailMap).length === 0) {
      return "itemDetailMap not available yet — retry after the game has fully loaded.";
    }
    const res = await gmRequest("POST", `${apiBase}/api/client-data`, { itemDetailMap });
    if (res.status === 200) {
      clientDataSent = true;
      const body = JSON.parse(res.responseText);
      return `Pushed itemDetailMap (${body.size} items) to the ledger.`;
    }
    return `Client-data push failed (${res.status}): ${res.responseText}`;
  }

  // Capture the game's STATIC guild-trial detail table (per-trial
  // sortIndex/kind) from the init_client_data login frame, when that frame
  // reaches our WS hook as a parseable string. This is the exact data the
  // game feeds to ci.sortTrialHrids() to order the Guild → Trials panel, so
  // with it we can order this week's trials the same way WITHOUT opening any
  // panel or touching the UI. The table is week-INDEPENDENT (static content
  // shipped with the game build), so one capture is enough for the whole
  // session. Best-effort: when the field is absent (the frame often crosses
  // the game's internal message bus as a deserialized object and never
  // reaches the string hook) the push path confirms the order via the
  // Guild → Trials DOM read / currentTrialsData instead, and otherwise
  // holds the push rather than storing an unconfirmed order.
  function captureGuildTrialDetails(msg) {
    if (!msg || typeof msg !== "object") return;
    const m = msg.guildTrialDetailMap;
    if (m && typeof m === "object") guildTrialDetailMap = m;
  }

  // Look up a trial's detail entry (by hrid) from the captured table.
  function trialDetailFor(hrid) {
    if (!guildTrialDetailMap) return null;
    const d = guildTrialDetailMap[hrid];
    return (d && typeof d === "object") ? d : null;
  }

  // Order this week's SKILLING trial hrids exactly like the game's
  // Guild → Trials panel, using the game's own sortTrialHrids() logic against
  // the captured static table (see captureGuildTrialDetails). No panel/UI
  // interaction is involved. Returns an array of hrids in panel order, or
  // null when the table is missing or none of the hrids are in it (in which
  // case the caller tries the other confirmation sources and, if none
  // confirms the order, holds the push).
  function orderSkillingHrids(hrids) {
    if (!guildTrialDetailMap || !Array.isArray(hrids) || hrids.length === 0) return null;
    const idx = (h) => { const d = trialDetailFor(h); return (d && d.sortIndex != null) ? Number(d.sortIndex) : 0; };
    const ordered = hrids.slice().sort((a, b) => idx(a) - idx(b));
    // Confirm the table actually carried these hrids (a stable sort would
    // "succeed" as a no-op otherwise); if not, report null → unconfirmed.
    let any = false;
    for (const h of hrids) { if (trialDetailFor(h)) { any = true; break; } }
    if (!any) return null;
    return ordered;
  }

  // Same, for this week's COMBAT trial hrids.
  function orderCombatHrids(hrids) {
    if (!guildTrialDetailMap || !Array.isArray(hrids) || hrids.length === 0) return null;
    const idx = (h) => { const d = trialDetailFor(h); return (d && d.sortIndex != null) ? Number(d.sortIndex) : 0; };
    const ordered = hrids.slice().sort((a, b) => idx(a) - idx(b));
    let any = false;
    for (const h of hrids) { if (trialDetailFor(h)) { any = true; break; } }
    if (!any) return null;
    return ordered;
  }

  // Capture this week's two combat-trial encounters from a guild message.
  // The game carries them in `guildWeeklyTrialSet.combatHrids` (e.g.
  // ["/guild_combat/badger", "/guild_combat/swarm"]); the weekly set also
  // resets on a new guild week, so a fresh capture is authoritative.
  function captureCombatTrials(msg) {
    if (!msg || typeof msg !== "object") return;
    const set = msg.guildWeeklyTrialSet;
    if (set && Array.isArray(set.combatHrids) && set.combatHrids.length > 0) {
      combatTrialHrids = set.combatHrids.slice(0, 5);
      combatTrialsSent = false; // a new/changed week may need re-pushing
    }
  }

  // Push this week's combat-trial hrids to the ledger (one-time per page
  // load) so the Combat Dashboard can name the two teams after the monsters.
  // Pushes ONLY when the panel order is CONFIRMED through a data channel (no
  // panel/UI interaction at all): (1) the game's static guild-trial table
  // (guildTrialDetailMap, see captureGuildTrialDetails) — the exact sort the
  // game applies to the Guild → Trials panel; (2) a Guild → Trials DOM read
  // (readTrialPanelOrder / panelTrialOrder) when that tab happens to be the
  // active sub-panel and its tiles show exactly this week's trials.
  // Otherwise the push is HELD (skip note returned, combatTrialsSent stays
  // false) so the raw combatHrids order is never stored — a later sync or
  // panel read re-pushes once the order is confirmed.
  // Best-effort: a failure never blocks the rest of a sync/pull.
  async function pushCombatTrials(apiBase) {
    if (combatTrialsSent || !combatTrialHrids || combatTrialHrids.length === 0) return null;
    const fromTable = orderCombatHrids(combatTrialHrids); // from the static table — no UI
    const panelNames = panelTrialOrder && panelTrialOrder.combat; // cached DOM order (if any)
    const fromPanel = (fromTable == null && panelNames
      && panelOrderMatches(combatTrialHrids, panelNames))
      ? reorderHridsToPanelOrder(combatTrialHrids, panelNames)
      : null;
    const confirmed = (fromTable && fromTable.length > 0)
      ? fromTable
      : (fromPanel && fromPanel.length > 0 ? fromPanel : null);
    if (!confirmed) {
      return "Combat trials: held (order not confirmed yet — will push once it is known).";
    }
    const res = await gmRequest("POST", `${apiBase}/api/combat-trials`, { combatHrids: confirmed });
    if (res.status === 200) {
      combatTrialsSent = true;
      lastCombatPush = confirmed; // seed the panel-order self-correction baseline
      return `Pushed this week's combat trials (${confirmed.length}) to the ledger.`;
    }
    return `Combat-trial push failed (${res.status}): ${res.responseText}`;
  }

  // Capture this week's skilling-trial skills from a guild message. The game
  // carries them in `guildWeeklyTrialSet.skillHrids` (e.g.
  // ["/guild_skilling/milking", "/guild_skilling/alchemy", …]); the weekly set
  // also resets on a new guild week, so a fresh capture is authoritative.
  // We also snapshot the game's `currentTrialsData` (same message, via
  // msg.guild) as a tertiary order source. The PRIMARY order source is now
  // the static guildTrialDetailMap table (captured from init_client_data —
  // see captureGuildTrialDetails), which pushSkillingTrials prefers; the
  // Guild → Trials DOM read (panelTrialOrder) and currentTrialsData are only
  // fallbacks.
  function captureSkillingTrials(msg) {
    if (!msg || typeof msg !== "object") return;
    const set = msg.guildWeeklyTrialSet;
    if (set && Array.isArray(set.skillHrids) && set.skillHrids.length > 0) {
      skillingTrialHrids = set.skillHrids.slice(0, 10);
      // msg.guild may be the guild object (as on guild_updated). Refresh
      // currentTrialsData only when this message actually carries it, so a
      // message without it can't wipe a value an earlier message captured.
      const guild = (msg.guild && typeof msg.guild === "object") ? msg.guild : null;
      if (guild && typeof guild.currentTrialsData === "string") {
        skillingCurrentTrialsData = guild.currentTrialsData;
      }
      skillingTrialsSent = false; // a new/changed week may need re-pushing
    }
  }

  // Reindex the captured raw skillHrids into the in-game panel order using
  // currentTrialsData's `skilling.parties` key order (the game's own trial
  // payload, so this IS a confirmed order, not the raw array order). Returns
  // an array of the ORIGINAL hrids (from skillHrids) in panel order, or null
  // when currentTrialsData isn't available/parsable (the push then stays
  // HELD rather than storing the raw order). Matching is by hrid TAIL, so it
  // works whether the panel keys are full hrids ("/guild_skilling/cooking") or
  // bare ids ("cooking"). STRICT: every hrid of this week must be present in
  // the parties keys, otherwise the ordering can't be trusted (e.g. stale
  // data from a previous week) and the push stays HELD.
  function skillingPanelOrderHrids() {
    if (!skillingCurrentTrialsData || !Array.isArray(skillingTrialHrids) || skillingTrialHrids.length === 0) return null;
    let parsed;
    try { parsed = JSON.parse(skillingCurrentTrialsData); } catch (e) { return null; }
    const parties = parsed && parsed.skilling && parsed.skilling.parties;
    if (!parties || typeof parties !== "object") return null;
    const tailOf = (s) => String(s).split("/").pop().toLowerCase();
    const partyTails = {};
    for (const key of Object.keys(parties)) partyTails[tailOf(key)] = true;
    // Confirmation gate: this week's trials must all be covered by the
    // parties keys, else the order is unconfirmed (return null → hold).
    for (const h of skillingTrialHrids) if (!partyTails[tailOf(h)]) return null;
    const tailToHrid = {};
    for (const h of skillingTrialHrids) tailToHrid[tailOf(h)] = h;
    const panelOrder = [];
    const seen = {};
    for (const key of Object.keys(parties)) {
      const tail = tailOf(key);
      if (tailToHrid[tail] && !seen[tail]) {
        panelOrder.push(tailToHrid[tail]);
        seen[tail] = true;
      }
    }
    return panelOrder.length === skillingTrialHrids.length ? panelOrder : null;
  }

  // Push this week's skilling-trial hrids to the ledger (one-time per page
  // load) so the Skilling Dashboard auto-selects this week's trial skills in
  // the in-game panel order. The raw guildWeeklyTrialSet.skillHrids array is
  // NOT the panel order (the game sorts it by a static per-trial sortIndex),
  // so we reorder using (in priority order, NO panel/UI interaction involved):
  //   1. the game's static guild-trial table (guildTrialDetailMap — see
  //      captureGuildTrialDetails), the exact table the game itself sorts by;
  //   2. a Guild → Trials DOM read (readTrialPanelOrder / panelTrialOrder)
  //      when that tab is the active sub-panel and its tiles show exactly
  //      this week's trials;
  //   3. the currentTrialsData path (skillingPanelOrderHrids) — the game's
  //      own trial-set payload (captured from guild messages).
  // If NONE of those confirms the order, the push is HELD (skip note
  // returned, skillingTrialsSent stays false) so the raw skillHrids order is
  // never stored — a later sync or panel read re-pushes once it is confirmed.
  // A failure never blocks the rest of a sync/pull.
  async function pushSkillingTrials(apiBase) {
    if (skillingTrialsSent || !skillingTrialHrids || skillingTrialHrids.length === 0) return null;
    const fromTable = orderSkillingHrids(skillingTrialHrids); // from the static table — no UI
    const panelSkilling = panelTrialOrder && panelTrialOrder.skilling; // cached DOM order (if any)
    const fromPanel = (fromTable == null && Array.isArray(panelSkilling) && panelSkilling.length > 0
      && panelOrderMatches(skillingTrialHrids, panelSkilling))
      ? reorderHridsToPanelOrder(skillingTrialHrids, panelSkilling)
      : null;
    const fromData = (fromTable == null && fromPanel == null)
      ? skillingPanelOrderHrids()
      : null;
    const confirmed = (fromTable && fromTable.length > 0)
      ? fromTable
      : ((fromPanel && fromPanel.length > 0)
          ? fromPanel
          : ((fromData && fromData.length > 0)
              ? fromData
              : null));
    if (!confirmed) {
      return "Skilling trials: held (order not confirmed yet — will push once it is known).";
    }
    const res = await gmRequest("POST", `${apiBase}/api/skilling-trials`, { skillHrids: confirmed });
    if (res.status === 200) {
      skillingTrialsSent = true;
      lastSkillingPush = confirmed; // seed the panel-order self-correction baseline
      return `Pushed this week's skilling trials (${confirmed.length}) to the ledger.`;
    }
    return `Skilling-trial push failed (${res.status}): ${res.responseText}`;
  }

  // Push all full trial profiles to the ledger via POST /api/member-profiles/sync.
  async function pushPulledProfiles(apiBase) {
    const entries = Object.values(pulledProfilesFull).filter((p) => p && p.characterId !== null);
    if (entries.length === 0) {
      return "No full profiles captured — Pull members first (or reload so our own profile is captured).";
    }
    const profiles = {};
    for (const p of entries) {
      // Tag as "pulled" so the ledger's merge logic protects any loadouts a
      // member explicitly sent ("Send to Ledger") from being clobbered.
      p.source = "pulled";
      profiles[p.characterId] = p;
    }
    const res = await gmRequest("POST", `${apiBase}/api/member-profiles/sync`, { profiles });
    if (res.status === 200) {
      const body = JSON.parse(res.responseText);
      return `Pushed ${body.upserted} full member profiles to the ledger.`;
    }
    return `Profile push failed (${res.status}): ${res.responseText}`;
  }

  // Push our OWN full trial profile (loadouts, buff maps, lab shop, per-skill
  // loadout selection, and the latest skill levels) to the ledger. Used by the
  // "Send to Ledger" button so a single click syncs both levels and gear.
  // Prefers the raw login payload (ownProfileRaw) so loadouts come straight
  // from the game; falls back to any full profile already pulled for this id.
  async function pushOwnProfile(apiBase, characterId, characterName) {
    let full = null;
    if (ownProfileRaw) {
      full = normalizeMemberProfile(ownProfileRaw, characterName, characterId);
    } else if (pulledProfilesFull[characterId]) {
      full = pulledProfilesFull[characterId];
    }
    if (!full) {
      return "Loadouts: skipped — own profile not captured yet (reload so our own profile is captured, or use Pull).";
    }
    full.characterId = characterId;
    full.name = characterName;
    // Explicit "Send to Ledger" push: the ledger always lets this win over a
    // later "pulled" push (see server/lib/profile-merge.js).
    full.source = "sent";
    // Mirror ingestOwnProfile: the live skill levels are authoritative for our
    // own profile, so the ledger never keeps stale levels from a prior sync.
    full.skills = Object.assign({}, full.skills, detectedLevels);
    const res = await gmRequest("POST", `${apiBase}/api/member-profiles/sync`, {
      profiles: { [characterId]: full }
    });
    if (res.status === 200) {
      const body = JSON.parse(res.responseText);
      const loCount = Array.isArray(full.loadouts) ? full.loadouts.length : 0;
      return `Profile + loadouts: pushed (own profile, ${loCount} loadout(s)).`;
    }
    return `Profile + loadouts push failed (${res.status}): ${res.responseText}`;
  }

  // ---------------------------------------------------------------------
  // Per-player auto-sync (v1.26.0).
  //
  // Pushes the logged-in character to the ledger automatically — exactly the
  // payload the "Sync Character" button sends (per-skill roster upserts +
  // own full profile tagged source:"sent") — on game (re)open and at most
  // once every AUTO_SYNC_INTERVAL_MS while the page stays open.
  //
  // The cooldown state (lastAt / lastCharId) lives in GM storage, shared
  // across reloads and tabs of the same browser, so a page reload within
  // the window does not re-trigger a push. Identity comes from
  // resolveCharacter() and levels from live detection, so it works with
  // the panel closed and never needs the panel to be opened.
  //
  // Not guild-gated (button parity) and no itemDetailMap push (button
  // parity). ON by default; the panel checkbox opts out.
  // ---------------------------------------------------------------------
  let autoSyncInFlight = false;
  let autoSyncLastAt = parseInt(stlGetValue("autoSyncLastAt", 0), 10) || 0;
  let autoSyncLastCharId = stlGetValue("autoSyncLastCharId", null);

  // Due when: never synced (fresh install / cleared storage), or the
  // character changed since the last sync (switch → immediate push), or the
  // interval has elapsed. The charId check uses the freshest identity, so a
  // character switch syncs immediately even within the 30-minute window.
  function autoSyncDue() {
    const charId = resolveCharacterId();
    if (!autoSyncLastAt) return true;
    return (
      autoSyncLastCharId !== charId ||
      Date.now() - autoSyncLastAt >= AUTO_SYNC_INTERVAL_MS
    );
  }

  async function maybeAutoSync() {
    if (!cfgGet().autoSyncEnabled) return;
    if (detectedCharacterId === null) return; // no identity captured yet
    const apiBase = cfgGet().apiBase.replace(/\/$/, "");
    if (!apiBase) return;
    if (autoSyncInFlight) return;
    if (!autoSyncDue()) return;
    // v1.27.0: honor "push regardless of guild" (async — reads the ledger's
    // live-guild snapshot). A block is NOT a completed run, so it must not
    // set the 30-min cooldown: the next trigger retries. The status line is
    // shown so the player sees why nothing synced.
    const { characterId, characterName } = resolveCharacter();
    const gate = await ownSyncGate(apiBase, characterId, characterName);
    if (gate) {
      setAutoSyncStatus(gate, "err");
      return;
    }
    autoSync(apiBase);
  }

  // Shared writer for the auto-sync status line (used by the completed-run
  // summary and the "blocked" notice).
  function setAutoSyncStatus(message, cls) {
    // v1.36.0: write the status into BOTH the popup and the in-game Settings
    // tab (whichever are mounted), so auto-sync feedback is visible in either.
    let wrote = false;
    const panel = document.getElementById("stl-panel");
    if (panel) {
      const el = panel.querySelector("#stl-autosync-status");
      if (el) { el.textContent = message; el.className = cls; wrote = true; }
    }
    const tab = document.getElementById("stl-settings-tab-panel");
    if (tab) {
      const el = tab.querySelector("#stlt-autosync-status");
      if (el) { el.textContent = message; el.className = cls; wrote = true; }
    }
    return wrote;
  }

  async function autoSync(apiBase) {
    autoSyncInFlight = true;
    try {
      const { characterId, characterName } = resolveCharacter();
      readLevelsFromSidebar(); // fill any WebSocket gaps before pushing
      let pushed = 0;
      let failed = 0;
      for (const skill of SKILLS) {
        const level = detectedLevels[skill.id];
        if (typeof level !== "number" || !Number.isFinite(level)) continue;
        stlSetValue(`level_${skill.id}`, level); // mirror the button
        try {
          const result = await upsertSkill(
            apiBase, skill.id, characterId, characterName, level
          );
          if (result.ok) pushed++; else failed++;
        } catch (err) {
          failed++;
        }
      }
      let profileMsg;
      try {
        profileMsg = await pushOwnProfile(apiBase, characterId, characterName);
      } catch (err) {
        profileMsg = `Loadouts: failed \u2014 ${err.message || err}`;
      }
      // Best-effort: refresh this week's combat-trial monsters (Combat Dashboard)
      // and skilling-trial skills (Skilling Dashboard). A failure never blocks or
      // marks the sync as failed.
      try {
        await pushCombatTrials(apiBase);
      } catch (err) { /* best-effort — ignore */ }
      try {
        await pushSkillingTrials(apiBase);
      } catch (err) { /* best-effort — ignore */ }
      // Persist the cooldown only after a completed run, so a hard failure
      // (transport reject) leaves lastAt unset and the next trigger retries.
      autoSyncLastAt = Date.now();
      autoSyncLastCharId = characterId;
      stlSetValue("autoSyncLastAt", autoSyncLastAt);
      stlSetValue("autoSyncLastCharId", characterId);
      const t = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      const profileFailed = profileMsg.includes("failed");
      setAutoSyncStatus(
        failed === 0 && !profileFailed
          ? `Auto-synced ${characterName} ${t} — ${pushed} level(s) + profile.`
          : failed === 0
            ? `Auto-synced ${characterName} ${t} — ${pushed} level(s); ${profileMsg}`
            : `Auto-sync ${t}: ${pushed} level(s) pushed, ${failed} failed.`,
        failed === 0 && !profileFailed ? "ok" : "err"
      );
      applyTrialHighlight(); // button parity
    } finally {
      autoSyncInFlight = false;
    }
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  // GM_addStyle is unsafe at document-start in the Android app: its shim
  // appends the <style> node straight onto `document.head ||
  // document.documentElement`, both of which are null before the DOM is
  // parsed, so it throws a TypeError that the app's wrapper swallows —
  // silently killing everything after this point (the FAB, panel, overlay,
  // and init). Tampermonkey defers pre-DOM calls, so this only bites in-app.
  // The fix is environment-agnostic: hand the CSS straight to GM_addStyle
  // when the DOM exists, otherwise defer it to DOMContentLoaded.
  function stlAddStyle(css) {
    try {
      if (document.head || document.documentElement) {
        GM_addStyle(css);
        return;
      }
    } catch (e) { /* queue below */ }
    try {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          try { GM_addStyle(css); } catch (e) { /* give up silently */ }
        }, { once: true });
      } else {
        GM_addStyle(css);
      }
    } catch (e) { /* no DOM at all — drop the CSS */ }
  }

  stlAddStyle(`
    #stl-fab {
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #a86a0c; color: #fff; border: none; border-radius: 999px;
      padding: 10px 16px; font: 600 13px system-ui, sans-serif; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35); touch-action: none; user-select: none;
    }
    #stl-fab:hover { background: #8f5808; }
    #stl-fab-update-dot {
      position: absolute; top: -10px; right: -6px;
      background: #f5b301; color: #fff; border: 2px solid #fff;
      border-radius: 999px; padding: 2px 8px; white-space: nowrap;
      font: 700 10px system-ui, sans-serif; letter-spacing: 0.2px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4); pointer-events: none;
    }
    #stl-update-banner {
      display: flex; align-items: center; gap: 8px;
      background: #fff7e0; color: #6b4c00;
      border: 1px solid #f0c060; border-radius: 8px;
      padding: 8px 10px; margin: 0 0 12px;
      font: 500 12px system-ui, sans-serif; line-height: 1.35;
    }
    #stl-update-banner[hidden] { display: none; }
    #stl-update-banner .stl-update-msg { flex: 1; }
    #stl-update-banner .stl-update-dismiss {
      flex: none; background: transparent; border: none;
      color: #6b4c00; font: 600 12px system-ui, sans-serif;
      cursor: pointer; padding: 2px 6px; border-radius: 6px;
    }
    #stl-update-banner .stl-update-dismiss:hover { background: rgba(0,0,0,0.06); }
    /* In-game Settings-page "Trial Tracker" tab. It lives inside the game's
       own tab bar (a MUI Tabs component), so it reuses the game's CSS custom
       properties (--color-*, --spacing-*, --font-*) to match the built-in
       tabs exactly. #stl-settings-tab is the button; #stl-settings-tab-panel
       is the injected panel that replaces the Settings content when active. */
    #stl-settings-tab {
      min-height: 2rem; min-width: 5rem;
      border-top-left-radius: 4px; border-top-right-radius: 4px;
      padding: var(--spacing-xs-plus);
      color: var(--color-text-dark-mode);
      background: var(--color-midnight-500);
      font-family: inherit; font-size: var(--font-size-base); font-weight: 500;
      text-transform: none; white-space: nowrap; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      outline: none;
    }
    #stl-settings-tab:hover { background: var(--color-midnight-300); }
    #stl-settings-tab.stl-active { background: var(--color-space-600); }
    #stl-settings-tab-panel {
      padding: var(--spacing-md, 16px) var(--spacing-lg, 20px);
      font-family: inherit; font-size: var(--font-size-base, 14px);
      color: var(--color-text-dark-mode);
    }
    /* Hidden/shown via inline style.display (set by the JS), which is robust
       across game deploys — the built-in panels hide with a CSS-module class
       whose hashed suffix changes per deploy, so we never match that class. */
    #stl-settings-tab-panel .stl-tab-heading {
      margin: 0 0 8px; font-size: var(--font-size-lg, 18px); font-weight: 600;
    }
    /* Duplicate of the popup's Settings-view controls, living inside the
       in-game Settings tab. Scoped to #stl-settings-tab-panel so it never
       leaks into the game or the popup; matches the panel's colors/fonts.
       These are the #stlt- ids (the popup uses #stl- ids). */
    #stl-settings-tab-panel label {
      display: block; margin: 10px 0 4px; color: #b7b9cc; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em; font-family: system-ui, sans-serif;
    }
    #stl-settings-tab-panel input:not([type=checkbox]) {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.15); background: #101117; color: #fff;
      font-size: 13px; font-family: system-ui, sans-serif;
    }
    #stl-settings-tab-panel label.stl-check {
      display: flex; align-items: center; gap: 6px; margin-top: 10px;
      text-transform: none; letter-spacing: 0; font-size: 12px; color: #f3f3f7;
      cursor: pointer; font-family: system-ui, sans-serif;
    }
    #stl-settings-tab-panel label.stl-check input { width: auto; margin: 0; }
    #stlt-characterId, #stlt-characterName {
      background: #17181f; color: #e8eaf3; border-color: rgba(255,255,255,0.08);
      pointer-events: none; user-select: none;
    }
    #stlt-characterId { -moz-appearance: textfield; appearance: textfield; }
    #stlt-characterId::-webkit-outer-spin-button,
    #stlt-characterId::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #stl-settings-tab-panel .stlt-save { display: flex; gap: 8px; margin-top: 12px; }
    #stl-settings-tab-panel .stlt-save button {
      flex: 1; padding: 7px 0; border-radius: 6px; border: none; cursor: pointer;
      font: 600 12px system-ui, sans-serif;
    }
    #stlt-save { background: #333; color: #fff; }
    #stlt-reset { background: #7a2d24; color: #fff; }
    #stlt-status { margin-top: 10px; font-size: 11px; color: #b7b9cc; white-space: pre-line; font-family: system-ui, sans-serif; }
    #stlt-status.err { color: #e2564a; }
    #stlt-status.ok { color: #35c25a; }
    #stlt-autosync-status { margin-top: 4px; font-size: 11px; color: #b7b9cc; font-family: system-ui, sans-serif; }
    #stlt-autosync-status.ok { color: #35c25a; }
    #stlt-autosync-status.err { color: #e2564a; }
    #stl-panel {
      position: fixed; bottom: 70px; right: 20px; z-index: 999999;
      /* v1.36.0: responsive width — capped at 300px (desktop) but shrinks to
         the viewport on narrow screens so it never overflows. The 40px
         leaves 20px of breathing room on each side at the smallest size. */
      width: min(300px, calc(100vw - 40px));
      max-width: 300px; min-width: 200px;
      /* v1.36.0: auto-size to the current view's content so there's no
         trailing empty space (e.g. below "Sync Character" in the Main view),
         but the max-height cap keeps the panel from ever growing past its
         old fixed size — it only shrinks to fit, and longer views scroll
         inside. Leaves room for the FAB below. */
      height: auto;
      max-height: min(85vh, calc(100vh - 100px));
      overflow-y: auto;
      background: #1b1c28; color: #f3f3f7; border-radius: 10px;
      padding: 14px 16px 16px; font: 13px system-ui, sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,0.5); display: none;
      border: 1px solid rgba(255,255,255,0.1);
    }
    #stl-panel.open { display: block; }
    #stl-panel h4 {
      display: flex; align-items: center; justify-content: space-between;
      margin: 0 0 10px; font-size: 14px; cursor: grab; user-select: none; touch-action: none;
    }
    #stl-panel-close {
      margin: -4px -6px 0 8px; padding: 2px 6px; border: none; background: none;
      color: #888; font: 20px/1 system-ui, sans-serif; cursor: pointer;
    }
    #stl-panel-close:hover { color: #fff; }
    #stl-panel h4:active { cursor: grabbing; }
    /* v1.36.0: Main/Settings view nav under the title. */
    #stl-nav { display: flex; gap: 6px; margin: 0 0 12px; }
    #stl-nav button {
      flex: 1; padding: 7px 0; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);
      background: #262737; color: #b7b9cc; cursor: pointer; font: 600 12px system-ui, sans-serif;
    }
    #stl-nav button.active { background: #a86a0c; border-color: #a86a0c; color: #fff; }
    #stl-panel label { display: block; margin: 8px 0 3px; color: #b7b9cc; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    #stl-panel input:not([type=checkbox]) {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.15); background: #101117; color: #fff; font-size: 13px;
    }
    #stl-panel label.stl-check {
      display: flex; align-items: center; gap: 6px; margin-top: 10px;
      text-transform: none; letter-spacing: 0; font-size: 12px; color: #f3f3f7; cursor: pointer;
    }
    #stl-panel label.stl-check input { width: auto; margin: 0; }
    #stl-skill-row { display: flex; align-items: center; justify-content: space-between; margin: 4px 0; gap: 8px; }
    #stl-skill-row label { margin: 0; flex: 1; text-transform: none; letter-spacing: 0; color: #f3f3f7; font-size: 12px; }
    /* Fixed width for every level box: just enough for 3 digits, with a few
       px of slack so it looks tidy. The :not([type=checkbox]) keeps
       specificity level with the generic #stl-panel input rule above, so
       this one wins (source order). Without it each box's width varied with
       its label's length. */
    #stl-skill-row input:not([type=checkbox]) { width: 62px; flex: none; }
    /* Levels are always read-only displays of auto-detected values, so give
       every box the same dimmed "locked" look (dark fill, bright text for
       readability, faint border), strip the number spin buttons
       (increase/decrease arrows), and disable pointer interaction so clicking
       one never focuses it (no text caret) or selects its value — the numbers
       are never hand-typed. -moz-appearance / appearance covers Firefox; the
       ::-webkit-*-spin-button rules cover Chromium + Safari. */
    #stl-skill-row input[type=number] {
      background: #17181f; color: #e8eaf3; border-color: rgba(255,255,255,0.08);
      pointer-events: none; user-select: none;
      -moz-appearance: textfield; appearance: textfield;
    }
    #stl-skill-row input[type=number]::-webkit-outer-spin-button,
    #stl-skill-row input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    /* Character ID / name are read-only displays of the auto-detected
       identity, so they get the same dimmed "locked" box look as the level
       values — reference info, not editable fields (no caret on click).
       The ID box is a number input, so strip its spin buttons too. */
    #stl-characterId, #stl-characterName {
      background: #17181f; color: #e8eaf3; border-color: rgba(255,255,255,0.08);
      pointer-events: none; user-select: none;
    }
    #stl-characterId { -moz-appearance: textfield; appearance: textfield; }
    #stl-characterId::-webkit-outer-spin-button,
    #stl-characterId::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #stl-actions { display: flex; gap: 8px; margin-top: 12px; }
    #stl-actions button {
      flex: 1; padding: 7px 0; border-radius: 6px; border: none; cursor: pointer; font: 600 12px system-ui, sans-serif;
    }
    #stl-send { background: #a86a0c; color: #fff; }
    #stl-save { background: #333; color: #fff; }
    #stl-reset { background: #7a2d24; color: #fff; }
    #stl-status { margin-top: 10px; font-size: 11px; color: #b7b9cc; white-space: pre-line; }
    #stl-status.err { color: #e2564a; }
    #stl-status.ok { color: #35c25a; }
    /* v1.36.0: the per-skill result list from "Sync Character" renders in
       this always-visible dropdown instead of the status line, so a long
       dump can never make the panel suddenly grow. The summary row is a
       constant height; only the (user-expanded) body adds height. */
    #stl-sync-details { margin-top: 10px; }
    #stl-sync-details summary {
      cursor: pointer; color: #b7b9cc; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.04em;
      list-style: none;
    }
    #stl-sync-details summary::-webkit-details-marker { display: none; }
    #stl-sync-details summary::before { content: "▸"; margin-right: 6px; color: #888; }
    #stl-sync-details[open] summary::before { content: "▾"; }
    #stl-sync-summary.ok { color: #35c25a; }
    #stl-sync-summary.err { color: #e2564a; }
    #stl-sync-results { margin-top: 6px; font-size: 11px; }
    #stl-sync-results > div { white-space: pre-line; color: #b7b9cc; }
    #stl-sync-results > div.ok { color: #35c25a; }
    #stl-sync-results > div.err { color: #e2564a; }
    #stl-sync-results > .stl-sync-empty { color: #7d7f97; }
    #stl-autosync-status { margin-top: 4px; font-size: 11px; color: #b7b9cc; }
    #stl-autosync-status.ok { color: #35c25a; }
    #stl-autosync-status.err { color: #e2564a; }
    #stl-login { border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px 10px 10px; margin-bottom: 10px; background: rgba(255,255,255,0.02); }
    #stl-login label { margin-top: 0; }
    #stl-login-detected { font-size: 11px; color: #b7b9cc; margin: 6px 0 2px; }
    #stl-login-code { font-size: 16px; font-weight: 600; text-align: center; }
    #stl-login-actions { display: flex; gap: 8px; margin-top: 8px; }
    #stl-login-actions button {
      flex: 1; padding: 7px 0; border-radius: 6px; border: none; cursor: pointer;
      font: 600 12px system-ui, sans-serif; background: #2f6fb2; color: #fff;
    }
    #stl-login-actions button:hover { background: #2a629e; }
    #stl-login-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    #stl-login-status { margin-top: 6px; font-size: 11px; color: #b7b9cc; white-space: pre-line; }
    #stl-login-status.err { color: #e2564a; }
    #stl-login-status.ok { color: #35c25a; }
    #stl-detect-hint { font-size: 10.5px; color: #7d7f97; margin-top: 4px; }
    .stl-trial-best {
      position: relative; /* anchor for the ribbon badge */
      outline: 2px solid #f5c542;
      outline-offset: 2px;
      border-radius: 10px;
      filter: drop-shadow(0 0 8px rgba(245, 197, 66, 0.55));
    }
    .stl-trial-badge {
      position: absolute; top: -19px; left: 50%; /* fully above the card */
      transform: translateX(-50%);
      z-index: 1; padding: 2px 10px; border-radius: 999px;
      background: linear-gradient(180deg, #ffd86b, #f5c542);
      color: #221a02;
      font: 700 10px system-ui, sans-serif; letter-spacing: 0.03em;
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
      pointer-events: none;
    }
    .stl-trial-notice {
      margin: 0 0 10px; padding: 6px 12px; border-radius: 8px;
      border: 1px solid rgba(245, 197, 66, 0.5);
      background: rgba(120, 96, 20, 0.35);
      color: #ffe08a;
      font: 500 12px system-ui, sans-serif; line-height: 1.45;
      pointer-events: none;
    }
    /* ---- Guild roster overlay (centered card, styled like #stl-panel) ---- */
    #stl-overlay {
      position: fixed; inset: 0; z-index: 1000000;
      display: none; justify-content: center; align-items: center; padding: 8px;
      pointer-events: none; /* click-through: only the panel/pill intercept input */
    }
    #stl-overlay.stl-overlay-open { display: flex; }
    #stl-overlay-panel {
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      background: #1b1c28; color: #f3f3f7; border-radius: 10px;
      box-sizing: border-box;
      width: min(920px, 92vw); max-height: min(700px, 86vh);
      display: flex; flex-direction: column;
      box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.1);
      font: 13px system-ui, sans-serif;
      pointer-events: auto;
    }
    #stl-overlay.stl-overlay-minimized #stl-overlay-panel { display: none; }
    #stl-overlay-header {
      padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.12);
      display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
      cursor: grab; user-select: none; touch-action: none;
    }
    #stl-overlay-header:active { cursor: grabbing; }
    #stl-overlay-header h3 { margin: 0; font-size: 14px; }
    #stl-overlay-header .stl-guild-name { color: #ffd700; font-weight: 400; }
    #stl-overlay-minimize {
      background: none; border: none; color: #888; font-size: 18px; cursor: pointer;
      padding: 0 6px; line-height: 1;
    }
    #stl-overlay-minimize:hover { color: #fff; }
    #stl-overlay-close {
      background: none; border: none; color: #888; font-size: 20px; cursor: pointer;
      padding: 0 4px; line-height: 1;
    }
    #stl-overlay-close:hover { color: #fff; }
    #stl-overlay-toolbar {
      padding: 10px 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.12); flex-shrink: 0;
    }
    #stl-overlay-toolbar button {
      padding: 7px 14px; border: none; border-radius: 6px; cursor: pointer;
      font: 600 12px system-ui, sans-serif; color: #fff;
    }
    #stl-overlay-toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
    #stl-ov-pull { background: linear-gradient(135deg, #667eea, #764ba2); }
    #stl-ov-pause { background: #33344a; }
    #stl-ov-pause.stl-paused { background: #c0392b; }
    #stl-ov-push { background: #a86a0c; }
    #stl-ov-search {
      margin-left: auto; padding: 7px 10px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.15); background: #101117; color: #fff;
      font-size: 12px; width: 160px;
    }
    #stl-overlay-progress { font-size: 12px; color: #b7b9cc; margin-left: 10px; white-space: nowrap; }
    #stl-overlay-body { flex: 1 1 auto; overflow: auto; min-height: 120px; }
    #stl-overlay-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    #stl-overlay-table th, #stl-overlay-table td {
      padding: 6px 10px; text-align: right; white-space: nowrap;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    #stl-overlay-table th {
      position: sticky; top: 0; background: #23243a; color: #cfd1e8;
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; z-index: 1;
    }
    #stl-overlay-table th .stl-skill-head { display: inline-flex; align-items: center; gap: 4px; }
    #stl-overlay-table th .stl-skill-icon { font-size: 12px; line-height: 1; }
    #stl-overlay-table th.stl-col-name, #stl-overlay-table td.stl-col-name { text-align: left; }
    #stl-overlay-table tr.stl-row-missing td { color: #6f7190; }
    /* v1.35.1 — equipped-abilities column in the roster overlay */
    #stl-overlay-table td.stl-col-abilities { text-align: left; max-width: 220px; white-space: normal; }
    .stl-ab-list { display: inline-flex; flex-wrap: wrap; gap: 3px 8px; }
    .stl-ab { white-space: nowrap; color: #cfd1e8; font-size: 11.5px; }
    .stl-ab b { color: #ffd700; font-weight: 600; }
    #stl-overlay-empty { padding: 24px; text-align: center; color: #7d7f97; font-size: 12.5px; white-space: pre-line; }
    #stl-overlay-footer {
      padding: 10px 18px; border-top: 1px solid rgba(255,255,255,0.12);
      font-size: 11.5px; color: #b7b9cc; white-space: pre-line; flex-shrink: 0;
    }
    #stl-overlay-footer.err { color: #e2564a; }
    #stl-overlay-footer.ok { color: #35c25a; }
    /* Minimized pull pill (visible only while a pull is running + minimized) */
    #stl-overlay-pill {
      display: none;
      position: fixed; right: 20px; bottom: 84px; z-index: 1000000;
      align-items: center; gap: 10px;
      background: #1b1c28; color: #f3f3f7;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 999px;
      padding: 8px 14px; font: 600 12px system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,0.55); pointer-events: auto;
      cursor: grab; user-select: none; touch-action: none;
    }
    #stl-overlay-pill:active { cursor: grabbing; }
    #stl-overlay-pill.stl-pill-visible { display: inline-flex; }
    #stl-overlay-pill .stl-pill-label { color: #ffd700; }
    #stl-overlay-pill .stl-pill-status { color: #b7b9cc; font-weight: 400; }
    #stl-overlay-pill button {
      background: #33344a; border: none; color: #fff; border-radius: 999px;
      padding: 4px 10px; font: 600 12px system-ui, sans-serif; cursor: pointer;
    }
    #stl-overlay-pill button:hover { background: #44465e; }
  `);

  // ---------------------------------------------------------------------
  // Guild roster overlay (Pull / Push)
  // ---------------------------------------------------------------------
  function overlayFooter(text, kind) {
    const el = overlayEl && overlayEl.querySelector("#stl-overlay-footer");
    if (!el) return;
    el.textContent = text;
    el.className = kind || "";
  }

  function setOverlayButtons(disabled) {
    if (!overlayEl) return;
    for (const id of ["stl-ov-pull", "stl-ov-pause", "stl-ov-push"]) {
      const b = overlayEl.querySelector("#" + id);
      if (b) b.disabled = disabled;
    }
    // While a pull runs, Pull stays enabled only as "Stop" via the pause btn;
    // Pull itself is disabled to avoid double-starts.
    const pull = overlayEl.querySelector("#stl-ov-pull");
    if (pull) pull.disabled = disabled;
  }

  function renderOverlay() {
    if (!overlayEl) return;

    const progress = overlayEl.querySelector("#stl-overlay-progress");
    if (progress) {
      if (pullState.running) {
        progress.textContent = `Pulling ${pullState.fetched}/${pullState.total}…`;
      } else {
        progress.textContent = `${Object.keys(pulledProfiles).length} profile(s) pulled · ${guildMembers.length} member(s) in roster`;
      }
    }

    // Minimized pill: show it only while a pull is running and the panel is
    // minimized; the pull keeps running in the background either way.
    const pill = overlayEl.querySelector("#stl-overlay-pill");
    if (pill) {
      const pillStatus = pill.querySelector(".stl-pill-status");
      const visible = pullState.running && overlayState.minimized;
      pill.classList.toggle("stl-pill-visible", visible);
      if (visible) applyOverlayPillPosition(pill);
      if (visible && pillStatus) {
        pillStatus.textContent = pullState.paused
          ? `Paused ${pullState.fetched}/${pullState.total}`
          : `Pulling ${pullState.fetched}/${pullState.total}…`;
      }
    }

    // Header guild name.
    const guildEl = overlayEl.querySelector(".stl-guild-name");
    if (guildEl) guildEl.textContent = guildName ? ` · ${guildName}` : "";

    // Pause button label/state.
    const pauseBtn = overlayEl.querySelector("#stl-ov-pause");
    if (pauseBtn) {
      if (pullState.running) {
        pauseBtn.disabled = false;
        pauseBtn.textContent = pullState.paused ? "Resume" : "Pause";
        pauseBtn.classList.toggle("stl-paused", pullState.paused);
      } else {
        pauseBtn.disabled = true;
        pauseBtn.textContent = "Pause";
        pauseBtn.classList.remove("stl-paused");
      }
    }

    const body = overlayEl.querySelector("#stl-overlay-body");
    if (!body) return;

    // Empty state.
    if (guildMembers.length === 0) {
      body.innerHTML = `<div id="stl-overlay-empty">No guild roster captured yet.

Open the in-game Guild panel once (or reload with the script active) so the member list loads, then come back and Press Pull.</div>`;
      return;
    }

    const searchEl = overlayEl.querySelector("#stl-ov-search");
    const filter = searchEl ? searchEl.value.trim().toLowerCase() : "";

    const rows = guildMembers
      .filter((m) => !filter || m.characterName.toLowerCase().includes(filter))
      .map((m) => {
        const p = pulledProfiles[m.characterId] || pulledProfiles[m.characterName];
        const missing = !p;
        // The game's own total already sums skilling + combat (verified against
        // the guild export), so prefer it. When it's absent, fall back to the
        // sum of every captured level — SKILLS now includes the combat stats,
        // so the computed total counts them too.
        let total = p && p.totalLevel != null ? p.totalLevel : "";
        if (total === "" && p) {
          let sum = 0;
          let any = false;
          for (const s of SKILLS) {
            const lv = p.skills[s.id];
            if (typeof lv === "number" && Number.isFinite(lv)) { sum += lv; any = true; }
          }
          if (any) total = sum;
        }
        const cells = SKILLS.map((s) => {
          const lv = p ? p.skills[s.id] : undefined;
          return `<td>${lv !== undefined ? lv : "–"}</td>`;
        }).join("");
        // v1.35.1: equipped abilities (slot order), each "Name Lv N".
        const abList = p && Array.isArray(p.abilities) ? p.abilities : [];
        const abilitiesCell = abList.length
          ? `<span class="stl-ab-list">${abList
              .map((a) => `<span class="stl-ab" title="${escapeHtml(a.hrid)}">${escapeHtml(abilityTail(a.hrid))} <b>${a.level}</b></span>`)
              .join("")}</span>`
          : "–";
        return `<tr class="${missing ? "stl-row-missing" : ""}">
          <td class="stl-col-name">${escapeHtml(m.characterName)}</td>
          ${cells}
          <td class="stl-col-abilities">${abilitiesCell}</td>
          <td class="stl-col-total">${total === "" ? "–" : total}</td>
        </tr>`;
      });

    const headCells = SKILLS.map((s) =>
      `<th title="${s.label}"><span class="stl-skill-head"><span class="stl-skill-icon">${s.icon}</span>${s.label}</span></th>`
    ).join("");
    body.innerHTML = `<table id="stl-overlay-table">
      <thead>
        <tr>
          <th class="stl-col-name">Member</th>
          ${headCells}
          <th class="stl-col-abilities">Abilities</th>
          <th class="stl-col-total">Total</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // v1.35.1: "/abilities/pestilent_shot" -> "Pestilent Shot" for the
  // roster overlay's Abilities column (same convention as the site).
  function abilityTail(hrid) {
    const tail = String(hrid).split("/").pop() || "";
    const parts = tail.split("_").filter(Boolean);
    if (parts.length === 0) return tail;
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }

  function buildOverlay() {
    if (overlayBuilt || overlayEl) return overlayEl;
    overlayBuilt = true;

    const overlay = document.createElement("div");
    overlay.id = "stl-overlay";

    const header = document.createElement("div");
    header.id = "stl-overlay-header";
    header.innerHTML = `<h3>Guild Roster <span class="stl-guild-name"></span></h3>
      <span>
        <button id="stl-overlay-minimize" type="button" title="Minimize (pull keeps running)">&#8722;</button>
        <button id="stl-overlay-close" type="button" title="Close">&times;</button>
      </span>`;

    const toolbar = document.createElement("div");
    toolbar.id = "stl-overlay-toolbar";
    toolbar.innerHTML = `
      <button id="stl-ov-pull" type="button" title="Pull every guild member's live skill levels and equipped abilities">Pull members</button>
      <button id="stl-ov-pause" type="button" title="Pause/Resume the pull" disabled>Pause</button>
      <button id="stl-ov-push" type="button" title="Push the pulled roster to the ledger">Push to ledger</button>
      <span id="stl-overlay-progress"></span>
      <input id="stl-ov-search" type="text" placeholder="Filter members…" />
    `;

    const pill = document.createElement("div");
    pill.id = "stl-overlay-pill";
    pill.innerHTML = `
      <span class="stl-pill-label">&#128104; Guild Roster</span>
      <span class="stl-pill-status"></span>
      <button id="stl-pill-restore" type="button" title="Restore the roster panel">&#8617;</button>
    `;

    const bodyEl = document.createElement("div");
    bodyEl.id = "stl-overlay-body";

    const footer = document.createElement("div");
    footer.id = "stl-overlay-footer";
    footer.textContent = guildMembers.length
      ? `${guildMembers.length} member(s) in roster. Press Pull to fetch live levels.`
      : "No guild roster captured yet.";

    // Wrap the card content in #stl-overlay-panel (the centered card). The
    // pill is fixed-positioned and stays a direct child of the overlay so it
    // is never affected by the panel's minimize display rule.
    const panel = document.createElement("div");
    panel.id = "stl-overlay-panel";
    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(bodyEl);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.appendChild(pill);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    let pillDrag = null;
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = pill.getBoundingClientRect();
      pillDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        left: rect.left,
        top: rect.top
      };
      pill.setPointerCapture(event.pointerId);
    });
    pill.addEventListener("pointermove", (event) => {
      if (!pillDrag || event.pointerId !== pillDrag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - pill.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - pill.offsetHeight);
      const left = Math.min(Math.max(0, event.clientX - pillDrag.offsetX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - pillDrag.offsetY), maxTop);
      pillDrag.left = left;
      pillDrag.top = top;
      pill.style.left = `${left}px`;
      pill.style.top = `${top}px`;
      pill.style.right = "auto";
      pill.style.bottom = "auto";
    });
    const finishPillDrag = (event) => {
      if (!pillDrag || event.pointerId !== pillDrag.pointerId) return;
      if (pill.hasPointerCapture(event.pointerId)) pill.releasePointerCapture(event.pointerId);
      cfgSet({ overlayPillPosition: { left: pillDrag.left, top: pillDrag.top } });
      pillDrag = null;
    };
    pill.addEventListener("pointerup", finishPillDrag);
    pill.addEventListener("pointercancel", finishPillDrag);
    applyOverlayPillPosition(pill);

    let overlayDrag = null;
    header.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      overlayDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        left: rect.left,
        top: rect.top
      };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!overlayDrag || event.pointerId !== overlayDrag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, event.clientX - overlayDrag.offsetX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - overlayDrag.offsetY), maxTop);
      overlayDrag.left = left;
      overlayDrag.top = top;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.transform = "none";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    const finishOverlayDrag = (event) => {
      if (!overlayDrag || event.pointerId !== overlayDrag.pointerId) return;
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
      cfgSet({ overlayPosition: { left: overlayDrag.left, top: overlayDrag.top } });
      overlayDrag = null;
    };
    header.addEventListener("pointerup", finishOverlayDrag);
    header.addEventListener("pointercancel", finishOverlayDrag);

    // Read the API base fresh on each action so settings saved in the
    // panel (or Tampermonkey menu) apply without rebuilding the overlay.
    const currentApiBase = () => cfgGet().apiBase.replace(/\/$/, "");

    overlay.querySelector("#stl-overlay-close").addEventListener("click", () => {
      if (pullState.running) {
        // Keep the overlay present so the progress pill stays visible, but
        // hide the panel — equivalent to minimizing while a pull is in flight.
        overlayState.minimized = true;
        overlay.classList.add("stl-overlay-minimized");
      } else {
        overlayState.minimized = false;
        overlay.classList.remove("stl-overlay-minimized");
        overlay.classList.remove("stl-overlay-open");
      }
      renderOverlay();
    });
    overlay.querySelector("#stl-overlay-minimize").addEventListener("click", () => {
      overlayState.minimized = true;
      overlay.classList.add("stl-overlay-minimized");
      renderOverlay(); // shows the pull pill if a pull is in flight
    });
    overlay.querySelector("#stl-pill-restore").addEventListener("click", () => {
      overlayState.minimized = false;
      overlay.classList.remove("stl-overlay-minimized");
      renderOverlay();
    });
    overlay.querySelector("#stl-ov-search").addEventListener("input", renderOverlay);
    overlay.querySelector("#stl-ov-pause").addEventListener("click", () => {
      if (!pullState.running) return;
      pullState.paused = !pullState.paused;
      renderOverlay();
    });
    overlay.querySelector("#stl-ov-pull").addEventListener("click", async () => {
      setOverlayButtons(true);
      overlayFooter("Pulling member profiles…", "");
      let result;
      try {
        result = await pullAllMembers();
      } catch (e) {
        result = "Pull error: " + (e.message || e);
      }
      setOverlayButtons(false);
      overlayFooter(result, /failed|error|not ready|No guild/i.test(result) ? "err" : "ok");
      renderOverlay();
    });
    overlay.querySelector("#stl-ov-push").addEventListener("click", async () => {
      setOverlayButtons(true);
      overlayFooter("Pushing profiles to ledger…", "");
      let result;
      const gate = pushGuildGate();
      if (gate) {
        result = gate;
      } else {
        try {
          const apiBase = currentApiBase();
          const parts = [];
          // Live roster FIRST: the server gates all other writes against this
          // snapshot, so it has to land before the rest of the pushes.
          parts.push(await pushLiveRoster(apiBase));
          const cdMsg = await pushClientData(apiBase);
          if (cdMsg) parts.push(cdMsg);
          const ctMsg = await pushCombatTrials(apiBase);
          if (ctMsg) parts.push(ctMsg);
          const stMsg = await pushSkillingTrials(apiBase);
          if (stMsg) parts.push(stMsg);
          parts.push(await pushPulledProfiles(apiBase));
          parts.push(await pushPulledRoster(apiBase));
          result = parts.join(" ");
        } catch (e) {
          result = "Push error: " + (e.message || e);
        }
      }
      setOverlayButtons(false);
      overlayFooter(result, /failed|error|Nothing to push|blocked/i.test(result) ? "err" : "ok");
    });

    renderOverlay();
    return overlay;
  }

  function openOverlay() {
    const el = buildOverlay();
    overlayState.minimized = false;
    el.classList.remove("stl-overlay-minimized");
    renderOverlay();
    el.classList.add("stl-overlay-open");
    applyOverlayPosition(el.querySelector("#stl-overlay-panel"));
  }

  // Refresh the ledger-login section of the open panel (if any) to reflect
  // the current in-game detection. Called when the panel is built and again
  // when `init_character_data` arrives late — the confirm button stays
  // disabled until the game has told us who we are.
  function refreshLoginUi() {
    // v1.36.0: keep the in-game Settings tab's read-only identity fields in
    // sync with the same detection — independent of the popup, which the
    // player may never open if they only use the Settings tab.
    const tabId = document.getElementById("stlt-characterId");
    const tabName = document.getElementById("stlt-characterName");
    if (detectedCharacterId !== null) {
      if (tabId && tabId.value !== String(detectedCharacterId)) tabId.value = detectedCharacterId;
      if (tabName && detectedCharacterName && tabName.value !== detectedCharacterName) {
        tabName.value = detectedCharacterName;
      }
    } else if (tabId) {
      tabId.value = "";
      if (tabName) tabName.value = "";
    }
    const panel = document.getElementById("stl-panel");
    if (!panel) return;
    const detected = panel.querySelector("#stl-login-detected");
    const btn = panel.querySelector("#stl-login-confirm");
    if (!detected || !btn) return;
    if (detectedCharacterId !== null) {
      const name = detectedCharacterName || "unknown character";
      detected.textContent = `Detected in game: ${name} (${detectedCharacterId})`;
      btn.disabled = false;
      // Keep the read-only character fields in sync too — init data often
      // arrives after the panel was built, and the whole point is for these
      // to track the character actually logged in right now.
      const idInput = panel.querySelector("#stl-characterId");
      const nameInput = panel.querySelector("#stl-characterName");
      if (idInput && idInput.value !== String(detectedCharacterId)) {
        idInput.value = detectedCharacterId;
      }
      if (nameInput && detectedCharacterName && nameInput.value !== detectedCharacterName) {
        nameInput.value = detectedCharacterName;
      }
    } else {
      detected.textContent = "Not detected yet — the game must be logged in first.";
      btn.disabled = true;
    }
  }

  // v1.28.0: "Reset to default" — wipe everything the app wrote to GM
  // storage (config, UI positions, detection cache, auto-sync cooldown,
  // and every saved level) so the install behaves exactly like a fresh
  // one. In-memory game detection is left alone: the game re-reports the
  // logged-in character on every init message, so the session keeps
  // working. Returns the number of stored keys cleared.
  function resetToDefaults() {
    const baseKeys = [
      "apiBase", "characterId", "characterName",
      "hideUpdateFab", "fabLocked", "fabPosition", "panelLocked",
      "panelPosition", "overlayPosition", "overlayPillPosition",
      "allowPushOutsideGuild", "autoSyncEnabled",
      "detectedCharacterId", "detectedCharacterName",
      "autoSyncLastAt", "autoSyncLastCharId",
      "stlDismissedUpdateVersion"
    ];
    // DELETE the keys — that is what "fresh install" means (no stored value
    // at all, so GM_getValue returns its default). Storing null instead is
    // NOT equivalent: some backends hand the null back (or the string
    // "null"), which would shadow DEFAULTS.apiBase and show up as the
    // literal text "null" in the panel.
    baseKeys.forEach((key) => clearStoredValue(key));
    SKILLS.forEach((skill) => clearStoredValue(`level_${skill.id}`));
    // Also drop the in-memory auto-sync cooldown so the next game
    // (re)open re-arms the push like a fresh install would.
    autoSyncLastAt = 0;
    autoSyncLastCharId = null;
    // ...and the in-memory update-reminder state.
    updateLatest = null;
    updateFetchInFlight = false;
    // A dragged FAB carries inline left/top (and right/bottom: auto) that
    // outlive the cleared fabPosition — applyFabPosition() only *sets* a
    // stored position, it never clears existing inline styles, so the button
    // would stay where it was dragged until a refresh. Snap it back to its
    // default bottom-right CSS spot now.
    if (fab) {
      fab.style.left = "";
      fab.style.top = "";
      fab.style.right = "";
      fab.style.bottom = "";
      fab.style.transform = "";
    }
    rebuildOpenPanel();
    return baseKeys.length + SKILLS.length;
  }

  // Rebuild the panel (if one exists) so it reflects the cleared state —
  // blank character fields, default checkboxes, no remembered position.
  // `panel` is module scope, so onFabClick keeps working with the fresh
  // element. A not-yet-built panel is nothing to rebuild. If the old panel
  // was open, the new one reopens (and re-applies the — now cleared —
  // position, i.e. the default spot).
  function rebuildOpenPanel() {
    const existing = document.getElementById("stl-panel");
    if (!existing) return;
    const wasOpen = existing.classList.contains("open");
    existing.remove();
    panel = buildPanel();
    if (wasOpen) {
      panel.classList.add("open");
      applyPanelPosition(panel);
    }
  }

  function buildPanel() {
    const cfg = cfgGet();

    // Prefill from the freshest known identity (game detection, last
    // session's detection, or the configured value — in that order), so
    // switching characters in-game never leaves a stale ID/name here.
    // v1.28.0: with no seed defaults, resolution can come back empty —
    // render those as blank inputs, not the string "null".
    const resolvedCharacter = resolveCharacter();
    const characterId =
      resolvedCharacter.characterId == null ? "" : resolvedCharacter.characterId;
    const characterName =
      resolvedCharacter.characterName == null ? "" : resolvedCharacter.characterName;

    const panel = document.createElement("div");
    panel.id = "stl-panel";
    // v1.36.0: the panel has two views — Main (login, levels, sync actions)
    // and Settings (Save, API base URL, read-only character ID/name,
    // auto-sync, fab lock, Reset) — switched via the nav under the title.
    // Each view replaces the other's content entirely (top-to-bottom:
    // title, nav, view content, shared status line).
    panel.innerHTML = `
      <h4>
        <span>MWI Trial Tracker</span>
        <button id="stl-panel-close" type="button" title="Close Trial Tracker popup" aria-label="Close Trial Tracker popup">&times;</button>
      </h4>
      <nav id="stl-nav" aria-label="Trial Tracker views">
        <button id="stl-view-main" type="button" title="Show the main Trial Tracker view">Tracker</button>
        <button id="stl-view-settings" type="button" title="Show the Trial Tracker settings">&#9881; Settings</button>
      </nav>
      <div id="stl-view-main-content">
        <div id="stl-update-banner" hidden>
          <span class="stl-update-msg"></span>
          <button class="stl-update-dismiss" type="button"
            title="Hide this reminder until the next version">Dismiss</button>
        </div>
        <div id="stl-login">
          <label>Log in to the ledger site (MWI)</label>
          <div id="stl-login-detected"></div>
          <input id="stl-login-code" type="text" maxlength="8" placeholder="CODE FROM SITE"
                 autocomplete="off" spellcheck="false" style="text-transform: uppercase; letter-spacing: 0.18em;" />
          <div id="stl-login-actions">
            <button id="stl-login-confirm" type="button">Confirm login</button>
          </div>
          <div id="stl-login-status"></div>
        </div>
        <label>Levels</label>
        <div id="stl-skills"></div>
        <div id="stl-actions">
          <button id="stl-send" type="button">Sync Character</button>
          <button id="stl-roster" type="button" title="Pull / push the guild roster (cull lives on the website, admin only)">\uD83D\uDC65 Guild Roster</button>
        </div>
        <!-- v1.36.0: always-visible dropdown holding the per-skill results
             of "Sync Character" (rendered by renderSyncResults) so the
             status line stays one line and the panel never jumps. -->
        <details id="stl-sync-details">
          <summary id="stl-sync-summary">Sync results</summary>
          <div id="stl-sync-results"></div>
        </details>
      </div>
      <div id="stl-view-settings-content" hidden>
        <div id="stl-actions">
          <button id="stl-save" type="button">Save settings</button>
        </div>
        <label>API base URL</label>
        <input id="stl-apiBase" type="text" value="${cfg.apiBase}" />
        <!-- v1.36.0: character identity is auto-detected from the game and
             can no longer be typed in — shown read-only for reference. -->
        <label>Character ID</label>
        <input id="stl-characterId" type="number" value="${characterId}" readonly />
        <label>Character name</label>
        <input id="stl-characterName" type="text" value="${characterName}" readonly />
        <label class="stl-check" title="Automatically push this character's levels and profile to the ledger when the game opens and every 30 minutes (a 30-minute cooldown prevents reload spam)">
          <input id="stl-autosync" type="checkbox" ${cfg.autoSyncEnabled ? "checked" : ""} />
          Auto-sync this character (on open + every 30 min)
        </label>
        <div id="stl-autosync-status"></div>
        <label>Trial Tracker button</label>
        <!-- v1.36.0: show/hide the floating button — the same setting the
             Tampermonkey menu command "hide/show Trial Tracker button" uses,
             so it can also be toggled from here. -->
        <label class="stl-check" title="Show or hide the floating Trial Tracker button (same setting as the Tampermonkey menu's 'hide/show Trial Tracker button').">
          <input id="stl-settings-show-fab" type="checkbox" checked />
          Show the Trial Tracker button
        </label>
        <label class="stl-check" title="Lock the Trial Tracker button in place. While unlocked you can drag it around; locking remembers its position.">
          <input id="stl-settings-fab-lock" type="checkbox" />
          Lock button position
        </label>
        <label class="stl-check" title="Lock the panel in place. While unlocked you can drag it by its title bar; locking remembers its position.">
          <input id="stl-settings-panel-lock" type="checkbox" />
          Lock panel position
        </label>
        <div id="stl-actions">
          <button id="stl-reset" type="button" title="Clears everything this app stored in this browser (settings, positions, saved levels, auto-sync state) and starts from a fresh-install state">Reset to default</button>
        </div>
      </div>
      <div id="stl-status"></div>
    `;
    document.body.appendChild(panel);
    const panelHeader = panel.querySelector("h4");
    panel.querySelector("#stl-panel-close").addEventListener("click", (event) => {
      event.stopPropagation();
      panel.classList.remove("open");
    });
    let panelDrag = null;
    panelHeader.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("#stl-panel-close")) return;
      if (cfgGet().panelLocked !== false) return; // locked: ignore title drags
      const rect = panel.getBoundingClientRect();
      panelDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        left: rect.left,
        top: rect.top
      };
      panelHeader.setPointerCapture(event.pointerId);
    });
    panelHeader.addEventListener("pointermove", (event) => {
      if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, event.clientX - panelDrag.offsetX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - panelDrag.offsetY), maxTop);
      panelDrag.left = left;
      panelDrag.top = top;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.transform = "none";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    const finishPanelDrag = (event) => {
      if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
      if (panelHeader.hasPointerCapture(event.pointerId)) panelHeader.releasePointerCapture(event.pointerId);
      cfgSet({ panelPosition: { left: panelDrag.left, top: panelDrag.top } });
      panelDrag = null;
    };
    panelHeader.addEventListener("pointerup", finishPanelDrag);
    panelHeader.addEventListener("pointercancel", finishPanelDrag);

    const skillsContainer = panel.querySelector("#stl-skills");
    // Levels are read-only displays of the auto-detected values (they come
    // from the game's WebSocket traffic — `detectedLevels` — with any
    // previously saved value as a fallback). Manual editing was removed:
    // levels are always synced from detection, never hand-typed.
    SKILLS.forEach((skill) => {
      const row = document.createElement("div");
      row.id = "stl-skill-row";
      const savedLevel = stlGetValue(`level_${skill.id}`, "");
      const prefill = detectedLevels[skill.id] !== undefined ? detectedLevels[skill.id] : savedLevel;
      row.innerHTML = `
        <label for="stl-level-${skill.id}">${skill.icon} ${skill.label}</label>
        <input id="stl-level-${skill.id}" type="number" min="0" value="${prefill}" readonly />
      `;
      skillsContainer.appendChild(row);
    });

    function setStatus(text, kind) {
      const el = panel.querySelector("#stl-status");
      el.textContent = text;
      el.className = kind ? kind : "";
    }

    // v1.36.0: render a "Sync Character" results list into the always-
    // visible dropdown (#stl-sync-details) instead of the status line, so
    // the long per-skill dump can never make the panel suddenly grow.
    // Each line keeps its own coloring: "failed" lines read as errors,
    // and a list with no failures tints whole. The dropdown is never
    // auto-opened and no summary is written to the status line — the
    // user expands it when they want to check. `state` (v1.36.0) lets the
    // run's intermediate notices ("Checking guild…", "Sending…") show in
    // the dropdown's own label instead of the separate status line, so a
    // sync never touches #stl-status until a real failure lands there.
    //   "checking" / "sending" → in-progress label, neutral color
    //   "done"   → "Sync results — all ok" / "— some failed"
    //   null     → plain "Sync results" (empty placeholder / cleared list)
    function renderSyncResults(lines, anyFail, state) {
      const details = panel.querySelector("#stl-sync-details");
      if (!details) return; // panel rebuilt mid-run (reset): nothing to paint
      const summary = panel.querySelector("#stl-sync-summary");
      const box = panel.querySelector("#stl-sync-results");
      if (!box) return;
      box.textContent = "";
      if (!lines.length) {
        const empty = document.createElement("div");
        empty.className = "stl-sync-empty";
        empty.textContent = "No sync results yet — press Sync Character.";
        box.appendChild(empty);
      } else {
        for (const line of lines) {
          const row = document.createElement("div");
          const err = line.includes("failed") || line.includes("blocked");
          const ok = lines.length === 1 && !err;
          if (err) row.className = "err";
          else if (ok) row.className = "ok";
          row.textContent = line;
          box.appendChild(row);
        }
      }
      if (summary) {
        let label;
        if (state === "checking") label = "Checking guild\u2026";
        else if (state === "sending") label = "Sending\u2026";
        else if (state === "done")
          label = anyFail
            ? "Sync results — some failed"
            : "Sync results — all ok";
        else label = "Sync results"; // null: empty placeholder / cleared list
        summary.textContent = label;
        summary.className = state === "done"
          ? (anyFail ? "err" : "ok")
          : "";
      }
      // Never auto-open: the dropdown stays collapsed unless the user
      // expands it, so a sync can't change the panel's footprint.
    }

    // ---- Ledger site login (MWI one-time code) ----
    const loginCode = panel.querySelector("#stl-login-code");
    const loginBtn = panel.querySelector("#stl-login-confirm");
    const loginStatus = panel.querySelector("#stl-login-status");
    function setLoginStatus(text, kind) {
      loginStatus.textContent = text;
      loginStatus.className = kind ? kind : "";
    }
    loginBtn.addEventListener("click", async () => {
      const apiBase = panel.querySelector("#stl-apiBase").value.trim().replace(/\/$/, "");
      if (!apiBase) {
        setLoginStatus("Set the API base URL in the Settings view first.", "err");
        return;
      }
      const code = loginCode.value.trim().toUpperCase();
      if (!/^[A-HJ-KM-NP-Z2-9]{8}$/.test(code)) {
        setLoginStatus("Enter the 8-character code shown on the site.", "err");
        return;
      }
      // Confirm as the character the game says we are — that's the whole
      // point of the login. Falls back to the configured id/name only if
      // detection never happened (button is disabled in that case anyway).
      const characterId = detectedCharacterId;
      const characterName = detectedCharacterName || cfgGet().characterName;
      loginBtn.disabled = true;
      setLoginStatus("Confirming…");
      try {
        const res = await gmRequest("POST", `${apiBase}/api/mwi-login/confirm`, {
          code,
          characterId,
          characterName
        });
        if (res.status === 200) {
          let name = characterName;
          try { name = JSON.parse(res.responseText).characterName || name; } catch (e) {}
          setLoginStatus(
            `Logged in as ${name}. The site is editable only for site admins; otherwise it stays read-only.`,
            "ok"
          );
          loginCode.value = "";
        } else {
          let msg;
          try { msg = JSON.parse(res.responseText).error; } catch (e) { msg = res.responseText; }
          setLoginStatus(msg || `Confirm failed (${res.status}).`, "err");
        }
      } catch (err) {
        setLoginStatus(`Confirm failed — ${err.message || err}`, "err");
      } finally {
        loginBtn.disabled = detectedCharacterId === null;
      }
    });
    refreshLoginUi();

    // v1.37.0: "update available" reminder — Dismiss remembers THIS specific
    // version (a newer one will re-arm the banner) and hides the UI.
    const updateDismiss = panel.querySelector(".stl-update-dismiss");
    if (updateDismiss) {
      updateDismiss.addEventListener("click", () => {
        if (updateLatest != null) stlSetValue("stlDismissedUpdateVersion", updateLatest);
        renderUpdateReminder();
      });
    }
    renderUpdateReminder();

    // v1.36.0: the character ID/name fields are read-only (auto-detected
    // from the game), so saving here only persists the API base URL.
    panel.querySelector("#stl-save").addEventListener("click", () => {
      const apiBase = panel.querySelector("#stl-apiBase").value.trim().replace(/\/$/, "");
      cfgSet({ apiBase });
      setStatus("Settings saved.", "ok");
    });

    // v1.26.0: per-player auto-sync opt-out (ON by default). Persist the
    // preference immediately; the engine reads it fresh on every trigger.
    panel.querySelector("#stl-autosync").addEventListener("change", (event) => {
      cfgSet({ autoSyncEnabled: event.target.checked });
      if (event.target.checked) maybeAutoSync(); // re-arm now if it was due
      const t = document.getElementById("stlt-autosync"); // keep the tab in sync
      if (t) t.checked = event.target.checked;
    });

    // v1.28.0: wipe all app storage → fresh-install state (see
    // resetToDefaults). Confirm first — this is the nuclear option.
    panel.querySelector("#stl-reset").addEventListener("click", () => {
      if (!window.confirm(
        "Reset to default?\n\nThis clears everything the Trial Tracker stored in this browser (API base, character ID/name, button/panel positions, saved levels, auto-sync state) — like a fresh install. Your ledger data on the website is NOT touched."
      )) return;
      const count = resetToDefaults();
      setStatus(`Reset to default \u2014 cleared ${count} stored values. Fresh-install state.`, "ok");
    });

    // v1.36.0: Main/Settings view switcher. The two content divs replace
    // each other entirely (title + nav + status stay put); the active view
    // is remembered for the panel's lifetime and defaults to Main.
    const viewMainContent = panel.querySelector("#stl-view-main-content");
    const viewSettingsContent = panel.querySelector("#stl-view-settings-content");
    const viewMainBtn = panel.querySelector("#stl-view-main");
    const viewSettingsBtn = panel.querySelector("#stl-view-settings");
    const showFabToggle = panel.querySelector("#stl-settings-show-fab");
    const fabLockToggle = panel.querySelector("#stl-settings-fab-lock");
    const panelLockToggle = panel.querySelector("#stl-settings-panel-lock");
    let activeView = "main";

    function syncSettingsUi() {
      // hideUpdateFab defaults to false → button shown (checkbox = "show").
      showFabToggle.checked = cfgGet().hideUpdateFab !== true; // default: shown
      fabLockToggle.checked = cfgGet().fabLocked !== false; // default: locked
      panelLockToggle.checked = cfgGet().panelLocked !== false; // default: locked
      // The read-only identity fields live in this view — refresh them from
      // the freshest known resolution (live detection first) on entry.
      const resolved = resolveCharacter();
      const idInput = panel.querySelector("#stl-characterId");
      const nameInput = panel.querySelector("#stl-characterName");
      if (idInput) idInput.value = resolved.characterId == null ? "" : resolved.characterId;
      if (nameInput) nameInput.value = resolved.characterName == null ? "" : resolved.characterName;
    }
    function showView(view) {
      activeView = view;
      viewMainContent.hidden = view !== "main";
      viewSettingsContent.hidden = view !== "settings";
      viewMainBtn.classList.toggle("active", view === "main");
      viewSettingsBtn.classList.toggle("active", view === "settings");
    }
    viewMainBtn.addEventListener("click", () => showView("main"));
    viewSettingsBtn.addEventListener("click", () => {
      showView("settings");
      syncSettingsUi(); // refresh the settings rows on entry
      if (stlTabRefresh) stlTabRefresh(); // keep the in-game Settings tab in sync
    });
    showView("main");

    // v1.36.0: pin the panel's height to the Main (Tracker) view's natural
    // size so the Settings tab is exactly the same size — switching tabs
    // never resizes the panel. The panel is height:auto (CSS), so dropping
    // the inline height measures the auto-sized (Main) value, which we then
    // re-apply inline so it holds for the Settings view too. Re-measured
    // whenever the Main view's content changes (e.g. the login block
    // appearing/hiding) via a ResizeObserver on the Main view's content —
    // that's what actually changes size, since the panel's own rendered
    // height stays pinned.
    let pinningHeight = false;
    const pinPanelToMainHeight = () => {
      // Re-entrancy guard, and — crucially — only measure while the Main
      // view is actually on display. With Main hidden, the panel's auto
      // height would be the Settings view's size, so a re-measure there
      // would wrongly shrink the pin (this is what caused the panel to
      // collapse when switching tabs). Returning to Main unhides the
      // content, which fires the observer again and re-pins correctly.
      if (pinningHeight || viewMainContent.hidden) return;
      pinningHeight = true;
      try {
        panel.style.height = ""; // drop any pin → read the auto (Main) size
        const mainHeight = panel.offsetHeight;
        if (mainHeight > 0) panel.style.height = `${mainHeight}px`;
      } finally {
        pinningHeight = false;
      }
    };
    pinPanelToMainHeight();
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(pinPanelToMainHeight).observe(viewMainContent);
    }

    // v1.36.0: show/hide the floating button — the same setting the
    // Tampermonkey menu command toggles, so it can now be changed here too.
    // Hiding removes the FAB; showing re-adds it (if the panel is open the
    // FAB still exists, so only the hidden→shown transition needs ensureFab).
    showFabToggle.addEventListener("change", (event) => {
      const show = event.target.checked;
      cfgSet({ hideUpdateFab: !show });
      if (show) {
        if (document.body) ensureFab();
        setStatus("Trial Tracker button shown.", "ok");
      } else {
        removeFab();
        setStatus(
          "Trial Tracker button hidden. It stays hidden on reload until you show it again.",
          "ok"
        );
      }
      syncSettingsUi();
    });

    fabLockToggle.addEventListener("change", (event) => {
      const willLock = event.target.checked;
      cfgSet({ fabLocked: willLock });
      if (willLock) {
        // Keep the saved position (if any) and re-apply it: locking
        // re-pins the button where it currently is rather than resetting.
        applyFabPosition();
        setStatus(
          cfgGet().fabPosition
            ? "Trial Tracker button locked in place at its current position."
            : "Trial Tracker button locked in place (bottom-right).",
          "ok"
        );
      } else {
        setStatus("Trial Tracker button unlocked — drag it anywhere you like.", "ok");
      }
      syncSettingsUi();
    });

    // Lock/unlock the panel's title-bar drag. Like the FAB lock, unlocking
    // leaves the panel where it is; re-locking re-pins it there (the saved
    // panelPosition is what applyPanelPosition restores on open/rebuild).
    panelLockToggle.addEventListener("change", (event) => {
      const willLock = event.target.checked;
      cfgSet({ panelLocked: willLock });
      if (willLock) {
        setStatus(
          cfgGet().panelPosition
            ? "Panel locked in place at its current position."
            : "Panel locked in place (bottom-right).",
          "ok"
        );
      } else {
        setStatus("Panel unlocked — drag it by its title bar.", "ok");
      }
      syncSettingsUi();
    });

    syncSettingsUi();

    panel.querySelector("#stl-roster").addEventListener("click", () => {
      // Persist the API base first so the overlay uses it; the character
      // identity is auto-detected and resolved by the overlay itself.
      const apiBase = panel.querySelector("#stl-apiBase").value.trim().replace(/\/$/, "");
      if (apiBase) cfgSet({ apiBase });
      openOverlay();
    });

    panel.querySelector("#stl-send").addEventListener("click", async () => {
      const apiBase = panel.querySelector("#stl-apiBase").value.trim().replace(/\/$/, "");
      const characterId = parseInt(panel.querySelector("#stl-characterId").value, 10);
      const characterName = panel.querySelector("#stl-characterName").value.trim();
      cfgSet({ apiBase, characterId, characterName });

      if (!apiBase || Number.isNaN(characterId) || !characterName) {
        setStatus("Fill in API base, character ID, and name first.", "err");
        return;
      }

      // v1.27.0: honor "push regardless of guild" (async — reads the
      // ledger's live-guild snapshot). Blocks only on a definitive
      // "not in the guild" answer; an unknown roster (no snapshot yet /
      // ledger down) still syncs. v1.36.0: the intermediate notices
      // ("Checking guild…", "Sending…") show in the dropdown's own label
      // — the status line is only used for a hard failure (e.g. the
      // guild gate).
      renderSyncResults([], null, "checking"); // also clears any stale list
      const gate = await ownSyncGate(apiBase, characterId, characterName);
      if (gate) {
        setStatus(gate, "err");
        return;
      }

      renderSyncResults([], null, "sending");
      const results = [];
      for (const skill of SKILLS) {
        const input = panel.querySelector(`#stl-level-${skill.id}`);
        const level = parseInt(input.value, 10);
        if (Number.isNaN(level)) {
          results.push(`${skill.label}: skipped (no level)`);
          continue;
        }
        stlSetValue(`level_${skill.id}`, level);
        try {
          const result = await upsertSkill(apiBase, skill.id, characterId, characterName, level);
          results.push(`${skill.label}: ${result.ok ? "updated" : "failed \u2014 " + result.error}`);
        } catch (err) {
          results.push(`${skill.label}: failed \u2014 ${err.message || err}`);
        }
      }
      // Also push our own full profile (loadouts, buff maps, lab shop, per-skill
      // loadout selection) so a single "Send to Ledger" click syncs both levels
      // and gear.
      try {
        results.push(await pushOwnProfile(apiBase, characterId, characterName));
      } catch (err) {
        results.push(`Loadouts: failed \u2014 ${err.message || err}`);
      }
      // Also push this week's combat trials (best-effort, one-shot) so a
      // single "Sync Character" click also names the Combat Dashboard teams
      // after the monsters. `pushCombatTrials` returns null when nothing is
      // captured yet / already sent this session, so it adds no status line.
      try {
        const ctMsg = await pushCombatTrials(apiBase);
        if (ctMsg) results.push(ctMsg);
      } catch (err) {
        results.push(`Combat trials: failed \u2014 ${err.message || err}`);
      }
      // …and this week's skilling-trial skills so the Skilling Dashboard
      // auto-selects this week's 4 trial skills (same best-effort, one-shot).
      try {
        const stMsg = await pushSkillingTrials(apiBase);
        if (stMsg) results.push(stMsg);
      } catch (err) {
        results.push(`Skilling trials: failed \u2014 ${err.message || err}`);
      }
      const anyFail = results.some((r) => r.includes("failed"));
      // v1.36.0: the full per-skill list goes into the always-visible
      // dropdown so it can never grow the panel. No status-line summary:
      // the dropdown's label ("some failed" / "all ok") carries the
      // outcome, and the one-line status is cleared again so the panel's
      // footprint never changes from a sync.
      renderSyncResults(results, anyFail, "done");
      setStatus("");

      // Re-apply the plan-based highlight right away instead of waiting
      // for the next sweep.
      applyTrialHighlight();
    });

    return panel;
  }

  // The bottom-right "Trial Tracker" button is optional: the Tampermonkey
  // menu (dropdown) can hide it, and the hidden state persists across page
  // loads. Kept at module scope so the menu command below can toggle it.
  let fab = null;
  let onFabClick = null;
  let suppressFabClick = false;
  let fabDrag = null;
  // v1.28.0: the panel lives at module scope (was a local in init()) so
  // resetToDefaults() can rebuild it — the onFabClick closure reads this
  // variable, so swapping `panel` swaps what the FAB opens.
  let panel = null;

  function applyFabPosition() {
    if (!fab) return;
    const position = cfgGet().fabPosition;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const maxLeft = Math.max(0, window.innerWidth - fab.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - fab.offsetHeight);
    const left = Math.min(Math.max(0, position.left), maxLeft);
    const top = Math.min(Math.max(0, position.top), maxTop);
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
    fab.style.right = "auto";
    fab.style.bottom = "auto";
  }

  function applyPanelPosition(panel) {
    const position = cfgGet().panelPosition;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    const left = Math.min(Math.max(0, position.left), maxLeft);
    const top = Math.min(Math.max(0, position.top), maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.transform = "none";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function applyOverlayPosition(panel) {
    if (!panel) return;
    const position = cfgGet().overlayPosition;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
    const left = Math.min(Math.max(0, position.left), maxLeft);
    const top = Math.min(Math.max(0, position.top), maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.transform = "none";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function applyOverlayPillPosition(pill) {
    const position = cfgGet().overlayPillPosition;
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const maxLeft = Math.max(0, window.innerWidth - pill.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - pill.offsetHeight);
    const left = Math.min(Math.max(0, position.left), maxLeft);
    const top = Math.min(Math.max(0, position.top), maxTop);
    pill.style.left = `${left}px`;
    pill.style.top = `${top}px`;
    pill.style.right = "auto";
    pill.style.bottom = "auto";
  }

  function finishFabDrag(event) {
    if (!fabDrag || event.pointerId !== fabDrag.pointerId) return;
    if (fab.hasPointerCapture(event.pointerId)) fab.releasePointerCapture(event.pointerId);
    if (fabDrag.moved) {
      cfgSet({ fabPosition: { left: fabDrag.left, top: fabDrag.top } });
      suppressFabClick = true;
    }
    fabDrag = null;
  }

  function ensureFab() {
    if (fab) return fab;
    fab = document.createElement("button");
    fab.id = "stl-fab";
    fab.type = "button";
    fab.textContent = "\uD83D\uDCCA Trial Tracker";
    fab.title = "Click to open the ledger updater";
    fab.addEventListener("click", onFabClick);
    fab.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (cfgGet().fabLocked !== false) return; // locked: ignore drags
      const rect = fab.getBoundingClientRect();
      fabDrag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener("pointermove", (event) => {
      if (!fabDrag || event.pointerId !== fabDrag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - fab.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - fab.offsetHeight);
      const left = Math.min(Math.max(0, event.clientX - fabDrag.offsetX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - fabDrag.offsetY), maxTop);
      if (Math.abs(left - fabDrag.left) > 2 || Math.abs(top - fabDrag.top) > 2) fabDrag.moved = true;
      fabDrag.left = left;
      fabDrag.top = top;
      fab.style.left = `${left}px`;
      fab.style.top = `${top}px`;
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    });
    fab.addEventListener("pointerup", finishFabDrag);
    fab.addEventListener("pointercancel", finishFabDrag);
    fab.addEventListener("click", (event) => {
      if (!suppressFabClick) return;
      suppressFabClick = false;
      event.stopImmediatePropagation();
    }, true);
    // v1.37.0: "update available" dot — #stl-fab is position:fixed, so this
    // absolutely-positioned child anchors to the button's corner.
    const dot = document.createElement("span");
    dot.id = "stl-fab-update-dot";
    dot.textContent = "Update available";
    dot.hidden = true;
    fab.appendChild(dot);
    document.body.appendChild(fab);
    applyFabPosition();
    return fab;
  }

  function removeFab() {
    if (!fab) return;
    fab.remove();
    fab = null;
  }

  // ---------------------------------------------------------------------
  // v1.36.0 — In-game Settings-page "Trial Tracker" tab.
  //
  // The game renders its Settings page with a MUI `Tabs` component: a
  // horizontal tab bar (`.TabsComponent_tabsContainer` → `.MuiTabs-
  // flexContainer`) and a sibling panels container (`.TabsComponent_
  // tabPanelsContainer`). There is ONE panels container; each built-in tab's
  // panel is a wrapper inside it that the game shows/hides by toggling a
  // CSS-module class on the wrapper — its name is hashed per deploy (e.g.
  // `TabPanel_hidden__XXXX`), so we must NOT match that class string by name.
  //
  // We append our own tab button to the flex container (at the END, so it
  // sits to the right of every built-in tab, e.g. Toolasha's) and our own
  // panel wrapper to the panels container. React re-renders replace its
  // *children* but never touch foreign nodes we've inserted, so the tab
  // persists across in-game re-renders (same trick Toolasha's tab uses).
  //
  // Activating our tab: hide every built-in panel wrapper (remembering its
  // pre-hidden state) and show ours. Deactivating (when the player clicks a
  // built-in tab, or the game switches tabs) restores the wrappers exactly.
  // State is derived from clicks, not by polling the game's selected index.
  //
  // Because the game is a SPA, the Settings page is mounted/unmounted as the
  // player navigates. A body-level MutationObserver watches for the tab bar
  // appearing (and disappearing) and (re)attaches our tab + panel. Each
  // injected node carries a `data-stl-settings-tab` marker so re-runs are
  // idempotent.
  //
  // For now the panel is a DUMMY placeholder — just enough to see how the
  // tab + content look. Real Trial Tracker content will go here later.
  // ---------------------------------------------------------------------
  const STL_SETTINGS_TAB_MARKER = "data-stl-settings-tab";
  let stlTabActive = false;
  let settingsTabWatcher = null;
  let settingsWiring = null; // { container, tabHost, panelsHost, tab }
  // v1.36.0: set to the tab's settings-refresh closure once the duplicate
  // controls are wired, so setStlTabActive can re-paint them on (re)activation.
  // Module scope (not settingsWiring) so a re-render re-assigning
  // settingsWiring can't drop the reference.
  let stlTabRefresh = null;
  // Maps each built-in panel wrapper to its inline `style.display` at the
  // moment we hid it, so deactivation can restore it exactly. (The game hides
  // panels with a CSS-module class whose name is hashed per deploy, so we can't
  // rely on toggling that class — inline display is deployment-proof.)
  const builtInDisplayStyle = new Map(); // wrapperEl -> saved inline display

  // The game's Settings page tab bar (present only while the page is open).
  function findSettingsTabContainer() {
    return document.querySelector('[class*="SettingsPanel_tabsComponentContainer"]');
  }

  function builtInPanels(panelsHost) {
    if (!panelsHost) return [];
    return Array.from(panelsHost.children).filter(
      (c) => !(c.getAttribute && c.getAttribute(STL_SETTINGS_TAB_MARKER))
    );
  }

  // The built-in MUI tab buttons in the tab bar. Our own foreign button has no
  // `role="tab"`, so it's excluded by the selector; the marker filter is just
  // belt-and-suspenders in case we ever tag it.
  function builtInTabButtons() {
    if (!settingsWiring || !settingsWiring.tabHost) return [];
    return Array.from(settingsWiring.tabHost.querySelectorAll('button[role="tab"]')).filter(
      (b) => !(b.getAttribute && b.getAttribute(STL_SETTINGS_TAB_MARKER))
    );
  }

  // The MUI underline indicator sitting under the active tab. MUI positions it
  // via an inline transform under the tab it (stale) thinks is selected, so we
  // hide it while our tab is active and restore it on deactivate.
  function findStlIndicator() {
    if (!settingsWiring || !settingsWiring.container) return null;
    return settingsWiring.container.querySelector('[class*="MuiTabs-indicator"]');
  }

  // Scrub the built-in tab buttons' MUI "selected" state (class + aria +
  // tabindex) and hide the underline indicator. MUI can't see our foreign tab,
  // so its React state is stale and it will NOT clear the previous tab's
  // highlight for us — we have to (this is exactly what Toolasha / krymoore's
  // injected-settings-tab code does). Also called from reassert so a re-render
  // that re-applies Mui-selected can't leave a stale highlight on our panel.
  function scrubBuiltInTabState() {
    builtInTabButtons().forEach((b) => {
      b.classList.remove("Mui-selected");
      b.setAttribute("aria-selected", "false");
      b.setAttribute("tabindex", "-1");
    });
    const ind = findStlIndicator();
    if (ind && ind.style.display !== "none") ind.style.display = "none";
  }

  // Restore the MUI indicator when we hand control back. We deliberately don't
  // re-add Mui-selected to a built-in button here: the clicked built-in tab's
  // own re-render (MUI onTabChange → the game's tabChangeHandler) re-selects it.
  function unscrubBuiltInTabState() {
    const ind = findStlIndicator();
    if (ind && ind.style.display === "none") ind.style.display = "";
  }

  // Set our tab + panel to the given active state. When activating, remember
  // each built-in panel's current hidden state so deactivation can restore it
  // exactly. (Our own panel is not a child of the built-in set.) On
  // deactivation, if the player clicked a specific built-in tab, `clickedBuiltIn`
  // is that button and we re-highlight it immediately (MUI's own re-render
  // confirms it).
  function setStlTabActive(active, force, clickedBuiltIn) {
    if (stlTabActive === active && !force) return;
    stlTabActive = active;
    const tab = document.getElementById("stl-settings-tab");
    if (tab) tab.classList.toggle("stl-active", active);
    // Our own panel is driven by inline display (robust across deploys).
    const ourPanel = document.getElementById("stl-settings-tab-panel");
    if (ourPanel) ourPanel.style.display = active ? "block" : "none";
    if (!settingsWiring || !settingsWiring.panelsHost) return;
    const builtins = builtInPanels(settingsWiring.panelsHost);
    if (active) {
      // De-select the built-in tabs MUI still thinks is active (its state is
      // stale — it can't see our foreign tab) and hide the underline, so only
      // our tab is highlighted. (Same trick Toolasha / krymoore use.)
      scrubBuiltInTabState();
      // Remember each built-in wrapper's current inline display so we can
      // restore it on deactivate; then hide the wrapper. (The game's own
      // hidden state is class-based, but the wrapper is still a flex column
      // child, so a hidden panel with no inline style would still take
      // layout space unless display:none — which is exactly why we use
      // inline display rather than re-adding the game's hashed class.)
      builtins.forEach((el) => {
        if (builtInDisplayStyle.has(el)) return; // already hidden by us
        builtInDisplayStyle.set(el, el.style.display);
        el.style.display = "none";
      });
      // Re-paint the duplicated controls from stored config + detection so
      // they're never stale when (re)activated (e.g. after another window or
      // the popup changed a setting).
      if (stlTabRefresh) stlTabRefresh();
    } else {
      // Hand control back: restore the underline indicator and the built-in
      // panels' own visibility.
      unscrubBuiltInTabState();
      builtins.forEach((el) => {
        if (!builtInDisplayStyle.has(el)) return;
        const saved = builtInDisplayStyle.get(el);
        el.style.display = saved === "" ? "" : saved;
        builtInDisplayStyle.delete(el);
      });
      // Highlight the built-in tab the player actually clicked, immediately
      // (MUI's re-render confirms/positions it; doing it here mirrors
      // Toolasha/krymoore's manual switchTo so there's no flash of the stale
      // selection).
      if (clickedBuiltIn && clickedBuiltIn.isConnected) {
        clickedBuiltIn.classList.add("Mui-selected");
        clickedBuiltIn.setAttribute("aria-selected", "true");
        clickedBuiltIn.setAttribute("tabindex", "0");
      }
    }
  }

  // Re-hide any built-in panel wrapper that is currently visible while our tab
  // is active. This handles a full re-render recreating built-in wrapper nodes
  // (which would otherwise lose the inline `display:none` we set and reappear
  // under our panel). Each wrapper's display is snapshotted only the FIRST
  // time we hide it, so the value saved for deactivation-restore is never
  // clobbered by repeated re-asserts.
  function reassertHiddenBuiltins() {
    if (!settingsWiring || !settingsWiring.panelsHost) return;
    // Prune wrappers a re-render detached (their saved entries are stale).
    for (const [node] of builtInDisplayStyle) {
      if (!node.isConnected) builtInDisplayStyle.delete(node);
    }
    builtInPanels(settingsWiring.panelsHost).forEach((el) => {
      if (!builtInDisplayStyle.has(el)) {
        builtInDisplayStyle.set(el, el.style.display);
        el.style.display = "none";
      } else if (el.style.display !== "none") {
        el.style.display = "none";
      }
    });
    // A re-render can also re-apply Mui-selected to the stale built-in tab —
    // re-scrub so only our tab is highlighted while we're active.
    scrubBuiltInTabState();
    const ourPanel = document.getElementById("stl-settings-tab-panel");
    if (ourPanel && ourPanel.style.display !== "block") {
      ourPanel.style.display = "block";
    }
  }

  // Build (and attach) the Trial Tracker tab button + dummy panel, and wire
  // the click handlers that drive the active state. Idempotent: existing
  // `data-stl-settings-tab` nodes are kept in place.
  function ensureSettingsTab(container) {
    if (!container) return false;
    const tabHost =
      container.querySelector('[class*="MuiTabs-flexContainer"]') || container;
    const panelsHost = container.querySelector('[class*="TabsComponent_tabPanelsContainer"]');
    if (!panelsHost) return false;

    let tab = document.getElementById("stl-settings-tab");
    if (!tab) {
      tab = document.createElement("button");
      tab.type = "button";
      tab.id = "stl-settings-tab";
      tab.setAttribute(STL_SETTINGS_TAB_MARKER, "1");
      tab.textContent = "Trial Tracker";
      tab.addEventListener("click", () => setStlTabActive(true));
      // Append to the END of the tab bar so it sits to the right of every
      // built-in tab (Profile, Game, Chat, …, and Toolasha's tab).
      tabHost.appendChild(tab);
    } else if (tab.parentElement !== tabHost) {
      // A re-render recreated the tab bar (our button survived elsewhere) —
      // move it back into the current tab bar so it's clickable + wired.
      tabHost.appendChild(tab);
    }

    let stlPanel = document.getElementById("stl-settings-tab-panel");
    if (!stlPanel) {
      stlPanel = document.createElement("div");
      stlPanel.id = "stl-settings-tab-panel";
      stlPanel.setAttribute(STL_SETTINGS_TAB_MARKER, "1");
      stlPanel.style.display = stlTabActive ? "block" : "none";
      // v1.36.0: a full duplicate of the popup's Settings-view controls
      // (API base URL, character ID/name, auto-sync, show button, fab lock,
      // panel lock, show tab, Save, Reset). Each control is wired to the SAME
      // stored config as the panel's copy, so editing it in either place keeps
      // both in sync (see syncSettingsUi + refreshTabSettingsUi). Inputs use
      // distinct #stlt- ids so they never collide with the panel's.
      stlPanel.innerHTML =
        '<div class="stl-tab-heading">MWI Trial Tracker</div>' +
        '<div class="stlt-save"><button id="stlt-save" type="button">Save settings</button></div>' +
        '<label>API base URL</label>' +
        '<input id="stlt-apiBase" type="text" />' +
        '<label>Character ID</label>' +
        '<input id="stlt-characterId" type="number" readonly />' +
        '<label>Character name</label>' +
        '<input id="stlt-characterName" type="text" readonly />' +
        '<label class="stl-check" title="Automatically push this character\'s levels and profile to the ledger when the game opens and every 30 minutes (a 30-minute cooldown prevents reload spam)">' +
        '<input id="stlt-autosync" type="checkbox" />' +
        'Auto-sync this character (on open + every 30 min)</label>' +
        '<div id="stlt-autosync-status"></div>' +
        '<label>Trial Tracker button</label>' +
        '<label class="stl-check" title="Show or hide the floating Trial Tracker button (same setting as the Tampermonkey menu\'s \'hide/show Trial Tracker button\').">' +
        '<input id="stlt-showfab" type="checkbox" />' +
        'Show the Trial Tracker button</label>' +
        '<label class="stl-check" title="Lock the Trial Tracker button in place. While unlocked you can drag it around; locking remembers its position.">' +
        '<input id="stlt-fablock" type="checkbox" />' +
        'Lock button position</label>' +
        '<label class="stl-check" title="Lock the panel in place. While unlocked you can drag it by its title bar; locking remembers its position.">' +
        '<input id="stlt-panellock" type="checkbox" />' +
        'Lock panel position</label>' +
        '<div class="stlt-save"><button id="stlt-reset" type="button" title="Clears everything this app stored in this browser (settings, positions, saved levels, auto-sync state) and starts from a fresh-install state">Reset to default</button></div>' +
        '<div id="stlt-status"></div>';
      panelsHost.appendChild(stlPanel);
    } else if (stlPanel.parentElement !== panelsHost) {
      panelsHost.appendChild(stlPanel);
    }

    // (Re)wire click handlers. Our tab click activates us; any OTHER tab
    // click deactivates us and hands control back to the built-in panels.
    tabHost.removeEventListener("click", onSettingsTabClick, true);
    settingsWiring = { container, tabHost, panelsHost, tab };
    tabHost.addEventListener("click", onSettingsTabClick, true);

    // ---- Wire the duplicated Settings controls (v1.36.0) ----
    // Each control writes the SAME stored config as the popup's copy, so the
    // popup (if it exists) and this tab stay in sync. Idempotent: we only
    // attach once per panel instance (survives re-renders that keep our nodes),
    // and re-apply the stored values on (re)attach.
    if (!stlPanel.__stlTabWired) {
      stlPanel.__stlTabWired = true;

      const tabStatusEl = stlPanel.querySelector("#stlt-status");
      const setTabStatus = (text, kind) => {
        if (!tabStatusEl) return;
        tabStatusEl.textContent = text;
        tabStatusEl.className = kind ? kind : "";
      };
      const tApi = stlPanel.querySelector("#stlt-apiBase");
      const tShowFab = stlPanel.querySelector("#stlt-showfab");
      const tFabLock = stlPanel.querySelector("#stlt-fablock");
      const tPanelLock = stlPanel.querySelector("#stlt-panellock");
      const tAuto = stlPanel.querySelector("#stlt-autosync");

      // Refresh the tab's settings inputs from stored config + detection.
      // Mirrors the popup's syncSettingsUi (auto-sync is left alone, since
      // the checkbox itself is its source of truth after first paint).
      const refreshTabSettingsUi = () => {
        const cfg = cfgGet();
        if (tApi) tApi.value = cfg.apiBase || "";
        tShowFab.checked = cfg.hideUpdateFab !== true; // default: shown
        tFabLock.checked = cfg.fabLocked !== false; // default: locked
        tPanelLock.checked = cfg.panelLocked !== false; // default: locked
        const resolved = resolveCharacter();
        const idInput = stlPanel.querySelector("#stlt-characterId");
        const nameInput = stlPanel.querySelector("#stlt-characterName");
        if (idInput) idInput.value = resolved.characterId == null ? "" : resolved.characterId;
        if (nameInput) nameInput.value = resolved.characterName == null ? "" : resolved.characterName;
      };

      stlPanel.querySelector("#stlt-save").addEventListener("click", () => {
        const apiBase = (tApi && tApi.value.trim().replace(/\/$/, "")) || "";
        cfgSet({ apiBase });
        setTabStatus("Settings saved.", "ok");
        // Keep the popup's Settings view in sync if it's currently open.
        const pApi = document.getElementById("stl-apiBase");
        if (pApi && pApi.value !== apiBase) pApi.value = apiBase;
      });

      tShowFab.addEventListener("change", (event) => {
        const show = event.target.checked;
        cfgSet({ hideUpdateFab: !show });
        if (show) {
          if (document.body) ensureFab();
          setTabStatus("Trial Tracker button shown.", "ok");
        } else {
          removeFab();
          setTabStatus("Trial Tracker button hidden. It stays hidden on reload until you show it again.", "ok");
        }
        const p = document.getElementById("stl-settings-show-fab");
        if (p) p.checked = show;
      });

      tFabLock.addEventListener("change", (event) => {
        const willLock = event.target.checked;
        cfgSet({ fabLocked: willLock });
        if (willLock) {
          applyFabPosition();
          setTabStatus(
            cfgGet().fabPosition
              ? "Trial Tracker button locked in place at its current position."
              : "Trial Tracker button locked in place (bottom-right).",
            "ok"
          );
        } else {
          setTabStatus("Trial Tracker button unlocked — drag it anywhere you like.", "ok");
        }
        const p = document.getElementById("stl-settings-fab-lock");
        if (p) p.checked = willLock;
      });

      tPanelLock.addEventListener("change", (event) => {
        const willLock = event.target.checked;
        cfgSet({ panelLocked: willLock });
        if (willLock) {
          setTabStatus(
            cfgGet().panelPosition
              ? "Panel locked in place at its current position."
              : "Panel locked in place (bottom-right).",
            "ok"
          );
        } else {
          setTabStatus("Panel unlocked — drag it by its title bar.", "ok");
        }
        const p = document.getElementById("stl-settings-panel-lock");
        if (p) p.checked = willLock;
      });

      tAuto.addEventListener("change", (event) => {
        cfgSet({ autoSyncEnabled: event.target.checked });
        if (event.target.checked) maybeAutoSync(); // re-arm now if it was due
        const p = document.getElementById("stl-autosync");
        if (p) p.checked = event.target.checked;
      });

      stlPanel.querySelector("#stlt-reset").addEventListener("click", () => {
        if (!window.confirm(
          "Reset to default?\n\nThis clears everything the Trial Tracker stored in this browser (API base, character ID/name, button/panel positions, saved levels, auto-sync state) — like a fresh install. Your ledger data on the website is NOT touched."
        )) return;
        const count = resetToDefaults();
        const resolved = resolveCharacter();
        const idInput = stlPanel.querySelector("#stlt-characterId");
        const nameInput = stlPanel.querySelector("#stlt-characterName");
        if (idInput) idInput.value = resolved.characterId == null ? "" : resolved.characterId;
        if (nameInput) nameInput.value = resolved.characterName == null ? "" : resolved.characterName;
        setTabStatus(`Reset to default \u2014 cleared ${count} stored values. Fresh-install state.`, "ok");
      });

      // Paint the stored values into the (freshly built) tab inputs.
      const cfg = cfgGet();
      if (tApi) tApi.value = cfg.apiBase || "";
      tShowFab.checked = cfg.hideUpdateFab !== true;
      tFabLock.checked = cfg.fabLocked !== false;
      tPanelLock.checked = cfg.panelLocked !== false;
      tAuto.checked = cfg.autoSyncEnabled !== false; // default: on
      const tResolved = resolveCharacter();
      const tId = stlPanel.querySelector("#stlt-characterId");
      const tName = stlPanel.querySelector("#stlt-characterName");
      if (tId) tId.value = tResolved.characterId == null ? "" : tResolved.characterId;
      if (tName) tName.value = tResolved.characterName == null ? "" : tResolved.characterName;

      // Expose the tab's re-paint so the popup's view-switch can refresh it
      // (keeps the two duplicates in sync regardless of which is edited).
      stlTabRefresh = refreshTabSettingsUi;
    }

    if (stlTabActive) {
      // A re-render can recreate some built-in wrapper nodes (dropping the
      // inline display we set). Re-hide them and re-show our panel without
      // touching the saved restore-state from the original activation.
      reassertHiddenBuiltins();
    }
    return true;
  }

  // Click handler on the whole tab bar (capture phase): our tab → activate;
  // a built-in tab → deactivate and re-highlight it.
  function onSettingsTabClick(event) {
    const tab = document.getElementById("stl-settings-tab");
    if (tab && tab.contains(event.target)) {
      setStlTabActive(true);
    } else {
      // Identify the built-in tab the player clicked so we can re-highlight it.
      const btn = event.target && event.target.closest ? event.target.closest('button[role="tab"]') : null;
      const builtIn =
        btn &&
        !btn.hasAttribute(STL_SETTINGS_TAB_MARKER) &&
        btn !== document.getElementById("stl-settings-tab");
      setStlTabActive(false, false, builtIn || null);
    }
  }

  function dropSettingsTab() {
    if (settingsWiring && settingsWiring.tabHost) {
      settingsWiring.tabHost.removeEventListener("click", onSettingsTabClick, true);
    }
    // The whole Settings page is unmounted, so the built-in wrappers we may
    // have hidden are gone with it — no need to restore them individually.
    builtInDisplayStyle.clear();
    stlTabActive = false;
    settingsWiring = null;
  }

  // Watch the whole document for the Settings tab bar so the tab survives the
  // game's SPA navigation (open / close / re-render of the Settings page).
  function startSettingsTabWatcher() {
    if (settingsTabWatcher || typeof MutationObserver !== "function" || !document.body) return;
    settingsTabWatcher = new MutationObserver(() => {
      if (!findSettingsTabContainer()) {
        // The Settings page left the DOM — release our wiring so a later
        // re-open starts clean. (Injected nodes are gone with the page.)
        dropSettingsTab();
        return;
      }
      // The in-game Settings tab is always on — there is no setting to turn
      // it off, so a user can never lock themselves out of the controls.
      // Steady state: both our tab AND our panel are attached. A re-render
      // may have just re-created the built-in panel wrappers (as visible)
      // underneath an active tab — re-hide them so they don't stack under
      // ours. (Also re-asserts our panel's display if a re-render reset it.)
      if (
        document.getElementById("stl-settings-tab") &&
        document.getElementById("stl-settings-tab-panel")
      ) {
        if (stlTabActive) reassertHiddenBuiltins();
        return;
      }
      // Defer one tick so the game's own render has finished laying out the
      // tab bar before we append (keeps our tab at the end, stable).
      setTimeout(() => {
        const container = findSettingsTabContainer();
        if (container) ensureSettingsTab(container);
      }, 0);
    });
    settingsTabWatcher.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    // v1.28.0: `panel` is the module-level variable (see the declaration
    // near `fab`), so resetToDefaults() can replace the live panel.
    onFabClick = () => {
      if (!panel) panel = buildPanel();

      // Refresh the read-only level inputs with whatever's been
      // auto-detected since the panel was last built.
      if (!panel.classList.contains("open")) {
        readLevelsFromSidebar(); // fresh DOM pass to fill any gaps now
        SKILLS.forEach((skill) => {
          if (detectedLevels[skill.id] === undefined) return;
          const input = panel.querySelector(`#stl-level-${skill.id}`);
          if (input) input.value = detectedLevels[skill.id];
        });
      }
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        applyPanelPosition(panel);
        // Re-check on open so the banner reflects the latest version even
        // if the startup fetch failed (or predates a deploy).
        checkForUpdate(cfgGet().apiBase.replace(/\/$/, ""));
      }
    };
    if (!cfgGet().hideUpdateFab) ensureFab();

    // v1.37.0: fetch the ledger's latest version at startup. The banner is
    // idempotent, so this is safe even before the panel exists.
    checkForUpdate(cfgGet().apiBase.replace(/\/$/, ""));

    // v1.36.0: watch for the in-game Settings page so the "Trial Tracker"
    // tab attaches the moment the page mounts (and re-attaches after
    // re-renders / SPA navigation).
    startSettingsTabWatcher();

    // v1.26.0: tab re-opens / window re-focus are "game (re)open" moments —
    // auto-sync if due (cooldown dedupes the repeated events).
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) maybeAutoSync();
    });
    window.addEventListener("focus", () => maybeAutoSync());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // v1.36.0: only Tampermonkey menu command remaining — the API base URL,
  // auto-sync, fab lock, and reset all live in the in-panel Settings view,
  // and level editing / advanced fields were removed entirely.
  GM_registerMenuCommand("MWI Trial Tracker: hide/show Trial Tracker button", () => {
    const hide = !cfgGet().hideUpdateFab;
    cfgSet({ hideUpdateFab: hide });
    if (hide) {
      removeFab();
    } else if (document.body) {
      ensureFab();
    }
    window.alert(
      hide
        ? "Trial Tracker button hidden. It stays hidden on reload until you show it again from this menu."
        : "Trial Tracker button shown."
    );
  });
})();
