// ==UserScript==
// @name         MWI Trial Tracker
// @namespace    http://tampermonkey.net/
// @version      1.37.1
// @description  Tracks and optimizes trials  on milkywayidle.
// @author       MadCuzDev, Rhohydronian
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
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
  // v1.37.1: "Reset to default" backstop — delete EVERY key this script
  // could ever hold in the localStorage mirror, whatever it is. Every
  // persist goes through localSet (via stlSetValue), which always uses
  // LOCAL_STORAGE_PREFIX, so a prefix sweep stays complete without ever
  // touching a key list — and can never touch a key of the page or of
  // another script. Returns the number of keys removed.
  function clearLocalMirror() {
    const ls = pageLocalStorage();
    if (!ls) return 0;
    let removed = 0;
    try {
      // Snapshot the doomed keys first — removeItem invalidates the
      // length-based enumeration mid-loop otherwise.
      const doomed = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.indexOf(LOCAL_STORAGE_PREFIX) === 0) doomed.push(k);
      }
      doomed.forEach((k) => {
        try {
          ls.removeItem(k);
          removed++;
        } catch (e) {
          /* one bad key must not abort the sweep */
        }
      });
    } catch (e) {
      /* localStorage unavailable — the GM store still got cleared */
    }
    return removed;
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
  const SCRIPT_VERSION = "1.37.1";

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
      autoSyncEnabled: stlGetValue("autoSyncEnabled", true),
      // v1.37.0: the per-character master switch — the character IDs (a clean
      // numeric array) for which the tracker is fully OFF. The Android
      // bridge can hand the stored value back as a JSON string, so this is
      // always run through normalizeDisabledCharacterIds (see below).
      disabledCharacterIds: getDisabledCharacterIds()
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
    // v1.37.0: the per-character off list — always persisted as a clean
    // numeric array (normalize drops junk values and dedupes).
    if (partial.disabledCharacterIds !== undefined) {
      stlSetValue("disabledCharacterIds", normalizeDisabledCharacterIds(partial.disabledCharacterIds));
    }
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

  // Paint the read-only character ID/name fields of a settings surface
  // (popup: "stl-", in-game Settings tab: "stlt-") from the freshest known
  // resolution (live detection first). Both surfaces share this paint.
  function paintIdentityFields(surface, prefix) {
    const resolved = resolveCharacter();
    const idInput = surface.querySelector(`#${prefix}characterId`);
    const nameInput = surface.querySelector(`#${prefix}characterName`);
    if (idInput) idInput.value = resolved.characterId == null ? "" : resolved.characterId;
    if (nameInput) nameInput.value = resolved.characterName == null ? "" : resolved.characterName;
  }

  // ---------------------------------------------------------------------
  // v1.37.0 — Per-character master switch.
  //
  // The tracker can be switched OFF for individual characters (keyed by
  // character ID, as resolved above — live detection first). For any
  // character in the disabled list the tracker does NOTHING in the page:
  // no WebSocket level capture, no level/profile/trial pushes (manual,
  // auto-sync, or guild), no optimizer plan fetches, no trial highlight or
  // notice, no update banner, no floating button, no panel, no overlay,
  // no Tampermonkey-menu action.
  //
  // The in-game Settings → Trial Tracker tab is deliberately the ONE thing
  // that keeps working: it is the escape hatch that turns the tracker back
  // on for that character (applyTrackerState re-arms everything, no
  // reload).
  //
  // Identity capture still runs while disabled — the game's
  // init_character_data is how the script learns WHICH character is logged
  // in (and that an in-page character switch happened), which is exactly
  // what the switch keys on.
  //
  // Persistence rides the usual GM store + localStorage mirror, so the
  // switch survives Android app relaunches (where the raw GM copy is
  // wiped) like every other setting.
  // ---------------------------------------------------------------------
  // Normalize whatever storage returned (a real array in Tampermonkey, a
  // JSON string from the Android webview bridge) into a clean numeric ID
  // list: numbers only, positive, deduped, order preserved.
  function normalizeDisabledCharacterIds(raw) {
    let list = raw;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch (e) {
        return []; // unparseable — treat as empty rather than junk
      }
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
      const id = Number(entry);
      if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id);
    }
    return out;
  }
  function getDisabledCharacterIds() {
    return normalizeDisabledCharacterIds(stlGetValue("disabledCharacterIds", null));
  }
  // True when the numeric character ID `id` is in the off list. A null or
  // otherwise unresolved ID can never be off — the switch has nothing to
  // key on until the game identifies the character.
  function isCharacterDisabled(id) {
    return Number.isInteger(id) && id > 0 && getDisabledCharacterIds().includes(id);
  }
  // The switch state for the character this browser is acting as right now.
  function trackerDisabled() {
    return isCharacterDisabled(resolveCharacter().characterId);
  }
  // Add/remove `id` in the off list, persist it, and re-apply the tracker
  // state (the flip is what strips or re-arms everything in the page).
  // No-op when the list already reflects `disabled` for that ID.
  function setCharacterDisabled(id, disabled) {
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) return false;
    const ids = getDisabledCharacterIds();
    const at = ids.indexOf(idNum);
    if (disabled && at === -1) {
      ids.push(idNum);
      stlSetValue("disabledCharacterIds", ids);
    } else if (!disabled && at !== -1) {
      ids.splice(at, 1);
      stlSetValue("disabledCharacterIds", ids);
    }
    applyTrackerState();
    return true;
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

  // Where a newer build lives: this script's Greasy Fork page. The in-game
  // "update available" banner links to it.
  const GREASYFORK_PAGE =
    "https://greasyfork.org/en/scripts/596862-mwi-trial-tracker";

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
  // v1.37.x: quiet background-run tracking. While the roster panel is
  // tucked into its floating pill (manually — the buttons no longer
  // auto-tuck it), the pill mirrors progress for any running action;
  // `loadoutsAck` keeps the pill up with the burst's completion summary
  // until the user restores the panel.
  let overlayState = {
    minimized: false,
    loadouts: { running: false, done: 0, total: 0, captured: 0 },
    loadoutsAck: false
  };

  // ---------------------------------------------------------------------
  // Weekly trial snapshot capture (feeds the Trial History page).
  //
  // The game broadcasts, over the same WS we already hook, everything a
  // guild-wide weekly snapshot needs — zero manual steps for members:
  //   - guild_trial_stats_updated: guild-wide per-member-per-trial stat
  //     rows { characterId, trialHrid, damageDealt, healingDone,
  //     premitigatedDamageTaken, workDone } (combat rows carry
  //     damage/healing/damage-taken, skilling rows carry workDone). The
  //     game clears this list on a week rollover; a fresh answer is
  //     available on demand via { type: "get_guild_trial_stats" } (the
  //     same request the in-game Stats dialog sends), which this capture
  //     fires right before pushing so even a member who was offline
  //     during the trials records the server's current guild-wide list.
  //   - guild_trial_signup_updated (+ the guildCharacterMap entries of
  //     guild_characters_updated): per member, which trial and which
  //     LOADOUT they signed up with — signedUp{Skilling,Combat}
  //     TrialHrid / LoadoutID / RoleHrid fields, stamped with
  //     signupWeekStartAt so stale old-week updates can't leak in.
  //   - guild.currentWeekStartAt: anchor of the current guild week — the
  //     week starts at the Friday 00:00 UTC guild-trial reset (ISO-8601
  //     string in current builds; older ones sent an ms epoch); the
  //     snapshot week key is the UTC DATE of that anchor ("YYYY-MM-DD"),
  //     which the server accepts and which is stable for each game week.
  //   - guild.currentTrialsData: this week's {skilling,combat} trial
  //     statuses ("scheduled" | "in_progress" | "completed").
  //
  // Push targets (server upserts, so overlapping pushes are harmless —
  // a later one just refreshes the rows):
  //   1. rollover  — the instant a NEW week's guild message arrives, the
  //      just-ended week's captured buffer goes up under its OWN weekKey
  //      (the game clears its stat list in that same message, so this is
  //      the last chance for the old data);
  //   2. completed — once both of this week's trials report "completed",
  //      the final state lands within minutes of the last trial;
  //   3. manual    — the roster panel's "Push Trials" button: a direct
  //      guild-gated push from this in-game client, exactly like the
  //      guild roster's "Push Members" (any member of the guild can
  //      send it; the server enforces membership — the site's old
  //      "Snapshot now" request round-trip is gone).
  //
  // Before EVERY push (regardless of trigger), each entry's member is
  // verified against this client's current guild roster — the same
  // guildCharacterMap / guildSharableCharacterMap data the live-roster
  // push sends — so people who are no longer in the guild (left/kicked
  // mid-week, or a transient sign-up wave that the game briefly listed)
  // no longer show up on the History page. If the roster was never
  // captured on this client, verification is impossible and entries pass
  // through unfiltered (the push still goes out; see filterSnapshotToRoster).
  // ---------------------------------------------------------------------
  const SNAPSHOT_PUSH_COOLDOWN_MS = 3 * 60 * 1000; // rate-limits auto re-pushes
  const SNAPSHOT_STATS_REFRESH_MS = 2500; // wait for the get_guild_trial_stats answer
  // v1.37.1: trial-history (weekly snapshot) pushes are MANUAL-only for
  // now — the roster overlay's "Push Trials" button is the only trigger
  // that sends a week's snapshot to the ledger. The two automatic
  // triggers (the old-week flush on week rollover, and the completion /
  // re-login catch-up inside maybeCompletionSnapshot) stay implemented
  // but disabled, so History rows never appear unless a member explicitly
  // pushes. Flip to true to restore automatic snapshots.
  const SNAPSHOT_AUTO_PUSH = false;
  let trialsSnapshot = {
    weekStartAt: null, // guild.currentWeekStartAt of the week being captured
    weekKey: null, // UTC date ("YYYY-MM-DD") the game's week starts (Friday 00:00 UTC reset)
    statuses: { skilling: null, combat: null }, // parsed currentTrialsData
    statRows: [], // latest guild-wide guildTrialStatList for this week
    statListUpdatedAt: 0, // when statRows last changed (refresh detection)
    signups: {}, // charId -> { name, skilling/combat: {trialHrid, loadoutId, roleHrid} }
    lastPushedWeekKey: null, // local anti-duplicate guard per week
    lastPushAt: 0,
    lastPushRichness: 0, // captured-data count at the last successful push
    pushInFlight: false,
    itemNameMap: null, // lazy hrid -> item detail, for loadout name resolution
    trialLoadouts: {}, // "charId:kind" -> normalized signed-up trial loadout
    pendingViewLoadouts: [], // in-flight view_loadout requests (FIFO + name match)
    // Per-trial tile values from the game's currentTrialsData: trialHrid
    // (full, e.g. "/guild_skilling/alchemy") -> { kind, points, tier
    // (1-based index, 0 = none), progress (0..1 next-tier), done,
    // capturedAt }. Rides along with every snapshot push so the History
    // tables can mirror the in-game Guild -> Trials tile at their top.
    trialProgress: {},
    lastPushTrialStats: "" // serialized wire form at the last successful push
  };

  const PROFILE_FETCH = {
    delayMs: 1000, // gap between member requests
    timeoutMs: 5000, // wait this long for a single member's profile_shared
    maxRetries: 2 // re-send the view_profile request on timeout
  };

  // Trial-loadout fetch (feeds the History page's "loadout they used"
  // menu): the game answers { type: "view_loadout", viewLoadoutData:
  // { characterId, context: "guild_trial", kind } } with a
  // "loadout_shared" frame (verified in-game: ~150 ms, works for ANY
  // signed-up member, online or offline). Both context AND kind are
  // required — the server silently drops a kind-less request
  // (kind: undefined is stripped from the wire by JSON.stringify).
  const TRIAL_LOADOUT_FETCH = {
    timeoutMs: 8000, // wait this long for one member's loadout_shared
    gapMs: 1000, // one request per second — the burst paces the game gently
    maxTargets: 260 // safety cap per burst (guild size x 2 kinds)
  };
  let loadoutBurstRunning = false;

  // While a loadout burst runs, the game's own socket dispatcher opens the
  // "X's Loadout" popup for EVERY loadout_shared frame it sees (root
  // state `sharableLoadout` — the popup in the Combat zone screen). The
  // burst's one-request-per-second answers would keep that modal parked
  // on top of the user's game view for the whole run. The MessageEvent.
  // data getter hook (patchPageWebSocket below) hands the game a NEUTRAL
  // frame ({ type, loadout: null } — the game closes/keeps-closed its
  // popup on that) for exactly the frames that answer OUR pending
  // view_loadout requests, while the RAW frame still feeds our capture.
  // Nameless or unmatched frames pass through untouched, so a member the
  // user opens in-game during the burst still pops normally.
  function neuterLoadoutFrameForGame(rawMessage) {
    if (!loadoutBurstRunning) return null;
    const q = trialsSnapshot.pendingViewLoadouts;
    if (!q.length) return null;
    if (typeof rawMessage !== "string" || rawMessage.indexOf("loadout_shared") < 0) {
      return null; // fast path: most game frames are not loadout answers
    }
    let frame = null;
    try { frame = JSON.parse(rawMessage); } catch (e) { return null; }
    if (!frame || frame.type !== "loadout_shared") return null;
    const lo = frame.loadout && typeof frame.loadout === "object" ? frame.loadout : null;
    if (!lo) return null;
    const sc = lo.sharableCharacter || {};
    const who = (typeof sc.name === "string" && sc.name) ? sc.name.toLowerCase() : null;
    if (!who) return null; // nameless echoes never match our named pending queue
    // Only answers to OUR pending requests (same match rule as
    // handleSharedLoadoutResponse) — never a loadout the user opened.
    const ours = q.some((r) => r.name && r.name.toLowerCase() === who);
    if (!ours) return null;
    try {
      return JSON.stringify({ type: "loadout_shared", loadout: null });
    } catch (e) {
      return null;
    }
  }

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
    // v1.37.0: identity capture runs even when the tracker is switched off
    // for this character — init_character_data is how the script learns
    // WHO is logged in, which is what the per-character off switch keys on
    // (and what makes an in-page character switch re-evaluate it).
    if (data.type === "init_character_data" && data.character && typeof data.character === "object") {
      rememberCharacter(data.character.id, data.character.name);
      applyTrackerState();
    }
    // Everything else the tracker does — skill capture, guild roster,
    // trial pushes, auto-sync — is off for a disabled character.
    if (trackerDisabled()) return;
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
        // Weekly-snapshot state (week anchor, trial statuses, this
        // week's completion) also rides on the login payload's guild
        // object.
        trackGuildTrialWeek(data);
        break;
      case "skills_updated":
        ingestSkills(data.characterSkills);
        break;
      case "action_completed":
        ingestSkills(data.endCharacterSkills);
        break;
      case "guild_trial_stats_updated":
        // Guild-wide per-member-per-trial stats (the Trial History
        // capture stores these rows; see the module above).
        captureSnapshotStats(data);
        break;
      case "guild_trial_signup_updated":
        // Per-member trial + loadout signup (which loadout each member
        // used for the week's trials).
        captureSnapshotSignup(data);
        break;
      case "guild_characters_updated":
        handleGuildCharactersUpdated(data);
        captureCombatTrials(data);
        captureSkillingTrials(data);
        trackGuildTrialWeek(data);
        break;
      case "guild_updated":
        captureCombatTrials(data);
        captureSkillingTrials(data);
        trackGuildTrialWeek(data);
        break;
      case "profile_shared":
        ingestProfileResponse(data);
        break;
      case "loadout_shared":
        // Answer to one of our view_loadout requests — the member's
        // signed-up trial loadout (see the fetch block below).
        handleSharedLoadoutResponse(data);
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
        // v1.37.0: the current game build carries the roster maps at the
        // message TOP level (guildCharacterMap / guildSharableCharacterMap
        // beside `guild` — verified from a live init_character_data dump:
        // the nested guild object contains neither), so the pass above can
        // find nobody. Run the panel-message handler on the same payload:
        // it reads the top-level maps, and its union merge makes the
        // double-capture harmless.
        handleGuildCharactersUpdated({
          ...data,
          guildName: data.guildName || (guild.name || guild.guildName || null)
        });
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
  //   - init_character_data: the guild object is embedded here at login
  //     (current build: the roster maps ride at the message top level,
  //     beside `guild` — the handler call in that branch covers both
  //     placements), so we capture the roster without requiring the user
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
    if (overlayEl && overlayEl.classList.contains("stl-overlay-open")) {
      renderOverlay();
      // v1.37.0: a gear hover on this member may be open showing
      // "no gear captured yet" — upgrade it to the real gear now that
      // the profile (from a full pull or our own init data) arrived.
      if (gearTipCid !== null) refreshGearTip();
    }
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
  // Two real placements exist (verified from live payloads in
  // profileshape-*.json):
  //  - OUR OWN init_character_data carries `characterLoadoutMap` (id-keyed
  //    loadout objects with a wearableMap of "id::loc::item::E" strings).
  //  - OTHER members' profile_shared.profile carries NO loadout map at all —
  //    just `wearableItemMap` (locationHrid -> {itemHrid, enhancementLevel,
  //    ...}), the currently-equipped set, plus a `hideWearableItems` flag.
  // *Dict variants are how the game renames *Map fields in its React state.
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
    // Fallback: other members' profile_shared has `wearableItemMap`
    // (location -> equipped-item object with itemHrid/enhancementLevel but
    // no loadout structure). Synthesize one "Currently equipped" loadout so
    // the roster tooltip can still show their gear.
    const wim = raw.wearableItemMap;
    if (wim && typeof wim === "object" && !Array.isArray(wim)) {
      const equipment = [];
      for (const [slot, value] of Object.entries(wim)) {
        if (!value || typeof value !== "object" || !value.itemHrid) continue;
        equipment.push({
          slot,
          itemHrid: String(value.itemHrid),
          enhancementLevel: Number(value.enhancementLevel) || 0
        });
      }
      if (equipment.length > 0) {
        return [{
          loadoutId: null,
          name: "Currently equipped",
          actionTypeHrid: null,
          isDefault: true,
          equipment
        }];
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
            // `__stlFrameChecked` guards the re-entrant reads: processSocketMessage
            // (or our constructor listener) reads event.data from INSIDE this getter.
            if (!this.__stlFrameChecked) {
              this.__stlFrameChecked = true;
              const neutered = neuterLoadoutFrameForGame(message);
              if (neutered) {
                // Burst is running and this answer is ours: capture the RAW
                // frame, then hand the game a neutral one so its "X's Loadout"
                // popup never opens (pull-members parity: no game UI while the
                // background fetch is in flight). Every later read of this
                // event — the game's dispatcher included — gets the neutral
                // frame, so the popup stays closed from first to last.
                this.__stlNeutered = neutered;
                processedMessageEvents.add(this); // skip processSocketMessage
                queueRawMessage(message);
                return neutered;
              }
            }
            processSocketMessage(this, socket);
          } catch (e) {
            // Never break the game's message reading — fail open (raw frame).
            this.__stlNeutered = null;
          }
        }
        return this.__stlNeutered || message;
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
  patchPageWebSocket();
  patchPageWebSocketConstructor();

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
      if (adoptToolashaData() || Date.now() >= deadline) return;
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
    // v1.37.0: a disabled character gets none of the sweep's work (plan
    // fetch, highlight, panel observation, auto-sync). The re-enable path
    // calls sweep() itself, so the first tick after re-enabling catches up.
    if (trackerDisabled()) return;
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
    // Weekly trial snapshot (Trial History page): push when due — both of
    // this week's trials completed. Rollover captures fire immediately in
    // trackGuildTrialWeek, not here. The manual trigger is the panel's
    // "Push Trials" button (direct guild-gated push, like the roster
    // push — there is no longer a site-side request round-trip).
    maybeCompletionSnapshot();
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
    if (planFetchInFlight || !apiBase) return;
    planFetchInFlight = true;
    planFetchStartedAt = Date.now();
    try {
      const plansUrl = `${apiBase}/api/trials/plans/latest`;
      let res = await gmRequest("GET", plansUrl);
      planFetchAttempted = true;
      if (res.status === 304) {
        // HTTP-cache revalidation: the browser/Tampermonkey answered from
        // a cached ETag, so the body is EMPTY. If we already hold a plan
        // this is a no-op win. On the very first fetch of a page load we
        // still have no body, so retry once against a cache-busted URL
        // (the server also marks this route no-store, but older servers
        // may still revalidate).
        if (latestPlan !== null) {
          planState = "ready";
          return;
        }
        res = await gmRequest("GET", `${plansUrl}?nc=${Date.now()}`);
      }
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
    // v1.37.0: a disabled character hides the banner AND the FAB dot,
    // whatever the version state is — the tracker is off, so its update
    // nag is off too. (A re-enable repaints this from the stored state.)
    if (trackerDisabled()) {
      if (banner) banner.hidden = true;
      if (dot) dot.hidden = true;
      return;
    }
    const dismissed = stlGetValue("stlDismissedUpdateVersion", null);
    const outdated =
      updateLatest != null &&
      compareScriptVersions(SCRIPT_VERSION, updateLatest) < 0 &&
      dismissed !== updateLatest;
    if (banner) {
      if (outdated) {
        // Built from DOM nodes (not innerHTML) so the version strings from
        // the ledger can never inject markup; the Greasy Fork link is the
        // clickable part of the message.
        const msg = banner.querySelector(".stl-update-msg");
        msg.textContent =
          `Update available — v${updateLatest} is out (you're on v${SCRIPT_VERSION}). `;
        const link = document.createElement("a");
        link.className = "stl-update-link";
        link.textContent = "greasyfork.org";
        link.href = GREASYFORK_PAGE;
        link.target = "_blank";
        link.rel = "noopener";
        msg.appendChild(link);
        msg.append(" to get the latest features.");
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
    if (updateFetchInFlight || !apiBase) return;
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

  // The latest plan's member set is built server-side from the synced guild
  // profiles: the union of every per-skill assignment list, the named
  // unassigned pool (meta.unassigned), and the admin-excluded members
  // (meta.excluded). A character outside the guild — e.g. an ironcow alt
  // that never pushed a profile to the ledger — is in none of those lists
  // even though a plan exists, which made it look "not assigned" and
  // surfaced the "No suitable trial found" sit-out notice for it
  // (2026-10-30: reported by ironcow accounts that aren't in the guild).
  // applyNoTrialNotice() consults this test before painting that notice.
  //
  // Returns:
  //   true  — the character is in the plan's member set (assigned,
  //           unassigned, or excluded);
  //   false — a modern plan (carries the unassigned/excluded lists) and
  //           the character is in none of them — a non-member, suppress;
  //   null  — undecidable: no plan yet, or a legacy plan without the
  //           membership lists — callers keep the pre-fix behavior, since
  //           a sitting-out member can't be distinguished from a
  //           non-member on those plans.
  function characterInPlanMemberSet() {
    if (!latestPlan) return null;
    const { characterId, characterName } = resolveCharacter();
    const hasId = characterId != null;
    const name = String(characterName || "").trim().toLowerCase();
    // Id match first, case-insensitive name match only when no id is known
    // (same semantics as isInGuildRoster()). Tolerates both the
    // optimizer's member objects ({ characterId, name, ... }) and raw ids.
    const inList = (list) => {
      if (!Array.isArray(list)) return false;
      if (hasId) {
        for (const entry of list) {
          const cid = entry && typeof entry === "object" ? entry.characterId : entry;
          if (cid != null && Number(cid) === Number(characterId)) return true;
        }
        return false; // an id is authoritative — never fall back to name guessing
      }
      if (!name) return false;
      for (const entry of list) {
        const n = entry && typeof entry === "object" ? entry.name : null;
        if (n && String(n).trim().toLowerCase() === name) return true;
      }
      return false;
    };
    const meta = latestPlan.meta && typeof latestPlan.meta === "object" ? latestPlan.meta : {};
    // The server writes both lists on every run (manual and auto); plans
    // saved before that carry only the assignments, which can't identify
    // the run's unassigned (sitting-out) members.
    const modern = Array.isArray(meta.unassigned) || Array.isArray(meta.excluded);
    const lists = [];
    const assignments = latestPlan.assignments || {};
    for (const key of Object.keys(assignments)) lists.push(assignments[key]);
    lists.push(meta.unassigned, meta.excluded);
    for (const list of lists) {
      if (inList(list)) return true;
    }
    return modern ? false : null;
  }

  // Panel notice for two distinct failure states, painted at the top of
  // the trials panel so it is visible as soon as the panel opens:
  //   (a) "sit out" — the latest optimizer run exists, this character is
  //       in the plan's member set (characterInPlanMemberSet()), and is in
  //       no assignment (excluded members surface the same way: they are
  //       skipped before assignment, so they are simply absent from every
  //       assignments[skill] array). 2026-10-30: the membership gate —
  //       a character in NO plan list (e.g. an ironcow account that isn't
  //       in the guild and never synced a profile) is not sitting out;
  //       it simply has nothing to sit out of, so it gets no notice.
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
    // 2026-10-30: the sit-out notice applies only to a character in the
    // plan's member set. An unassigned character outside the guild (an
    // ironcow alt that never synced a profile) is in no list at all —
    // characterInPlanMemberSet() reports false and the notice is
    // suppressed. null (legacy plan, membership unknowable) keeps the
    // pre-fix behavior of showing the notice.
    const membership = characterInPlanMemberSet();
    const shouldShow =
      unreachable ||
      (latestPlan !== null && bestSkill === null && membership !== false);
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
    // v1.37.0: a disabled character paints nothing. Late callbacks that
    // outlive a switch-off (a plan fetch still in flight, a retry tick,
    // the panel observer) all funnel through here, so this guard strips
    // whatever the tracker last painted and paints nothing back.
    if (trackerDisabled()) {
      if (appliedHighlight || document.querySelector(".stl-trial-badge")) {
        clearTrialHighlightMarks();
      }
      appliedHighlight = null;
      const notice = document.getElementById("stl-trial-notice");
      if (notice) notice.remove();
      appliedNoTrialNotice = null;
      return false;
    }
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
        ? "\u2605 Recommended Trial \u00b7 " + pts + " pts"
        : "\u2605 Recommended Trial";
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
    // v1.37.0: the character was switched off mid-retry — drop the chain
    // so a late tick can't repaint a disabled character's panel.
    if (trackerDisabled()) {
      highlightRetryCount = 0;
      highlightRetryPanel = null;
      return;
    }
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

  // Last path segment of a hrid, lowercased ("/guild_combat/badger" ->
  // "badger") — the match token shared by the panel-order code below.
  const tailOf = (s) => String(s).split("/").pop().toLowerCase();

  // True when the panel names and the game hrids cover exactly the same set
  // of trials (hrid tail vs normalized panel name) — i.e. the on-screen panel
  // shows THIS week's trials. Guards the self-correction against a stale panel
  // (previous week's order) being open across a week rollover.
  function panelOrderMatches(hrids, panelNames) {
    if (!Array.isArray(hrids) || hrids.length === 0) return false;
    if (!Array.isArray(panelNames) || panelNames.length === 0) return false;
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
      // One loop over both kinds — the two blocks were otherwise identical
      // with the kind's variables swapped (skilling first: it is the one
      // whose currentTrialsData fallback usually arms the push).
      for (const kind of ["skilling", "combat"]) {
        const raw = kind === "skilling" ? skillingTrialHrids : combatTrialHrids;
        if (!raw || raw.length === 0 || panelTrialOrder[kind].length === 0
          || !panelOrderMatches(raw, panelTrialOrder[kind])) continue;
        const ordered = reorderHridsToPanelOrder(raw, panelTrialOrder[kind]);
        const last = kind === "skilling" ? lastSkillingPush : lastCombatPush;
        if (ordered.length === 0 || hridArraysEqual(ordered, last)) continue;
        const field = kind === "skilling" ? "skillHrids" : "combatHrids";
        const path = kind === "skilling" ? `${apiBase}/api/skilling-trials` : `${apiBase}/api/combat-trials`;
        const res = await gmRequest("POST", path, { [field]: ordered });
        if (res.status !== 200) continue;
        if (kind === "skilling") { lastSkillingPush = ordered; skillingTrialsSent = true; }
        else { lastCombatPush = ordered; combatTrialsSent = true; }
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
        if (!relevant || !document.querySelector(TRIALS_TAB_MARKER)) return;
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
    if (members.length === 0) return "Nothing to push — Pull Members first.";
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
  // v1.37.0 — also captures/pushes combat-trial boss stats (trial monster
  //            combatDetails + the static guild-trial table) so the combat
  //            simulator on the ledger can run against live game data.
  // ---------------------------------------------------------------------

  // The game exposes its static client data (item details, monster details,
  // etc.) through a page-level `localStorageUtil` global. We run sandboxed,
  // so reach it via unsafeWindow. Returns
  // { itemDetailMap: object|null, combatTrialData: object|null }.
  function readClientData() {
    const result = { itemDetailMap: null, combatTrialData: null };
    try {
      const pageWindow = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
      const util = pageWindow.localStorageUtil;
      if (util && typeof util.getInitClientData === "function") {
        const clientData = util.getInitClientData();
        if (clientData && typeof clientData.itemDetailMap === "object") {
          result.itemDetailMap = clientData.itemDetailMap;
        }
        // v1.37.0 — combat-trial boss stats: keep the payload tiny by
        // pushing only the /monsters/trial_* entries of
        // combatMonsterDetailMap (8 small blocks) plus the week-independent
        // guild-trial table when it is part of the client data. The same
        // capture also ships the game-data maps the ledger's combat
        // simulator engine needs (buildSimGameData), minus the duplicated
        // itemDetailMap which already ships at the top level of the push.
        const monsterMap = clientData && clientData.combatMonsterDetailMap;
        let trialMonsters = null;
        if (monsterMap && typeof monsterMap === "object") {
          trialMonsters = {};
          for (const hrid of Object.keys(monsterMap)) {
            if (hrid.indexOf("/monsters/trial_") === 0) {
              trialMonsters[hrid] = monsterMap[hrid];
            }
          }
          if (Object.keys(trialMonsters).length === 0) trialMonsters = null;
        }
        const simGameData = buildSimGameData(clientData);
        if (trialMonsters || simGameData) {
          result.combatTrialData = {
            combatTrials: (clientData && typeof clientData.guildTrialDetailMap === "object")
              ? clientData.guildTrialDetailMap
              : null,
            trialMonsters: trialMonsters,
            gameData: simGameData,
            source: "game client data (user-script capture)",
            capturedAt: Date.now()
          };
        }
      }
    } catch (e) {
      /* game API not present yet */
    }
    return result;
  }

  // v1.37.0 — The game-data maps the ledger's combat-sim engine indexes,
  // extracted from the same initClientData snapshot. Sized down where the
  // game ships more than the sim ever indexes: actionDetailMap keeps
  // /actions/combat/* only (the ledger injects its own synthetic boss zone
  // before simming), combatMonsterDetailMap keeps the /monsters/trial_*
  // entries with drop tables normalized to arrays (the engine walks
  // rareDropTable without a null check). itemDetailMap is deliberately not
  // duplicated here — it ships at the top level of the push and the ledger
  // re-joins it into the blob before running the sim.
  function buildSimGameData(clientData) {
    if (!clientData || typeof clientData !== "object") return null;
    const gameData = {};
    const passthroughKeys = [
      "abilityDetailMap",
      "combatStyleDetailMap",
      "damageTypeDetailMap",
      "houseRoomDetailMap",
      "combatTriggerDependencyDetailMap",
      "combatTriggerConditionDetailMap",
      "combatTriggerComparatorDetailMap",
      "enhancementLevelTotalBonusMultiplierTable",
      "abilitySlotsLevelRequirementList",
      "openableLootDropMap",
      "labyrinthCrateDetailMap",
      "guildBuffDetailMap",
      "guildShrineDetailMap",
      "achievementDetailMap",
      "achievementTierDetailMap"
    ];
    let present = 0;
    for (const key of passthroughKeys) {
      const value = clientData[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        gameData[key] = value;
        present += 1;
      } else if (Array.isArray(value)) {
        gameData[key] = value;
        present += 1;
      }
    }
    const actionMap = clientData.actionDetailMap;
    if (actionMap && typeof actionMap === "object") {
      const combatActions = {};
      for (const hrid of Object.keys(actionMap)) {
        if (hrid.indexOf("/actions/combat/") === 0) {
          combatActions[hrid] = actionMap[hrid];
        }
      }
      gameData.actionDetailMap = combatActions;
      present += 1;
    }
    const monsterMap = clientData.combatMonsterDetailMap;
    if (monsterMap && typeof monsterMap === "object") {
      const trialOnly = {};
      for (const hrid of Object.keys(monsterMap)) {
        if (hrid.indexOf("/monsters/trial_") !== 0) continue;
        const m = monsterMap[hrid] && typeof monsterMap[hrid] === "object" ? monsterMap[hrid] : {};
        trialOnly[hrid] = Object.assign({}, m, {
          dropTable: Array.isArray(m.dropTable) ? m.dropTable : [],
          rareDropTable: Array.isArray(m.rareDropTable) ? m.rareDropTable : []
        });
      }
      gameData.combatMonsterDetailMap = trialOnly;
      present += 1;
    }
    // A few maps is too little to run the engine — require a working core.
    return present >= 5 ? gameData : null;
  }

  // Push the captured client data to the ledger (one-time per page load).
  async function pushClientData(apiBase) {
    if (clientDataSent) return null;
    const captured = readClientData();
    const itemDetailMap = captured.itemDetailMap;
    if (!itemDetailMap || Object.keys(itemDetailMap).length === 0) {
      return "itemDetailMap not available yet — retry after the game has fully loaded.";
    }
    const body = { itemDetailMap };
    if (captured.combatTrialData) body.combatTrialData = captured.combatTrialData;
    const res = await gmRequest("POST", `${apiBase}/api/client-data`, body);
    if (res.status === 200) {
      clientDataSent = true;
      const parsed = JSON.parse(res.responseText);
      const ct = captured.combatTrialData || null;
      let extra;
      if (!ct) {
        extra = " (no trial boss data captured yet)";
      } else {
        extra = " + combat-sim data";
        if (ct.trialMonsters) {
          extra += ` (${Object.keys(ct.trialMonsters).length} trial monsters)`;
        }
        if (ct.gameData) extra += " + engine game-data maps";
      }
      return `Pushed itemDetailMap (${parsed.size} items)${extra} to the ledger.`;
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

  // Order this week's trial hrids exactly like the game's Guild → Trials
  // panel, using the game's own sortTrialHrids() logic against the captured
  // static table (see captureGuildTrialDetails). The sort is kind-agnostic,
  // so the same function serves both the skilling and the combat arrays. No
  // panel/UI interaction is involved. Returns an array of hrids in panel
  // order, or null when the table is missing or none of the hrids are in it
  // (a stable sort would "succeed" as a no-op otherwise) — in which case
  // the caller tries the other confirmation sources and, if none confirms
  // the order, holds the push.
  function orderTrialHrids(hrids) {
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
  // =====================================================================
  // Weekly trial snapshot — the module functions
  // (state lives with the other capture state, near the top of the file,
  // so sweep() can never hit a TDZ gap on a late page load).
  // =====================================================================

  const snapPad2 = (n) => (n < 10 ? "0" + n : String(n));

  // The game's week anchors (guild.currentWeekStartAt, the signup entries'
  // signupWeekStartAt) arrive as ISO-8601 strings ("2026-10-30T00:00:00Z")
  // in current builds — older builds used ms epochs — so accept both. The
  // game's own helpers (ci.currentWeekStartMs) date-parse the same way.
  function weekStartToMs(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : NaN;
    const s = String(v).trim();
    if (!s) return NaN;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 && n < 1e15 ? n : NaN;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) && t > 0 ? t : NaN;
  }

  // Week key of the game's weekly cycle: the UTC calendar date
  // ("YYYY-MM-DD") on which the guild week STARTS — guild trials reset
  // every Friday at 00:00 UTC, so for current builds the anchor
  // (guild.currentWeekStartAt) is exactly that Friday, and its UTC date
  // is one stable, chronologically ordering key per game week. (The old
  // "YYYY-Www" ISO-week key mislabeled the range: a Friday-start week
  // sits in the MIDDLE of an ISO week, not on its Monday boundary.)
  let nonFridayAnchorWarned = false;
  function weekKeyFromStart(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getUTCDay() !== 5 && !nonFridayAnchorWarned) {
      // The anchor should be the Friday 00:00 UTC reset; if a future
      // build moves the reset day, the key still tracks the actual anchor.
      console.warn(
        `[STL] week anchor ${new Date(ts).toISOString()} is not a Friday — using its UTC date as the week key anyway`
      );
      nonFridayAnchorWarned = true;
    }
    return d.getUTCFullYear() + "-" + snapPad2(d.getUTCMonth() + 1) + "-" + snapPad2(d.getUTCDate());
  }

  const normTrialStatus = (v) => {
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase();
    return s === "scheduled" || s === "in_progress" || s === "completed" ? s : null;
  };

  // Merge one member's signup fields into the capture buffer. Only
  // non-empty values overwrite, so a partial update never blanks an
  // earlier capture. Updates stamped for a different week (the game
  // carries signupWeekStartAt on each entry) are dropped — a stale
  // old-week broadcast must not leak into the new week's buffer.
  function mergeSnapshotSignup(characterId, patch) {
    if (characterId === null || characterId === undefined) return;
    const key = Number(characterId);
    if (!Number.isInteger(key) || key <= 0) return;
    const stampedWeek = weekStartToMs(patch.signupWeekStartAt);
    const trackedWeek = weekStartToMs(trialsSnapshot.weekStartAt);
    if (
      Number.isFinite(stampedWeek) &&
      Number.isFinite(trackedWeek) &&
      Math.abs(stampedWeek - trackedWeek) > 86400000
    ) {
      return;
    }
    const cur = trialsSnapshot.signups[key] || {};
    if (patch.name) cur.name = String(patch.name);
    const prevSkilling = cur.skilling || null;
    const prevCombat = cur.combat || null;
    for (const kind of ["skilling", "combat"]) {
      const p = patch[kind];
      if (!p) continue;
      const k = cur[kind] || {};
      if (p.trialHrid) k.trialHrid = String(p.trialHrid);
      if (p.loadoutId !== null && p.loadoutId !== undefined && p.loadoutId !== "") {
        const n = Number(p.loadoutId);
        if (Number.isInteger(n) && n > 0) k.loadoutId = n;
      }
      if (p.roleHrid) k.roleHrid = String(p.roleHrid);
      if (k.trialHrid || k.loadoutId || k.roleHrid) cur[kind] = k;
    }
    if (cur.name || cur.skilling || cur.combat) trialsSnapshot.signups[key] = cur;
    // A mid-week (re)signup changes the loadout the member will actually
    // run — drop any cached trial-loadout capture so the next button run
    // re-fetches the loadout they signed up with.
    const prevByKind = { skilling: prevSkilling, combat: prevCombat };
    for (const kind of ["skilling", "combat"]) {
      const prev = prevByKind[kind];
      const now = cur[kind] || null;
      const unchanged =
        (prev && now &&
          (prev.trialHrid || "") === (now.trialHrid || "") &&
          (prev.loadoutId || 0) === (now.loadoutId || 0)) ||
        (!prev && !now);
      if (!unchanged && trialsSnapshot.trialLoadouts[key + ":" + kind]) {
        delete trialsSnapshot.trialLoadouts[key + ":" + kind];
      }
    }
  }

  // Field extractor for the {Skilling,Combat}-suffixed signup fields the
  // game carries on each character entry (the role field only exists for
  // combat signups — the game returns "" otherwise).
  function signupPatch(d, prefix) {
    const field = (base) => (d && d[base] !== undefined ? d[base] : null);
    let loadoutRaw = field(prefix + "LoadoutID");
    const loadoutNum = loadoutRaw === null || loadoutRaw === "" ? null : Number(loadoutRaw);
    return {
      trialHrid: typeof field(prefix + "TrialHrid") === "string" ? field(prefix + "TrialHrid") : null,
      loadoutId: Number.isInteger(loadoutNum) && loadoutNum > 0 ? loadoutNum : null,
      roleHrid: typeof field(prefix + "RoleHrid") === "string" ? field(prefix + "RoleHrid") : null
    };
  }

  // WS: guild_trial_stats_updated. The game's own handler stores the list
  // only when e.guildId matches the joined guild; we mirror that guard.
  function captureSnapshotStats(msg) {
    if (!msg || typeof msg !== "object" || !Array.isArray(msg.guildTrialStatList)) return;
    if (msg.guildId != null && detectedGuildId != null) {
      const gid = Number(msg.guildId);
      if (Number.isInteger(gid) && gid !== detectedGuildId) return; // another guild's traffic
    }
    trialsSnapshot.statRows = msg.guildTrialStatList.slice();
    trialsSnapshot.statListUpdatedAt = Date.now();
    console.log(`[STL] captured guild trial stats: ${trialsSnapshot.statRows.length} rows (guild ${msg.guildId})`);
  }

  // WS: guild_trial_signup_updated. The game's handler reads
  // characterId and the signedUp* fields off the message top level and
  // merges them into guildCharacterDict[characterId]; a {characterId,
  // data:{…}} shape is tolerated too in case a future build wraps it.
  function captureSnapshotSignup(msg) {
    if (!msg || typeof msg !== "object") return;
    const d = msg.data && typeof msg.data === "object" ? msg.data : msg;
    const cid = msg.characterId !== undefined && msg.characterId !== null ? msg.characterId : d.characterId;
    if (cid === undefined || cid === null) return;
    mergeSnapshotSignup(cid, {
      name: d.name || d.characterName || d.character_name || null,
      signupWeekStartAt: d.signupWeekStartAt,
      skilling: signupPatch(d, "signedUpSkilling"),
      combat: signupPatch(d, "signedUpCombat")
    });
    // A (re)signup is cached above; the roster overlay's "⚙ Trial
    // Loadouts" button picks the new loadout up on its next run (manual
    // by design).
  }

  // Called from every guild-bearing message (init_character_data,
  // guild_characters_updated, guild_updated). Records this week's trial
  // statuses + per-member signups, and — when the message carries a NEW
  // guild.currentWeekStartAt — pushes the just-ended week's captured
  // buffer under the old weekKey (the game clears its stat list in the
  // same message, so this is the last chance for the old week's data)
  // before resetting the capture state for the new week. Rollover
  // pushes deliberately do NOT refresh the live stat list: by the time
  // the new week's anchor arrives, the list already belongs to it.
  function trackGuildTrialWeek(msg) {
    if (!msg || typeof msg !== "object") return;
    const guild =
      (msg.guild && typeof msg.guild === "object") ? msg.guild :
      (msg.myGuild && typeof msg.myGuild === "object") ? msg.myGuild :
      (msg.guildInfo && typeof msg.guildInfo === "object") ? msg.guildInfo :
      (msg.characterData && msg.characterData.guild && typeof msg.characterData.guild === "object")
        ? msg.characterData.guild : null;
    // Per-member signup state (the full map is present on
    // guild_characters_updated — the Guild-panel-open message).
    const charMap = (guild && guild.guildCharacterMap) || msg.guildCharacterMap || null;
    const sharable = (guild && guild.guildSharableCharacterMap) || msg.guildSharableCharacterMap || {};
    if (charMap && typeof charMap === "object") {
      for (const cid of Object.keys(charMap)) {
        const c = charMap[cid] || {};
        const name = (sharable[cid] && sharable[cid].name) || c.name || null;
        mergeSnapshotSignup(cid, {
          name,
          signupWeekStartAt: c.signupWeekStartAt,
          skilling: signupPatch(c, "signedUpSkilling"),
          combat: signupPatch(c, "signedUpCombat")
        });
      }
    }
    if (!guild) return;
    // Refresh this week's trial statuses from the game's payload.
    if (typeof guild.currentTrialsData === "string" && guild.currentTrialsData) {
      try {
        const parsed = JSON.parse(guild.currentTrialsData) || {};
        const s = {
          skilling: parsed.skilling ? normTrialStatus(parsed.skilling.status) : null,
          combat: parsed.combat ? normTrialStatus(parsed.combat.status) : null
        };
        if (s.skilling || s.combat) {
          trialsSnapshot.statuses = {
            skilling: s.skilling || trialsSnapshot.statuses.skilling,
            combat: s.combat || trialsSnapshot.statuses.combat
          };
        }
        // Same payload also carries the per-trial tile values: earned
        // points (points[<trialHrid>]) and each trial's party state
        // (skilling|combat -> parties -> <trialHrid> -> { done,
        // highestTier, nextTierProgress }). Keyed by the trial's FULL
        // hrid — the same key the snapshot entries use for trial_id — so
        // a push can mirror the in-game Guild -> Trials tile (tier line +
        // "N pts") at the top of each History table.
        if (parsed && typeof parsed === "object") {
          const points = (parsed.points && typeof parsed.points === "object")
            ? parsed.points : {};
          for (const kind of ["skilling", "combat"]) {
            const block = parsed[kind];
            if (!block || typeof block !== "object") continue;
            const parties = (block.parties && typeof block.parties === "object")
              ? block.parties : {};
            for (const hrid of Object.keys(parties)) {
              const party = parties[hrid];
              if (!party || typeof party !== "object") continue;
              trialsSnapshot.trialProgress[hrid] = {
                kind,
                points: Number(points[hrid]) || 0,
                tier: Number(party.highestTier) || 0, // 1-based (11 -> "Lv.200")
                progress: Number(party.nextTierProgress) || 0,
                done: Boolean(party.done),
                capturedAt: Date.now()
              };
            }
          }
        }
      } catch (e) { /* keep the previous statuses */ }
    }
    const weekStart = weekStartToMs(guild.currentWeekStartAt);
    if (!Number.isFinite(weekStart)) return;
    if (trialsSnapshot.weekStartAt === weekStart) {
      // Same week — statuses just refreshed; if both trials are now done,
      // this week is final and can be snapshotted.
      maybeCompletionSnapshot();
      return;
    }
    // NEW week (or first capture): roll the buffer forward.
    const oldKey = trialsSnapshot.weekKey;
    const oldRows = trialsSnapshot.statRows;
    const oldSignups = trialsSnapshot.signups;
    const oldLoadouts = trialsSnapshot.trialLoadouts; // mid-week captures of the old week
    const oldProgress = trialsSnapshot.trialProgress; // old week's per-trial tile values
    const oldPending = trialsSnapshot.pendingViewLoadouts.slice();
    trialsSnapshot.weekStartAt = weekStart;
    trialsSnapshot.weekKey = weekKeyFromStart(weekStart);
    trialsSnapshot.statRows = []; // statListUpdatedAt is kept: a rollover does not touch the live list
    trialsSnapshot.signups = {};
    // The server's guild-trial context ROLLS in this same message — from
    // here on a view_loadout would return the NEW week's loadouts, so the
    // old week rides up with whatever we already captured mid-week (and
    // any in-flight answer is abandoned: it belongs to the new week).
    trialsSnapshot.trialLoadouts = {};
    trialsSnapshot.trialProgress = {}; // captured values belong to the old week now
    for (const req of oldPending) { if (req.settle) req.settle(null); }
    trialsSnapshot.pendingViewLoadouts = [];
    // v1.37.1: the rollover flush is gated off while trial history is
    // manual-only — a week nobody pushed during the week is not pushed
    // automatically when it rolls over (see SNAPSHOT_AUTO_PUSH).
    if (
      SNAPSHOT_AUTO_PUSH &&
      oldKey &&
      (hasSnapshotData(oldRows, oldSignups) || Object.keys(oldProgress).length > 0)
    ) {
      void pushTrialSnapshot(oldKey, {
        apiBase: snapshotApiBase(),
        buffer: { statRows: oldRows, signups: oldSignups, trialLoadouts: oldLoadouts, trialStats: oldProgress },
        reason: "rollover"
      });
    }
    // Re-login after this week already completed: catch up now.
    maybeCompletionSnapshot();
  }

  function hasSnapshotData(rows, signups) {
    if (Array.isArray(rows) && rows.length > 0) return true;
    if (signups && typeof signups === "object") {
      for (const key of Object.keys(signups)) {
        const s = signups[key];
        if (!s) continue;
        for (const kind of ["skilling", "combat"]) {
          if (s[kind] && s[kind].trialHrid) return true;
        }
      }
    }
    return false;
  }

  // How much capture data exists (stat rows + per-member signup entries
  // + captured trial loadouts): used to decide whether a completed week
  // gained NEW data after its first push (e.g. signup/loadout info
  // arriving when the Guild panel opens after the login-time push, or a
  // mid-week trial-loadout sweep landing), worth an upsert re-push.
  function snapshotRichness(rows, signups, loadouts) {
    let n = Array.isArray(rows) ? rows.length : 0;
    if (signups && typeof signups === "object") {
      for (const key of Object.keys(signups)) {
        const s = signups[key];
        if (!s) continue;
        if (s.skilling) n += 1;
        if (s.combat) n += 1;
      }
    }
    if (loadouts && typeof loadouts === "object") {
      n += Object.keys(loadouts).length;
    }
    return n;
  }

  // Completion trigger: both of this week's trials report "completed"
  // and this week hasn't been pushed yet -> capture the final state. A
  // week already pushed re-pushes only when strictly richer data arrived
  // since (the server upserts, so this just refreshes the rows).
  function maybeCompletionSnapshot() {
    // v1.37.1: the completion / re-login catch-up push is off while trial
    // history is manual-only (see SNAPSHOT_AUTO_PUSH).
    if (!SNAPSHOT_AUTO_PUSH) return;
    const s = trialsSnapshot;
    if (s.pushInFlight || !s.weekKey) return;
    if (s.statuses.skilling !== "completed" || s.statuses.combat !== "completed") return;
    if (s.lastPushedWeekKey === s.weekKey) {
      // Compare what we would actually push (verified against the current
      // guild roster — lastPushRichness is recorded from the filtered
      // set) against what was last pushed, or it can loop on pushes of
      // data that no longer contains the non-member entrants.
      const toVerify = filterSnapshotToRoster(s.statRows, s.signups, s.trialLoadouts);
      const richer = snapshotRichness(toVerify.rows, toVerify.signups, toVerify.loadouts) > s.lastPushRichness;
      // The per-trial tile values can advance even when the data COUNT is
      // flat (a tier/points bump after the first push) — a different
      // serialized set is also worth the re-push.
      const statsChanged = JSON.stringify(serializeTrialStats(s.trialProgress || {}))
        !== (s.lastPushTrialStats || "[]");
      if (!richer && !statsChanged) return;
    }
    if (Date.now() - s.lastPushAt < SNAPSHOT_PUSH_COOLDOWN_MS) return; // retry next window
    void pushTrialSnapshot(s.weekKey, { apiBase: snapshotApiBase(), reason: "completed" });
  }

  // Lazy hrid -> item-detail lookup from the game's client data (the same
  // map we push to the ledger) — used to name the gear in a signed-up
  // loadout. An empty result (game client data not loaded yet) is NOT
  // cached, so a later push can re-resolve names.
  function ensureItemNameMap() {
    const cached = trialsSnapshot.itemNameMap;
    if (cached && Object.keys(cached).length > 0) return cached;
    let map = {};
    try {
      const detail = readClientData().itemDetailMap;
      if (detail && typeof detail === "object") {
        for (const hrid of Object.keys(detail)) {
          const v = detail[hrid];
          if (v && typeof v === "object") map[hrid] = v;
        }
      }
    } catch (e) { /* game client data not ready */ }
    if (Object.keys(map).length > 0) trialsSnapshot.itemNameMap = map;
    return map;
  }

  // Best-effort gear-name resolution for the loadout a member signed up
  // with: their captured profile (a full guild pull stores every
  // loadout by the SAME loadoutId) lists the equipment, and the game's
  // itemDetailMap supplies display names. Returns the History page's
  // { group: [{name, count}] } shape, or null when this client never
  // captured that member's loadouts (the entry then still carries the
  // raw loadoutId).
  function resolveLoadoutGroup(memberId, loadoutId) {
    if (loadoutId === null || loadoutId === undefined) return null;
    const n = Number(loadoutId);
    if (!Number.isInteger(n) || n <= 0) return null;
    const prof =
      (pulledProfilesFull && pulledProfilesFull[memberId]) ||
      (pulledProfilesFull && pulledProfilesFull[String(memberId)]) || null;
    if (!prof || !Array.isArray(prof.loadouts)) return null;
    const lo = prof.loadouts.find((l) => l && Number(l.loadoutId) === n) || null;
    if (!lo || !Array.isArray(lo.equipment) || lo.equipment.length === 0) return null;
    const items = [];
    const names = ensureItemNameMap();
    const seen = {};
    for (const eq of lo.equipment) {
      if (!eq || !eq.itemHrid) continue;
      const d = names[eq.itemHrid];
      const name =
        (d && (typeof d.name === "string" ? d.name : (d.displayName || d.itemName || ""))) ||
        String(eq.itemHrid).split("/").pop();
      if (!name || seen[name]) continue;
      seen[name] = true;
      items.push({ name, count: 1 });
    }
    if (items.length === 0) return null;
    return { Equipment: items };
  }

  // -------------------------------------------------------------------
  // Signed-up TRIAL loadouts (feeds the History page's gear menu: the
  // loadout each member actually used, captured from the game MID-WEEK
  // instead of a "currently equipped" snapshot from a later profile pull).
  //
  // WS protocol (verified against the live game, online + offline members):
  //   send  { type: "view_loadout",
  //           viewLoadoutData: { characterId,
  //                              context: "guild_trial",
  //                              kind: "skilling" | "combat" } }
  //   recv  { type: "loadout_shared",
  //           loadout: { sharableCharacter: { name, isOnline, ... },
  //                     hasLoadout, actionTypeHrid,
  //                     wearableItemMap: { <locationHrid>:
  //                       { itemHrid, enhancementLevel, ... } },
  //                     equippedAbilities: [{ abilityHrid, level, ... }],
  //                     combatConsumables: [{ itemHrid, enhancementLevel,
  //                       count, ... }] } }
  // context and kind are BOTH required — the server silently drops a
  // request without a valid trial kind, and JSON.stringify strips an
  // undefined kind, so the kind is always passed explicitly. Responses
  // carry no characterID of their own, so we match them to pending
  // requests by the echoed character name (guild names are unique) with
  // FIFO as the fallback.
  // -------------------------------------------------------------------

  // Reduce a loadout_shared payload to the compact shape the snapshot
  // stores: gear per location (with the item's equipment type, so the
  // page can label the slot without fresh client data), the loadout's
  // equipped abilities, and — for combat — the consumables.
  function normalizeTrialLoadoutResponse(characterId, kind, lo, fallbackName) {
    const wm = (lo && typeof lo.wearableItemMap === "object" && lo.wearableItemMap) || {};
    const names = ensureItemNameMap();
    const equipment = [];
    for (const slot of Object.keys(wm)) {
      const it = wm[slot];
      if (!it || !it.itemHrid) continue;
      const enh = Number(it.enhancementLevel);
      const det = names[it.itemHrid];
      const ed = det && det.equipmentDetail;
      equipment.push({
        slot,
        itemHrid: String(it.itemHrid),
        enhancementLevel: Number.isFinite(enh) ? enh : 0,
        // e.g. "/equipment_types/hands" — the page labels the slot from
        // this even when its own game-data table lacks the item.
        slotType: ed && typeof ed.type === "string" && ed.type ? ed.type : null
      });
    }
    const abilities = [];
    if (lo && Array.isArray(lo.equippedAbilities)) {
      for (const a of lo.equippedAbilities) {
        if (!a || !a.abilityHrid) continue;
        const lvl = Number(a.level);
        abilities.push({
          abilityHrid: String(a.abilityHrid),
          level: Number.isFinite(lvl) && lvl > 0 ? Math.floor(lvl) : 1
        });
      }
    }
    const consumables = [];
    if (kind === "combat" && lo && Array.isArray(lo.combatConsumables)) {
      for (const c of lo.combatConsumables) {
        if (!c || !c.itemHrid) continue;
        const enh = Number(c.enhancementLevel);
        const cnt = Number(c.count);
        consumables.push({
          itemHrid: String(c.itemHrid),
          enhancementLevel: Number.isFinite(enh) ? enh : 0,
          count: Number.isFinite(cnt) ? cnt : 1
        });
      }
    }
    const sc = (lo && typeof lo.sharableCharacter === "object" && lo.sharableCharacter) || {};
    return {
      characterId: Number(characterId),
      kind,
      name: typeof sc.name === "string" && sc.name ? sc.name : fallbackName || null,
      // The game's own flag, with a content fallback (a loadout can exist
      // with hasLoadout false in edge cases — gear that is still there).
      hasLoadout: lo.hasLoadout === true ||
        equipment.length > 0 || abilities.length > 0 || consumables.length > 0,
      actionTypeHrid:
        lo && typeof lo.actionTypeHrid === "string" && lo.actionTypeHrid
          ? lo.actionTypeHrid
          : (typeof sc.actionType === "string" && sc.actionType ? sc.actionType : null),
      equipment,
      abilities,
      consumables,
      resolvedAt: Date.now()
    };
  }

  // Send one view_loadout request and resolve with the matching
  // loadout_shared payload (or null on timeout/socket failure). The
  // answer is settled by handleSharedLoadoutResponse when it arrives.
  function requestViewLoadout(characterId, kind, name) {
    return new Promise((resolve) => {
      const cid = Number(characterId);
      if (!Number.isInteger(cid) || cid <= 0) { resolve(null); return; }
      const req = {
        characterId: cid,
        kind,
        name: name || null,
        settled: false,
        timer: null,
        settle: null
      };
      req.settle = (lo) => {
        if (req.settled) return;
        req.settled = true;
        if (req.timer) { clearTimeout(req.timer); req.timer = null; }
        const i = trialsSnapshot.pendingViewLoadouts.indexOf(req);
        if (i >= 0) trialsSnapshot.pendingViewLoadouts.splice(i, 1);
        resolve(lo || null);
      };
      trialsSnapshot.pendingViewLoadouts.push(req);
      req.timer = setTimeout(() => req.settle(null), TRIAL_LOADOUT_FETCH.timeoutMs);
      try {
        gameSocket.send(JSON.stringify({
          type: "view_loadout",
          viewLoadoutData: {
            characterId: cid,
            context: "guild_trial",
            kind
          },
          ts: Date.now()
        }));
      } catch (e) {
        req.settle(null); // socket vanished between check and send
      }
    });
  }

  // WS: loadout_shared. Match the answer to a pending view_loadout —
  // by the member name the server echoes when present (so the game's own
  // UI requesting a loadout mid-burst can never consume one of OUR
  // pending slots) — and cache the normalized loadout keyed
  // "characterId:kind" for the snapshot's entries.
  function handleSharedLoadoutResponse(msg) {
    if (!msg || typeof msg !== "object") return;
    const lo = msg.loadout && typeof msg.loadout === "object" ? msg.loadout : null;
    if (!lo) return;
    const q = trialsSnapshot.pendingViewLoadouts;
    if (!q.length) return; // unsolicited (e.g. the game's party UI)
    const sc = lo.sharableCharacter || {};
    const who = typeof sc.name === "string" ? sc.name.toLowerCase() : null;
    let req = null;
    if (who) {
      const i = q.findIndex((r) => r.name && r.name.toLowerCase() === who);
      if (i === -1) return; // not ours — never shift the FIFO for it
      req = q.splice(i, 1)[0];
    } else {
      req = q.shift();
    }
    if (!req) return;
    const stored = normalizeTrialLoadoutResponse(req.characterId, req.kind, lo, req.name);
    trialsSnapshot.trialLoadouts[req.characterId + ":" + req.kind] = stored;
    console.log(`[STL] captured trial loadout: ${(stored.name || "member " + req.characterId)} (${req.kind}, ${stored.equipment.length} gear)`);
    // A tooltip may be open on this member — refresh it in place so the
    // new trial section appears live as each capture settles.
    try {
      if (gearTipCid === req.characterId) refreshGearTip();
    } catch (e) { /* UI-only refresh */ }
    req.settle(lo);
  }

  // Burst: fetch the signed-up loadout for every (member, kind) pair
  // signed up this week that we don't have cached yet. Invoked from the
  // roster overlay's "Pull Trials" button (manual by design) — a pass
  // only pays for what's missing (cached pairs are skipped). Sequential,
  // one request per second (TRIAL_LOADOUT_FETCH.gapMs) so a full roster
  // takes a few minutes; the name-matched FIFO still tolerates slow
  // answers. Returns this pass's count; the optional `onProgress(done,
  // total, captured)` callback reports per-request progress to the caller
  // (the roster overlay's footer line).
  async function fetchWeekTrialLoadouts(onProgress) {
    if (loadoutBurstRunning || !socketReady()) return 0;
    const s = trialsSnapshot;
    const targets = [];
    for (const key of Object.keys(s.signups)) {
      const su = s.signups[key];
      if (!su) continue;
      const cid = Number(key);
      if (!Number.isInteger(cid) || cid <= 0) continue;
      for (const kind of ["skilling", "combat"]) {
        const k = su[kind];
        if (!k || !k.trialHrid) continue; // not signed up for that trial
        if (s.trialLoadouts[cid + ":" + kind]) continue; // already cached
        targets.push({ cid, kind, name: su.name || null });
      }
      if (targets.length >= TRIAL_LOADOUT_FETCH.maxTargets) break;
    }
    if (!targets.length) return 0;
    loadoutBurstRunning = true;
    // While this is true, the socket hook keeps the game's "X's Loadout"
    // popups closed (see neuterLoadoutFrameForGame). Belt and braces — the
    // same trick the roster "Pull" button uses for the profile popup: a
    // <style> that display:none's the game's SharableProfile modal classes
    // (CSS-module hashes from the CURRENT game build; if they ever drift,
    // the frame-neuter hook is the second line of defense). Removed in the
    // finally so the game UI is untouched again as soon as the burst ends.
    const hideStyleId = "stl-hide-loadout-modal";
    let hideStyle = null;
    try {
      hideStyle = document.createElement("style");
      hideStyle.id = hideStyleId;
      hideStyle.textContent = ".SharableProfile_modalContainer__6Q2JL, .SharableProfile_background__1nCL5, .SharableProfile_modal__2OmCQ { display: none !important; }";
      document.head.appendChild(hideStyle);
    } catch (e) { /* cosmetic guard only — the frame neuter still applies */ }
    console.log("[STL] trial loadout burst started — in-game loadout popups stay closed for the run");
    let captured = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const lo = await requestViewLoadout(t.cid, t.kind, t.name);
        if (lo) captured += 1;
        if (onProgress) {
          try { onProgress(i + 1, targets.length, captured); } catch (e) { /* UI hook only */ }
        }
        await sleep(TRIAL_LOADOUT_FETCH.gapMs);
      }
    } finally {
      loadoutBurstRunning = false;
      if (hideStyle && hideStyle.parentNode) {
        try { hideStyle.parentNode.removeChild(hideStyle); } catch (e) {
          // The node may already be gone (page teardown); either way the
          // burst has stopped, nothing to retry.
        }
      }
    }
    if (captured) {
      console.log(`[STL] trial loadout burst: ${captured} of ${targets.length} remaining loadouts captured`);
    }
    return captured;
  }

  // v1.37.0: loadout fetching is MANUAL ONLY — the panel's "⚙ Trial
  // Loadouts" button is the sole trigger (there are no auto-sweeps and
  // pushes no longer gap-fill). The SERVER CONTEXT ROLLS at the weekly
  // reset, so anything the button cached MID-WEEK is what rides along
  // with the next push (a rollover push carries the old week's cached
  // map; a fresh burst mid-week paces one view_loadout per second).

  const toStatNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // Flatten a capture buffer into the ledger's entry shape — one row per
  // (member, kind, trial): first the guild-wide stat rows (actual
  // participants), then any signed-up member who has no stat row (out for
  // the trial). data carries the game's stat fields plus the signup's
  // loadoutId/roleHrid, the resolved gear names (profile pull, when this
  // client ran one) and — when captured this week — the member's actual
  // signed-up TRIAL loadout (data.trialLoadout: gear per slot with the
  // item's equipment type, the loadout's equipped abilities, and combat
  // consumables), which the History page's gear menu shows in preference
  // to the "currently equipped" profile snapshot.
  function buildSnapshotEntries(statRows, signups, weekKey, loadouts) {
    loadouts = loadouts || trialsSnapshot.trialLoadouts;
    const entries = [];
    const seen = {};
    // The mid-week capture of this member's signed-up loadout for this
    // trial, when the fetch covered it (null = not captured this client).
    const trialLoadoutFor = (cid, kind) => {
      const tl = (loadouts && (loadouts[cid + ":" + kind] || loadouts[String(cid) + ":" + kind])) || null;
      if (!tl || tl.kind !== kind) return null;
      return {
        kind: tl.kind,
        hasLoadout: !!tl.hasLoadout,
        actionTypeHrid: tl.actionTypeHrid || null,
        equipment: (tl.equipment || []).slice(),
        abilities: (tl.abilities || []).slice(),
        consumables: (tl.consumables || []).slice()
      };
    };
    const nameFor = (cid) => {
      const s = signups[cid];
      if (s && s.name) return s.name;
      const m = guildMembers.find((g) => g && Number(g.characterId) === Number(cid));
      return m ? String(m.characterName) : null;
    };
    const addEntry = (cid, kind, hrid, data) => {
      if (hrid === null || hrid === undefined) return;
      const key = Number(cid) + "|" + kind + "|" + String(hrid).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      const name = nameFor(cid);
      entries.push({
        memberId: Number(cid),
        memberName: name ? String(name).slice(0, 80) : "",
        trialKind: kind,
        trialId: String(hrid).toLowerCase(),
        capturedAt: Date.now(),
        data
      });
    };
    if (Array.isArray(statRows)) {
      for (const row of statRows) {
        if (!row || row.characterId === undefined || row.characterId === null || !row.trialHrid) continue;
        const cid = Number(row.characterId);
        if (!Number.isInteger(cid) || cid <= 0) continue;
        const kind = String(row.trialHrid).indexOf("/guild_combat/") === 0 ? "combat" : "skilling";
        const su = (signups[cid] && signups[cid][kind]) || null;
        const data = {
          participant: true,
          damageDealt: toStatNum(row.damageDealt),
          healingDone: toStatNum(row.healingDone),
          premitigatedDamageTaken: toStatNum(row.premitigatedDamageTaken),
          workDone: toStatNum(row.workDone)
        };
        if (su) {
          if (su.loadoutId != null) data.loadoutId = Number(su.loadoutId);
          if (su.roleHrid) data.roleHrid = String(su.roleHrid);
          const loadout = resolveLoadoutGroup(cid, su.loadoutId);
          if (loadout) data.loadout = loadout;
        }
        // The actual signed-up loadout this week (mid-week capture) beats
        // the profile-pull snapshot above; either may be absent.
        const trialLoadout = trialLoadoutFor(cid, kind);
        if (trialLoadout) data.trialLoadout = trialLoadout;
        addEntry(cid, kind, row.trialHrid, data);
      }
    }
    if (signups && typeof signups === "object") {
      const ids = Object.keys(signups).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      for (const cid of ids) {
        const s = signups[cid];
        if (!s) continue;
        for (const kind of ["skilling", "combat"]) {
          const su = s[kind];
          if (!su || !su.trialHrid) continue;
          const data = { participant: false };
          if (su.loadoutId != null) data.loadoutId = Number(su.loadoutId);
          if (su.roleHrid) data.roleHrid = String(su.roleHrid);
          const loadout = resolveLoadoutGroup(cid, su.loadoutId);
          if (loadout) data.loadout = loadout;
          const trialLoadout = trialLoadoutFor(cid, kind);
          if (trialLoadout) data.trialLoadout = trialLoadout;
          addEntry(cid, kind, su.trialHrid, data);
        }
      }
    }
    // No client-side cap: the push is the week's COMPLETE picture — the
    // ledger replaces the week's stored rows with it (latest push wins) —
    // so truncating the tail here would silently drop real members from
    // the History page. The server's 20 MB body limit + 5000-entry cap
    // are the runaway guards.
    return entries;
  }

  function snapshotApiBase() {
    try {
      const b = cfgGet().apiBase;
      return b ? String(b).replace(/\/+$/, "") : "";
    } catch (e) {
      return "";
    }
  }

  // Ask the game to (re)send the week's guild-wide trial stat list —
  // the same { type: "get_guild_trial_stats" } request the in-game Stats
  // dialog fires — then wait (bounded) for the guild_trial_stats_updated
  // answer, so a push records the server's current view even if this
  // client was offline while the trials ran. Resolves true when a fresh
  // answer arrived within the window.
  function requestGuildTrialStats(timeoutMs) {
    return new Promise((resolve) => {
      let sent = false;
      try {
        if (gameSocket && typeof gameSocket.send === "function" && gameSocket.readyState === 1) {
          gameSocket.send(JSON.stringify({ type: "get_guild_trial_stats" }));
          sent = true;
        }
      } catch (e) { /* socket vanished between check and send */ }
      if (!sent) { resolve(false); return; }
      const stamp = trialsSnapshot.statListUpdatedAt;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearInterval(tick);
        clearTimeout(deadline);
        resolve(v);
      };
      const tick = setInterval(() => {
        if (trialsSnapshot.statListUpdatedAt !== stamp) finish(true);
      }, 150);
      const deadline = setTimeout(
        () => finish(trialsSnapshot.statListUpdatedAt !== stamp),
        timeoutMs || SNAPSHOT_STATS_REFRESH_MS
      );
    });
  }

  // The wire form of the captured per-trial tile values: one compact row
  // per trial. The server re-derives the "Lv.N" the in-game tile shows
  // from `tier` (100 + 10 * (tier - 1) — the game's own formula), so the
  // client only ships tier/points/progress/done.
  function serializeTrialStats(map) {
    const out = [];
    if (map && typeof map === "object") {
      for (const hrid of Object.keys(map)) {
        const p = map[hrid];
        if (!p || typeof p !== "object") continue;
        if (p.kind !== "skilling" && p.kind !== "combat") continue;
        if (typeof hrid !== "string" || !hrid) continue;
        out.push({
          trialKind: p.kind,
          trialId: hrid,
          tier: Math.max(0, Math.round(Number(p.tier) || 0)),
          points: Math.max(0, Math.round(Number(p.points) || 0)),
          progress: Math.min(1, Math.max(0, Number(p.progress) || 0)),
          done: Boolean(p.done),
          capturedAt: Number(p.capturedAt) || Date.now()
        });
      }
    }
    return out;
  }

  // The character IDs this client currently knows as belonging to the
  // guild — the same roster data (guildCharacterMap /
  // guildSharableCharacterMap, unioned across the guild messages seen on
  // this page load) that the live-roster push sends. When the roster was
  // never captured yet, null: verification is impossible and entries
  // must not be dropped.
  function rosterIdSet() {
    if (!Array.isArray(guildMembers) || guildMembers.length === 0) return null;
    const set = new Set();
    for (const m of guildMembers) {
      const id = Number(m && m.characterId);
      if (Number.isInteger(id) && id > 0) set.add(id);
    }
    return set;
  }

  // Drop anything in a snapshot that belongs to members the client's
  // guild roster no longer knows: rows by their characterId, signups by
  // their characterId key, loadouts by the "charId:kind" key. A `null`
  // roster (never captured) passes everything through unchanged.
  function filterSnapshotToRoster(rows, signups, loadouts) {
    const roster = rosterIdSet();
    if (roster === null) {
      return { rows: rows, signups: signups, loadouts: loadouts, dropped: 0 };
    }
    const inRoster = (id) => {
      const n = Number(id);
      return Number.isInteger(n) && n > 0 && roster.has(n);
    };
    let dropped = 0;
    const keptRows = [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const id = row && row.characterId;
        if (inRoster(id)) keptRows.push(row);
        else dropped += 1;
      }
    }
    const keptSignups = {};
    if (signups && typeof signups === "object") {
      for (const key of Object.keys(signups)) {
        if (inRoster(key)) keptSignups[key] = signups[key];
        else dropped += 1;
      }
    }
    const keptLoadouts = {};
    if (loadouts && typeof loadouts === "object") {
      for (const key of Object.keys(loadouts)) {
        // loadout keys are "<characterId>:<skilling|combat>"
        if (inRoster(String(key).split(":")[0])) keptLoadouts[key] = loadouts[key];
        else dropped += 1;
      }
    }
    return { rows: keptRows, signups: keptSignups, loadouts: keptLoadouts, dropped: dropped };
  }

  // Push one week's snapshot to the ledger. `buffer` is optional: when
  // omitted the LIVE capture state (this week) goes up, after a
  // best-effort get_guild_trial_stats refresh (see above); a rollover
  // push passes the OLD week's buffer explicitly and skips the refresh
  // (the live list already belongs to the new week). All failure paths
  // resolve with a human-readable string — a snapshot miss must never
  // break the rest of the sweep.
  async function pushTrialSnapshot(weekKey, opts) {
    const o = opts || {};
    const apiBase = o.apiBase || snapshotApiBase();
    if (!weekKey || !apiBase || trialsSnapshot.pushInFlight) return null;
    if (!o.force && trialsSnapshot.lastPushedWeekKey === weekKey) return null;
    trialsSnapshot.pushInFlight = true;
    try {
      const buffer = o.buffer || null;
      const live = buffer === null;
      let rows, signups, loadouts, trialStats;
      if (live) {
        await requestGuildTrialStats(SNAPSHOT_STATS_REFRESH_MS);
        // Re-read AFTER the refresh: captureSnapshotStats replaces
        // trialsSnapshot.statRows with a new array when the answer
        // arrives, so a pre-await reference would be stale/empty.
        rows = trialsSnapshot.statRows;
        signups = trialsSnapshot.signups;
        // Trial loadouts are fetched ONLY by the roster overlay's "Pull
        // Trials" button (manual by design — no burst is ever fired as a
        // side effect of a push); whatever the button cached this week
        // rides along here.
        loadouts = trialsSnapshot.trialLoadouts;
        trialStats = trialsSnapshot.trialProgress || {};
      } else {
        rows = buffer.statRows || [];
        signups = buffer.signups || {};
        loadouts = buffer.trialLoadouts || {}; // captured mid-week; a fresh burst is impossible after the server rolled the week
        trialStats = buffer.trialStats || {}; // the OLD week's tile values, captured mid-week
      }
      const trialStatsWire = serializeTrialStats(trialStats);
      console.log(`[STL] snapshot push ${weekKey} (${o.reason || "auto"}): rows=${rows.length}, signups=${Object.keys(signups).length}, loadouts=${Object.keys(loadouts).length}, trialStats=${trialStatsWire.length}, statsUpdated=${trialsSnapshot.statListUpdatedAt || "never"}`);
      // Verify every entrant is still in the guild before sending: someone
      // who left (or was kicked) mid-week should not keep showing up on the
      // History page. Same roster source as the live-roster push — if this
      // client never captured one, filterSnapshotToRoster passes everything
      // through unchanged.
      const verified = filterSnapshotToRoster(rows, signups, loadouts);
      rows = verified.rows;
      signups = verified.signups;
      loadouts = verified.loadouts;
      if (verified.dropped > 0) {
        console.log(`[STL] snapshot push ${weekKey}: excluded ${verified.dropped} entr(y/ies) not found in the live guild roster`);
      }
      const entries = buildSnapshotEntries(rows, signups, weekKey, loadouts);
      if (entries.length === 0 && trialStatsWire.length === 0) {
        return "No participant or signup data for " + weekKey + " — nothing to snapshot.";
      }
      const res = await gmRequest("POST", `${apiBase}/api/trial-snapshots`, { weekKey, entries, trialStats: trialStatsWire });
      if (res.status === 200) {
        let upserted = entries.length;
        let cleared = 0;
        try {
          const p = JSON.parse(res.responseText);
          if (p && Number.isFinite(Number(p.upserted))) upserted = Number(p.upserted);
          if (p && Number.isFinite(Number(p.cleared))) cleared = Number(p.cleared);
        } catch (e) { /* keep the local counts */ }
        trialsSnapshot.lastPushedWeekKey = weekKey;
        trialsSnapshot.lastPushAt = Date.now();
        trialsSnapshot.lastPushRichness = snapshotRichness(rows, signups, loadouts);
        trialsSnapshot.lastPushTrialStats = JSON.stringify(trialStatsWire);
        const okMsg = `Snapshot pushed: ${upserted} entries for ${weekKey} (${o.reason || "auto"}).` +
          (cleared > 0 ? ` Cleared ${cleared} stale stored entr(y/ies) the latest week push no longer lists.` : "");
        console.log("[STL] " + okMsg);
        return okMsg;
      }
      const failMsg = `Snapshot push failed (${res.status}): ${res.responseText || ""}`.trim();
      console.log("[STL] " + failMsg);
      return failMsg;
    } catch (err) {
      const failMsg = `Snapshot push failed: ${err && err.message ? err.message : String(err)}`;
      console.log("[STL] " + failMsg);
      return failMsg;
    } finally {
      trialsSnapshot.pushInFlight = false;
    }
  }

  // v1.37.0: the ledger's old "Snapshot now" pending-request round-trip
  // (site button arms a request → this client's sweep polled it and
  // dispatched the push) is gone — snapshots now go out exactly like the
  // guild roster does: rollover/completion fire automatically, and a
  // member's panel "Push Trials" button sends a direct guild-gated push
  // (see buildPanel). No meta-poll of the ledger remains.

  function captureCombatTrials(msg) {
    if (!msg || typeof msg !== "object") return;
    const set = msg.guildWeeklyTrialSet;
    if (set && Array.isArray(set.combatHrids) && set.combatHrids.length > 0) {
      combatTrialHrids = set.combatHrids.slice(0, 5);
      combatTrialsSent = false; // a new/changed week may need re-pushing
    }
  }

  // One shared driver for the week's trial-hrid pushes (combat + skilling).
  // A push goes out ONLY when the panel order is CONFIRMED through a data
  // channel — no panel/UI interaction:
  //   1. the game's static guild-trial table (guildTrialDetailMap — see
  //      captureGuildTrialDetails), the exact table the game sorts the
  //      Guild → Trials panel by;
  //   2. a Guild → Trials DOM read (panelTrialOrder) when that tab is the
  //      active sub-panel and its tiles show exactly this week's trials;
  //   3. (skilling only) the game's own currentTrialsData payload — the
  //      skilling.parties key order (skillingPanelOrderHrids).
  // If none confirms it, the push is HELD (skip note returned, the sent
  // flag stays false) so the raw order is never stored — a later sync,
  // panel read, or rollover re-pushes once it is confirmed. A failure never
  // blocks the rest of a sync/pull.
  async function pushTrialHrids(spec) {
    if (spec.isSent() || !spec.raw || spec.raw.length === 0) return null;
    const fromTable = spec.orderFromTable(spec.raw); // from the static table — no UI
    const panelNames = panelTrialOrder ? panelTrialOrder[spec.kind] : null; // cached DOM order (if any)
    const fromPanel = (fromTable == null && Array.isArray(panelNames) && panelNames.length > 0
      && panelOrderMatches(spec.raw, panelNames))
      ? reorderHridsToPanelOrder(spec.raw, panelNames)
      : null;
    const fromData = (fromTable == null && fromPanel == null && spec.orderFromData)
      ? spec.orderFromData()
      : null;
    let confirmed = null;
    for (const candidate of [fromTable, fromPanel, fromData]) {
      if (candidate && candidate.length > 0) { confirmed = candidate; break; }
    }
    if (!confirmed) return spec.heldNote;
    const res = await gmRequest("POST", spec.apiBase + spec.endpoint, spec.payload(confirmed));
    if (res.status === 200) {
      spec.markSent(confirmed);
      return `Pushed this week's ${spec.label} trials (${confirmed.length}) to the ledger.`;
    }
    return `${spec.failLabel} push failed (${res.status}): ${res.responseText}`;
  }

  // Push this week's combat-trial hrids so the Combat Dashboard can name the
  // two teams after the monsters. Only the static table + DOM read confirm
  // combat order (no currentTrialsData for combat). One-time per page load.
  async function pushCombatTrials(apiBase) {
    return pushTrialHrids({
      apiBase, kind: "combat", raw: combatTrialHrids,
      isSent: () => combatTrialsSent,
      // markSent seeds the panel-order self-correction baseline
      markSent: (h) => { combatTrialsSent = true; lastCombatPush = h; },
      orderFromTable: (h) => orderTrialHrids(h),
      endpoint: "/api/combat-trials",
      payload: (h) => ({ combatHrids: h }),
      label: "combat", failLabel: "Combat-trial",
      heldNote: "Combat trials: held (order not confirmed yet — will push once it is known)."
    });
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

  // Push this week's skilling-trial hrids so the Skilling Dashboard
  // auto-selects this week's skills in the in-game panel order. The raw
  // guildWeeklyTrialSet.skillHrids array is NOT the panel order (the game
  // sorts it by a static per-trial sortIndex), and unlike combat the
  // currentTrialsData payload is also a valid confirmation source (orderFromData).
  async function pushSkillingTrials(apiBase) {
    return pushTrialHrids({
      apiBase, kind: "skilling", raw: skillingTrialHrids,
      isSent: () => skillingTrialsSent,
      // markSent seeds the panel-order self-correction baseline
      markSent: (h) => { skillingTrialsSent = true; lastSkillingPush = h; },
      orderFromTable: (h) => orderTrialHrids(h),
      orderFromData: () => skillingPanelOrderHrids(),
      endpoint: "/api/skilling-trials",
      payload: (h) => ({ skillHrids: h }),
      label: "skilling", failLabel: "Skilling-trial",
      heldNote: "Skilling trials: held (order not confirmed yet — will push once it is known)."
    });
  }

  // Push all full trial profiles to the ledger via POST /api/member-profiles/sync.
  async function pushPulledProfiles(apiBase) {
    const entries = Object.values(pulledProfilesFull).filter((p) => p && p.characterId !== null);
    if (entries.length === 0) {
      return "No full profiles captured — Pull Members first (or reload so our own profile is captured).";
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
    if (trackerDisabled() || !cfgGet().autoSyncEnabled) return; // v1.37.0: off for this character, or auto-sync disabled
    if (detectedCharacterId === null) return; // no identity captured yet
    const apiBase = cfgGet().apiBase.replace(/\/$/, "");
    if (!apiBase || autoSyncInFlight || !autoSyncDue()) return;
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
    #stl-update-banner .stl-update-link { color: #8a5a00; font-weight: 600; }
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
    /* v1.37.0: the per-character "tracker is OFF" state — an amber note
       above the re-enable control in the in-game Settings tab (the one UI
       the switch can never remove: it is the escape hatch back on). */
    #stlt-disabled-note {
      margin: 10px 0 6px; padding: 8px 10px; border-radius: 6px;
      border: 1px solid rgba(245, 197, 66, 0.45);
      background: rgba(120, 96, 20, 0.25);
      color: #ffe08a; font-size: 12px; line-height: 1.45;
      font-family: system-ui, sans-serif; text-transform: none; letter-spacing: 0;
    }
    #stlt-disabled-note:empty { display: none; }
    #stlt-enabled { transform: scale(1.2); cursor: pointer; }
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
    /* Shared with the in-game Settings tab's #stlt- inputs/labels (the
       tab's copy sits in the game's own DOM, whose default font is not
       system-ui — so font-family is stated explicitly; on #stl-panel it is
       already the inherited value, i.e. a no-op there). */
    #stl-panel input:not([type=checkbox]), #stl-settings-tab-panel input:not([type=checkbox]) {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.15); background: #101117; color: #fff; font-size: 13px;
      font-family: system-ui, sans-serif;
    }
    #stl-panel label.stl-check, #stl-settings-tab-panel label.stl-check {
      display: flex; align-items: center; gap: 6px; margin-top: 10px;
      text-transform: none; letter-spacing: 0; font-size: 12px; color: #f3f3f7; cursor: pointer;
    }
    #stl-panel label.stl-check input, #stl-settings-tab-panel label.stl-check input { width: auto; margin: 0; }
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
    #stl-characterId, #stlt-characterId, #stl-characterName, #stlt-characterName {
      background: #17181f; color: #e8eaf3; border-color: rgba(255,255,255,0.08);
      pointer-events: none; user-select: none;
    }
    #stl-characterId, #stlt-characterId { -moz-appearance: textfield; appearance: textfield; }
    #stl-characterId::-webkit-outer-spin-button,
    #stlt-characterId::-webkit-outer-spin-button,
    #stl-characterId::-webkit-inner-spin-button,
    #stlt-characterId::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #stl-actions, #stl-settings-tab-panel .stlt-save { display: flex; gap: 8px; margin-top: 12px; }
    #stl-actions button, #stl-settings-tab-panel .stlt-save button {
      flex: 1; padding: 7px 0; border-radius: 6px; border: none; cursor: pointer; font: 600 12px system-ui, sans-serif;
    }
    #stl-send { background: #a86a0c; color: #fff; }
    #stl-save, #stlt-save { background: #333; color: #fff; }
    #stl-reset, #stlt-reset { background: #7a2d24; color: #fff; }
    #stl-status, #stlt-status { margin-top: 10px; font-size: 11px; color: #b7b9cc; white-space: pre-line; }
    #stl-status.err, #stlt-status.err { color: #e2564a; }
    #stl-status.ok, #stlt-status.ok { color: #35c25a; }
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
    #stl-login .stl-login-optional { font-size: 11px; font-style: italic; color: #b7b9cc; margin: 0 0 6px; }
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
    /* Extra gap splits the toolbar into the roster group (left) and the
       trial group (right); harmless if the buttons wrap on a narrow panel. */
    #stl-ov-loadouts { background: #3a3f5c; margin-left: 20px; }
    #stl-ov-push-snapshot { background: #1f6f43; }
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
    /* v1.37.0 — gear tooltip: hover a member's name to see their loadouts
       (equipment + enhancement), like the combat sim's character view. */
    #stl-overlay-table td.stl-col-name { cursor: help; }
    #stl-gear-tip {
      position: fixed; z-index: 1000000; display: none; box-sizing: border-box;
      min-width: 230px; max-width: 360px; max-height: 62vh; overflow-y: auto;
      background: #1b1c26; border: 1px solid #3a3c52; border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.55); padding: 10px 12px;
      font: 12.5px system-ui, sans-serif; color: #d5d7ea;
    }
    #stl-gear-tip .stl-gt-name { font-size: 13px; font-weight: 700; color: #fff; }
    #stl-gear-tip .stl-gt-id { color: #888aa5; font-weight: 400; font-size: 11px; }
    #stl-gear-tip .stl-gt-loadout { margin-top: 8px; padding-top: 6px; border-top: 1px solid #2b2d40; }
    #stl-gear-tip .stl-gt-lo-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; }
    #stl-gear-tip .stl-gt-lo-name { font-weight: 600; color: #f0d98c; }
    #stl-gear-tip .stl-gt-lo-skill { color: #888aa5; font-size: 11px; }
    #stl-gear-tip .stl-gt-tag {
      font-size: 10.5px; line-height: 15px; padding: 0 6px; border-radius: 8px;
      background: #2b2d40; color: #b7b9cc; white-space: nowrap;
    }
    #stl-gear-tip .stl-gt-tag.trial { background: #4a3413; color: #ffd700; }
    #stl-gear-tip .stl-gt-row { display: flex; gap: 8px; margin-top: 3px; }
    #stl-gear-tip .stl-gt-slot { flex: 0 0 88px; color: #888aa5; font-size: 11.5px; }
    #stl-gear-tip .stl-gt-item { color: #e8eaf3; }
    #stl-gear-tip .stl-gt-enh { color: #79c0ff; font-weight: 600; font-size: 11px; margin-left: 4px; }
    #stl-gear-tip .stl-gt-note { margin-top: 8px; color: #888aa5; font-size: 11.5px; font-style: italic; }
    /* The "Pull Trials" capture: this week's signed-up loadout(s). */
    #stl-gear-tip .stl-gt-trial { margin-top: 8px; padding-top: 6px; border-top: 1px solid #2b2d40; }
    #stl-gear-tip .stl-gt-trial-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; }
    #stl-gear-tip .stl-gt-trial-kind { font-weight: 600; color: #ffd700; }
    #stl-gear-tip .stl-gt-cons { color: #9fe8b0; }
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
    // v1.37.x: pull and the snapshot push lock the WHOLE toolbar (no
    // concurrent runs); the trial-loadouts burst runs quietly in the
    // background and locks ONLY its own button — that rule also has to
    // survive any unlock that happens while the burst is mid-flight.
    for (const id of ["stl-ov-pull", "stl-ov-pause", "stl-ov-push", "stl-ov-push-snapshot"]) {
      const b = overlayEl.querySelector("#" + id);
      if (b) b.disabled = disabled;
    }
    const lo = overlayEl.querySelector("#stl-ov-loadouts");
    if (lo) lo.disabled = disabled || loadoutBurstRunning;
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

// Minimized pill: the quiet home of every background run — show it
        // while the panel is tucked away and a pull or loadouts burst is in
        // flight, and keep it up afterwards while a burst's completion
        // summary is pending (cleared when the panel is restored).
        const pill = overlayEl.querySelector("#stl-overlay-pill");
        if (pill) {
          const pillStatus = pill.querySelector(".stl-pill-status");
          const lo = overlayState.loadouts;
          const visible =
            (pullState.running || lo.running || (overlayState.loadoutsAck && lo.captured > 0))
            && overlayState.minimized;
          pill.classList.toggle("stl-pill-visible", visible);
          if (visible) applyOverlayPillPosition(pill);
          if (visible && pillStatus) {
            if (pullState.running) {
              pillStatus.textContent = pullState.paused
                ? `Paused ${pullState.fetched}/${pullState.total}`
                : `Pulling ${pullState.fetched}/${pullState.total}…`;
            } else if (lo.running) {
              pillStatus.textContent = lo.total > 0
                ? `Fetching loadouts ${lo.done}/${lo.total}…`
                : `Fetching loadouts… ${lo.done} requested`;
            } else {
              pillStatus.textContent = `${lo.captured} trial loadouts fetched`;
            }
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
        // A "Pull Trials" capture counts as captured data too: a member
        // whose trial loadout was fetched gets the same full-bright row
        // as a pulled profile, even if no full profile was ever pulled
        // (the skill columns then just show "–" — hover the name for the
        // trial loadout details).
        const tl = weekTrialLoadouts(m.characterId);
        const missing = !p && !tl.skilling && !tl.combat;
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
        // v1.37.0: data-stl-cid ties the row to its member so the gear
        // tooltip can resolve the row's profile even after re-renders.
        return `<tr class="${missing ? "stl-row-missing" : ""}" data-stl-cid="${m.characterId}">
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
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]
    );
  }

  // v1.35.1: "/abilities/pestilent_shot" -> "Pestilent Shot" for the
  // roster overlay's Abilities column (same convention as the site).
  // Title-case an underscored hrid tail ("pestilent_shot" -> "Pestilent
  // Shot") — shared by the roster Abilities column and the gear tooltip.
  function titleizeHridTail(tail) {
    const parts = String(tail).split("_").filter(Boolean);
    if (parts.length === 0) return String(tail);
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }

  function abilityTail(hrid) {
    return titleizeHridTail(String(hrid).split("/").pop() || "");
  }

  // ---------------------------------------------------------------------
  // v1.37.0: gear hover tooltip for the roster overlay.
  //
  // Hover a member's name to see their equipment the way the combat
  // simulator shows a character's gear: every loadout (its name, the
  // skill it's used for, a "default" tag, and a "this week's …" tag for
  // the loadout the member signed up with on a trial), with the item
  // names (+ enhancement) per slot under each.
  //
  // Sources:
  //   - pulledProfilesFull[cid].loadouts — each pulled member's FULL
  //     loadout set (profile_shared carries characterLoadoutMap, same
  //     shape our own init snapshot uses);
  //   - ensureItemNameMap() — the game's itemDetailMap, for names;
  //   - trialsSnapshot.signups[cid] — this week's signups, to tag which
  //     loadout actually ran the trials.
  // Enhancement levels shown for SAVED loadouts are the ones the game
  // ACTUALLY equips: its default "use highest enhancement level" mode runs
  // the best copy the member owns, which can be higher than the level the
  // loadout reference was written at (the site's gear menus apply the same
  // rule); loadouts with the game's "use exact enhancement level" checkbox
  // show the level as written. Trial-section levels come from the game's
  // own trial-loadout answer and are already resolved.
  // Hovering never triggers a fetch: the tooltip only shows what
  // "Pull Members" (full gear) and "Pull Trials" (this week's
  // signed-up loadouts) have already captured — an on-demand per-member
  // fetch used to fire here and was removed (it made hover traffic hit
  // the game socket). When nothing is captured yet the tip says so and
  // points at the two toolbar buttons.
  // ---------------------------------------------------------------------
  let gearTipEl = null; // tooltip node (lazy)
  let gearTipCid = null; // member id the tooltip is showing (null = hidden)
  let gearTipTimer = null; // hover-dwell timer
  let gearTipXY = null; // last known cursor position [x, y] — the tip shows at it

  function ensureGearTipEl() {
    if (gearTipEl) return gearTipEl;
    const tip = document.createElement("div");
    tip.id = "stl-gear-tip";
    (overlayEl || document.body).appendChild(tip);
    // The tip is readable on hover: entering it cancels a pending hide.
    tip.addEventListener("mouseenter", () => {
      if (gearTipTimer) { clearTimeout(gearTipTimer); gearTipTimer = null; }
    });
    tip.addEventListener("mouseleave", () => scheduleHideGearTip(120));
    gearTipEl = tip;
    return tip;
  }

  // "/equipment_locations/robe_top" -> "Robe Top"; plain labels pass
  // through untouched.
  function gearLabel(hrid) {
    const s = String(hrid || "").trim();
    if (!s) return "";
    const tail = s.split("/").pop() || s;
    if (!s.includes("/") && !tail.includes("_")) return s;
    return titleizeHridTail(tail);
  }

  // Loadouts this member committed to this week's trials, keyed by
  // numeric loadoutId -> "<kind>: <trial>" e.g. "combat: Dragon Slayer".
  function weekTrialLoadoutTags(cid) {
    const tags = {};
    const s = trialsSnapshot.signups[cid] || trialsSnapshot.signups[String(cid)] || null;
    if (!s) return tags;
    for (const kind of ["skilling", "combat"]) {
      const sub = s[kind];
      if (!sub || sub.loadoutId === null || sub.loadoutId === undefined) continue;
      const n = Number(sub.loadoutId);
      if (!Number.isFinite(n) || n <= 0) continue;
      const trial = String(sub.trialHrid || "")
        .split("/").pop().replace(/_/g, " ").trim();
      tags[n] = kind + (trial ? ": " + trial : "");
    }
    return tags;
  }

  // This member's captured signed-up TRIAL loadouts (the Pull Trials
  // fetch), kind -> normalized loadout; `null` = not captured on this
  // client yet. Independent of a profile pull: a member whose profile
  // was never pulled can still have a captured trial loadout, which is
  // exactly what this lets the roster overlay show for them.
  function weekTrialLoadouts(cid) {
    const out = {};
    const cache = trialsSnapshot.trialLoadouts;
    if (cache && typeof cache === "object") {
      for (const kind of ["skilling", "combat"]) {
        const lo = cache[cid + ":" + kind] || cache[String(cid) + ":" + kind];
        if (lo && typeof lo === "object") out[kind] = lo;
      }
    }
    return out;
  }

  // The tooltip's "This week's trial loadouts" section: per signed-up
  // kind, the gear per slot (item name + enhancement), the loadout's
  // equipped abilities, and combat consumables.
  function buildTrialTipSections(cid) {
    const trials = weekTrialLoadouts(cid);
    if (!trials.skilling && !trials.combat) return "";
    const names = ensureItemNameMap();
    const itemName = (hrid) => {
      const d = names[hrid];
      return (d && typeof d.name === "string" && d.name)
        || String(hrid).split("/").pop().replace(/_/g, " ");
    };
    let html = `<div class="stl-gt-note">This week's trial loadouts (Pull Trials)</div>`;
    for (const kind of ["skilling", "combat"]) {
      const lo = trials[kind];
      if (!lo) continue;
      let rows = "";
      for (const eq of lo.equipment || []) {
        if (!eq || !eq.itemHrid) continue;
        const enh = typeof eq.enhancementLevel === "number" && eq.enhancementLevel > 0
          ? `<span class="stl-gt-enh">+${eq.enhancementLevel}</span>`
          : "";
        rows += `<div class="stl-gt-row">` +
          `<span class="stl-gt-slot">${escapeHtml(gearLabel(eq.slotType) || gearLabel(eq.slot) || String(eq.slot || "Item"))}</span>` +
          `<span class="stl-gt-item">${escapeHtml(itemName(eq.itemHrid))}${enh}</span></div>`;
      }
      for (const a of lo.abilities || []) {
        if (!a || !a.abilityHrid) continue;
        rows += `<div class="stl-gt-row">` +
          `<span class="stl-gt-slot">Ability</span>` +
          `<span class="stl-gt-item">${escapeHtml(abilityTail(a.abilityHrid))}${a.level > 0 ? ` <b>Lv${a.level}</b>` : ""}</span></div>`;
      }
      for (const c of lo.consumables || []) {
        if (!c || !c.itemHrid) continue;
        const enh = typeof c.enhancementLevel === "number" && c.enhancementLevel > 0
          ? `<span class="stl-gt-enh">+${c.enhancementLevel}</span>`
          : "";
        rows += `<div class="stl-gt-row">` +
          `<span class="stl-gt-slot">Consumable</span>` +
          `<span class="stl-gt-item stl-gt-cons">${escapeHtml(itemName(c.itemHrid))}${(c.count > 1 ? " ×" + c.count : "")}${enh}</span></div>`;
      }
      const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
      const head = `<span class="stl-gt-trial-kind">⚙ ${kindLabel}</span>` +
        (lo.actionTypeHrid ? `<span class="stl-gt-lo-skill">${escapeHtml(gearLabel(lo.actionTypeHrid))}</span>` : "");
      html += `<div class="stl-gt-trial"><div class="stl-gt-trial-head">${head}</div>` +
        (rows || `<div class="stl-gt-note">signed up, but the loadout was captured as empty</div>`) +
        `</div>`;
    }
    return html;
  }

  // Highest enhancement level the member OWNS of each item, from the raw
  // captured profile (their every item instance + their current gear) —
  // mirrors the site-side menus (server/lib/trial-stats.js
  // buildMaxOwnedMap, public/combat.js maxOwnedEnhancementLevels).
  // Returns {} when neither source is present (nothing to resolve).
  function maxOwnedEnhancementLevels(raw) {
    const map = {};
    if (!raw || typeof raw !== "object") return map;
    const bump = (itemHrid, level) => {
      if (!itemHrid) return;
      const lvl = Math.max(0, Math.floor(Number(level) || 0));
      if (lvl > (map[itemHrid] || -1)) map[itemHrid] = lvl;
    };
    const items = raw.characterItems;
    if (items && typeof items === "object") {
      for (const it of Object.values(items)) {
        if (!it || typeof it !== "object") continue;
        if (typeof it.hash === "string") {
          const p = it.hash.split("::"); // charId, slot, itemHrid, level
          if (p.length >= 4) bump(p[2], p[3]);
        }
        if (it.itemHrid && it.enhancementLevel != null) bump(it.itemHrid, it.enhancementLevel);
      }
    }
    const wim = raw.wearableItemMap;
    if (wim && typeof wim === "object") {
      for (const it of Object.values(wim)) {
        if (it && it.itemHrid) bump(it.itemHrid, it.enhancementLevel);
      }
    }
    return map;
  }

  // Does a SAVED loadout use exact (as-written) enhancement levels? The
  // in-game "use highest enhancement level" checkbox is stored as
  // useExactEnhancement on the raw characterLoadoutMap entry: false/absent
  // = the game's default (equip the highest owned copy of each item),
  // true = use the level written in the loadout reference. Saved references
  // can point at an older, lower-level copy — which is why a tooltip that
  // shows the as-written level disagrees with what the game (and the site's
  // gear menus) actually run.
  function loadoutUsesExactEnhancement(prof, lo) {
    if (!prof || !lo || lo.loadoutId == null) return false;
    const clm = prof.raw && prof.raw.characterLoadoutMap;
    if (!clm || typeof clm !== "object") return false;
    const rawLo = clm[String(lo.loadoutId)];
    return !!(rawLo && typeof rawLo === "object" && rawLo.useExactEnhancement === true);
  }

  // Tooltip body for one member: renders whatever is already captured
  // (hover never fetches — see the panel doc block).
  function buildGearTipHtml(member) {
    const cid = member.characterId;
    let html = `<div class="stl-gt-name">${escapeHtml(member.characterName)} <span class="stl-gt-id">(#${cid})</span></div>`;
    const trialSections = buildTrialTipSections(cid);
    const prof =
      pulledProfilesFull[cid] || pulledProfilesFull[String(cid)] || null;
    if (!prof || !Array.isArray(prof.loadouts) || prof.loadouts.length === 0) {
      if (trialSections) {
        // No full profile pulled, but "Pull Trials" cached this
        // member's signed-up loadout(s) — show those.
        html += `<div class="stl-gt-note">No full profile pulled — the captured trial loadouts are shown below.</div>`;
        html += trialSections;
        return html;
      }
      // profile_shared carries hideWearableItems: when a member opts out of
      // gear sharing the wearableItemMap is empty/absent by design, so say
      // so instead of implying a capture failure.
      const hidden = !!(prof && prof.raw && prof.raw.hideWearableItems === true);
      html += hidden
        ? `<div class="stl-gt-note">This member has hidden their gear from other players.</div>`
        : `<div class="stl-gt-note">No gear captured yet — use "Pull Members" (full gear) or "Pull Trials" (this week's trial loadouts).</div>`;
      return html;
    }
    const names = ensureItemNameMap();
    const tags = weekTrialLoadoutTags(cid);
    // Trial-used loadouts first, then the default, then the rest.
    const rank = (lo) => {
      const n = Number(lo.loadoutId) || 0;
      if (tags[n]) return 0;
      if (lo.isDefault) return 1;
      return 2;
    };
    const loadouts = prof.loadouts.slice().sort((a, b) => rank(a) - rank(b));
    let maxOwned = null; // lazy: computed once, when a "highest"-mode saved loadout shows up
    for (const lo of loadouts) {
      const n = Number(lo.loadoutId) || 0;
      // Live/synthesized loadouts (no loadoutId) and "exact" loadouts keep
      // their as-written levels; a SAVED loadout in the game's default
      // "use highest enhancement level" mode shows the best owned copy
      // instead — the level the game actually equips (same rule as the
      // site's gear menus).
      const canBump = lo.loadoutId != null && !loadoutUsesExactEnhancement(prof, lo);
      if (canBump && maxOwned === null) maxOwned = maxOwnedEnhancementLevels(prof.raw);
      let rows = "";
      for (const eq of lo.equipment || []) {
        if (!eq || !eq.itemHrid) continue;
        const d = names[eq.itemHrid];
        const name = (d && typeof d.name === "string" && d.name)
          || String(eq.itemHrid).split("/").pop().replace(/_/g, " ");
        let enhLvl = typeof eq.enhancementLevel === "number" ? eq.enhancementLevel : 0;
        if (canBump && maxOwned && maxOwned[eq.itemHrid] !== undefined
            && maxOwned[eq.itemHrid] > enhLvl) enhLvl = maxOwned[eq.itemHrid];
        const enh = enhLvl > 0 ? `<span class="stl-gt-enh">+${enhLvl}</span>` : "";
        rows += `<div class="stl-gt-row">` +
          `<span class="stl-gt-slot">${escapeHtml(gearLabel(eq.slot) || "Item")}</span>` +
          `<span class="stl-gt-item">${escapeHtml(name)}${enh}</span></div>`;
      }
      const tagsHtml =
        (lo.isDefault ? `<span class="stl-gt-tag">default</span>` : "") +
        (tags[n] ? `<span class="stl-gt-tag trial">${escapeHtml("this week's " + tags[n])}</span>` : "");
      const sub = lo.actionTypeHrid ? `<span class="stl-gt-lo-skill">${escapeHtml(gearLabel(lo.actionTypeHrid))}</span>` : "";
      html += `<div class="stl-gt-loadout">` +
        `<div class="stl-gt-lo-head">` +
        `<span class="stl-gt-lo-name">${escapeHtml(lo.name || ("Loadout #" + (n || "?")))}</span>` +
        sub + tagsHtml +
        `</div>${rows}</div>`;
    }
    if (loadouts.length > 12) {
      html += `<div class="stl-gt-note">…${loadouts.length - 12} more loadout(s)</div>`;
      // (all loadouts still list above — the note is a length cue only)
    }
    // The captured signed-up trial loadout(s) come last — they are a
    // separate, this-week capture (Pull Trials), not part of the
    // profile's full loadout set.
    html += trialSections;
    return html;
  }

  // Render/refresh the open tooltip for gearTipCid. Re-resolves the anchor
  // cell from the live DOM so table re-renders (search filter, pull
  // progress) can't strand the tip on a detached node; the tip itself sits
  // at the user's cursor (see positionGearTip), like the History page's
  // menu, not pinned to the cell edge.
  function refreshGearTip() {
    if (gearTipCid === null) return;
    if (!overlayEl || !overlayEl.classList.contains("stl-overlay-open")) {
      hideGearTip();
      return;
    }
    const member = guildMembers.find((g) => g && g.characterId === gearTipCid);
    if (!member) {
      hideGearTip();
      return;
    }
    const tip = ensureGearTipEl();
    // Gear is read-only now (no hover fetch) — the tip renders whatever a
    // toolbar action already captured.
    tip.innerHTML = buildGearTipHtml(member);
    const anchor = overlayEl.querySelector(`tr[data-stl-cid="${gearTipCid}"] > td.stl-col-name`);
    if (!anchor) {
      hideGearTip();
      return;
    }
    tip.style.display = "block";
    positionGearTip(anchor);
  }

  // Places the tip just past the user's CURSOR (like the History page's
  // menu): right of it +16px, below it +12px, flipped to the other side
  // when it would overflow the viewport. `anchorEl` is only a fallback
  // position source (its center) for refreshes that happen without a
  // captured cursor sample (e.g. a profile fetch settling after the mouse
  // left the table).
  function positionGearTip(anchorEl) {
    const tip = gearTipEl;
    if (!tip) return;
    const rect = tip.getBoundingClientRect();
    let cx = null, cy = null;
    if (gearTipXY) { cx = gearTipXY[0]; cy = gearTipXY[1]; }
    else if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
    if (cx === null) return;
    let x = cx + 16;
    let y = cy + 12;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, cx - rect.width - 16);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, cy - rect.height - 12);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function showGearTip(cid) {
    gearTipCid = Number(cid);
    refreshGearTip();
  }

  function hideGearTip() {
    gearTipCid = null;
    gearTipXY = null;
    if (gearTipTimer) { clearTimeout(gearTipTimer); gearTipTimer = null; }
    if (gearTipEl) gearTipEl.style.display = "none";
  }

  function scheduleHideGearTip(delay) {
    if (gearTipTimer) { clearTimeout(gearTipTimer); gearTipTimer = null; }
    gearTipTimer = setTimeout(hideGearTip, delay);
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
      <button id="stl-ov-pull" type="button" title="Pull every guild member's live skill levels and equipped abilities">Pull Members</button>
      <button id="stl-ov-pause" type="button" title="Pause/Resume the pull" disabled>Pause</button>
      <button id="stl-ov-push" type="button" title="Push the pulled roster to the ledger">Push Members</button>
      <!-- v1.37.0: trial-loadout capture lives in the roster toolbar (its
           "multi-use area" for everyone-in-the-guild actions) — the ONLY
           thing that asks the game for members' signed-up trial loadouts
           (one view_loadout per second; the full roster takes a few
           minutes). Cached results attach to the next snapshot push and
           show on the site's History page. v1.37.x: the run is quiet —
           the panel stays open, progress reports in its footer, the burst
           locks only its own button (and a manual minimize still tucks
           it into the floating pill, which mirrors the same progress). -->
      <button id="stl-ov-loadouts" type="button" title="Fetch the signed-up trial loadouts of every guild member from the game (online or offline — one request per second, the full roster takes a few minutes). Runs in the background; progress shows in the panel's footer (and in the floating pill if you minimize the panel).">Pull Trials</button>
      <!-- v1.37.0: manual mid-week snapshot push — direct and guild-
           gated, the same way the roster's "Push Members" works (no
           site-side "Snapshot now" request). Runs the week's snapshot
           (stats + signups + any loadouts fetched by the button above)
           right now; auto-pushes still happen at the weekly rollover
           and once both trials complete. -->
      <button id="stl-ov-push-snapshot" type="button" title="Push THIS week's trial snapshot (stats + signups + any fetched loadouts) to the site right now, like the roster push above. Guild members only — the ledger verifies your membership. Auto-pushes still happen at the weekly rollover and once both trials are completed.">Push Trials</button>
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

    wireDrag(pill, pill, {
      skipTarget: "button",
      onEnd: (d) => cfgSet({ overlayPillPosition: { left: d.left, top: d.top } })
    });
    applyOverlayPillPosition(pill);

    wireDrag(header, panel, {
      skipTarget: "button",
      clearTransform: true,
      onEnd: (d) => cfgSet({ overlayPosition: { left: d.left, top: d.top } })
    });

    // Read the API base fresh on each action so settings saved in the
    // panel (or Tampermonkey menu) apply without rebuilding the overlay.
    const currentApiBase = () => cfgGet().apiBase.replace(/\/$/, "");

    overlay.querySelector("#stl-overlay-close").addEventListener("click", () => {
      if (pullState.running || loadoutBurstRunning || overlayState.loadoutsAck) {
        // Keep the overlay present so the progress pill stays visible, but
        // hide the panel — equivalent to minimizing while a pull or the
        // loadouts burst is in flight (or its summary is still pending).
        overlayState.minimized = true;
        overlay.classList.add("stl-overlay-minimized");
      } else {
        overlayState.minimized = false;
        overlay.classList.remove("stl-overlay-minimized");
        overlay.classList.remove("stl-overlay-open");
        hideGearTip();
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
      // The burst summary leaves the pill for the panel footer below.
      overlayState.loadoutsAck = false;
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

    // v1.37.0: on-demand trial-loadout capture, home-swapped from the main
    // panel into the roster toolbar (the "multi-use area" for
    // everyone-in-the-guild actions). This is the ONLY trigger for
    // view_loadout bursts (no auto-sweeps; pushes never gap-fill).
    // v1.37.x: the run is quiet — the panel stays open and progress
    // surfaces in its footer (a manual minimize tucks it into the
    // floating progress pill, which mirrors the same lines), the burst
    // locks ONLY its own button (Pull Members / Push Members / Push
    // Trials remain usable; a concurrent pull's unlock can't re-enable
    // it mid-flight), and the completion summary ("⚙ N trial loadouts
    // fetched") is remembered for the pill.
    // The cached loadouts ride along on the next snapshot push — the
    // toolbar's "Push Trials" button (or the rollover / completion
    // auto-pushes) ships them to the site.
    overlay.querySelector("#stl-ov-loadouts").addEventListener("click", async () => {
      const btn = overlay.querySelector("#stl-ov-loadouts");
      if (!socketReady()) {
        overlayFooter("The game's socket isn't connected yet — rejoin the game, then press this again.", "err");
        return;
      }
      // v1.37.x quiet background run: lock only this button (Pull Members /
      // Push Members / Push Trials stay usable). The panel stays open —
      // progress reports in its footer (a manual minimize still tucks it
      // into the floating pill, which mirrors the same progress).
      btn.disabled = true;
      overlayState.loadouts = { running: true, done: 0, total: 0, captured: 0 };
      overlayState.loadoutsAck = false;
      overlayFooter("Fetching trial loadouts… (one member per second; a full roster takes a few minutes)", "");
      try {
        const captured = await fetchWeekTrialLoadouts((done, total) => {
          overlayState.loadouts.done = done;
          overlayState.loadouts.total = total;
          overlayFooter(`Fetching trial loadouts… ${done}/${total} requested`, "");
          renderOverlay(); // keeps the pill's progress line fresh
        });
        const stored = Object.keys(trialsSnapshot.trialLoadouts).length;
        overlayState.loadouts.running = false;
        overlayState.loadouts.captured = captured;
        if (captured > 0) {
          // Remember the summary in the pill (shown if the user minimizes
          // or tucks the panel away; the open panel shows it in its footer).
          overlayState.loadoutsAck = true;
          renderOverlay();
          overlayFooter(`Fetched ${captured} trial loadout${captured === 1 ? "" : "s"} — ${stored} stored this week; they ship with the next snapshot push.`, "ok");
        } else if (stored > 0) {
          overlayFooter(`Nothing new to fetch — all ${stored} of this week's loadouts are already stored.`, "ok");
        } else {
          overlayFooter("No trial loadouts fetched — nobody appears signed up for a trial yet, or the game hasn't shared the guild's trial data yet.", "err");
        }
      } catch (err) {
        overlayState.loadouts.running = false;
        overlayFooter(`Trial-loadout fetch failed — ${err && err.message ? err.message : String(err)}`, "err");
      } finally {
        // The burst itself cleared loadoutBurstRunning; a pull may have run
        // meanwhile and left the toolbar locked — never steal that unlock.
        if (!pullState.running) btn.disabled = false;
        renderOverlay();
        // Upgrade a tooltip currently open on a member in place with the
        // burst's results (covers a tip opened after the last capture
        // settled, which per-capture refreshes wouldn't see).
        try {
          if (gearTipCid !== null) refreshGearTip();
        } catch (e) { /* UI-only refresh */ }
      }
    });

    // v1.37.0: manual mid-week snapshot push — the site's "Snapshot now"
    // request round-trip is gone, so this button is the manual path: a
    // DIRECT, guild-gated POST, exactly like this toolbar's roster
    // "Push Members" (pushGuildGate gives early local feedback; the
    // ledger's own membership check is authoritative server-side).
    // force:true skips the local "already pushed this week" guard, so
    // pressing it again (e.g. after a loadouts fetch) refreshes the rows
    // via upsert.
    overlay.querySelector("#stl-ov-push-snapshot").addEventListener("click", async () => {
      const btn = overlay.querySelector("#stl-ov-push-snapshot");
      const apiBase = currentApiBase();
      if (!apiBase) {
        overlayFooter("Set the API base URL in Settings first.", "err");
        return;
      }
      if (!trialsSnapshot.weekKey) {
        overlayFooter("No week captured yet — open the in-game Guild panel once so the guild's trial data lands.", "err");
        return;
      }
      const gate = pushGuildGate();
      if (gate) {
        overlayFooter(gate, "err");
        return;
      }
      setOverlayButtons(true);
      overlayFooter(`Pushing this week's snapshot (${trialsSnapshot.weekKey}) to the ledger…`, "");
      let message = null;
      try {
        message = await pushTrialSnapshot(trialsSnapshot.weekKey, { apiBase, reason: "roster overlay button", force: true });
      } catch (err) {
        message = `Snapshot push failed — ${err && err.message ? err.message : String(err)}`;
      } finally {
        setOverlayButtons(false);
      }
      if (!message) message = "Nothing pushed (a push was already in flight, or no data captured).";
      overlayFooter(message, /failed/i.test(message) ? "err" : "ok");
    });

    // v1.37.0: gear tooltip — enter a member's name cell after a short
    // dwell (so a sweep across the table doesn't strobe tooltips);
    // leaving (except into the tooltip itself) hides it again. The tip
    // opens at the user's cursor (like the History page's menu) and keeps
    // following it while the cursor moves over name cells.
    bodyEl.addEventListener("mouseover", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const cell = target.closest("td.stl-col-name");
      if (!cell) return;
      const row = cell.closest("tr");
      const cid = row ? Number(row.getAttribute("data-stl-cid")) : NaN;
      if (!Number.isFinite(cid) || cid <= 0) return;
      gearTipXY = [event.clientX, event.clientY];
      if (gearTipTimer) { clearTimeout(gearTipTimer); gearTipTimer = null; }
      // Purely display: dwell opens the tip for whatever is already
      // captured — it never asks the game for anything.
      gearTipTimer = setTimeout(() => {
        gearTipTimer = null;
        showGearTip(cid);
      }, 140);
    });
    // Track the pointer while it is over name cells so the tip opens exactly
    // where the cursor is (even mid-dwell); once open it also follows the
    // cursor. Moving it onto the tooltip itself (target = the tip, not a
    // name cell) leaves the tip exactly where it is, so it can be read or
    // scrolled without jumping under the cursor.
    bodyEl.addEventListener("mousemove", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const cell = target.closest("td.stl-col-name");
      if (!cell) return;
      gearTipXY = [event.clientX, event.clientY];
      if (gearTipCid !== null && gearTipEl && gearTipEl.style.display !== "none") {
        positionGearTip(cell);
      }
    });
    bodyEl.addEventListener("mouseout", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest("td.stl-col-name")) return;
      const to = event.relatedTarget;
      if (to && gearTipEl && gearTipEl.contains(to)) return; // moved into the tip
      scheduleHideGearTip(120);
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

  // v1.37.1: "Reset to default" — a FULL wipe of everything the app
  // persists, so the install really behaves like a fresh one:
  //   1. the userscript manager's key store (Tampermonkey): this script's
  //      store is scoped to its name+namespace, so every key in it is ours.
  //      When GM_listValues is granted and available, the store is
  //      enumerated and EVERY key in it is deleted — any key a future
  //      feature ever adds is wiped automatically, with no key-list change
  //      in this code. Backends without GM_listValues (e.g. the Android
  //      webview-gm bridge) get a static key manifest instead. Either way
  //      the DELETE semantics matter: no stored value at all, so
  //      GM_getValue returns the code default (storing null is NOT
  //      equivalent: some backends hand the null back and it would shadow
  //      DEFAULTS.apiBase).
  //   2. the stl.* localStorage mirror: swept by prefix, whatever keys it
  //      holds — they can only ever be written through localSet (via
  //      stlSetValue), all with the stl. prefix, so the sweep stays
  //      complete forever and can never touch a key of the page or of
  //      another script. (On Android the bridge already deletes its GM
  //      store on every app relaunch, so the mirror is what survives there
  //      and the prefix sweep is the real wipe.)
  // In-memory state is reset explicitly below: the game re-reports the
  // logged-in character on every init message, so the session keeps
  // working. Returns the number of distinct keys cleared.
  // v1.37.1: static manifest of every key this script persists — fallback
  // for backends that don't expose GM_listValues. Keep in sync with the
  // stlSetValue call sites.
  function storedKeyManifest() {
    const base = [
      "apiBase", "characterId", "characterName",
      "hideUpdateFab", "fabLocked", "fabPosition", "panelLocked",
      "panelPosition", "overlayPosition", "overlayPillPosition",
      "allowPushOutsideGuild", "autoSyncEnabled",
      // v1.37.0: the per-character off list — a reset re-enables every
      // character that had been switched off.
      "disabledCharacterIds",
      "detectedCharacterId", "detectedCharacterName",
      "autoSyncLastAt", "autoSyncLastCharId",
      "stlDismissedUpdateVersion"
    ];
    return base.concat(SKILLS.map((skill) => `level_${skill.id}`));
  }
  // v1.37.1: delete EVERY key in this script's userscript-manager store —
  // full enumeration via GM_listValues when available (complete forever),
  // static manifest otherwise. Returns the number of keys cleared.
  function wipeGmStore() {
    let keys = null;
    if (typeof GM_listValues === "function") {
      try {
        keys = GM_listValues();
      } catch (e) {
        keys = null;
      }
    }
    if (!Array.isArray(keys)) keys = storedKeyManifest();
    let cleared = 0;
    keys.forEach((key) => {
      try {
        clearStoredValue(key);
        cleared++;
      } catch (e) {
        /* one unreadable key must not abort the sweep */
      }
    });
    return cleared;
  }
  function resetToDefaults() {
    const clearedKeys = wipeGmStore();
    const clearedLocal = clearLocalMirror();
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
    // v1.37.0: the reset also clears the per-character off list, so a
    // character that had been switched off is re-enabled — re-apply the
    // tracker state (no-op when nothing flipped) before the panel rebuild
    // so `wasOpen` reflects the post-reset UI.
    applyTrackerState();
    rebuildOpenPanel();
    // GM store and mirror hold the same logical keys — report the larger
    // sweep, not a double count.
    return Math.max(clearedKeys, clearedLocal);
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

  const RESET_CONFIRM = "Reset to default?\n\nThis clears everything the Trial Tracker stored in this browser AND in the userscript manager's (Tampermonkey's) key store — settings, positions, saved levels, auto-sync state, everything. Like a fresh install. Your ledger data on the website is NOT touched.";

  // The Settings controls duplicated in two places (the popup's Settings
  // view: #stl-* ids, the in-game Settings tab: #stlt-* ids) — API base,
  // auto-sync, show/lock button, lock panel, reset, and the per-character
  // enable switch. Both write the SAME stored config, so each change
  // mirrors the other surface's inputs and either place can edit without
  // the other going stale. Per-surface differences (where status is
  // written, repainting its own rows, extra reset bookkeeping, the
  // re-enable hint, the master-switch success line) are supplied via opts.
  function wireSettingsControls(root, ids, opts) {
    const q = (key) => root.querySelector(ids[key]);
    const set = (text, kind) => opts.setStatus(text, kind);
    const rep = () => opts.repaint && opts.repaint();
    const mirror = (key, value) => {
      const id = opts.mirrorIds && opts.mirrorIds[key];
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (el.type === "checkbox") el.checked = value;
      else el.value = value;
    };

    q("save").addEventListener("click", () => {
      // Character ID/name are auto-detected — saving persists the API base.
      const apiEl = q("apiBase");
      const apiBase = apiEl ? (apiEl.value || "").trim().replace(/\/$/, "") : "";
      cfgSet({ apiBase });
      set("Settings saved.", "ok");
      if (opts.mirrorApiBase) opts.mirrorApiBase(apiBase);
    });

    q("autosync").addEventListener("change", (event) => {
      cfgSet({ autoSyncEnabled: event.target.checked });
      if (event.target.checked) maybeAutoSync(); // re-arm now if it was due
      mirror("autosync", event.target.checked);
    });

    q("showFab").addEventListener("change", (event) => {
      const show = event.target.checked;
      cfgSet({ hideUpdateFab: !show });
      if (show) {
        if (document.body) ensureFab(); // hidden→shown needs the FAB re-added
        set("Trial Tracker button shown.", "ok");
      } else {
        removeFab();
        set("Trial Tracker button hidden. It stays hidden on reload until you show it again.", "ok");
      }
      mirror("showFab", show);
      if (opts.repaintToggles) rep();
    });

    q("fabLock").addEventListener("change", (event) => {
      const willLock = event.target.checked;
      cfgSet({ fabLocked: willLock });
      if (willLock) {
        // Keep the saved position: locking re-pins the button where it is.
        applyFabPosition();
        set(cfgGet().fabPosition
          ? "Trial Tracker button locked in place at its current position."
          : "Trial Tracker button locked in place (bottom-right).", "ok");
      } else {
        set("Trial Tracker button unlocked — drag it anywhere you like.", "ok");
      }
      mirror("fabLock", willLock);
      if (opts.repaintToggles) rep();
    });

    q("panelLock").addEventListener("change", (event) => {
      const willLock = event.target.checked;
      cfgSet({ panelLocked: willLock });
      if (willLock) {
        set(cfgGet().panelPosition
          ? "Panel locked in place at its current position."
          : "Panel locked in place (bottom-right).", "ok");
      } else {
        set("Panel unlocked — drag it by its title bar.", "ok");
      }
      mirror("panelLock", willLock);
      if (opts.repaintToggles) rep();
    });

    q("enabled").addEventListener("change", (event) => {
      const el = q("enabled");
      const { characterId, characterName } = resolveCharacter();
      if (!Number.isInteger(characterId) || characterId <= 0) {
        set("No character ID detected yet — log in to the game first, then toggle this.", "err");
        rep();
        return;
      }
      const enable = event.target.checked;
      // Confirm before flipping the master switch — off carries a warning
      // (it strips everything the tracker does in this page).
      const who = characterName ? `${characterName} (ID ${characterId})` : `ID ${characterId}`;
      const message = enable
        ? `Turn the trial tracker back ON for ${who}?\n\nIt will resume capturing levels, pushing to the ledger, auto-syncing, and highlighting this character's recommended trial.`
        : `Turn the trial tracker OFF for ${who}?\n\nWARNING: this disables EVERYTHING the trial tracker does for this character — it stops capturing levels, pushing to the ledger (auto and manual), auto-syncing, and the recommended-trial / sit-out highlight and update button all go away. You can turn it back on anytime from ${opts.reEnableHint}.`;
      if (!window.confirm(message)) {
        el.checked = !enable; // cancel: put the switch back
        return;
      }
      setCharacterDisabled(characterId, !enable);
      const msg = opts.enabledStatus({ enable, isOn: !trackerDisabled() });
      if (msg) set(msg, "ok");
      mirror("enabled", enable);
    });

    q("reset").addEventListener("click", () => {
      // The nuclear option (see resetToDefaults) — confirm first.
      if (!window.confirm(RESET_CONFIRM)) return;
      const count = resetToDefaults();
      if (opts.afterReset) opts.afterReset();
      set(`Reset to default \u2014 cleared ${count} stored value${count === 1 ? "" : "s"}. Fresh-install state.`, "ok");
    });
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
    // v1.36.0: the panel has two views — Main (levels, sync actions)
    // and Settings (Save, API base URL, optional ledger-site login,
    // read-only character ID/name, auto-sync, fab lock, Reset) —
    // switched via the nav under the title.
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
        <label>Levels</label>
        <div id="stl-skills"></div>
        <div id="stl-actions">
          <button id="stl-send" type="button">Sync Character</button>
          <button id="stl-roster" type="button" title="Pull / push the guild roster (cull lives on the website, admin only)">\uD83D\uDC65 Guild Roster</button>
        <!-- v1.37.0: the whole "guild-wide" action set moved into the
             guild roster overlay's toolbar (see buildOverlay) — its
             multi-use area: the "Pull Trials" burst button AND the
             manual mid-week "Push Trials" button (direct,
             guild-gated, no site-side "Snapshot now" request). The panel
             keeps only Sync Character + Guild Roster. -->
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
        <!-- v1.36.3: the ledger-site login moved here out of the Tracker view
             so it isn't the first thing users see — and it sits next to the
             API base URL it needs to work. Explicitly marked optional: the
             tracker (levels, sync, roster, auto-sync) works fully without it. -->
        <div id="stl-login">
          <label>Log in to the website — OPTIONAL</label>
          <div class="stl-login-optional">Tracker works without an account. The site access stays read-only unless you're an admin.</div>
          <div id="stl-login-detected"></div>
          <input id="stl-login-code" type="text" maxlength="8" placeholder="CODE FROM SITE"
                 autocomplete="off" spellcheck="false" style="text-transform: uppercase; letter-spacing: 0.18em;" />
          <div id="stl-login-actions">
            <button id="stl-login-confirm" type="button">Confirm login</button>
          </div>
          <div id="stl-login-status"></div>
        </div>
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
        <!-- v1.37.0: per-character master switch — the same stored state
             as the in-game Settings tab's copy (#stlt-enabled). OFF means
             the tracker does nothing FOR THIS CHARACTER ONLY (keyed by
             character ID); the in-game Settings tab stays as the escape
             hatch to turn it back on. -->
        <label class="stl-check" title="Turn the whole trial tracker on or off for THIS character only (keyed by character ID — every other character in this browser is unaffected). Off means no button, no auto-sync, no trial highlight; turn it back on here or from the in-game Settings → Trial Tracker tab.">
          <input id="stl-settings-enabled" type="checkbox" />
          Enable the trial tracker for this character
        </label>
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
    wireDrag(panelHeader, panel, {
      skipTarget: "#stl-panel-close",
      locked: () => cfgGet().panelLocked !== false,
      clearTransform: true,
      onEnd: (d) => cfgSet({ panelPosition: { left: d.left, top: d.top } })
    });

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
        setLoginStatus("Set the API base URL above first.", "err");
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
    // from the game) — saving only persists the API base. The duplicated
    // settings controls (save, auto-sync, show/lock button, lock panel,
    // reset, per-character enable) are wired below through the shared
    // wireSettingsControls(), the same wiring the in-game Settings tab
    // uses (v1.36.0 auto-sync, v1.28.0 reset, v1.37.0 master switch).

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
    // v1.37.0: the per-character master switch (mirrors #stlt-enabled in
    // the in-game Settings tab).
    const enabledToggle = panel.querySelector("#stl-settings-enabled");
    let activeView = "main";

    function syncSettingsUi() {
      // v1.37.0: the per-character master switch (mirrors #stlt-enabled in
      // the in-game Settings tab).
      enabledToggle.checked = !trackerDisabled();
      // hideUpdateFab defaults to false → button shown (checkbox = "show").
      showFabToggle.checked = cfgGet().hideUpdateFab !== true; // default: shown
      fabLockToggle.checked = cfgGet().fabLocked !== false; // default: locked
      panelLockToggle.checked = cfgGet().panelLocked !== false; // default: locked
      // The read-only identity fields live in this view — refresh them from
      // the freshest known resolution (live detection first) on entry.
      paintIdentityFields(panel, "stl-");
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
    // whenever the Main view's content changes (e.g. the update banner
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

    // v1.36.0: show/hide the floating button (same setting as the
    // Tampermonkey menu command); v1.37.0: the per-character master switch
    // (mirrors the in-game Settings tab's #stlt-enabled; switching OFF
    // strips everything in the page, so the confirm line is only seen on
    // re-enable). All of the duplicated controls are wired through the
    // shared wireSettingsControls() above.
    wireSettingsControls(panel, {
      save: "#stl-save",
      apiBase: "#stl-apiBase",
      autosync: "#stl-autosync",
      reset: "#stl-reset",
      showFab: "#stl-settings-show-fab",
      fabLock: "#stl-settings-fab-lock",
      panelLock: "#stl-settings-panel-lock",
      enabled: "#stl-settings-enabled"
    }, {
      setStatus,
      repaint: syncSettingsUi, // repaint the settings rows after a change
      repaintToggles: true,
      reEnableHint: "Settings → Trial Tracker",
      // Switching off closes the panel — so only the re-enable gets a
      // line of confirmation.
      enabledStatus: ({ isOn }) => (isOn ? "Trial tracker enabled for this character." : null),
      // Mirror changes into the in-game Settings tab's copies.
      mirrorIds: {
        autosync: "stlt-autosync",
        showFab: "stlt-showfab",
        fabLock: "stlt-fablock",
        panelLock: "stlt-panellock",
        enabled: "stlt-enabled"
      }
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

    // v1.37.0: both guild-wide actions moved to the roster overlay
    // toolbar — the "Pull Trials" button + handler and the manual
    // "Push Trials" button + handler now live in buildOverlay()
    // (the roster is the panel's multi-use area for everyone-in-the-
    // guild actions). The panel keeps Sync Character / Guild Roster.

    return panel;
  }

  // The bottom-right "Trial Tracker" button is optional: the Tampermonkey
  // menu (dropdown) can hide it, and the hidden state persists across page
  // loads. Kept at module scope so the menu command below can toggle it.
  let fab = null;
  let onFabClick = null;
  let suppressFabClick = false;
  // v1.28.0: the panel lives at module scope (was a local in init()) so
  // resetToDefaults() can rebuild it — the onFabClick closure reads this
  // variable, so swapping `panel` swaps what the FAB opens.
  let panel = null;

  // Shared drag wiring for the four draggable chrome pieces (fab, popup
  // panel via h4, overlay panel via its header, overlay pill). All clamp to
  // the viewport and clear right/bottom anchoring while dragging; the
  // element's final position is handed to opts.onEnd. clearTransform resets
  // a CSS bottom-right transform (panels only); trackMoved lets onEnd tell
  // a real drag from a plain click (the fab).
  function wireDrag(handleEl, targetEl, opts) {
    let drag = null;
    handleEl.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (opts.skipTarget && event.target.closest && event.target.closest(opts.skipTarget)) return;
      if (opts.locked && opts.locked()) return; // locked: ignore drags
      const rect = targetEl.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        left: rect.left,
        top: rect.top,
        moved: false
      };
      handleEl.setPointerCapture(event.pointerId);
    });
    handleEl.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const maxLeft = Math.max(0, window.innerWidth - targetEl.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - targetEl.offsetHeight);
      const left = Math.min(Math.max(0, event.clientX - drag.offsetX), maxLeft);
      const top = Math.min(Math.max(0, event.clientY - drag.offsetY), maxTop);
      if (opts.trackMoved && (Math.abs(left - drag.left) > 2 || Math.abs(top - drag.top) > 2)) drag.moved = true;
      drag.left = left;
      drag.top = top;
      targetEl.style.left = `${left}px`;
      targetEl.style.top = `${top}px`;
      if (opts.clearTransform) targetEl.style.transform = "none";
      targetEl.style.right = "auto";
      targetEl.style.bottom = "auto";
    });
    const finish = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (handleEl.hasPointerCapture(event.pointerId)) handleEl.releasePointerCapture(event.pointerId);
      if (opts.onEnd) opts.onEnd(drag);
      drag = null;
    };
    handleEl.addEventListener("pointerup", finish);
    handleEl.addEventListener("pointercancel", finish);
  }

  // Restore a remembered element position, clamped to the current viewport.
  function applyStoredPosition(el, position, clearTransform) {
    if (!el || !position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
    const left = Math.min(Math.max(0, position.left), Math.max(0, window.innerWidth - el.offsetWidth));
    const top = Math.min(Math.max(0, position.top), Math.max(0, window.innerHeight - el.offsetHeight));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (clearTransform) el.style.transform = "none";
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  function applyFabPosition() { applyStoredPosition(fab, cfgGet().fabPosition); }

  function applyPanelPosition(panel) { applyStoredPosition(panel, cfgGet().panelPosition, true); }

  function applyOverlayPosition(panel) { applyStoredPosition(panel, cfgGet().overlayPosition, true); }

  function applyOverlayPillPosition(pill) { applyStoredPosition(pill, cfgGet().overlayPillPosition); }

  function ensureFab() {
    if (fab) return fab;
    fab = document.createElement("button");
    fab.id = "stl-fab";
    fab.type = "button";
    fab.textContent = "\uD83D\uDCCA Trial Tracker";
    fab.title = "Click to open the ledger updater";
    fab.addEventListener("click", onFabClick);
    wireDrag(fab, fab, {
      locked: () => cfgGet().fabLocked !== false,
      trackMoved: true,
      onEnd: (d) => {
        if (!d.moved) return; // a plain click must not move the button
        cfgSet({ fabPosition: { left: d.left, top: d.top } });
        suppressFabClick = true;
      }
    });
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
  // v1.37.0: while our tab is active, re-run the idempotent hide pass on a
  // short tick. Field evidence: in long sessions the game re-renders the
  // Settings page (and Toolasha can re-inject its panel) — React's re-render
  // rewrites the panels' inline `style`, clobbering the one-shot
  // `display:none !important` we set at click time, so the leak comes back
  // until the next mutation happens to trigger the MutationObserver
  // self-heal ("sometimes it self-heals"). A 400ms guard makes the hide
  // continuous instead of event-driven. reassertHiddenBuiltins is fully
  // idempotent (it only writes when something is actually wrong), so an
  // idle tick causes zero DOM churn and therefore no observer feedback loop.
  let stlHideGuard = null; // setInterval id, or null
  let styleClobberWatcher = null; // MutationObserver (style attrs) on the Settings page
  let settingsClickAttached = false; // one-shot document-level tab-click listener
  function startStlHideGuard() {
    if (stlHideGuard != null || !stlTabActive) return;
    stlHideGuard = setInterval(() => {
      if (!stlTabActive) {
        stopStlHideGuard();
        return;
      }
      try {
        if (findSettingsTabContainer()) reassertHiddenBuiltins();
      } catch (e) {
        // Never let a guard tick take the page down.
      }
    }, 400);
  }
  function stopStlHideGuard() {
    if (stlHideGuard != null) {
      clearInterval(stlHideGuard);
      stlHideGuard = null;
    }
  }

  // v1.37.0 (follow-up to the 400ms guard): the interval only CORRECTS a
  // clobber after the fact, so a re-render that rewrites a panel's inline
  // style (a React re-render of the tab panels does exactly this, WITHOUT
  // any childList change) leaves a visible flash window of up to one tick
  // where the foreign panel paints under our tab. This observer closes the
  // window: it watches the Settings page for `style` attribute rewrites and
  // re-asserts within the same task as the clobber — before any paint.
  // reassertHiddenBuiltins is fully idempotent (it only writes when
  // something is actually wrong), so a write it performs can trigger at
  // most one more observer pass, which finds nothing to fix and settles —
  // no feedback loop. It is (re)attached in ensureSettingsTab whenever the
  // wiring refreshes (the game re-creates the container on re-renders) and
  // disconnected in dropSettingsTab.
  function watchStyleClobbers(container) {
    if (styleClobberWatcher) {
      try { styleClobberWatcher.disconnect(); } catch (e) {}
      styleClobberWatcher = null;
    }
    if (!container || typeof MutationObserver !== "function") return;
    styleClobberWatcher = new MutationObserver(() => {
      if (!stlTabActive) return;
      try {
        reassertHiddenBuiltins();
      } catch (e) {
        // Never let a style-clobber reaction take the page down.
      }
    });
    // subtree:true is REQUIRED: the clobbered nodes (Toolasha's panel, the
    // built-in wrapper divs) are DESCENDANTS of the container, and attribute
    // mutations on the container node alone never cover them — without the
    // flag the observer only saw rewrites of the container's own style and
    // a descendant clobber waited for the 400ms interval tick (verified
    // live: +150ms sample still painted, fixed by the tick at +450ms).
    styleClobberWatcher.observe(container, {
      attributes: true,
      attributeFilter: ["style"],
      subtree: true,
    });
  }
  function stopStyleClobberWatch() {
    if (styleClobberWatcher) {
      try { styleClobberWatcher.disconnect(); } catch (e) {}
      styleClobberWatcher = null;
    }
  }

  // v1.37.0: attach the tab-bar click handler to `document` ONCE. The previous
  // design re-attached it to whatever `tabHost` node was current; when the
  // game rebuilt that node in a long session, the listener was left stranded
  // on a detached node (see onSettingsTabClick's note) and tab clicks stopped
  // reaching us. `document` is never torn down by the game, so the handler
  // stays live for the life of the page; it self-scopes each click via
  // `closest`, so no per-host re-wiring is needed.
  function installSettingsClickListener() {
    if (settingsClickAttached) return;
    settingsClickAttached = true;
    document.addEventListener("click", onSettingsTabClick, true);
  }
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

  // v1.37.0: hide a foreign (built-in / Toolasha) settings panel with
  // `display:none !important`. A plain inline `display:none` provably loses
  // in the cascade to Toolasha's own author stylesheet rule
  // `#toolasha-settings { display:block !important }` (verified live in a
  // real Edge window: inline none + computed block = the leaked panel).
  // Inline !important beats author !important regardless of specificity, so
  // this cannot be overridden while our tab is active. Deactivation restores
  // the saved NON-important value, which drops our flag and hands visibility
  // back to the game / Toolasha normally.
  function hideForeignPanel(el) {
    el.style.setProperty("display", "none", "important");
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
    // The game can rebuild the Settings page while we're (un)active, leaving
    // `settingsWiring` pointing at dead hosts — a hide/restore done against
    // dead nodes is a silent no-op and the LIVE panels (Toolasha's included)
    // show right under ours. Re-attach to the live container first
    // (idempotent: re-parents our surviving nodes, refreshes listeners); its
    // tail also re-asserts the hides while activating.
    const liveContainer = findSettingsTabContainer();
    if (liveContainer) ensureSettingsTab(liveContainer);
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
        // v1.37.0: !important (Toolasha's block!important override — see
        // hideForeignPanel). NOTE: the saved value above stays non-important,
        // so deactivation-restore drops our flag.
        hideForeignPanel(el);
      });
      // Re-paint the duplicated controls from stored config + detection so
      // they're never stale when (re)activated (e.g. after another window or
      // the popup changed a setting).
      if (stlTabRefresh) stlTabRefresh();
    } else {
      // v1.37.0: our tab left the stage — stop the continuous guard, and the
      // raw (non-!important) restores below hand Toolasha/built-in visibility
      // back. (If we kept ticking while deactivated we'd re-hide panels that
      // the player is now legitimately looking at.)
      stopStlHideGuard();
      // Hand control back: restore the underline indicator and the built-in
      // panels' own visibility.
      unscrubBuiltInTabState();
      builtins.forEach((el) => {
        if (!builtInDisplayStyle.has(el)) return;
        const saved = builtInDisplayStyle.get(el);
        el.style.display = saved === "" ? "" : saved;
        builtInDisplayStyle.delete(el);
      });
      // Toolasha's settings panel sits in the same panels host, but its tab
      // switching (reviewed in its pinned v3.25.3 dist — setupTabSwitching in
      // toolasha-ui.js) captured its tab/panel lists ONCE at injection and is
      // purely click-driven: no observer re-asserts its panel. So if the
      // player lands on a game tab whose button Toolasha never captured (a
      // settings tab added by a game update), Toolasha's handler never runs
      // and the restore above can leave its panel visible under the clicked
      // one. When the clicked built-in tab is NOT Toolasha's own tab, pin its
      // panel hidden — its own handler explicitly re-shows it when that tab
      // is clicked, and in this build nothing else ever re-shows it, so the
      // pin is stable. (When our tab is active, reassertHiddenBuiltins
      // already keeps it hidden as any other built-in.)
      const toolashaPanel = document.getElementById("toolasha-settings");
      const clickedToolasha = !!(
        clickedBuiltIn && clickedBuiltIn.id === "toolasha-settings-tab"
      );
      if (toolashaPanel && !clickedToolasha) {
        toolashaPanel.style.display = "none";
      }
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
    if (active) {
      // Deterministic follow-up self-heals after activation. The click can
      // land while the game is mid-rebuild of the Settings page (the rebuild
      // churns the hosts our hide pass above just targeted, or re-parents
      // our nodes, IN THE SAME BATCH — so the pass above can race it and
      // leave the LIVE built-in/Toolasha panels visible under ours until the
      // next arbitrary DOM mutation triggers the watcher). Two one-shot
      // follow-ups — one right after this task's React flush, one after the
      // slower async data-driven re-render — re-run the idempotent
      // self-healing attach (re-sync wiring, re-hide builtins + Toolasha,
      // re-show our panel, re-paint the title). Each is a no-op when
      // everything is already correct (no mutation churn → no flicker, no
      // observer loop); skipped if we were deactivated first or the page
      // unmounted (dropSettingsTab clears stlTabActive).
      const followUpHeal = () => {
        if (!stlTabActive) return;
        const c = findSettingsTabContainer();
        if (c) ensureSettingsTab(c);
      };
      setTimeout(followUpHeal, 0);
      setTimeout(followUpHeal, 400);
      // v1.37.0: keep the hide CONTINUOUS while our tab is active, so a
      // later game re-render (or a Toolasha panel re-injection) that clobbers
      // our inline hides is corrected within one tick instead of waiting for
      // the next arbitrary mutation (see startStlHideGuard's note).
      startStlHideGuard();
    }
  }

  // Rewrite the Settings page's title line to ours while our tab is active.
  // The title is React-owned and only re-writes when the game's own tabIndex
  // changes — which never happens for a foreign tab, so without this it stays
  // on the last clicked tab's title (e.g. "Toolasha v3.25.3 Settings
  // (refresh to apply)") under our panel and misreads. Toolasha does the same
  // rewrite for its own tab. Only writes textContent (no childList churn →
  // never trips our childList watcher), and is a no-op when already correct.
  function paintSettingsTitle() {
    const titleEl = document.querySelector('[class*="SettingsPanel_title"]');
    if (titleEl && titleEl.textContent !== "MWI Trial Tracker") {
      titleEl.textContent = "MWI Trial Tracker";
    }
  }

  // Re-hide any built-in panel wrapper that is currently visible while our tab
  // is active. This handles a full re-render recreating built-in wrapper nodes
  // (which would otherwise lose the inline `display:none` we set and reappear
  // under our panel). Each wrapper's display is snapshotted only the FIRST
  // time we hide it, so the value saved for deactivation-restore is never
  // clobbered by repeated re-asserts.
  function reassertHiddenBuiltins() {
    // Self-heal first: if the game rebuilt the page (fresh container hosts)
    // while our wiring pointed at the old ones, re-sync the wiring via
    // ensureSettingsTab (re-parents our surviving nodes, refreshes listeners,
    // and — while active — re-enters here once with fresh hosts).
    const container = findSettingsTabContainer();
    if (container) {
      const tabHost =
        container.querySelector('[class*="MuiTabs-flexContainer"]') || container;
      const panelsHost = container.querySelector(
        '[class*="TabsComponent_tabPanelsContainer"]'
      );
      if (!settingsWiring || !settingsWiring.panelsHost || panelsHost) {
        const stale =
          !settingsWiring ||
          settingsWiring.tabHost !== tabHost ||
          settingsWiring.panelsHost !== panelsHost;
        if (stale) {
          ensureSettingsTab(container);
          if (!settingsWiring || !settingsWiring.panelsHost) return;
        }
      }
    }
    if (!settingsWiring || !settingsWiring.panelsHost) return;
    // Prune wrappers a re-render detached (their saved entries are stale).
    for (const [node] of builtInDisplayStyle) {
      if (!node.isConnected) builtInDisplayStyle.delete(node);
    }
    builtInPanels(settingsWiring.panelsHost).forEach((el) => {
      if (!builtInDisplayStyle.has(el)) {
        // Snapshot the raw (non-important) value before overriding: the
        // saved value is what deactivation restores, and restoring it drops
        // our !important flag (v1.37.0).
        builtInDisplayStyle.set(el, el.style.display);
        hideForeignPanel(el);
      } else if (el.style.display !== "none") {
        hideForeignPanel(el);
      }
    });
    // Id-based safety net, immune to stale host enumeration: re-hide
    // Toolasha's panel wherever it lives. (Normally it's covered by the
    // wrapper loop above; this also covers the case where the wrapper loop
    // ran against a dead host before the self-heal kicked in.) Saving it in
    // the map here keeps deactivation-restore sane.
    const toolashaPanel = document.getElementById("toolasha-settings");
    if (toolashaPanel && toolashaPanel.isConnected) {
      if (!builtInDisplayStyle.has(toolashaPanel)) {
        builtInDisplayStyle.set(toolashaPanel, toolashaPanel.style.display);
      }
      if (toolashaPanel.style.display !== "none") {
        hideForeignPanel(toolashaPanel);
      }
    }
    // A re-render can also re-apply Mui-selected to the stale built-in tab —
    // re-scrub so only our tab is highlighted while we're active.
    scrubBuiltInTabState();
    paintSettingsTitle();
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
      // Order mirrors the popup's Settings view: Save + API base (hidden
      // while the character is off), character ID/name (always visible),
      // the master switch, then the off-able auto-sync / button / lock /
      // reset controls in #stlt-controls.
      stlPanel.innerHTML = `
        <div class="stl-tab-heading">MWI Trial Tracker</div>
        <div id="stlt-controls-top">
          <div class="stlt-save"><button id="stlt-save" type="button">Save settings</button></div>
          <label>API base URL</label>
          <input id="stlt-apiBase" type="text" />
        </div>
        <!-- v1.36.0: identity is auto-detected + read-only, and kept OUTSIDE
             the hidden-when-off wrappers so the player still sees WHICH
             character is off. -->
        <label>Character ID</label>
        <input id="stlt-characterId" type="number" readonly />
        <label>Character name</label>
        <input id="stlt-characterName" type="text" readonly />
        <!-- v1.37.0: master switch — ALWAYS visible; while off, the note
             appears and the other controls stay hidden. The tab itself is
             never removed by the switch (the escape hatch back on). -->
        <label class="stl-check" title="Turn the whole trial tracker on or off for THIS character only (keyed by its character ID — every other character in this browser keeps working as before).">
          <input id="stlt-enabled" type="checkbox" />
          Enable the trial tracker for this character
        </label>
        <div id="stlt-disabled-note"></div>
        <div id="stlt-controls">
          <label class="stl-check" title="Automatically push this character's levels and profile to the ledger when the game opens and every 30 minutes (a 30-minute cooldown prevents reload spam)">
            <input id="stlt-autosync" type="checkbox" />
            Auto-sync this character (on open + every 30 min)
          </label>
          <div id="stlt-autosync-status"></div>
          <label>Trial Tracker button</label>
          <label class="stl-check" title="Show or hide the floating Trial Tracker button (same setting as the Tampermonkey menu's 'hide/show Trial Tracker button').">
            <input id="stlt-showfab" type="checkbox" />
            Show the Trial Tracker button
          </label>
          <label class="stl-check" title="Lock the Trial Tracker button in place. While unlocked you can drag it around; locking remembers its position.">
            <input id="stlt-fablock" type="checkbox" />
            Lock button position
          </label>
          <label class="stl-check" title="Lock the panel in place. While unlocked you can drag it by its title bar; locking remembers its position.">
            <input id="stlt-panellock" type="checkbox" />
            Lock panel position
          </label>
          <div class="stlt-save"><button id="stlt-reset" type="button" title="Clears everything this app stored in this browser (settings, positions, saved levels, auto-sync state) and starts from a fresh-install state">Reset to default</button></div>
        </div>
        <div id="stlt-status"></div>
      `;
      panelsHost.appendChild(stlPanel);
    } else if (stlPanel.parentElement !== panelsHost) {
      panelsHost.appendChild(stlPanel);
    }

    // v1.37.0: the tab-bar click handler now lives ONCE on `document`
    // (installed in startSettingsTabWatcher) so it can't be stranded when the
    // game rebuilds `tabHost` — no per-host (re)wiring here. We still record
    // the live hosts below so the hide/restore passes target the current DOM.
    settingsWiring = { container, tabHost, panelsHost, tab };
    // v1.37.0 (follow-up): point the style-clobber observer at the current
    // container (see watchStyleClobbers) so a re-render that rewrites a
    // panel's inline style fixes in-task, before paint.
    watchStyleClobbers(container);

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
      // v1.37.0: the per-character master switch's re-enable control.
      const tEnabled = stlPanel.querySelector("#stlt-enabled");

      // Refresh the tab's settings inputs from stored config + detection.
      // Mirrors the popup's syncSettingsUi. Auto-sync is painted from the
      // stored setting — the checkbox is built without a `checked`
      // attribute, so without this paint it would stay unchecked (or
      // stale) even while auto-sync is on in the panel/popup.
      const refreshTabSettingsUi = () => {
        const cfg = cfgGet();
        if (tApi) tApi.value = cfg.apiBase || "";
        tShowFab.checked = cfg.hideUpdateFab !== true; // default: shown
        tFabLock.checked = cfg.fabLocked !== false; // default: locked
        tPanelLock.checked = cfg.panelLocked !== false; // default: locked
        tAuto.checked = cfg.autoSyncEnabled; // default: on
        const resolved = resolveCharacter();
        paintIdentityFields(stlPanel, "stlt-");
        // v1.37.0: the per-character master switch — the checkbox is always
        // visible (mirroring the popup's copy); while this character is off,
        // show the off note and hide the other controls — both hidden groups
        // (save/API above the identity fields, everything below) — while the
        // character ID/name stay visible.
        const disabled = trackerDisabled();
        const controlsTop = stlPanel.querySelector("#stlt-controls-top");
        const controls = stlPanel.querySelector("#stlt-controls");
        const note = stlPanel.querySelector("#stlt-disabled-note");
        if (controlsTop) controlsTop.hidden = disabled;
        if (controls) controls.hidden = disabled;
        if (tEnabled) tEnabled.checked = !disabled;
        if (note) {
          note.textContent = disabled
            ? "The trial tracker is OFF for " +
              (resolved.characterName
                ? resolved.characterName + " (ID " + resolved.characterId + ")"
                : "ID " + resolved.characterId) +
              ". Nothing is tracked, pushed, or highlighted for this character until it is enabled."
            : "";
        }
      };

      // v1.37.0: the per-character master switch (#stlt-enabled) keys on
      // the character ID the game reported for the logged-in character, so
      // other characters in the same browser are unaffected. Enabling
      // re-arms everything immediately (setCharacterDisabled →
      // applyTrackerState → sweep + auto-sync + button) — no reload needed.
      wireSettingsControls(stlPanel, {
        save: "#stlt-save",
        apiBase: "#stlt-apiBase",
        autosync: "#stlt-autosync",
        reset: "#stlt-reset",
        showFab: "#stlt-showfab",
        fabLock: "#stlt-fablock",
        panelLock: "#stlt-panellock",
        enabled: "#stlt-enabled"
      }, {
        setStatus: setTabStatus,
        repaint: refreshTabSettingsUi, // repaint the tab's rows after a change
        reEnableHint: "this tab",
        enabledStatus: ({ enable }) => (enable
          ? "Trial tracker enabled for this character — button, auto-sync, and the trial highlight are back on."
          : "Trial tracker switched off for this character. It does nothing until you enable it again from this tab."),
        // Mirror the API base into the popup's Settings view if it's open.
        mirrorApiBase: (apiBase) => {
          const p = document.getElementById("stl-apiBase");
          if (p && p.value !== apiBase) p.value = apiBase;
        },
        // Mirror changes into the popup's Settings view copies.
        mirrorIds: {
          autosync: "stl-autosync",
          showFab: "stl-settings-show-fab",
          fabLock: "stl-settings-fab-lock",
          panelLock: "stl-settings-panel-lock",
          enabled: "stl-settings-enabled"
        },
        afterReset: () => {
          // The reset may have cleared THIS character's off state —
          // repaint (incl. the identity fields) so the tab shows the
          // correct (enabled) controls.
          refreshTabSettingsUi();
        }
      });

      // Paint the stored values — and the per-character switch state
      // (v1.37.0) — into the freshly built tab inputs with the same paint
      // the (re)activations use.
      refreshTabSettingsUi();

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
  // v1.37.0: the ONE permanent listener lives on `document` (see
  // installSettingsClickListener). It used to be attached to the
  // `tabHost` node captured at (re)wiring time — but the game REBUILDS that
  // node on re-renders, so in long sessions the listener silently survived
  // on a DETACHED node: tab clicks stopped reaching us, our `stlTabActive`
  // state desynced from the DOM, and foreign panels were left stacked under
  // the wrong tab (observed live: clicking Toolasha's tab did nothing, our
  // tab stayed "active" with a stale title until an unrelated click).
  // Resolving the container from the LIVE click target via `closest` (instead
  // of a global `querySelector`) is both staleness-proof (it climbs from the
  // exact node that was just clicked, which is always in the current tree) and
  // cheap (it stops as soon as it leaves the subtree, so clicks elsewhere on
  // the page bail out without scanning the DOM).
  //
  // CAREFUL SCOPING (fixes a live-reported regression): the container
  // selector matches the whole Settings page INCLUDING the panel area, so
  // "a click that is not on our tab" is NOT "a click on another tab".
  // Deactivation may only happen when the player actually clicked a built-in
  // TAB BUTTON — the game's own tab switching is likewise button-driven.
  // Clicks anywhere else in the page (labels, inputs and buttons INSIDE our
  // tab's content, the tab strip background) must be inert for us: the
  // player is interacting with our tab, not choosing another one.
  function onSettingsTabClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const container = target.closest('[class*="SettingsPanel_tabsComponentContainer"]');
    if (!container) return; // click elsewhere on the page
    const tab = document.getElementById("stl-settings-tab");
    if (tab && tab.contains(target)) {
      setStlTabActive(true);
      return;
    }
    // Only a built-in tab button counts as "leaving our tab" — and it must be
    // a button, not just our own tab button (handled above) or a click that
    // happened to resolve to one through a child element.
    const btn = target.closest("button[role=\"tab\"]");
    if (!btn || btn === tab) return;
    if (btn.hasAttribute(STL_SETTINGS_TAB_MARKER)) return;
    setStlTabActive(false, false, btn);
  }

  function dropSettingsTab() {
    // The whole Settings page is unmounted, so the built-in wrappers we may
    // have hidden are gone with it — no need to restore them individually.
    // v1.37.0: the page is gone, so the continuous guard + the style-clobber
    // observer lose their purpose.
    stopStlHideGuard();
    stopStyleClobberWatch();
    builtInDisplayStyle.clear();
    stlTabActive = false;
    settingsWiring = null;
  }

  // Watch the whole document for the Settings tab bar so the tab survives the
  // game's SPA navigation (open / close / re-render of the Settings page).
  function startSettingsTabWatcher() {
    // v1.37.0: also (once) install the permanent document-level tab-click
    // handler — it never goes stale, unlike a per-tab-host listener.
    installSettingsClickListener();
    if (settingsTabWatcher || typeof MutationObserver !== "function" || !document.body) return;
    settingsTabWatcher = new MutationObserver(() => {
      const container = findSettingsTabContainer();
      if (!container) {
        // The Settings page left the DOM — release our wiring so a later
        // re-open starts clean. (Injected nodes are gone with the page.)
        dropSettingsTab();
        return;
      }
      // The in-game Settings tab is always on — there is no setting to turn
      // it off, so a user can never lock themselves out of the controls.
      // Steady state: our tab + panel are BOTH children of the LIVE hosts.
      // (Checked by parent, not mere existence: the game can rebuild the
      // page so our surviving nodes sit in dead hosts — or in the live
      // hosts without our wiring knowing, and only a parent check separates
      // "wired and fine" from "stale wiring, panels stacking under us".)
      const liveTabHost =
        container.querySelector('[class*="MuiTabs-flexContainer"]') || container;
      const livePanelsHost = container.querySelector(
        '[class*="TabsComponent_tabPanelsContainer"]'
      );
      const tab = document.getElementById("stl-settings-tab");
      const panel = document.getElementById("stl-settings-tab-panel");
      const tabLive = !!(tab && tab.isConnected && tab.parentElement === liveTabHost);
      const panelLive =
        !!(livePanelsHost && panel && panel.isConnected && panel.parentElement === livePanelsHost);
      if (tabLive && panelLive) {
        // A re-render may have just re-created the built-in panel wrappers
        // (as visible) underneath an active tab — re-hide them so they don't
        // stack under ours. (Also re-asserts our panel's display if a
        // re-render reset it, and self-heals stale wiring + our nodes.)
        if (stlTabActive) reassertHiddenBuiltins();
        return;
      }
      // Our nodes are missing or stranded outside the live hosts — (re)attach
      // them. Defer one tick so the game's own render has finished laying out
      // the tab bar before we append (keeps our tab at the end, stable).
      setTimeout(() => {
        const c = findSettingsTabContainer();
        if (c) ensureSettingsTab(c);
      }, 0);
    });
    settingsTabWatcher.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // v1.37.0 — Per-character master switch applier.
  //
  // Runs whenever the logged-in identity resolves or changes (the game's
  // init_character_data on login and on in-page character switches — see
  // handleGameMessage) or the switch itself flips (Settings tab / panel
  // toggles, via setCharacterDisabled). A disabled character strips
  // everything the tracker put in the page: the floating button, any open
  // panel / guild overlay, the trial highlight + notice (and the retry
  // chain + panel observer that would repaint them), and the update
  // banner / FAB dot. An enabled character re-arms the same things
  // immediately — button back, plan refetched, highlight re-applied,
  // auto-sync re-armed, update nag refetched — no reload needed.
  //
  // The in-game Settings tab is never stripped: it is the escape hatch
  // that turns a disabled character back on, so it is re-painted instead
  // (stlTabRefresh).
  //
  // Idempotent per (character, state) pair: the game re-sends init data,
  // so the body below runs once per actual change rather than per message.
  // ---------------------------------------------------------------------
  let trackerStateKey = null;

  function applyTrackerState() {
    const characterId = resolveCharacter().characterId;
    const disabled = isCharacterDisabled(characterId);
    const key = (characterId == null ? "unknown" : characterId) + ":" + disabled;
    if (trackerStateKey === key) return;
    trackerStateKey = key;

    if (disabled) {
      removeFab();
      // Close any tracker UI that is on screen (both become unreachable
      // once the button is gone, but left open they'd look "on").
      if (panel && panel.classList.contains("open")) panel.classList.remove("open");
      if (overlayEl && overlayEl.classList) overlayEl.classList.remove("stl-overlay-open");
      // Wipe every mark the tracker painted in the game world (highlight
      // card + badge, "no suitable trial" / "ledger unreachable" notice).
      clearTrialHighlightMarks();
      appliedHighlight = null;
      appliedNoTrialNotice = null;
      const notice = document.getElementById("stl-trial-notice");
      if (notice) notice.remove();
      // Freeze the highlight retry chain and detach the trials-panel
      // observer so a late re-render can't repaint anything.
      if (highlightRetryTimer !== null) {
        clearTimeout(highlightRetryTimer);
        highlightRetryTimer = null;
      }
      highlightRetryCount = 0;
      highlightRetryPanel = null;
      observeTrialPanel(null);
    } else if (document.body) {
      if (!cfgGet().hideUpdateFab) ensureFab();
      sweep(); // refetch the plan, re-apply the highlight, re-observe
      checkForUpdate(cfgGet().apiBase.replace(/\/$/, "")); // re-arm the nag
    }
    // The banner + FAB dot hide themselves while disabled (render reads
    // the switch on every paint); both directions repaint so a switch-off
    // hides a banner the startup fetch already showed.
    renderUpdateReminder();
    // Keep the in-game Settings tab's controls honest — it is the only UI
    // that survives a switch-off, so it must show the new state.
    if (stlTabRefresh) {
      try {
        stlTabRefresh();
      } catch (e) { /* tab not mounted */ }
    }
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
    // v1.37.0: a character already known to be off (last session's
    // detection, or an init message before the DOM was ready) never
    // flashes the button / update nag — the in-game Settings tab remains
    // the one tracker UI on the page.
    if (!cfgGet().hideUpdateFab && !trackerDisabled()) ensureFab();

    // v1.37.0: fetch the ledger's latest version at startup (skipped while
    // this character is off — applyTrackerState re-fetches on re-enable).
    // The banner is idempotent, so this is safe even before the panel exists.
    if (!trackerDisabled()) {
      checkForUpdate(cfgGet().apiBase.replace(/\/$/, ""));
    }

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
    // v1.37.0: while this character is switched off the button can't be
    // shown — point the player at the escape hatch that can turn the
    // tracker back on (the in-game Settings tab is the only UI the
    // switch keeps alive).
    if (trackerDisabled()) {
      window.alert(
        "The trial tracker is switched OFF for this character. Turn it back on from the in-game Settings \u2192 Trial Tracker tab."
      );
      return;
    }
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
