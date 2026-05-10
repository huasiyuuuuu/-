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
  let domObserver = null;

  // ---------- Page context / capability detection ----------

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

  // ---------- Toast ----------

  function showToast(message, kind = "") {
    let toast = document.querySelector(".gba-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "gba-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.show = "true";
    if (kind) toast.dataset.kind = kind;
    else delete toast.dataset.kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.dataset.show = "false";
    }, 2400);
  }

  // ---------- Clipboard helpers ----------

  /**
   * Copies text to the clipboard and schedules a clear after `ttlMs`.
   * The clear only fires while this frame is still alive; if the tab closes,
   * the clipboard keeps whatever was last copied. Before wiping, we verify the
   * clipboard still holds our value so we don't stomp on a user's later copy.
   */
  async function copyTransient(text, { ttlMs = 30000 } = {}) {
    await navigator.clipboard.writeText(text);
    setTimeout(async () => {
      try {
        const now = await navigator.clipboard.readText();
        if (now === text) await navigator.clipboard.writeText("");
      } catch {
        // readText typically requires a user gesture; if it's blocked we play
        // it safe and leave the clipboard alone rather than risk wiping an
        // unrelated value the user may have copied since.
      }
    }, ttlMs);
  }

  // ---------- Field writing ----------

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
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    } catch {
      // Older browsers may not support InputEvent('beforeinput'). Safe to ignore.
    }
    if (descriptor?.set) descriptor.set.call(element, text);
    else element.value = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function fieldsNear(target) {
    const root = target?.closest?.("form") || target?.closest?.("[role='form']") || target || document;
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

  // Characters banks/Stripe use to show a "masked" or placeholder value. Treat them as empty
  // so "•••• 4242" / "XXXX" / "****" don't block a fresh fill.
  const MASK_STRIP = /[\s•·●○◦\u2022*xX_\-—–]/g;

  function effectivelyEmpty(text) {
    if (!text) return true;
    return !String(text).replace(MASK_STRIP, "");
  }

  // Field labels for the structured banner shown in popup / dock toast.
  const KIND_LABELS = {
    email: "邮箱",
    username: "账号",
    password: "密码",
    otp: "验证码",
    cardNumber: "卡号",
    expiry: "到期",
    expiryMonth: "月",
    expiryYear: "年",
    cvv: "CVV",
    phone: "电话",
    name: "姓名",
    address: "地址",
    addressLine1: "地址 1",
    addressLine2: "地址 2",
    postal: "邮编",
    city: "城市",
    state: "州/省",
    country: "国家"
  };
  function labelFor(kind) { return KIND_LABELS[kind] || kind; }

  // decideSet — single source of truth for "do we write this field?".
  // Returns an object so callers can discriminate between "skipped because
  // already matching" vs "skipped because user didn't opt in to overwrite".
  function decideSet(field, value, settings, kind = "") {
    if (value == null || value === "") return { write: false, reason: "no-value" };
    const currentText = String(field.isContentEditable ? field.textContent : field.value || "").trim();
    if (effectivelyEmpty(currentText)) return { write: true, reason: "empty" };
    if (currentText === String(value)) return { write: false, reason: "already-matching" };
    if (settings?.overwriteExisting) return { write: true, reason: "overwrite" };

    const newDigits = digits(value).length;
    const curDigits = digits(currentText).length;
    if (kind === "cardNumber" && curDigits < newDigits) return { write: true, reason: "more-complete" };
    if (kind === "cvv" && curDigits < newDigits) return { write: true, reason: "more-complete" };
    if (kind === "expiry" && curDigits < 4) return { write: true, reason: "more-complete" };
    if (kind === "expiryMonth" && curDigits < 2) return { write: true, reason: "more-complete" };
    if (kind === "expiryYear" && curDigits < 2) return { write: true, reason: "more-complete" };
    if (kind === "otp" && curDigits < newDigits) return { write: true, reason: "more-complete" };
    if (kind === "postal" && curDigits < newDigits) return { write: true, reason: "more-complete" };
    return { write: false, reason: "has-value" };
  }

  // Structured result container used by every filler.
  function newDetails() {
    return { filled: [], skipped: [], alreadyMatching: 0, warnings: [] };
  }

  function recordDecision(details, decision, kind, write) {
    const label = labelFor(kind);
    if (write) { details.filled.push({ kind, label }); return; }
    if (decision.reason === "already-matching") { details.alreadyMatching += 1; return; }
    if (decision.reason === "has-value") { details.skipped.push({ kind, label, reason: "has-value" }); }
    // 'no-value' isn't recorded: it just means the vault lacked this field.
  }

  function expiryParts(billing) {
    const month = String(billing.expiryMonth || "").padStart(2, "0");
    const year4 = String(billing.expiryYear || "");
    const year2 = year4.slice(-2);
    return { month, year4, year2, compact: `${month}${year2}`, slash: `${month}/${year2}`, spaced: `${month} / ${year2}` };
  }

  // Writes the expiry value without re-running the decide step. Returns the
  // string that ended up in the field (or null if we had nothing to write).
  function writeExpiry(field, billing) {
    const exp = expiryParts(billing);
    if (!exp.month || !exp.year2) return null;
    const maxLength = Number(field.getAttribute("maxlength") || 0);
    const primary = maxLength && maxLength <= 5 ? exp.slash : exp.spaced;
    setNativeValue(field, primary);
    if (digits(field.value).length < 4) {
      setNativeValue(field, exp.compact);
      return exp.compact;
    }
    return primary;
  }

  async function fillAccount(target, account, settings = {}) {
    const details = newDetails();
    if (!account) return details;
    for (const field of fieldsNear(target || document.body)) {
      const kind = inferFieldType(field);
      let value = "";
      if (kind === "email") value = account.email || account.username;
      else if (kind === "username") value = account.username || account.email;
      else if (kind === "password") value = account.password;
      else if (kind === "otp" && settings.fillTotp !== false && account.totpSecret) {
        try { value = await totpCode(account.totpSecret); } catch { value = ""; }
      } else {
        continue;
      }
      const decision = decideSet(field, value, settings, kind);
      const written = decision.write && setNativeValue(field, value);
      recordDecision(details, decision, kind, Boolean(written));
    }
    return details;
  }

  function findSegmentedOtpGroup(fields, requiredLen) {
    const cand = fields.filter((field) => {
      if (!field || field.tagName !== "INPUT") return false;
      const maxlen = Number(field.getAttribute("maxlength") || 0);
      if (maxlen !== 1) return false;
      const type = (field.getAttribute("type") || "").toLowerCase();
      const inputmode = (field.getAttribute("inputmode") || "").toLowerCase();
      if (type === "password" || type === "checkbox" || type === "radio" || type === "hidden") return false;
      if (type && !["text", "tel", "number", "search", ""].includes(type)) return false;
      return !inputmode || inputmode === "numeric" || inputmode === "decimal" || inputmode === "text";
    });
    if (cand.length < Math.min(requiredLen, 4)) return null;
    return cand.slice(0, Math.min(cand.length, Math.max(requiredLen, 4)));
  }

  function fillSegmentedOtp(boxes, code) {
    const chars = String(code || "").split("");
    if (!boxes || !chars.length) return 0;
    let filled = 0;
    for (let i = 0; i < boxes.length && i < chars.length; i += 1) {
      const box = boxes[i];
      try { box.focus?.(); } catch { /* focus may throw in certain frames */ }
      if (setNativeValue(box, chars[i])) filled += 1;
      try {
        box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: chars[i] }));
        box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: chars[i] }));
      } catch {
        // KeyboardEvent may be unavailable in stripped environments (audit mock).
      }
    }
    try { boxes[Math.min(chars.length, boxes.length) - 1]?.blur?.(); } catch { /* ignore */ }
    return filled;
  }

  function fillOtpCode(target, code, settings = {}) {
    const details = newDetails();
    if (!code) return details;
    const fields = fieldsNear(target || document.body);
    const otpFields = fields.filter((field) => inferFieldType(field) === "otp");

    const singleBox = otpFields.find((field) => Number(field.getAttribute("maxlength") || 0) !== 1);
    if (singleBox) {
      try { singleBox.focus?.(); } catch { /* ignore */ }
      const decision = decideSet(singleBox, code, settings, "otp");
      if (decision.write && setNativeValue(singleBox, code)) {
        try { singleBox.blur?.(); } catch { /* ignore */ }
        details.filled.push({ kind: "otp", label: labelFor("otp") });
        return details;
      }
      try { singleBox.blur?.(); } catch { /* ignore */ }
      if (decision.reason === "already-matching") { details.alreadyMatching += 1; return details; }
      // else: fall through to segmented.
    }

    const segmentedOtp = otpFields.filter((field) => Number(field.getAttribute("maxlength") || 0) === 1);
    const boxes = segmentedOtp.length >= Math.min(code.length, 4)
      ? segmentedOtp
      : findSegmentedOtpGroup(fields, code.length);
    if (boxes && boxes.length >= Math.min(code.length, 4)) {
      const written = fillSegmentedOtp(boxes, code);
      if (written > 0) {
        details.filled.push({ kind: "otp", label: `${labelFor("otp")}（${written} 格）` });
      }
      return details;
    }

    // Last resort: write the full code into each otp-typed box we saw.
    for (const field of otpFields) {
      const decision = decideSet(field, code, settings, "otp");
      const written = decision.write && setNativeValue(field, code);
      recordDecision(details, decision, "otp", Boolean(written));
    }
    return details;
  }

  // Returns the set of <form> elements on the page that contain a card-number
  // style field. Used to scope `fillBilling` so that pages with a visible
  // billing form alongside a secondary "add backup card" form don't get both
  // filled.
  function billingFormScopes() {
    const selectors = [
      "[autocomplete='cc-number']",
      "[autocomplete='cc-csc']",
      "[autocomplete='cc-exp']",
      "[name*='card' i][name*='number' i]",
      "[id*='card' i][id*='number' i]",
      "[name*='cardnumber' i]",
      "[id*='cardnumber' i]"
    ].join(",");
    const forms = [];
    let hasLooseField = false;
    let candidates = [];
    try { candidates = [...document.querySelectorAll(selectors)]; } catch { candidates = []; }
    for (const el of candidates) {
      if (!visibleElement(el)) continue;
      const form = el.closest?.("form");
      if (form) { if (!forms.includes(form)) forms.push(form); }
      else hasLooseField = true;
    }
    return { forms, hasLooseField };
  }

  function fillBilling(target, billing, settings = {}) {
    const details = newDetails();
    if (!billing) return details;
    const address = splitAddress(billing.address);
    if (billing.addressLine1) address.line1 = billing.addressLine1;
    if (billing.addressLine2) address.line2 = billing.addressLine2;

    let scope = target || document.body;
    // Only auto-pick a form scope when the caller didn't point us at a specific
    // element tree. A caller (e.g. an event handler) that passes a form node
    // is trusted to know what it's doing.
    if (!target || target === document.body) {
      const s = billingFormScopes();
      if (s.forms.length === 1) scope = s.forms[0];
      else if (s.forms.length > 1) { scope = s.forms[0]; details.warnings.push("multi-form"); }
      // else: leave scope = document.body (loose fields, e.g. Stripe Elements
      // in an iframe with no enclosing form).
    }

    for (const field of fieldsNear(scope)) {
      const kind = inferFieldType(field);

      if (kind === "expiry") {
        const exp = expiryParts(billing);
        if (!exp.month || !exp.year2) continue;
        const decision = decideSet(field, exp.compact, settings, "expiry");
        if (decision.write) {
          if (writeExpiry(field, billing)) {
            details.filled.push({ kind: "expiry", label: labelFor("expiry") });
          }
        } else {
          recordDecision(details, decision, "expiry", false);
        }
        continue;
      }

      let value = "";
      if (kind === "cardNumber") value = billing.cardNumber;
      else if (kind === "expiryMonth") value = expiryParts(billing).month;
      else if (kind === "expiryYear") {
        const exp = expiryParts(billing);
        const maxLength = Number(field.getAttribute("maxlength") || 0);
        value = maxLength && maxLength <= 2 ? exp.year2 : exp.year4;
      }
      else if (kind === "cvv") value = billing.cvv;
      else if (kind === "phone") value = billing.phone;
      else if (kind === "name") value = billing.name;
      else if (kind === "address" || kind === "addressLine1") value = address.line1;
      else if (kind === "addressLine2") value = address.line2;
      else if (kind === "postal") value = address.postal;
      else if (kind === "city") value = address.city;
      else if (kind === "state") value = address.state;
      else if (kind === "country") value = address.country;
      else continue;

      const decision = decideSet(field, value, settings, kind);
      const written = decision.write && setNativeValue(field, value);
      recordDecision(details, decision, kind, Boolean(written));
    }
    return details;
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
      showToast("先在扩展弹窗里粘贴并保存数据", "warn");
      return newDetails();
    }
    return handler(getSelected(snapshot.vault));
  }

  // ---------- Dock positioning + drag ----------

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

  // ---------- Toast summariser ----------

  // Compresses a structured details object into a short string suitable for the
  // inline toast. popup renders a much richer multiline version.
  function summariseDetails(details, opts = {}) {
    if (!details) return { kind: "warn", text: opts.emptyText || "没有可填字段" };
    const filled = details.filled || [];
    const skipped = details.skipped || [];
    const already = Number(details.alreadyMatching) || 0;
    const warnings = details.warnings || [];
    if (filled.length) {
      const names = [...new Set(filled.map((item) => item.label))];
      const extra = [];
      if (skipped.length) extra.push(`跳过 ${skipped.length}`);
      if (already) extra.push(`已匹配 ${already}`);
      const suffix = extra.length ? ` · ${extra.join(" · ")}` : "";
      return { kind: "good", text: `已填 ${filled.length} 项（${names.join("、")}）${suffix}` };
    }
    if (already && !skipped.length) {
      return { kind: "warn", text: `字段已匹配当前 vault（${already} 项），无需重填` };
    }
    if (skipped.length) {
      return { kind: "warn", text: `跳过 ${skipped.length} 项已有值 · 勾 "覆盖已有字段" 后再试` };
    }
    if (warnings.includes("multi-form")) {
      return { kind: "warn", text: "发现多个账单表单，只填第一个" };
    }
    return { kind: "warn", text: opts.emptyText || "没有可填字段" };
  }

  // ---------- High-level dock actions ----------

  async function autoFillForContext(context) {
    const result = await withVault(async ({ settings, account, github, billing }) => {
      if (context.isPayment || context.isKiro) {
        const response = await chrome.runtime.sendMessage({
          type: "fillAllFrames",
          payload: {
            type: "fillFromPopup",
            kind: "billing",
            billing,
            settings
          }
        });
        return response?.details || newDetails();
      }
      if (context.isGithubLogin) return fillAccount(document.body, github || account, settings);
      return fillAccount(document.body, account || github, settings);
    });
    const summary = summariseDetails(result);
    showToast(summary.text, summary.kind);
  }

  function logoutOriginsForContext() {
    const origins = new Set([location.origin]);
    const ctx = pageContext();
    if (ctx.isKiro || /kiro/i.test(location.hostname)) {
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
    if (ctx.isPayment) {
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
    const confirmed = confirm(
      `深度清理本地 Cookie / 缓存 / storage：\n${origins.join("\n")}\n\n` +
      "注意：这只清除本机数据，不会让 Google 服务器端退出登录。页面会刷新。"
    );
    if (!confirmed) return;
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {
      // Some pages block storage access.
    }
    const response = await chrome.runtime.sendMessage({ type: "clearSiteData", origins, hard: true });
    if (!response?.ok) throw new Error(response?.error || "Clear failed");
    showToast("已深度清理本地站点记录", "good");
  }

  async function fetchAndFillSmsCodeFromDock() {
    await withVault(async ({ settings, billing }) => {
      if (!billing?.smsApi) throw new Error("当前账单没有接码 API");
      let code = "";
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const response = await chrome.runtime.sendMessage({ type: "fetchSmsCode", url: billing.smsApi });
        if (!response?.ok) throw new Error(response?.error || "SMS fetch failed");
        code = response.code || "";
        if (code) break;
        if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2500));
      }
      if (!code) throw new Error("接码 API 没返回验证码");
      await copyTransient(code);
      showToast(`SMS ${code} · 30s 后自动清剪贴板`, "warn");
      // The 3DS / challenge iframe often mounts only after the user hits "Pay".
      // Poll for ~12s so the user can open the challenge and we'll still fill.
      let details = newDetails();
      for (let i = 0; i < 12; i += 1) {
        const fillResponse = await chrome.runtime.sendMessage({
          type: "fillAllFrames",
          payload: {
            type: "fillFromPopup",
            kind: "smsCode",
            code,
            settings: { ...settings, overwriteExisting: true }
          }
        }).catch(() => null);
        details = fillResponse?.details || details;
        if ((details.filled?.length || 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const count = details.filled?.length || 0;
      if (count) showToast(`验证码已填入 ${count} 项`, "good");
      else showToast(`验证码 ${code} 已复制，12 秒内未找到输入框`, "warn");
      return details;
    });
  }

  async function copy2fa() {
    await withVault(async ({ account, github }) => {
      const selected = pageContext().isGithubLogin ? github || account : account || github;
      if (!selected?.totpSecret) throw new Error("没有 2FA 密钥");
      const code = await totpCode(selected.totpSecret);
      await copyTransient(code);
      showToast(`2FA 已复制：${code}（30s 后自动清剪贴板）`, "good");
      return newDetails();
    });
  }

  // ---------- Dock DOM ----------

  function dockButton(label, handler, { primary = false, danger = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.dataset.primary = "true";
    if (danger) button.dataset.danger = "true";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler().catch((error) => showToast(error?.message || "操作失败", "bad"));
    });
    return button;
  }

  function createDock() {
    const context = pageContext();
    if (!dockEnabled || !context.allowDock || dock) return;

    dock = document.createElement("div");
    dock.className = "gba-dock";
    dock.dataset.open = "false";

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "gba-dock-handle";
    handle.textContent = "⋮⋮";
    handle.title = "按住拖动";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "gba-dock-main";
    main.textContent = "Fill";
    main.title = "一键填充当前页";
    main.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      autoFillForContext(pageContext()).catch((error) => showToast(error?.message || "填充失败", "bad"));
    });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "gba-dock-toggle";
    toggle.textContent = "⋯";
    toggle.title = "更多操作";

    const panel = document.createElement("div");
    panel.className = "gba-dock-panel";
    panel.hidden = true;

    panel.append(
      dockButton("Gmail", async () => {
        const details = await withVault(({ settings, account }) => fillAccount(document.body, account, settings));
        const summary = summariseDetails(details, { emptyText: "没找到 Gmail 字段" });
        showToast(summary.text, summary.kind);
      }, { primary: context.isGoogleLogin }),
      dockButton("GitHub", async () => {
        const details = await withVault(({ settings, github }) => fillAccount(document.body, github, settings));
        const summary = summariseDetails(details, { emptyText: "没找到 GitHub 字段" });
        showToast(summary.text, summary.kind);
      }, { primary: context.isGithubLogin }),
      dockButton("账单", async () => {
        const details = await withVault(({ settings, billing }) => fillBilling(document.body, billing, settings));
        const summary = summariseDetails(details, { emptyText: "没找到账单字段" });
        showToast(summary.text, summary.kind);
      }, { primary: context.isPayment }),
      dockButton("Copy 2FA", copy2fa),
      dockButton("取短信码", fetchAndFillSmsCodeFromDock),
    );

    panel.append(document.createElement("hr"));
    panel.append(
      dockButton(context.isKiro ? "深清 Kiro+Google" : "深清本地", clearLoginData, { danger: true })
    );

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      panel.hidden = !panel.hidden;
      dock.dataset.open = panel.hidden ? "false" : "true";
    });

    // Close panel on outside click.
    document.addEventListener("click", (event) => {
      if (panel.hidden) return;
      if (dock.contains(event.target)) return;
      panel.hidden = true;
      dock.dataset.open = "false";
    }, true);

    const row = document.createElement("div");
    row.className = "gba-dock-row";
    row.append(handle, main, toggle);
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

  function scheduleDockSync() {
    clearTimeout(syncDockTimer);
    syncDockTimer = setTimeout(syncDock, 250);
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

  // ---------- Page-change detection (no more 1s polling) ----------

  function hookNavigation() {
    // Sample-SPA-safe hooks: intercept history changes and fire a custom event so we
    // re-evaluate dock visibility only when something meaningful happens.
    const fire = () => scheduleDockSync();
    try {
      const h = typeof history !== "undefined" ? history : null;
      if (h?.pushState) {
        const origPush = h.pushState;
        const origReplace = h.replaceState;
        h.pushState = function pushStatePatched(...args) {
          const result = origPush.apply(this, args);
          fire();
          return result;
        };
        h.replaceState = function replaceStatePatched(...args) {
          const result = origReplace.apply(this, args);
          fire();
          return result;
        };
      }
    } catch {
      // If history isn't writable (some hardened CSP contexts), skip the patch.
    }
    try {
      window.addEventListener?.("popstate", fire);
      window.addEventListener?.("hashchange", fire);
      window.addEventListener?.("pageshow", fire);
      window.addEventListener?.("visibilitychange", () => {
        if (document.visibilityState === "visible") fire();
      });
    } catch {
      // addEventListener is missing in the audit mock; we're fine without these hooks.
    }
  }

  function installDomObserver() {
    // One root observer only; debounced. We don't need to re-check on every mutation —
    // the context detection only depends on the document URL + a small set of
    // payment-field selectors, so 250 ms debounce is more than enough.
    if (domObserver) return;
    domObserver = new MutationObserver(scheduleDockSync);
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
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

  // ---------- Bootstrap ----------

  refreshDockSetting();
  hookNavigation();
  installDomObserver();

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
        let details = newDetails();
        if (message.kind === "account") details = await fillAccount(document.body, message.account, message.settings);
        else if (message.kind === "github") details = await fillAccount(document.body, message.github, message.settings);
        else if (message.kind === "billing") details = fillBilling(document.body, message.billing, message.settings);
        else if (message.kind === "smsCode") details = fillOtpCode(document.body, message.code, { ...message.settings, overwriteExisting: true });
        else if (message.kind === "both") {
          const preferGithub = /(^|\.)github\.com$/i.test(location.hostname);
          const accountDetails = await fillAccount(document.body, preferGithub ? message.github || message.account : message.account, message.settings);
          const billingDetails = fillBilling(document.body, message.billing, message.settings);
          details = {
            filled: [...accountDetails.filled, ...billingDetails.filled],
            skipped: [...accountDetails.skipped, ...billingDetails.skipped],
            alreadyMatching: accountDetails.alreadyMatching + billingDetails.alreadyMatching,
            warnings: [...accountDetails.warnings, ...billingDetails.warnings]
          };
        }
        const filled = details.filled.length;
        if (filled) showToast(`已填 ${filled} 项`, "good");
        // Keep the legacy `filled: number` field so older callers don't break.
        sendResponse({ ok: true, filled, details });
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
