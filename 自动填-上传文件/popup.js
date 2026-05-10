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

  let vault = normalizeVault(DEFAULT_VAULT);
  let importTimer = null;
  let lastImportedText = "";

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
    message: document.querySelector("#message")
  };

  function setMessage(text, kind = "") {
    els.message.textContent = text || "";
    els.message.dataset.kind = kind;
  }

  async function loadVault() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.plainVault]);
    vault = normalizeVault(data[STORAGE_KEYS.plainVault] || DEFAULT_VAULT);
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]).catch(() => {});
  }

  async function saveVault() {
    vault = normalizeVault(vault);
    await chrome.storage.local.set({ [STORAGE_KEYS.plainVault]: vault });
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]).catch(() => {});
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

  async function copyText(value, label) {
    const text = String(value || "");
    if (!text) {
      setMessage(`${label} 为空`, "bad");
      return;
    }
    await navigator.clipboard.writeText(text);
    setMessage(`已复制：${label}`, "good");
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
        rows.push(["Google", "https://accounts.google.com/", account.email, account.password, ""]);
      }
    }
    for (const github of vault.githubs) {
      if (github.username && github.password) {
        rows.push(["GitHub", "https://github.com/", github.username, github.password, ""]);
      }
    }

    if (rows.length === 1) {
      setMessage("没有可导出的 Gmail/GitHub 账号", "bad");
      return;
    }

    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadTextFile("google-passwords.csv", csv, "text/csv;charset=utf-8");
    setMessage("已导出 CSV，可到 Google Password Manager 导入", "good");
  }

  function chip(label, value, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.title = String(value || "");
    button.innerHTML = `<span class="chip-label"></span><span class="chip-value"></span>`;
    button.querySelector(".chip-label").textContent = `${label}:`;
    button.querySelector(".chip-value").textContent = String(value || "");
    button.addEventListener("click", () => {
      (action || (() => copyText(value, label)))().catch((error) => setMessage(error?.message || "复制失败", "bad"));
    });
    return button;
  }

  function selectControl(items, selectedId, labelFn, onChange) {
    if (!items.length) return null;
    const select = document.createElement("select");
    select.className = "record-select";
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = labelFn(item);
      if (item.id === selectedId) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      onChange(select.value).catch((error) => setMessage(error?.message || "切换失败", "bad"));
    });
    return select;
  }

  function card(title, chips, control = null) {
    const section = document.createElement("section");
    section.className = "card";
    const header = document.createElement("div");
    header.className = "card-title";
    const heading = document.createElement("span");
    heading.textContent = title;
    header.append(heading);
    if (control) header.append(control);
    const body = document.createElement("div");
    body.className = "chips";
    chips.filter(Boolean).forEach((node) => body.append(node));
    section.append(header, body);
    return section;
  }

  async function selectBillingForUse(billing) {
    vault.settings.selectedBillingId = billing.id;
    await saveVault();
    await render();
    setMessage("已设为当前账单", "good");
  }

  async function selectAccountForUse(account) {
    vault.settings.selectedAccountId = account.id;
    await saveVault();
    await render();
    setMessage("已设为当前 Gmail", "good");
  }

  async function selectGithubForUse(github) {
    vault.settings.selectedGithubId = github.id;
    await saveVault();
    await render();
    setMessage("已设为当前 GitHub", "good");
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
      empty.textContent = "还没有识别结果。把卡密或账单文本粘贴到上面的框里。";
      els.results.append(empty);
      return;
    }

    const account = currentAccount();
    if (account) {
      const nodes = [
        chip("账号", account.email),
        chip("密码", account.password),
        account.recoveryEmail ? chip("恢复邮箱", account.recoveryEmail) : null,
        account.year ? chip("年份", account.year) : null,
        account.country ? chip("国家", account.country) : null
      ];
      if (account.totpSecret) {
        const code = await totpCode(account.totpSecret);
        nodes.push(chip("2FA验证码", code, async () => copyText(await totpCode(account.totpSecret), "Gmail 2FA验证码")));
        nodes.push(chip("2FA密钥", account.totpSecret));
      }
      els.results.append(card(
        `当前 Gmail`,
        nodes,
        selectControl(accounts, account.id, (item) => item.email, async (id) => {
          const selected = accounts.find((item) => item.id === id);
          if (selected) await selectAccountForUse(selected);
        })
      ));
    }

    const github = currentGithub();
    if (github) {
      const nodes = [
        chip("账号", github.username),
        chip("密码", github.password)
      ];
      if (github.totpSecret) {
        const code = await totpCode(github.totpSecret);
        nodes.push(chip("2FA验证码", code, async () => copyText(await totpCode(github.totpSecret), "GitHub 2FA验证码")));
        nodes.push(chip("2FA密钥", github.totpSecret));
      }
      els.results.append(card(
        `当前 GitHub`,
        nodes,
        selectControl(githubs, github.id, (item) => item.username, async (id) => {
          const selected = githubs.find((item) => item.id === id);
          if (selected) await selectGithubForUse(selected);
        })
      ));
    }

    const billing = currentBilling();
    if (billing) {
      const nodes = [
        billing.cardNumber ? chip("卡号", billing.cardNumber) : null,
        billing.expiry ? chip("有效期", billing.expiry) : null,
        billing.expiryMonth ? chip("月", billing.expiryMonth) : null,
        billing.expiryYear ? chip("年", billing.expiryYear) : null,
        billing.cvv ? chip("CVV", billing.cvv) : null,
        billing.phone ? chip("电话", billing.phone) : null,
        billing.name ? chip("姓名", billing.name) : null,
        billing.addressLine1 ? chip("地址1", billing.addressLine1) : null,
        billing.addressLine2 ? chip("地址2", billing.addressLine2) : null,
        billing.address ? chip("地址", billing.address) : null,
        billing.smsApi ? chip("接码API", billing.smsApi) : null,
        billing.smsApi ? chip("取短信码", "点击获取", () => getSmsCodeFor(billing)) : null
      ];
      els.results.append(card(
        `当前账单${billing.cardNumber ? ` ${billing.cardNumber.slice(-4)}` : ""}`,
        nodes,
        selectControl(billings, billing.id, (item) => item.cardNumber ? `卡 ${item.cardNumber.slice(-4)}` : item.name || item.label || item.id, async (id) => {
          const selected = billings.find((item) => item.id === id);
          if (selected) await selectBillingForUse(selected);
        })
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
      accounts.forEach((item) => {
        if (upsertAccount(item)) count += 1;
      });
    } else if (upsertAccount(account)) {
      count += 1;
    }
    if (githubs.length) {
      githubs.forEach((item) => {
        if (upsertGithub(item)) count += 1;
      });
    } else if (upsertGithub(github)) {
      count += 1;
    }
    if (billings.length) {
      billings.forEach((item) => {
        if (upsertBilling(item)) count += 1;
      });
    } else if (upsertBilling(billing)) {
      count += 1;
    }

    if (!count) {
      setMessage("未识别到 Gmail、GitHub 或账单字段", "bad");
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
        ? `${source}已识别清洗：${names}；已写入文件夹`
        : `${source}已识别清洗：${names}；已保存到浏览器，本地文件夹未写入`,
      folderSaved ? "good" : ""
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
    setMessage(response.filled ? `已填充 ${response.filled} 个字段` : "没有找到可填字段", response.filled ? "good" : "");
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

  async function clearActiveSiteData() {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("没有当前标签页");
    const origins = clearOriginsForTab(tab);
    const confirmed = confirm(`深度清理以下站点的 Cookie、缓存和站点存储：\n${origins.join("\n")}\n\n页面会刷新。`);
    if (!confirmed) return;
    const response = await chrome.runtime.sendMessage({ type: "clearSiteData", origins, tabId: tab.id, hard: true });
    if (!response?.ok) throw new Error(response?.error || "清理失败");
    setMessage("已深度清理当前站点记录", "good");
  }

  async function getSmsCode() {
    const billing = currentBilling();
    return getSmsCodeFor(billing);
  }

  async function getSmsCodeFor(billing) {
    if (!billing?.smsApi) throw new Error("当前账单没有接码 API");
    let lastStatus = "";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await chrome.runtime.sendMessage({ type: "fetchSmsCode", url: billing.smsApi });
      if (!response?.ok) throw new Error(response?.error || "获取失败");
      const parsed = response.code ? response : parseSmsCode(response.raw || "");
      if (parsed.code) {
        await copyText(parsed.code, "短信码");
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
    setMessage(`验证码 ${code}（已复制）等待验证码输入框出现…`, "");
    const totalFilled = await pollFillSmsCode(code);
    if (totalFilled > 0) {
      setMessage(`验证码 ${code} 已填入 ${totalFilled} 个字段`, "good");
    } else {
      setMessage(`验证码 ${code} 已复制，但 12 秒内没有找到验证码输入框，请手动粘贴`, "bad");
    }
  }

  async function pollFillSmsCode(code, { attempts = 12, intervalMs = 1000 } = {}) {
    let total = 0;
    for (let i = 0; i < attempts; i += 1) {
      const response = await sendToAllFrames({
        type: "fillFromPopup",
        kind: "smsCode",
        code,
        settings: { ...vault.settings, overwriteExisting: true }
      }).catch(() => null);
      const filled = Number(response?.filled) || 0;
      if (filled > 0) {
        total = filled;
        break;
      }
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return total;
  }

  els.quickImport.addEventListener("input", () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(() => {
      importSmartText(els.quickImport.value).catch((error) => setMessage(error?.message || "导入失败", "bad"));
    }, 450);
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
    await render();
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
