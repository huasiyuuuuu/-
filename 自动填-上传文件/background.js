importScripts("shared.js");

const { STORAGE_KEYS, normalizeVault, parseSmsCode } = self.VaultUtils;
const LOCAL_SAVE_API = "http://127.0.0.1:37621";
const KIRO_SESSIONS_KEY = "kiro_sessions_vault";
// Domains we ask chrome.cookies for when exporting a Kiro session. We pass
// the naked domain to getAll() so both subdomain and host-only cookies are
// returned ({ domain: 'kiro.dev' } matches *.kiro.dev as well).
const KIRO_COOKIE_DOMAINS = ["kiro.dev", "app.kiro.dev"];
// Cookie-name → export field mapping. Keys are lower-cased for comparison.
const KIRO_COOKIE_FIELD_MAP = {
  "accesstoken": "access_token",
  "refreshtoken": "refresh_token",
  "userid": "user_id",
  "kiro-visitor-id": "visitor_id",
  "idp": "idp"
};

async function getSession() {
  const localData = await chrome.storage.local.get([STORAGE_KEYS.plainVault]);
  if (localData[STORAGE_KEYS.plainVault]) {
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]).catch(() => {});
    return {
      vault: normalizeVault(localData[STORAGE_KEYS.plainVault]),
      keyB64: ""
    };
  }

  const data = await chrome.storage.session.get([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]);
  if (data[STORAGE_KEYS.sessionVault]) {
    return {
      vault: normalizeVault(data[STORAGE_KEYS.sessionVault]),
      keyB64: data[STORAGE_KEYS.sessionKey] || ""
    };
  }
  return {
    vault: null,
    keyB64: ""
  };
}

async function fetchSmsCode(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain,*/*"
      }
    });
    const text = await response.text();
    const parsed = parseSmsCode(text);
    return {
      ok: response.ok,
      status: response.status,
      code: parsed.code,
      raw: parsed.raw || text
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, status: 0, code: "", raw: "", error: "SMS API timeout (10s)" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function saveVaultToLocalFolder(vault) {
  const response = await fetch(`${LOCAL_SAVE_API}/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ vault: normalizeVault(vault) })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Local save failed: ${response.status}`);
  }
  return body;
}

function removeBrowsingData(options, dataTypes) {
  return new Promise((resolve, reject) => {
    chrome.browsingData.remove(
      options,
      dataTypes,
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function clearSiteData(origins, tabId) {
  const cleanOrigins = [...new Set([].concat(origins || []))]
    .map((origin) => String(origin || "").trim())
    .filter((origin) => /^https?:\/\//i.test(origin));

  if (!cleanOrigins.length) {
    throw new Error("Invalid origin.");
  }

  await removeBrowsingData(
    {
      origins: cleanOrigins,
      since: 0
    },
    {
      cacheStorage: true,
      cookies: true,
      fileSystems: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
      webSQL: true
    }
  );

  await removeBrowsingData(
    { since: 0 },
    { cache: true }
  );

  if (tabId) chrome.tabs.reload(tabId);
  return { origins: cleanOrigins, cacheCleared: true };
}

async function sendMessageToAllFrames(tabId, payload) {
  if (!tabId) throw new Error("Missing tab id.");
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0 }]);
  const targets = frames?.length ? frames : [{ frameId: 0 }];
  const results = await Promise.all(
    targets.map((frame) =>
      chrome.tabs.sendMessage(tabId, payload, { frameId: frame.frameId })
        .then((response) => ({ frameId: frame.frameId, response }))
        .catch((error) => ({ frameId: frame.frameId, error: error?.message || String(error) }))
    )
  );
  const filled = results.reduce((sum, item) => sum + (Number(item.response?.filled) || 0), 0);
  const ok = results.some((item) => item.response?.ok);
  return { ok, filled, frames: results };
}

async function purgeOpenFrames(tabId) {
  if (!tabId) return { ok: false, frames: [] };
  const result = await sendMessageToAllFrames(tabId, { type: "purgeFrameStorage" });
  return { ok: true, frames: result.frames };
}

// --- Kiro Session export --------------------------------------------------
//
// Pulls auth cookies from kiro.dev / app.kiro.dev, asks the active Kiro tab
// for csrf_token + profile_arn (those don't live in cookies), and assembles
// a single session object. Missing fields are left as empty strings — the
// popup is responsible for showing the user which ones it couldn't grab so
// they can paste from DevTools as a fallback.

async function getAllKiroCookies() {
  const seen = new Map();
  for (const domain of KIRO_COOKIE_DOMAINS) {
    let cookies;
    try {
      cookies = await chrome.cookies.getAll({ domain });
    } catch (_) {
      cookies = [];
    }
    for (const cookie of cookies || []) {
      // Dedup on (domain,name,path) so we don't count the same cookie twice
      // when both the .kiro.dev and app.kiro.dev sweeps return it.
      const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
      if (!seen.has(key)) seen.set(key, cookie);
    }
  }
  return [...seen.values()];
}

function cookieMapToFields(cookies) {
  // Build case-insensitive name → value map. If a cookie name appears on
  // multiple domains, prefer the one with the longer value (tokens are long,
  // flags are short).
  const picks = {};
  for (const cookie of cookies || []) {
    const key = String(cookie.name || "").toLowerCase();
    if (!KIRO_COOKIE_FIELD_MAP[key]) continue;
    const value = String(cookie.value || "");
    if (!value) continue;
    const prev = picks[key];
    if (!prev || String(prev.value || "").length < value.length) {
      picks[key] = cookie;
    }
  }
  const fields = {};
  for (const [cookieKey, fieldKey] of Object.entries(KIRO_COOKIE_FIELD_MAP)) {
    const cookie = picks[cookieKey];
    fields[fieldKey] = cookie ? String(cookie.value || "") : "";
  }
  return fields;
}

async function findActiveKiroTab() {
  const tabs = await chrome.tabs.query({ url: ["https://kiro.dev/*", "https://*.kiro.dev/*"] });
  if (!tabs?.length) return null;
  // Prefer an app.kiro.dev tab (profile_arn only shows up after login there).
  return tabs.find((tab) => /app\.kiro\.dev/.test(tab.url || ""))
      || tabs.find((tab) => /\.kiro\.dev/.test(tab.url || ""))
      || tabs[0];
}

async function askTabForCsrfAndArn(tabId) {
  if (!tabId) return { csrfToken: "", profileArn: "", csrfSource: "" };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "getCsrfAndProfileArn" });
    if (!response?.ok) return { csrfToken: "", profileArn: "", csrfSource: "" };
    return {
      csrfToken: response.csrfToken || "",
      profileArn: response.profileArn || "",
      csrfSource: response.csrfSource || ""
    };
  } catch (_) {
    return { csrfToken: "", profileArn: "", csrfSource: "" };
  }
}

async function buildKiroSessionExport({ name = "" } = {}) {
  const cookies = await getAllKiroCookies();
  const fields = cookieMapToFields(cookies);
  const tab = await findActiveKiroTab();
  const extras = await askTabForCsrfAndArn(tab?.id);
  const exportedAt = new Date().toISOString();
  const session = {
    name: String(name || "").trim() || exportedAt,
    access_token: fields.access_token || "",
    refresh_token: fields.refresh_token || "",
    csrf_token: extras.csrfToken || "",
    user_id: fields.user_id || "",
    visitor_id: fields.visitor_id || "",
    profile_arn: extras.profileArn || "",
    exported_at: exportedAt,
    idp: fields.idp || ""
  };
  const missing = [];
  for (const key of ["access_token", "refresh_token", "user_id", "visitor_id"]) {
    if (!session[key]) missing.push(key);
  }
  if (!session.csrf_token) missing.push("csrf_token");
  if (!session.profile_arn) missing.push("profile_arn");
  return {
    session,
    missing,
    cookieCount: cookies.length,
    tabUrl: tab?.url || "",
    csrfSource: extras.csrfSource || ""
  };
}

function validateKiroSession(session) {
  // Schema check used by both the runtime "save" path and the audit.
  if (!session || typeof session !== "object") return { ok: false, error: "not an object" };
  const required = ["name", "access_token", "refresh_token", "csrf_token", "user_id", "visitor_id", "profile_arn", "exported_at"];
  for (const key of required) {
    if (typeof session[key] !== "string") return { ok: false, error: `${key} must be string` };
  }
  if (!session.access_token) return { ok: false, error: "access_token empty" };
  if (!session.refresh_token) return { ok: false, error: "refresh_token empty" };
  if (!/^arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Z0-9]+$/.test(session.profile_arn)) {
    return { ok: false, error: "profile_arn shape invalid" };
  }
  if (Number.isNaN(Date.parse(session.exported_at))) return { ok: false, error: "exported_at not ISO" };
  return { ok: true };
}

async function readKiroSessions() {
  const data = await chrome.storage.local.get([KIRO_SESSIONS_KEY]);
  const list = Array.isArray(data[KIRO_SESSIONS_KEY]) ? data[KIRO_SESSIONS_KEY] : [];
  return list;
}

async function saveKiroSession(session) {
  const valid = validateKiroSession(session);
  if (!valid.ok) throw new Error(`invalid session: ${valid.error}`);
  const list = await readKiroSessions();
  // Replace any record with the same user_id; otherwise prepend.
  const filtered = list.filter((item) => item.user_id !== session.user_id || !session.user_id);
  filtered.unshift(session);
  // Cap at 50 to keep storage bounded.
  const capped = filtered.slice(0, 50);
  await chrome.storage.local.set({ [KIRO_SESSIONS_KEY]: capped });
  return { count: capped.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "getVaultSnapshot") {
      const session = await getSession();
      sendResponse({ ok: true, unlocked: Boolean(session.vault), vault: session.vault });
      return;
    }

    if (message?.type === "fetchSmsCode") {
      if (!message.url || !/^https?:\/\//i.test(message.url)) {
        sendResponse({ ok: false, error: "Invalid SMS API URL." });
        return;
      }
      const result = await fetchSmsCode(message.url);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "saveVaultToLocalFolder") {
      const session = await getSession();
      if (!session.vault) {
        sendResponse({ ok: false, error: "Vault is locked." });
        return;
      }
      const result = await saveVaultToLocalFolder(session.vault);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "clearSiteData") {
      if (message.hard !== false) {
        await purgeOpenFrames(message.tabId || sender.tab?.id);
      }
      const result = await clearSiteData(message.origins || message.origin, message.tabId || sender.tab?.id);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "fillAllFrames") {
      const result = await sendMessageToAllFrames(message.tabId || sender.tab?.id, message.payload);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "exportKiroSession") {
      const result = await buildKiroSessionExport({ name: message.name });
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "saveKiroSession") {
      const result = await saveKiroSession(message.session);
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message?.type === "listKiroSessions") {
      const list = await readKiroSessions();
      sendResponse({ ok: true, sessions: list });
      return;
    }

    if (message?.type === "deleteKiroSession") {
      const list = await readKiroSessions();
      const next = list.filter((item) => item.exported_at !== message.exportedAt);
      await chrome.storage.local.set({ [KIRO_SESSIONS_KEY]: next });
      sendResponse({ ok: true, count: next.length });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});


// Exposed for the smoke-test audit. No runtime code reads these; a page
// context wouldn't see `self.__kiroSessionInternals` anyway since this file
// is a service worker.
self.__kiroSessionInternals = {
  cookieMapToFields,
  validateKiroSession,
  KIRO_COOKIE_DOMAINS,
  KIRO_COOKIE_FIELD_MAP,
  KIRO_SESSIONS_KEY
};
