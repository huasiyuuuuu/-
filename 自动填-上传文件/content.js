(() => {
  const {
    STORAGE_KEYS,
    parseAccountLine,
    parseGithubLine,
    parseBillingText,
    normalizeVault,
    inferFieldType,
    visibleElement,
    splitAddress,
    totpCode
  } = window.VaultUtils;

  const DOCK_POSITION_KEY = "gba_dock_position";
  let toastTimer = null;
  let dock = null;
  let dragState = null;
  let dockEnabled = true;
  let syncDockTimer = null;

  function pageContext() {
    const host = location.hostname.toLowerCase();
    const pathHref = `${location.pathname} ${location.href}`.toLowerCase();
    const isGoogleLogin = host === "accounts.google.com";
    const isGithubLogin = host === "github.com" && /login|session|sessions|two-factor|2fa|signin/.test(pathHref);
    const isKiro = host === "kiro.dev" || host.endsWith(".kiro.dev");
    const isStripe = host === "stripe.com" || host.endsWith(".stripe.com");
    const isPaymentPath = /billing|checkout|invoice|payment|session|subscribe|portal|payment-method/.test(pathHref);
    const hasPaymentFields = Boolean(document.querySelector([
      "[autocomplete^='cc-']",
      "[autocomplete='street-address']",
      "[autocomplete='address-line1']",
      "[autocomplete='address-level1']",
      "[autocomplete='address-level2']",
      "[autocomplete='postal-code']",
      "[name*='card' i]",
      "[id*='card' i]",
      "[name*='billing' i]",
      "[id*='billing' i]"
    ].join(",")));
    const isPayment = (isStripe || isKiro) && (isPaymentPath || hasPaymentFields);
    return {
      allowDock: window.top === window.self && (isGoogleLogin || isGithubLogin || isKiro || isPayment),
      isGoogleLogin,
      isGithubLogin,
      isKiro,
      isPayment
    };
  }

  function showToast(message) {
    let toast = document.querySelector(".gba-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "gba-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.dataset.show = "false";
    }, 2200);
  }

  function setNativeValue(element, value) {
    const text = String(value ?? "");
    if (!element || element.disabled || element.readOnly) return false;

    if (element.tagName === "SELECT") {
      const normalized = text.toLowerCase();
      const match = [...element.options].find((option) => {
        const optValue = option.value.trim().toLowerCase();
        const optText = option.textContent.trim().toLowerCase();
        return optValue === normalized || optText === normalized || optText.includes(normalized);
      });
      if (!match) return false;
      element.value = match.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, text);
    else element.value = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fieldsNear(target) {
    const root = target?.closest?.("form") || target?.closest?.("[role='form']") || document;
    return [...root.querySelectorAll("input, textarea, select, [contenteditable='true']")]
      .filter(visibleElement)
      .filter((field) => {
        const type = (field.getAttribute("type") || "").toLowerCase();
        return !["button", "submit", "reset", "checkbox", "radio", "hidden", "file"].includes(type);
      });
  }

  function digits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function shouldSetValue(field, value, settings, kind = "") {
    if (value == null || value === "") return false;
    if (settings?.overwriteExisting) return true;
    const currentText = String(field.isContentEditable ? field.textContent : field.value || "").trim();
    if (!currentText) return true;
    if (kind === "expiry") return digits(currentText).length < 4;
    if (kind === "expiryYear") return digits(currentText).length < 2;
    return false;
  }

  function expiryParts(billing) {
    const month = String(billing.expiryMonth || "").padStart(2, "0");
    const year4 = String(billing.expiryYear || "");
    const year2 = year4.slice(-2);
    return { month, year4, year2, compact: `${month}${year2}`, slash: `${month}/${year2}`, spaced: `${month} / ${year2}` };
  }

  function setExpiryValue(field, billing, settings) {
    const exp = expiryParts(billing);
    if (!exp.month || !exp.year2 || !shouldSetValue(field, exp.compact, settings, "expiry")) return false;
    const maxLength = Number(field.getAttribute("maxlength") || 0);
    setNativeValue(field, maxLength && maxLength <= 5 ? exp.slash : exp.spaced);
    if (digits(field.value).length < 4) setNativeValue(field, exp.compact);
    return true;
  }

  async function fillAccount(target, account, settings = {}) {
    if (!account) return 0;
    let filled = 0;
    for (const field of fieldsNear(target || document.body)) {
      const kind = inferFieldType(field);
      let value = "";
      if (kind === "email") value = account.email || account.username;
      if (kind === "username") value = account.username || account.email;
      if (kind === "password") value = account.password;
      if (kind === "otp" && settings.fillTotp !== false && account.totpSecret) {
        try {
          value = await totpCode(account.totpSecret);
        } catch {
          value = "";
        }
      }
      if (shouldSetValue(field, value, settings, kind) && setNativeValue(field, value)) filled += 1;
    }
    return filled;
  }

  function fillOtpCode(target, code, settings = {}) {
    if (!code) return 0;
    let filled = 0;
    for (const field of fieldsNear(target || document.body)) {
      const kind = inferFieldType(field);
      if (kind === "otp" && shouldSetValue(field, code, settings, "otp") && setNativeValue(field, code)) filled += 1;
    }
    return filled;
  }

  function fillBilling(target, billing, settings = {}) {
    if (!billing) return 0;
    const address = splitAddress(billing.address);
    if (billing.addressLine1) address.line1 = billing.addressLine1;
    if (billing.addressLine2) address.line2 = billing.addressLine2;
    let filled = 0;

    for (const field of fieldsNear(target || document.body)) {
      const kind = inferFieldType(field);
      let value = "";
      if (kind === "cardNumber") value = billing.cardNumber;
      if (kind === "expiry") {
        if (setExpiryValue(field, billing, settings)) filled += 1;
        continue;
      }
      if (kind === "expiryMonth") value = expiryParts(billing).month;
      if (kind === "expiryYear") {
        const exp = expiryParts(billing);
        const maxLength = Number(field.getAttribute("maxlength") || 0);
        value = maxLength && maxLength <= 2 ? exp.year2 : exp.year4;
      }
      if (kind === "cvv") value = billing.cvv;
      if (kind === "phone") value = billing.phone;
      if (kind === "name") value = billing.name;
      if (kind === "address" || kind === "addressLine1") value = address.line1;
      if (kind === "addressLine2") value = address.line2;
      if (kind === "postal") value = address.postal;
      if (kind === "city") value = address.city;
      if (kind === "state") value = address.state;
      if (kind === "country") value = address.country;
      if (shouldSetValue(field, value, settings, kind) && setNativeValue(field, value)) filled += 1;
    }
    return filled;
  }

  function getSelected(vault) {
    const settings = vault?.settings || {};
    const account = vault?.accounts?.find((item) => item.id === settings.selectedAccountId) || vault?.accounts?.[0] || null;
    const github = vault?.githubs?.find((item) => item.id === settings.selectedGithubId) || vault?.githubs?.[0] || null;
    const billing = vault?.billings?.find((item) => item.id === settings.selectedBillingId) || vault?.billings?.[0] || null;
    return { settings, account, github, billing };
  }

  async function withVault(handler) {
    const snapshot = await chrome.runtime.sendMessage({ type: "getVaultSnapshot" });
    if (!snapshot?.unlocked || !snapshot.vault) {
      showToast("Paste and save data in the extension popup first");
      return 0;
    }
    return handler(getSelected(snapshot.vault));
  }

  function dockButton(label, handler, primary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.dataset.primary = "true";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler().catch((error) => showToast(error?.message || "Action failed"));
    });
    return button;
  }

  function clampDockPosition(left, top) {
    const rect = dock?.getBoundingClientRect();
    const width = rect?.width || 150;
    const height = rect?.height || 48;
    return {
      left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8)),
      top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8))
    };
  }

  function applyDockPosition(position) {
    if (!dock || !position) return;
    const next = clampDockPosition(position.left, position.top);
    dock.style.left = `${next.left}px`;
    dock.style.top = `${next.top}px`;
    dock.style.right = "auto";
    dock.style.bottom = "auto";
    dock.style.transform = "none";
  }

  async function restoreDockPosition() {
    try {
      const data = await chrome.storage.local.get([DOCK_POSITION_KEY]);
      applyDockPosition(data[DOCK_POSITION_KEY]);
    } catch {
      // Ignore.
    }
  }

  async function saveDockPosition() {
    if (!dock) return;
    const rect = dock.getBoundingClientRect();
    const position = clampDockPosition(rect.left, rect.top);
    applyDockPosition(position);
    try {
      await chrome.storage.local.set({ [DOCK_POSITION_KEY]: position });
    } catch {
      // Ignore.
    }
  }

  function enableDockDrag(handle) {
    const move = (event) => {
      if (!dragState) return;
      event.preventDefault();
      applyDockPosition(clampDockPosition(dragState.left + event.clientX - dragState.startX, dragState.top + event.clientY - dragState.startY));
    };

    const finish = (event) => {
      if (!dragState) return;
      if (event) event.preventDefault();
      dragState = null;
      dock.dataset.dragging = "false";
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
      saveDockPosition();
    };

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = dock.getBoundingClientRect();
      dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top };
      dock.dataset.dragging = "true";
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    });
  }

  async function autoFillForContext(context) {
    const filled = await withVault(async ({ settings, account, github, billing }) => {
      if (context.isPayment || context.isKiro) {
        const response = await chrome.runtime.sendMessage({
          type: "fillAllFrames",
          payload: {
            type: "fillFromPopup",
            kind: "billing",
            billing,
            settings: { ...settings, overwriteExisting: false }
          }
        });
        return response?.filled || 0;
      }
      if (context.isGithubLogin) return fillAccount(document.body, github || account, settings);
      return fillAccount(document.body, account || github, settings);
    });
    showToast(filled ? `Filled ${filled} fields` : "No matching fields found");
  }

  function logoutOriginsForContext() {
    const origins = new Set([location.origin]);
    if (pageContext().isKiro || /kiro/i.test(location.hostname)) {
      origins.add("https://app.kiro.dev");
      origins.add("https://kiro.dev");
      origins.add("https://auth.kiro.dev");
      origins.add("https://accounts.google.com");
      origins.add("https://myaccount.google.com");
      origins.add("https://www.google.com");
      origins.add("https://google.com");
      origins.add("https://ogs.google.com");
      origins.add("https://apis.google.com");
      origins.add("https://billing.stripe.com");
      origins.add("https://checkout.stripe.com");
      origins.add("https://js.stripe.com");
      origins.add("https://hooks.stripe.com");
      origins.add("https://m.stripe.network");
    }
    if (pageContext().isPayment) {
      origins.add("https://billing.stripe.com");
      origins.add("https://checkout.stripe.com");
      origins.add("https://js.stripe.com");
      origins.add("https://hooks.stripe.com");
      origins.add("https://m.stripe.network");
    }
    return [...origins];
  }

  async function purgeFrameStorage() {
    const result = { localStorage: false, sessionStorage: false, caches: 0, indexedDB: 0, serviceWorkers: 0 };
    try {
      localStorage.clear();
      result.localStorage = true;
    } catch {
      // Ignore inaccessible storage.
    }
    try {
      sessionStorage.clear();
      result.sessionStorage = true;
    } catch {
      // Ignore inaccessible storage.
    }
    try {
      if (globalThis.caches?.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        result.caches = keys.length;
      }
    } catch {
      // Ignore cache storage failures.
    }
    try {
      if (indexedDB?.databases) {
        const databases = await indexedDB.databases();
        await Promise.all(databases.map((database) => new Promise((resolve) => {
          if (!database?.name) {
            resolve();
            return;
          }
          const request = indexedDB.deleteDatabase(database.name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        })));
        result.indexedDB = databases.length;
      }
    } catch {
      // Ignore IndexedDB failures.
    }
    try {
      if (navigator.serviceWorker?.getRegistrations) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
        result.serviceWorkers = registrations.length;
      }
    } catch {
      // Ignore service worker failures.
    }
    return result;
  }

  async function clearLoginData() {
    const origins = logoutOriginsForContext();
    const confirmed = confirm(`Deep clear cookies and site storage for:\n${origins.join("\n")}\n\nThe page will reload.`);
    if (!confirmed) return;
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {
      // Some pages block storage access.
    }
    const response = await chrome.runtime.sendMessage({ type: "clearSiteData", origins, hard: true });
    if (!response?.ok) throw new Error(response?.error || "Clear failed");
    showToast("Deep site data cleared");
  }

  async function fetchAndFillSmsCodeFromDock() {
    await withVault(async ({ settings, billing }) => {
      if (!billing?.smsApi) throw new Error("No SMS API");
      let code = "";
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const response = await chrome.runtime.sendMessage({ type: "fetchSmsCode", url: billing.smsApi });
        if (!response?.ok) throw new Error(response?.error || "SMS fetch failed");
        code = response.code || "";
        if (code) break;
        if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      if (!code) throw new Error("SMS API returned no code");
      await navigator.clipboard.writeText(code);
      const fillResponse = await chrome.runtime.sendMessage({
        type: "fillAllFrames",
        payload: {
          type: "fillFromPopup",
          kind: "smsCode",
          code,
          settings: { ...settings, overwriteExisting: true }
        }
      });
      const filled = fillResponse?.filled || 0;
      showToast(filled ? `SMS code filled: ${filled}` : `SMS code copied: ${code}`);
      return filled;
    });
  }

  function createDock() {
    const context = pageContext();
    if (!dockEnabled || !context.allowDock || dock) return;

    dock = document.createElement("div");
    dock.className = "gba-dock";

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "gba-dock-handle";
    handle.textContent = "拖动";
    handle.title = "按住拖动悬浮按钮";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "gba-dock-main";
    main.textContent = "Fill";
    main.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      autoFillForContext(pageContext()).catch((error) => showToast(error?.message || "Fill failed"));
    });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gba-dock-toggle";
    toggle.textContent = "...";

    const clean = document.createElement("button");
    clean.type = "button";
    clean.className = "gba-dock-clean";
    clean.textContent = context.isKiro ? "深清Kiro" : "深清理";
    clean.title = "深度清理当前站点登录记录";
    clean.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearLoginData().catch((error) => showToast(error?.message || "Clear failed"));
    });

    const panel = document.createElement("div");
    panel.className = "gba-dock-panel";
    panel.hidden = true;
    panel.append(
      dockButton("Gmail", async () => {
        const filled = await withVault(({ settings, account }) => fillAccount(document.body, account, settings));
        showToast(filled ? `Filled Gmail: ${filled}` : "No Gmail fields found");
      }, context.isGoogleLogin),
      dockButton("GitHub", async () => {
        const filled = await withVault(({ settings, github }) => fillAccount(document.body, github, settings));
        showToast(filled ? `Filled GitHub: ${filled}` : "No GitHub fields found");
      }, context.isGithubLogin),
      dockButton("Billing", async () => {
        const filled = await withVault(({ settings, billing }) => fillBilling(document.body, billing, { ...settings, overwriteExisting: false }));
        showToast(filled ? `Filled billing: ${filled}` : "No billing fields found");
      }, context.isPayment),
      dockButton("Copy 2FA", async () => {
        await withVault(async ({ account, github }) => {
          const selected = pageContext().isGithubLogin ? github || account : account || github;
          if (!selected?.totpSecret) throw new Error("No 2FA secret");
          const code = await totpCode(selected.totpSecret);
          await navigator.clipboard.writeText(code);
          showToast(`2FA copied: ${code}`);
          return 0;
        });
      }),
      dockButton("SMS code", fetchAndFillSmsCodeFromDock),
      dockButton(context.isKiro ? "Clear Kiro+Google" : "Clear site", clearLoginData)
    );

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    const row = document.createElement("div");
    row.className = "gba-dock-row";
    row.append(handle, main, clean, toggle);
    dock.append(panel, row);
    document.documentElement.appendChild(dock);
    enableDockDrag(handle);
    restoreDockPosition();
  }

  function destroyDock() {
    dock?.remove();
    dock = null;
    dragState = null;
  }

  function syncDock() {
    if (!dockEnabled || !pageContext().allowDock) {
      destroyDock();
      return;
    }
    createDock();
  }

  async function refreshDockSetting() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEYS.plainVault]);
      const vault = data[STORAGE_KEYS.plainVault] ? normalizeVault(data[STORAGE_KEYS.plainVault]) : null;
      dockEnabled = vault?.settings?.autoFillOnHover !== false;
    } catch {
      dockEnabled = true;
    }
    syncDock();
  }

  function scheduleDockSync() {
    clearTimeout(syncDockTimer);
    syncDockTimer = setTimeout(syncDock, 120);
  }

  function extractPageData() {
    const text = document.body?.innerText || "";
    return {
      account: parseAccountLine(text),
      github: parseGithubLine(text),
      billing: parseBillingText(text),
      title: document.title,
      url: location.href
    };
  }

  refreshDockSetting();
  setInterval(syncDock, 1000);
  new MutationObserver(scheduleDockSync).observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEYS.plainVault]) {
      refreshDockSetting();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      if (message?.type === "extractPageData") {
        sendResponse({ ok: true, data: extractPageData() });
        return;
      }
      if (message?.type === "fillFromPopup") {
        let filled = 0;
        if (message.kind === "account") filled = await fillAccount(document.body, message.account, message.settings);
        if (message.kind === "github") filled = await fillAccount(document.body, message.github, message.settings);
        if (message.kind === "billing") filled = fillBilling(document.body, message.billing, { ...message.settings, overwriteExisting: false });
        if (message.kind === "smsCode") filled = fillOtpCode(document.body, message.code, { ...message.settings, overwriteExisting: true });
        if (message.kind === "both") {
          const preferGithub = /(^|\.)github\.com$/i.test(location.hostname);
          filled = await fillAccount(document.body, preferGithub ? message.github || message.account : message.account, message.settings);
          filled += fillBilling(document.body, message.billing, { ...message.settings, overwriteExisting: false });
        }
        if (filled) showToast(`Filled ${filled} fields`);
        sendResponse({ ok: true, filled });
        return;
      }
      if (message?.type === "purgeFrameStorage") {
        const result = await purgeFrameStorage();
        sendResponse({ ok: true, result });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message type." });
    })().catch((error) => {
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
    return true;
  });
})();
