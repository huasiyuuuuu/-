importScripts("shared.js");

const { STORAGE_KEYS, normalizeVault, parseSmsCode } = self.VaultUtils;
const LOCAL_SAVE_API = "http://127.0.0.1:37621";

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

    sendResponse({ ok: false, error: "Unknown message type." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});
