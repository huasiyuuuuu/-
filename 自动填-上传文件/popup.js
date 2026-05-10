(() => {
  const {
    DEFAULT_VAULT,
    STORAGE_KEYS,
    normalizeVault,
    parseAccountLine,
    parseAccountLines,
    parseGithubLine,
    parseGithubLines,
    parseBillingText,
    parseBillingBlocks,
    parseSmsCode,
    totpCode
  } = window.VaultUtils;

  const CARD_STATE_KEY = "gba_popup_card_state";

  let vault = normalizeVault(DEFAULT_VAULT);
  let importTimer = null;
  let lastImportedText = "";
  let cardState = { account: false, github: false, billing: false };

  const els = {
    statusText: document.querySelector("#statusText"),
    quickImport: document.querySelector("#quickImport"),
    pasteImport: document.querySelector("#pasteImport"),
    clearImport: document.querySelector("#clearImport"),
    results: document.querySelector("#results"),
    fillAuto: document.querySelector("#fillAuto"),
    fillBilling: document.querySelector("#fillBilling"),
    fillSmsCode: document.querySelector("#fillSmsCode"),
    openKiroHome: document.querySelector("#openKiroHome"),
    capturePage: document.querySelector("#capturePage"),
    saveFolder: document.querySelector("#saveFolder"),
    exportGoogleCsv: document.querySelector("#exportGoogleCsv"),
    clearSiteData: document.querySelector("#clearSiteData"),
    autoFillOnHover: document.querySelector("#autoFillOnHover"),
    overwriteExisting: document.querySelector("#overwriteExisting"),
    message: document.querySelector("#message"),
    // Deep-clean dialog (injected by popup.html).
    cleanDialog: document.querySelector("#cleanDialog"),
    cleanDialogOrigins: document.querySelector("#cleanDialogOrigins"),
    cleanDialogCancel: document.querySelector("#cleanDialogCancel"),
    cleanDialogConfirm: document.querySelector("#cleanDialogConfirm"),
    cleanDialogNote: document.querySelector("#cleanDialogNote")
  };

  // ---- Structured banner ----------------------------------------------------

  function setMessage(text, kind = "") {
    // Plain string path, kept for back-compat.
    els.message.replaceChildren();
    if (text === null || text === undefined || text === "") {
      els.message.removeAttribute("data-kind");
      els.message.textContent = "";
      return;
    }
    els.message.dataset.kind = kind || "info";
    els.message.textContent = text;
  }

  function renderBanner(lines, kind = "info") {
    // `lines` is an array of either strings or { prefix, text } objects.
    els.message.replaceChildren();
    if (!lines || !lines.length) {
      els.message.removeAttribute("data-kind");
      return;
    }
    els.message.dataset.kind = kind;
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "banner-line";
      if (typeof line === "string") {
        row.textContent = line;
      } else {
        if (line.prefix) {
          const pre = document.createElement("span");
          pre.className = "banner-prefix";
          pre.textContent = line.prefix;
          row.append(pre);
        }
        row.append(document.createTextNode(line.text || ""));
      }
      els.message.append(row);
    }
  }

  /**
   * Turns the structured `details` returned by content.js into a banner.
   *   details.filled       — [{kind,label}, ...]
   *   details.skipped      — [{kind,label,reason}, ...]
   *   details.alreadyMatching — number
   *   details.warnings     — string[]
   */
  function renderFillOutcome(details, opts = {}) {
    if (!details || (!details.filled?.length && !details.skipped?.length && !details.alreadyMatching && !details.warnings?.length)) {
      renderBanner([opts.emptyText || "没有找到可填字段（试试打开 \"覆盖已有字段\"）"], "warn");
      return;
    }
    const lines = [];
    let overall = "warn";

    if (details.filled?.length) {
      overall = "good";
      const names = [...new Set(details.filled.map((f) => f.label))].join("、");
      lines.push({ prefix: "✓", text: `已填 ${details.filled.length} 项：${names}` });
    }

    if (details.skipped?.length) {
      const names = [...new Set(details.skipped.map((f) => f.label))].join("、");
      lines.push({ prefix: "⚠", text: `跳过 ${details.skipped.length} 项已有值：${names}（勾 "覆盖已有字段" 可强填）` });
      if (!details.filled?.length) overall = "warn";
    }

    if (details.alreadyMatching) {
      lines.push({ prefix: "·", text: `${details.alreadyMatching} 项字段已匹配 vault，无需重填` });
    }

    if (details.warnings?.includes("multi-form")) {
      lines.push({ prefix: "⚠", text: "发现多个账单表单，只填了第一个" });
      if (!details.filled?.length) overall = "warn";
    }

    renderBanner(lines, overall);
  }

  function maskCard(number) {
    const digits = String(number || "").replace(/\D/g, "");
    if (!digits) return "";
    return `•••• ${digits.slice(-4)}`;
  }

  async function loadVault() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.plainVault, CARD_STATE_KEY]);
    vault = normalizeVault(data[STORAGE_KEYS.plainVault] || DEFAULT_VAULT);
    if (data[CARD_STATE_KEY]) cardState = { ...cardState, ...data[CARD_STATE_KEY] };
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]).catch(() => {});
  }

  async function saveVault() {
    vault = normalizeVault(vault);
    await chrome.storage.local.set({ [STORAGE_KEYS.plainVault]: vault });
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]).catch(() => {});
  }

  async function saveCardState() {
    try { await chrome.storage.local.set({ [CARD_STATE_KEY]: cardState }); } catch { /* ignore */ }
  }

  async function syncFolderQuietly(showResult = false) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "saveVaultToLocalFolder" });
      if (!response?.ok) throw new Error(response?.error || "保存失败");
      if (showResult) setMessage(`已保存到 ${response.dataRoot}`, "good");
      return true;
    } catch (error) {
      if (showResult) setMessage("需要先运行 start-local-save.bat 才能写入文件夹", "bad");
      return false;
    }
  }

  function activeBatchId() {
    vault = normalizeVault(vault);
    return vault.settings.activeBatchId || vault.batches[0]?.id || "";
  }

  function attachBatch(record) {
    if (record) record.batchId = activeBatchId();
    return record;
  }

  function upsertAccount(account) {
    if (!account) return false;
    attachBatch(account);
    const existing = vault.accounts.find((item) => item.email === account.email);
    if (existing) Object.assign(existing, account, { id: existing.id, createdAt: existing.createdAt });
    else vault.accounts.unshift(account);
    vault.settings.selectedAccountId = existing?.id || account.id;
    return true;
  }

  function upsertGithub(github) {
    if (!github) return false;
    attachBatch(github);
    const existing = vault.githubs.find((item) => item.username === github.username);
    if (existing) Object.assign(existing, github, { id: existing.id, createdAt: existing.createdAt });
    else vault.githubs.unshift(github);
    vault.settings.selectedGithubId = existing?.id || github.id;
    return true;
  }

  function upsertBilling(billing) {
    if (!billing) return false;
    attachBatch(billing);
    const existing = vault.billings.find((item) => item.cardNumber && item.cardNumber === billing.cardNumber);
    if (existing) Object.assign(existing, billing, { id: existing.id, createdAt: existing.createdAt });
    else vault.billings.unshift(billing);
    vault.settings.selectedBillingId = existing?.id || billing.id;
    return true;
  }

  function currentAccount() {
    return vault.accounts.find((item) => item.id === vault.settings.selectedAccountId) || vault.accounts[0] || null;
  }

  function currentGithub() {
    return vault.githubs.find((item) => item.id === vault.settings.selectedGithubId) || vault.githubs[0] || null;
  }

  function currentBilling() {
    return vault.billings.find((item) => item.id === vault.settings.selectedBillingId) || vault.billings[0] || null;
  }

  // ---- Clipboard helpers ---------------------------------------------------

  /**
   * Writes `text` to the clipboard then schedules a wipe after `ttlMs`. Before
   * wiping we re-read the clipboard so we never clobber something the user
   * copied since. Reading may require a gesture; if it fails we leave the
   * clipboard alone, which is the safe default.
   */
  async function copyTransient(text, { ttlMs = 30000 } = {}) {
    await navigator.clipboard.writeText(text);
    setTimeout(async () => {
      try {
        const now = await navigator.clipboard.readText();
        if (now === text) await navigator.clipboard.writeText("");
      } catch {
        // Silently ignore; see doc above.
      }
    }, ttlMs);
  }

  async function copyText(value, label) {
    const text = String(value || "");
    if (!text) {
      setMessage(`${label} 为空`, "bad");
      return;
    }
    await navigator.clipboard.writeText(text);
    setMessage(`已复制 ${label}`, "good");
  }

  /**
   * Sensitive-chip copy: same as copyText, but clears the clipboard after 30 s
   * and tells the user so via the banner. Used for password / 2FA / SMS /
   * recovery secrets.
   */
  async function copyTextTransient(value, label) {
    const text = String(value || "");
    if (!text) {
      setMessage(`${label} 为空`, "bad");
      return;
    }
    await copyTransient(text);
    setMessage(`已复制 ${label}（30s 后自动清剪贴板）`, "good");
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function downloadTextFile(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportGooglePasswordCsv() {
    const rows = [["name", "url", "username", "password", "note"]];
    for (const account of vault.accounts) {
      if (account.email && account.password) {
        rows.push([`Google - ${account.email}`, "https://accounts.google.com/", account.email, account.password, ""]);
      }
    }
    for (const github of vault.githubs) {
      if (github.username && github.password) {
        rows.push([`GitHub - ${github.username}`, "https://github.com/", github.username, github.password, ""]);
      }
    }

    if (rows.length === 1) {
      setMessage("没有可导出的 Gmail / GitHub 账号", "bad");
      return;
    }

    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadTextFile("google-passwords.csv", csv, "text/csv;charset=utf-8");
    setMessage(`已导出 CSV（${rows.length - 1} 条），可到 Google Password Manager 导入`, "good");
  }

  /**
   * A chip button. `sensitive` → copy-transient (30 s clipboard TTL).
   */
  function chip(label, value, options = {}) {
    const { action, sensitive = false } = typeof options === "function" ? { action: options } : options;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    if (sensitive) button.dataset.sensitive = "true";
    button.title = String(value || "");
    button.innerHTML = `<span class="chip-label"></span><span class="chip-value"></span>`;
    button.querySelector(".chip-label").textContent = `${label}`;
    button.querySelector(".chip-value").textContent = String(value || "");
    button.addEventListener("click", () => {
      const defaultCopy = () => (sensitive ? copyTextTransient(value, label) : copyText(value, label));
      (action || defaultCopy)().catch((error) => setMessage(error?.message || "复制失败", "bad"));
    });
    return button;
  }

  function selectControl(items, selectedId, labelFn, onChange) {
    if (!items || items.length <= 1) return null;
    const select = document.createElement("select");
    select.className = "record-select";
    select.title = "切换当前记录";
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = labelFn(item);
      if (item.id === selectedId) option.selected = true;
      select.append(option);
    }
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      onChange(select.value).catch((error) => setMessage(error?.message || "切换失败", "bad"));
    });
    return select;
  }

  function card(kind, title, badge, chips, control = null, onDelete = null) {
    const section = document.createElement("section");
    section.className = "card";
    section.dataset.kind = kind;
    section.dataset.open = cardState[kind] ? "true" : "false";

    const head = document.createElement("div");
    head.className = "card-head";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "card-toggle";
    toggle.textContent = "▸";
    toggle.setAttribute("aria-label", "展开 / 折叠");

    const titleSpan = document.createElement("span");
    titleSpan.className = "card-title-text";
    titleSpan.textContent = title;

    head.append(toggle, titleSpan);

    if (badge) {
      const badgeSpan = document.createElement("span");
      badgeSpan.className = "card-badge";
      badgeSpan.textContent = badge;
      head.append(badgeSpan);
    }

    if (control) head.append(control);

    if (onDelete) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "card-delete";
      del.textContent = "✕";
      del.title = "删除当前记录";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        onDelete().catch((error) => setMessage(error?.message || "删除失败", "bad"));
      });
      head.append(del);
    }

    head.addEventListener("click", () => {
      cardState[kind] = section.dataset.open !== "true";
      section.dataset.open = cardState[kind] ? "true" : "false";
      saveCardState();
    });

    const body = document.createElement("div");
    body.className = "card-body";

    const chipsWrap = document.createElement("div");
    chipsWrap.className = "chips";
    chips.filter(Boolean).forEach((node) => chipsWrap.append(node));
    body.append(chipsWrap);

    section.append(head, body);
    return section;
  }

  async function selectBillingForUse(billing) {
    vault.settings.selectedBillingId = billing.id;
    await saveVault();
    await render();
    setMessage("已切换当前账单", "good");
  }

  async function selectAccountForUse(account) {
    vault.settings.selectedAccountId = account.id;
    await saveVault();
    await render();
    setMessage("已切换当前 Gmail", "good");
  }

  async function selectGithubForUse(github) {
    vault.settings.selectedGithubId = github.id;
    await saveVault();
    await render();
    setMessage("已切换当前 GitHub", "good");
  }

  async function confirmDelete(text) {
    // confirm() is fine here; popups can show native dialogs.
    return confirm(text);
  }

  async function deleteAccount(account) {
    if (!await confirmDelete(`删除 Gmail "${account.email}"？此操作仅移除本扩展记录。`)) return;
    vault.accounts = vault.accounts.filter((item) => item.id !== account.id);
    if (vault.settings.selectedAccountId === account.id) vault.settings.selectedAccountId = vault.accounts[0]?.id || "";
    await saveVault();
    await render();
    setMessage("已删除 Gmail 记录", "good");
  }

  async function deleteGithub(github) {
    if (!await confirmDelete(`删除 GitHub "${github.username}"？`)) return;
    vault.githubs = vault.githubs.filter((item) => item.id !== github.id);
    if (vault.settings.selectedGithubId === github.id) vault.settings.selectedGithubId = vault.githubs[0]?.id || "";
    await saveVault();
    await render();
    setMessage("已删除 GitHub 记录", "good");
  }

  async function deleteBilling(billing) {
    if (!await confirmDelete(`删除账单 ${maskCard(billing.cardNumber) || billing.label || "当前记录"}？`)) return;
    vault.billings = vault.billings.filter((item) => item.id !== billing.id);
    if (vault.settings.selectedBillingId === billing.id) vault.settings.selectedBillingId = vault.billings[0]?.id || "";
    await saveVault();
    await render();
    setMessage("已删除账单记录", "good");
  }

  async function renderResults() {
    els.results.replaceChildren();
    els.autoFillOnHover.checked = vault.settings.autoFillOnHover !== false;
    els.overwriteExisting.checked = vault.settings.overwriteExisting === true;

    const accounts = vault.accounts;
    const githubs = vault.githubs;
    const billings = vault.billings;

    if (!accounts.length && !githubs.length && !billings.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "还没有识别结果，把卡密或账单文本粘贴到上面的框里。";
      els.results.append(empty);
      return;
    }

    const account = currentAccount();
    if (account) {
      const nodes = [
        chip("邮箱", account.email),
        chip("密码", account.password, { sensitive: true }),
        account.recoveryEmail ? chip("恢复", account.recoveryEmail) : null,
        account.year ? chip("年份", account.year) : null,
        account.country ? chip("国家", account.country) : null
      ];
      if (account.totpSecret) {
        const code = await totpCode(account.totpSecret);
        nodes.push(chip("2FA", code, {
          sensitive: true,
          action: async () => copyTextTransient(await totpCode(account.totpSecret), "Gmail 2FA")
        }));
        nodes.push(chip("密钥", account.totpSecret, { sensitive: true }));
      }
      const badge = `${accounts.length} 条`;
      els.results.append(card(
        "account",
        account.email || "Gmail",
        accounts.length > 1 ? badge : "",
        nodes,
        selectControl(accounts, account.id, (item) => item.email, async (id) => {
          const selected = accounts.find((item) => item.id === id);
          if (selected) await selectAccountForUse(selected);
        }),
        () => deleteAccount(account)
      ));
    }

    const github = currentGithub();
    if (github) {
      const nodes = [
        chip("账号", github.username),
        chip("密码", github.password, { sensitive: true })
      ];
      if (github.totpSecret) {
        const code = await totpCode(github.totpSecret);
        nodes.push(chip("2FA", code, {
          sensitive: true,
          action: async () => copyTextTransient(await totpCode(github.totpSecret), "GitHub 2FA")
        }));
        nodes.push(chip("密钥", github.totpSecret, { sensitive: true }));
      }
      els.results.append(card(
        "github",
        github.username ? `GitHub · ${github.username}` : "GitHub",
        githubs.length > 1 ? `${githubs.length} 条` : "",
        nodes,
        selectControl(githubs, github.id, (item) => item.username, async (id) => {
          const selected = githubs.find((item) => item.id === id);
          if (selected) await selectGithubForUse(selected);
        }),
        () => deleteGithub(github)
      ));
    }

    const billing = currentBilling();
    if (billing) {
      const nodes = [
        billing.cardNumber ? chip("卡号", billing.cardNumber, { sensitive: true }) : null,
        billing.expiry ? chip("有效期", billing.expiry) : null,
        billing.expiryMonth ? chip("月", billing.expiryMonth) : null,
        billing.expiryYear ? chip("年", billing.expiryYear) : null,
        billing.cvv ? chip("CVV", billing.cvv, { sensitive: true }) : null,
        billing.phone ? chip("电话", billing.phone) : null,
        billing.name ? chip("姓名", billing.name) : null,
        billing.addressLine1 ? chip("地址 1", billing.addressLine1) : null,
        billing.addressLine2 ? chip("地址 2", billing.addressLine2) : null,
        billing.address && !billing.addressLine1 ? chip("地址", billing.address) : null,
        billing.smsApi ? chip("接码 API", billing.smsApi) : null,
        billing.smsApi ? chip("取短信码", "点击获取", { action: () => getSmsCodeFor(billing) }) : null
      ];
      const label = billing.cardNumber ? `账单 · ${maskCard(billing.cardNumber)}` : "账单";
      els.results.append(card(
        "billing",
        label,
        billings.length > 1 ? `${billings.length} 条` : "",
        nodes,
        selectControl(billings, billing.id, (item) => item.cardNumber ? `卡 ${item.cardNumber.slice(-4)}` : item.name || item.label || item.id, async (id) => {
          const selected = billings.find((item) => item.id === id);
          if (selected) await selectBillingForUse(selected);
        }),
        () => deleteBilling(billing)
      ));
    }
  }

  async function render() {
    await renderResults();
  }

  async function importSmartText(text, source = "粘贴内容") {
    const raw = String(text || "").trim();
    if (!raw || raw === lastImportedText) return;

    const accounts = parseAccountLines(raw);
    const githubs = parseGithubLines(raw);
    const account = accounts[0] || parseAccountLine(raw);
    const github = githubs[0] || parseGithubLine(raw);
    const billings = parseBillingBlocks(raw);
    const billing = billings[0] || parseBillingText(raw);
    let count = 0;
    if (accounts.length) {
      accounts.forEach((item) => { if (upsertAccount(item)) count += 1; });
    } else if (upsertAccount(account)) {
      count += 1;
    }
    if (githubs.length) {
      githubs.forEach((item) => { if (upsertGithub(item)) count += 1; });
    } else if (upsertGithub(github)) {
      count += 1;
    }
    if (billings.length) {
      billings.forEach((item) => { if (upsertBilling(item)) count += 1; });
    } else if (upsertBilling(billing)) {
      count += 1;
    }

    if (!count) {
      setMessage("未识别到 Gmail / GitHub / 账单字段", "bad");
      return;
    }

    lastImportedText = raw;
    await saveVault();
    const folderSaved = await syncFolderQuietly(false);
    await render();
    const names = [
      (accounts.length || account) ? `Gmail${accounts.length > 1 ? ` x${accounts.length}` : ""}` : "",
      (githubs.length || github) ? `GitHub${githubs.length > 1 ? ` x${githubs.length}` : ""}` : "",
      (billings.length || billing) ? `账单${billings.length > 1 ? ` x${billings.length}` : ""}` : ""
    ].filter(Boolean).join("、");
    setMessage(
      folderSaved
        ? `${source} · 识别 ${names}，已写入本地文件夹`
        : `${source} · 识别 ${names}（仅保存在浏览器）`,
      folderSaved ? "good" : "warn"
    );
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToActiveTab(message) {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("没有当前标签页");
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function sendToAllFrames(message) {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("没有当前标签页");
    return chrome.runtime.sendMessage({ type: "fillAllFrames", tabId: tab.id, payload: message });
  }

  async function fill(kind) {
    const response = await sendToAllFrames({
      type: "fillFromPopup",
      kind,
      account: currentAccount(),
      github: currentGithub(),
      billing: currentBilling(),
      settings: vault.settings
    });
    if (!response?.ok) throw new Error(response?.error || "填充失败");
    renderFillOutcome(response.details);
  }

  async function fillAuto() {
    const tab = await activeTab();
    const url = new URL(tab.url || "https://example.com");
    const host = url.hostname;
    const href = url.href.toLowerCase();
    if (/(^|\.)github\.com$/i.test(host)) {
      await fill("github");
    } else if (/^accounts\.google\.com$/i.test(host)) {
      await fill("account");
    } else if ((host === "kiro.dev" || host.endsWith(".kiro.dev")) && currentBilling()) {
      await fill("billing");
    } else if (
      currentBilling() &&
      (/(^|\.)stripe\.com$/i.test(host) || /billing|checkout|invoice|payment|session|subscribe|portal|payment-method/.test(href))
    ) {
      await fill("billing");
    } else if (currentBilling() && !currentAccount()) {
      await fill("billing");
    } else {
      await fill("account");
    }
  }

  async function openKiroHome() {
    const tab = await activeTab();
    if (tab?.id) await chrome.tabs.update(tab.id, { url: "https://app.kiro.dev/home" });
    else await chrome.tabs.create({ url: "https://app.kiro.dev/home" });
  }

  function clearOriginsForTab(tab) {
    const url = new URL(tab.url || "https://example.com");
    const host = url.hostname.toLowerCase();
    const origins = new Set([url.origin]);
    if (host === "kiro.dev" || host.endsWith(".kiro.dev")) {
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
    if (host === "accounts.google.com") {
      origins.add("https://accounts.google.com");
      origins.add("https://myaccount.google.com");
      origins.add("https://www.google.com");
      origins.add("https://google.com");
      origins.add("https://ogs.google.com");
      origins.add("https://apis.google.com");
    }
    if (host.endsWith(".stripe.com") || host.endsWith(".stripe.network")) {
      origins.add("https://billing.stripe.com");
      origins.add("https://checkout.stripe.com");
      origins.add("https://js.stripe.com");
      origins.add("https://hooks.stripe.com");
      origins.add("https://m.stripe.network");
    }
    return [...origins].filter((origin) => /^https?:\/\//i.test(origin));
  }

  /**
   * Classifies origins into the current site (pre-checked by default) versus
   * third-party SSO / payment bystanders (unchecked by default). Users who
   * want to fully log out of Google along with Kiro need to opt in.
   */
  function classifyOrigins(origins, currentOrigin) {
    const primary = [];
    const thirdParty = [];
    for (const origin of origins) {
      if (origin === currentOrigin) primary.push(origin);
      else thirdParty.push(origin);
    }
    return { primary, thirdParty };
  }

  /**
   * Renders the confirm dialog and returns the selected origins, or null if
   * the user cancelled. The confirm button is disabled for 500 ms to defeat
   * accidental double-clicks.
   */
  function askCleanDialog(origins, currentOrigin) {
    return new Promise((resolve) => {
      const dialog = els.cleanDialog;
      const list = els.cleanDialogOrigins;
      if (!dialog?.showModal || !list) {
        // Fallback if HTML hasn't been updated: plain confirm.
        const ok = confirm(
          `深度清理本地 Cookie / 缓存 / storage：\n${origins.join("\n")}\n\n` +
          "注意：这只清除本机数据，不会让 Google 服务器端退出登录。页面会刷新。"
        );
        resolve(ok ? origins : null);
        return;
      }

      const { primary, thirdParty } = classifyOrigins(origins, currentOrigin);
      list.replaceChildren();

      function addRow(origin, checked) {
        const row = document.createElement("label");
        row.className = "clean-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = origin;
        box.checked = checked;
        const span = document.createElement("span");
        span.textContent = origin;
        row.append(box, span);
        list.append(row);
      }

      if (primary.length) {
        const header = document.createElement("div");
        header.className = "clean-group-title";
        header.textContent = "当前站点（默认清理）";
        list.append(header);
        primary.forEach((origin) => addRow(origin, true));
      }

      if (thirdParty.length) {
        const header = document.createElement("div");
        header.className = "clean-group-title";
        header.textContent = "第三方（默认不清理，勾选后一起清）";
        list.append(header);
        thirdParty.forEach((origin) => addRow(origin, false));
      }

      // 500ms button-disabled guard against accidental double-clicks.
      const confirmBtn = els.cleanDialogConfirm;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "确认清理（0.5s…）";
      const unlockAt = Date.now() + 500;
      const tick = () => {
        const remaining = unlockAt - Date.now();
        if (remaining > 0) {
          confirmBtn.textContent = `确认清理（${(remaining / 1000).toFixed(1)}s…）`;
          requestAnimationFrame(tick);
        } else {
          confirmBtn.disabled = false;
          confirmBtn.textContent = "确认清理";
        }
      };
      requestAnimationFrame(tick);

      function cleanup(chosen) {
        confirmBtn.removeEventListener("click", onConfirm);
        els.cleanDialogCancel.removeEventListener("click", onCancel);
        dialog.removeEventListener("close", onClose);
        dialog.close();
        resolve(chosen);
      }
      function onConfirm() {
        const selected = [...list.querySelectorAll("input[type=checkbox]")]
          .filter((box) => box.checked)
          .map((box) => box.value);
        if (!selected.length) { cleanup(null); return; }
        cleanup(selected);
      }
      function onCancel() { cleanup(null); }
      function onClose() { cleanup(null); }

      confirmBtn.addEventListener("click", onConfirm);
      els.cleanDialogCancel.addEventListener("click", onCancel);
      dialog.addEventListener("close", onClose);
      dialog.showModal();
    });
  }

  async function clearActiveSiteData() {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("没有当前标签页");
    const url = new URL(tab.url || "https://example.com");
    const origins = clearOriginsForTab(tab);
    const chosen = await askCleanDialog(origins, url.origin);
    if (!chosen || !chosen.length) return;
    const response = await chrome.runtime.sendMessage({ type: "clearSiteData", origins: chosen, tabId: tab.id, hard: true });
    if (!response?.ok) throw new Error(response?.error || "清理失败");
    setMessage(`已深度清理 ${chosen.length} 个 origin（仅本地）`, "good");
  }

  async function getSmsCodeFor(billing) {
    if (!billing?.smsApi) throw new Error("当前账单没有接码 API");
    let lastStatus = "";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await chrome.runtime.sendMessage({ type: "fetchSmsCode", url: billing.smsApi });
      if (!response?.ok) throw new Error(response?.error || "获取失败");
      const parsed = response.code ? response : parseSmsCode(response.raw || "");
      if (parsed.code) {
        await copyTransient(parsed.code);
        setMessage(`已复制短信码（30s 后自动清剪贴板）`, "good");
        return parsed.code;
      }
      lastStatus = String(response.status || "");
      if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error(`接码 API 没返回验证码${lastStatus ? `，状态 ${lastStatus}` : ""}`);
  }

  async function fetchAndFillSmsCode() {
    setMessage("正在获取短信码…", "");
    const code = await getSmsCodeFor(currentBilling());
    setMessage(`验证码 ${code}（已复制，30s 自动清）· 等待验证码输入框出现…`, "warn");
    const result = await pollFillSmsCode(code);
    if (result.details.filled?.length) {
      renderFillOutcome(result.details, { emptyText: `验证码 ${code} 已复制，但 12 秒内未找到输入框，请手动粘贴` });
    } else {
      renderBanner(
        [
          { prefix: "⚠", text: `验证码 ${code} 已复制，12 秒内未找到输入框，请手动粘贴` },
          { prefix: "·", text: "剪贴板 30 秒后自动清空" }
        ],
        "warn"
      );
    }
  }

  async function pollFillSmsCode(code, { attempts = 12, intervalMs = 1000 } = {}) {
    let details = { filled: [], skipped: [], alreadyMatching: 0, warnings: [] };
    for (let i = 0; i < attempts; i += 1) {
      const response = await sendToAllFrames({
        type: "fillFromPopup",
        kind: "smsCode",
        code,
        settings: { ...vault.settings, overwriteExisting: true }
      }).catch(() => null);
      if (response?.details) details = response.details;
      if ((details.filled?.length || 0) > 0) break;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { details };
  }

  els.quickImport.addEventListener("input", () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => {
      importSmartText(els.quickImport.value).catch((error) => setMessage(error?.message || "导入失败", "bad"));
    }, 450);
  });

  // Paste event: run parsing immediately without waiting for the debounce.
  els.quickImport.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    // Let the default paste happen, then parse synchronously.
    setTimeout(() => {
      importSmartText(els.quickImport.value, "粘贴").catch((error) => setMessage(error?.message || "导入失败", "bad"));
    }, 0);
  });

  els.pasteImport.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      els.quickImport.value = text;
      await importSmartText(text, "剪贴板");
    } catch (error) {
      setMessage(error?.message || "读取剪贴板失败", "bad");
    }
  });

  els.clearImport.addEventListener("click", () => {
    els.quickImport.value = "";
    lastImportedText = "";
    setMessage("");
  });

  els.fillAuto.addEventListener("click", () => fillAuto().catch((error) => setMessage(error?.message || "填充失败", "bad")));
  els.fillBilling.addEventListener("click", () => fill("billing").catch((error) => setMessage(error?.message || "填充失败", "bad")));
  els.fillSmsCode.addEventListener("click", () => fetchAndFillSmsCode().catch((error) => setMessage(error?.message || "验证码失败", "bad")));
  els.openKiroHome.addEventListener("click", () => openKiroHome().catch((error) => setMessage(error?.message || "打开失败", "bad")));
  els.saveFolder.addEventListener("click", () => syncFolderQuietly(true));
  els.exportGoogleCsv.addEventListener("click", () => exportGooglePasswordCsv());
  els.clearSiteData.addEventListener("click", () => clearActiveSiteData().catch((error) => setMessage(error?.message || "清理失败", "bad")));

  els.capturePage.addEventListener("click", async () => {
    try {
      const response = await sendToActiveTab({ type: "extractPageData" });
      if (!response?.ok) throw new Error(response?.error || "识别失败");
      const { account, github, billing } = response.data || {};
      let count = 0;
      if (upsertAccount(account)) count += 1;
      if (upsertGithub(github)) count += 1;
      if (upsertBilling(billing)) count += 1;
      if (!count) {
        setMessage("当前页没有识别到资料", "bad");
        return;
      }
      await saveVault();
      await syncFolderQuietly(false);
      await render();
      setMessage(`已识别并保存 ${count} 条资料`, "good");
    } catch (error) {
      setMessage(error?.message || "识别失败", "bad");
    }
  });

  els.autoFillOnHover.addEventListener("change", async () => {
    vault.settings.autoFillOnHover = els.autoFillOnHover.checked;
    await saveVault();
    setMessage(els.autoFillOnHover.checked ? "已开启右侧悬浮按钮" : "已关闭右侧悬浮按钮", "good");
  });

  els.overwriteExisting.addEventListener("change", async () => {
    vault.settings.overwriteExisting = els.overwriteExisting.checked;
    await saveVault();
    setMessage(
      els.overwriteExisting.checked
        ? "已开启：下次填充会覆盖页面已有字段"
        : "已关闭：仅在字段为空或残留掩码时填充",
      "good"
    );
  });

  loadVault()
    .then(render)
    .catch((error) => setMessage(error?.message || "初始化失败", "bad"));
})();
