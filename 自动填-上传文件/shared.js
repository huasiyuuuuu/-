(() => {
  const DEFAULT_VAULT = {
    version: 1,
    accounts: [],
    billings: [],
    githubs: [],
    batches: [],
    settings: {
      selectedAccountId: "",
      selectedBillingId: "",
      selectedGithubId: "",
      activeBatchId: "",
      autoFillOnHover: true,
      overwriteExisting: false,
      fillTotp: true
    }
  };

  const STORAGE_KEYS = {
    vaultBlob: "gba_vault_blob",
    plainVault: "gba_plain_vault",
    sessionVault: "gba_session_vault",
    sessionKey: "gba_session_key"
  };

  const TEXT_ENCODER = new TextEncoder();
  const TEXT_DECODER = new TextDecoder();
  const PBKDF_ITERATIONS = 250000;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    const rand = crypto.getRandomValues(new Uint8Array(12));
    const suffix = Array.from(rand, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${prefix}_${suffix}`;
  }

  function normalizeVault(vault) {
    const next = { ...clone(DEFAULT_VAULT), ...(vault || {}) };
    next.accounts = Array.isArray(next.accounts) ? next.accounts : [];
    next.billings = Array.isArray(next.billings) ? next.billings : [];
    next.githubs = Array.isArray(next.githubs) ? next.githubs : [];
    next.batches = Array.isArray(next.batches) ? next.batches : [];
    next.settings = { ...DEFAULT_VAULT.settings, ...(next.settings || {}) };
    if (!next.batches.length) {
      const batch = makeBatch("默认批次");
      next.batches.push(batch);
      next.settings.activeBatchId = next.settings.activeBatchId || batch.id;
    }
    if (!next.settings.activeBatchId) next.settings.activeBatchId = next.batches[0]?.id || "";
    return next;
  }

  function makeBatch(label = "") {
    const cleanLabel = cleanBatchLabel(label || "默认批次");
    return {
      id: uid("batch"),
      label: cleanLabel,
      createdAt: new Date().toISOString()
    };
  }

  function cleanBatchLabel(label) {
    return String(label || "默认批次").trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "默认批次";
  }

  function activeBatchId(vault, label = "") {
    const normalized = normalizeVault(vault);
    if (label) {
      const cleanLabel = cleanBatchLabel(label);
      let batch = normalized.batches.find((item) => item.label === cleanLabel);
      if (!batch) {
        batch = makeBatch(cleanLabel);
        normalized.batches.push(batch);
      }
      normalized.settings.activeBatchId = batch.id;
      return batch.id;
    }
    return normalized.settings.activeBatchId || normalized.batches[0]?.id || "";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function deriveAesKey(passphrase, saltBytes) {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      TEXT_ENCODER.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: PBKDF_ITERATIONS,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function keyToBase64(key) {
    const raw = await crypto.subtle.exportKey("raw", key);
    return bytesToBase64(new Uint8Array(raw));
  }

  async function keyFromBase64(keyB64) {
    return crypto.subtle.importKey(
      "raw",
      base64ToBytes(keyB64),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptVault(vault, key, saltB64 = "") {
    const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const normalized = normalizeVault(vault);
    const plaintext = TEXT_ENCODER.encode(JSON.stringify(normalized));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      version: 1,
      kdf: "PBKDF2-SHA-256",
      iterations: PBKDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString()
    };
  }

  async function decryptVault(blob, passphrase) {
    const salt = base64ToBytes(blob.salt);
    const key = await deriveAesKey(passphrase, salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(blob.iv) },
      key,
      base64ToBytes(blob.ciphertext)
    );
    return {
      vault: normalizeVault(JSON.parse(TEXT_DECODER.decode(plaintext))),
      keyB64: await keyToBase64(key)
    };
  }

  async function encryptVaultWithKeyB64(vault, keyB64, saltB64) {
    const key = await keyFromBase64(keyB64);
    return encryptVault(vault, key, saltB64);
  }

  async function createEncryptedVault(passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveAesKey(passphrase, salt);
    const vault = clone(DEFAULT_VAULT);
    const blob = await encryptVault(vault, key, bytesToBase64(salt));
    return {
      blob,
      vault,
      keyB64: await keyToBase64(key)
    };
  }

  function maskValue(value, keepStart = 3, keepEnd = 3) {
    if (!value) return "";
    const text = String(value);
    if (text.length <= keepStart + keepEnd) return "*".repeat(text.length);
    return `${text.slice(0, keepStart)}${"*".repeat(Math.min(12, text.length - keepStart - keepEnd))}${text.slice(-keepEnd)}`;
  }

  function normalizeBase32(secret) {
    let text = String(secret || "").trim();
    if (/^otpauth:\/\//i.test(text)) {
      try {
        text = new URL(text).searchParams.get("secret") || text;
      } catch {
        // Keep original text and normalize below.
      }
    }
    return text
      .replace(/[\s=-]/g, "")
      .toUpperCase()
      .replace(/0/g, "O")
      .replace(/1/g, "I")
      .replace(/[^A-Z2-7]/g, "");
  }

  function base32ToBytes(secret) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const normalized = normalizeBase32(secret);
    let bits = "";
    for (const char of normalized) {
      const value = alphabet.indexOf(char);
      if (value < 0) {
        throw new Error(`Invalid base32 character: ${char}`);
      }
      bits += value.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return new Uint8Array(bytes);
  }

  function counterToBytes(counter) {
    const bytes = new Uint8Array(8);
    let value = BigInt(counter);
    for (let i = 7; i >= 0; i -= 1) {
      bytes[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    return bytes;
  }

  async function totpCode(secret, timestamp = Date.now(), digits = 6, period = 30) {
    const key = await crypto.subtle.importKey(
      "raw",
      base32ToBytes(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const counter = Math.floor(timestamp / 1000 / period);
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterToBytes(counter)));
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(binary % 10 ** digits).padStart(digits, "0");
  }

  function parseAccountLine(input) {
    const line = String(input || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => /@gmail\.com/i.test(item) && item.includes("|"));
    if (!line) return null;
    const parts = line.split("|").map((item) => item.trim());
    const emailIndex = parts.findIndex((item) => /@gmail\.com$/i.test(item));
    if (emailIndex < 0 || !parts[emailIndex + 1]) return null;
    const email = parts[emailIndex];
    const password = parts[emailIndex + 1];
    const recoveryEmail = parts.find((item, index) => index !== emailIndex && /@/.test(item) && item !== email) || "";
    const possibleSecret = parts.find((item) => looksLikeBase32Secret(item) && !/@/.test(item)) || "";
    const year = parts.find((item) => /^(19|20)\d{2}$/.test(item)) || "";
    const country = [...parts].reverse().find((item) => /^[a-z][a-z\s.-]{2,}$/i.test(item) && !/@/.test(item) && item !== possibleSecret) || "";
    return {
      id: uid("acct"),
      type: "gmail",
      label: email,
      email,
      username: email,
      password,
      recoveryEmail,
      totpSecret: possibleSecret,
      year,
      country,
      createdAt: new Date().toISOString()
    };
  }

  function parseAccountLines(input) {
    const lines = String(input || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const seen = new Set();
    return lines
      .map((line) => parseAccountLine(line))
      .filter((account) => {
        if (!account || seen.has(account.email)) return false;
        seen.add(account.email);
        return true;
      });
  }

  function looksLikeBase32Secret(value) {
    return normalizeBase32(value).length >= 16;
  }

  function parseGithubLine(input) {
    const text = normalizeTextForParsing(input).trim();
    const lines = text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    const candidate = lines.find((line) => line.includes("----") || /github/i.test(line)) || text;
    let parts = [];
    if (candidate.includes("----")) {
      parts = candidate.split("----").map((item) => cleanCapturedValue(item));
    } else if (candidate.includes("|")) {
      parts = candidate.split("|").map((item) => cleanCapturedValue(item)).filter((item) => !/^github$/i.test(item));
    }

    let username = "";
    let password = "";
    let totpSecret = "";

    if (parts.length >= 3 && looksLikeBase32Secret(parts[2])) {
      [username, password, totpSecret] = parts;
    } else {
      username = extractLabeledValue(text, ["GitHub账号", "Github账号", "GitHub 用户名", "Github 用户名", "username", "login"], "([^\\n|]+)");
      password = extractLabeledValue(text, ["GitHub密码", "Github密码", "password", "pass"], "([^\\n|]+)");
      totpSecret = extractLabeledValue(text, ["GitHub 2FA", "Github 2FA", "2FA", "TOTP", "OTP", "动态密钥", "验证密钥"], "([A-Z2-7\\s=-]{16,})");
    }

    username = cleanCapturedValue(username);
    password = cleanCapturedValue(password);
    totpSecret = normalizeBase32(totpSecret);
    if (!username || !password) return null;

    return {
      id: uid("gh"),
      type: "github",
      label: `GitHub ${username}`,
      username,
      password,
      totpSecret,
      createdAt: new Date().toISOString()
    };
  }

  function parseGithubLines(input) {
    const lines = normalizeTextForParsing(input).split(/\n+/).map((item) => item.trim()).filter(Boolean);
    const seen = new Set();
    return lines
      .map((line) => parseGithubLine(line))
      .filter((github) => {
        if (!github || seen.has(github.username)) return false;
        seen.add(github.username);
        return true;
      });
  }

  function parseExpiry(expiry) {
    const text = String(expiry || "").trim();
    const match = text.match(/(\d{1,4})\s*[/-]\s*(\d{1,4})/);
    if (!match) return { raw: text, month: "", year: "" };
    let first = match[1];
    let second = match[2];
    if (first.length === 4) {
      return { raw: text, month: second.padStart(2, "0"), year: first };
    }
    const year = second.length === 2 ? `20${second}` : second;
    return { raw: text, month: first.padStart(2, "0"), year };
  }

  function cleanCapturedValue(value) {
    const labelTail = "(卡号|信用卡号|银行卡号|CARD NUMBER|CARD NO|有效期|EXPIRY|EXPIRATION|CVV|CVC|安全码|电话|PHONE|手机号|姓名|NAME|持卡人|地址|ADDRESS|账单地址|接码\\s*API|SMS\\s*API|API)";
    return String(value || "")
      .replace(/[：:]\s*$/g, "")
      .replace(/\s*(点击复制|复制|一键复制|点此复制|click to copy|copy)\s*$/i, "")
      .replace(new RegExp(`\\s+${labelTail}.*$`, "i"), "")
      .trim();
  }

  function normalizeTextForParsing(input) {
    return String(input || "")
      .replace(/\u00a0/g, " ")
      .replace(/[｜]/g, "|")
      .replace(/[：]/g, ":")
      .replace(/[，]/g, ",")
      .replace(/[／]/g, "/")
      .replace(/[－–—]/g, "-")
      .replace(/\r/g, "");
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractLabeledValue(text, labels, valuePattern = "([^\\n|]+)") {
    const labelPattern = labels.map(escapeRegExp).join("|");
    const inline = new RegExp(`(?:^|[\\n|,;])\\s*(?:${labelPattern})(?:\\s*[A-Z _-]{0,24})?\\s*[:：=\\-]?\\s*${valuePattern}`, "i");
    const inlineMatch = text.match(inline);
    if (inlineMatch?.[1]) return cleanCapturedValue(inlineMatch[1]);

    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (new RegExp(`^(?:${labelPattern})(?:\\s+[A-Z _-]{0,24})?\\s*[:：=\\-]?\\s*$`, "i").test(line)) {
        return cleanCapturedValue(lines[i + 1] || "");
      }
      const embedded = line.match(new RegExp(`(?:${labelPattern})(?:\\s+[A-Z _-]{0,24})?\\s*[:：=\\-]\\s*(.+)$`, "i"));
      if (embedded?.[1]) return cleanCapturedValue(embedded[1]);
    }
    return "";
  }

  function normalizeCardName(value) {
    return cleanCapturedValue(value)
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function firstMatch(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return "";
  }

  function parseBillingText(input) {
    const text = normalizeTextForParsing(input);
    const cardNumber = (extractLabeledValue(text, ["卡号", "信用卡号", "银行卡号", "CARD NUMBER", "CARD NO", "CARD"], "([0-9][0-9\\s-]{11,24})") || firstMatch(text, [
      /(?:卡号\s*CARD NUMBER|CARD NUMBER|卡号)\s*\n\s*([0-9][0-9\s-]{11,24})/i,
      /\b((?:\d[ -]?){13,19})\b/
    ])).replace(/[\s-]/g, "");
    const expiryRaw = cleanCapturedValue(extractLabeledValue(text, ["有效期", "过期时间", "到期时间", "EXPIRY", "EXPIRATION", "EXP DATE", "VALID THRU"], "([0-9]{1,4}\\s*[/-]\\s*[0-9]{1,4})") || firstMatch(text, [
      /(?:有效期\s*EXPIRY|EXPIRY|有效期)\s*\n\s*([0-9]{1,4}\s*[/-]\s*[0-9]{1,4})/i,
      /\b((?:20)?\d{2}\s*[/-]\s*\d{1,2}|\d{1,2}\s*[/-]\s*(?:20)?\d{2})\b/
    ]));
    const expiry = parseExpiry(expiryRaw);
    const cvv = extractLabeledValue(text, ["CVV", "CVC", "安全码", "验证码", "卡验证码"], "(\\d{3,4})") || firstMatch(text, [
      /\bCVV\b\s*\n\s*(\d{3,4})/i,
      /\bCVC\b\s*\n\s*(\d{3,4})/i
    ]);
    const phone = cleanCapturedValue(extractLabeledValue(text, ["电话", "手机号", "手机", "联系电话", "PHONE", "MOBILE", "TEL"], "(\\+?\\d[\\d\\s().-]{7,})") || firstMatch(text, [
      /(?:电话\s*PHONE|PHONE|电话)\s*\n\s*(\+?\d[\d\s().-]{7,})/i
    ])).replace(/\s+/g, "");
    const name = normalizeCardName(extractLabeledValue(text, ["姓名", "持卡人", "持卡人姓名", "账单姓名", "NAME", "CARDHOLDER", "CARD HOLDER"], "([^\\n|]+)") || firstMatch(text, [
      /(?:姓名\s*NAME|NAME|姓名)\s*\n\s*([A-Z][A-Z\s.'-]{2,})/i
    ]));
    const addressLine1 = cleanCapturedValue(extractLabeledValue(text, ["地址1", "地址 1", "地址行1", "地址行 1", "ADDRESS LINE 1", "ADDRESS1", "STREET 1"], "([^\\n|]+)"));
    const addressLine2 = cleanCapturedValue(extractLabeledValue(text, ["地址2", "地址 2", "地址行2", "地址行 2", "ADDRESS LINE 2", "ADDRESS2", "APT", "APARTMENT", "SUITE"], "([^\\n|]+)"));
    const address = cleanCapturedValue(addressLine1 || extractLabeledValue(text, ["地址", "账单地址", "收货地址", "ADDRESS", "BILLING ADDRESS", "STREET"], "([^\\n]+)") || firstMatch(text, [
      /(?:地址\s*ADDRESS|ADDRESS|地址)\s*\n\s*(.+)/i
    ]));
    const smsApi = cleanCapturedValue(extractLabeledValue(text, ["接码 API", "接码API", "取码 API", "取码API", "短信 API", "短信API", "SMS API", "API"], "(https?:\\/\\/[^\\s\"'<>]+)") || firstMatch(text, [
      /(https?:\/\/[^\s"'<>]+\/api\/get_sms\?[^\s"'<>]+)/i,
      /(https?:\/\/[^\s"'<>]*get_sms[^\s"'<>]*)/i
    ]));

    if (!cardNumber && !expiry.raw && !cvv && !phone && !name && !address && !smsApi) {
      return null;
    }

    const last4 = cardNumber ? cardNumber.slice(-4) : "billing";
    return {
      id: uid("bill"),
      label: cardNumber ? `Card ${last4}` : `Billing ${new Date().toLocaleString()}`,
      cardNumber,
      expiry: expiry.raw,
      expiryMonth: expiry.month,
      expiryYear: expiry.year,
      cvv,
      phone,
      name,
      address,
      addressLine1,
      addressLine2,
      smsApi,
      createdAt: new Date().toISOString()
    };
  }

  function parseBillingBlocks(input) {
    const text = normalizeTextForParsing(input);
    const lines = text.split("\n");
    const blocks = [];
    let current = [];

    const pushCurrent = () => {
      const body = current.join("\n").trim();
      if (body) {
        const parsed = parseBillingText(body);
        if (parsed) blocks.push(parsed);
      }
      current = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const startsNewCard = /(?:^|\s)(?:卡号|信用卡号|银行卡号|card\s*number|card\s*no)\s*[:：]/i.test(trimmed);
      if (startsNewCard && current.some((item) => /(?:^|\s)(?:卡号|card\s*number|card\s*no)\s*[:：]/i.test(item))) {
        pushCurrent();
      }
      current.push(line);
      if (!trimmed && current.length > 1) pushCurrent();
    }
    pushCurrent();

    const seen = new Set();
    return blocks.filter((billing) => {
      const key = billing.cardNumber || `${billing.name}|${billing.address}|${billing.smsApi}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseSmsCode(input) {
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    const normalizedRaw = raw.replace(/\u00a0/g, " ");
    let candidates = [];
    const positiveKey = /(code|sms|otp|pin|verify|verification|passcode|captcha|message|msg|text|content|body|验证码|校验码|短信码|短信|取码|动态码)/i;
    const negativeKey = /(phone|mobile|tel|card|cc|exp|date|time|timestamp|created|updated|order|uuid|guid|id|status|key|token|amount|price|balance|zip|postal|address|url|link)/i;
    const addCandidate = (code, priority, source = "") => {
      const normalized = String(code || "").replace(/\D/g, "");
      if (normalized.length < 4 || normalized.length > 8) return;
      if (/^(0000|1111|1234|123456|9999)$/.test(normalized) && priority < 2) return;
      candidates.push({ code: normalized, priority, source });
    };
    const scanText = (valueText, basePriority, source = "") => {
      const text = String(valueText || "").replace(/\u00a0/g, " ");
      const contextualPatterns = [
        /(?:验证码|校验码|短信码|动态码|取码|code|otp|pin|verification code|verify code|passcode)[^\d]{0,40}(\d(?:[\s-]?\d){3,7})/i,
        /(?:is|为|是|:|：)\s*(\d(?:[\s-]?\d){3,7})(?:\D|$)/i,
        /\b(\d{4,8})\b(?=\s*(?:is your|为您的|是您的|验证码|校验码|code|otp|pin))/i
      ];
      contextualPatterns.forEach((pattern) => {
        const match = text.match(pattern);
        if (match?.[1]) addCandidate(match[1], basePriority + 3, source);
      });
      const generic = text.match(/\b(?:\d[\s-]?){4,8}\b/g) || [];
      generic.forEach((code) => addCandidate(code, basePriority, source));
    };

    try {
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      const walk = (value, keyPath = "") => {
        if (value == null) return;
        if (typeof value === "object") {
          Object.entries(value).forEach(([key, child]) => walk(child, `${keyPath}.${key}`));
          return;
        }
        const valueText = String(value);
        if (negativeKey.test(keyPath) && !positiveKey.test(keyPath)) return;
        const basePriority = positiveKey.test(keyPath) ? 5 : 1;
        scanText(valueText, basePriority, keyPath);
      };
      walk(parsed);
    } catch {
      // Fall through to plain text parsing.
    }

    scanText(normalizedRaw, positiveKey.test(normalizedRaw) ? 3 : 0, "raw");
    candidates = candidates.filter((item, index, arr) =>
      arr.findIndex((other) => other.code === item.code && other.priority === item.priority) === index
    );
    if (!candidates.length) return { code: "", raw };
    candidates.sort((a, b) => b.priority - a.priority || b.code.length - a.code.length);
    return { code: candidates[0].code, raw };
  }

  function visibleElement(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function elementText(element) {
    const parts = [
      element.getAttribute("autocomplete"),
      element.getAttribute("aria-label"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("placeholder"),
      element.getAttribute("type"),
      element.getAttribute("maxlength")
    ];
    const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    if (label) parts.push(label.innerText);
    const parentText = element.closest("label")?.innerText || element.closest("[class]")?.innerText || "";
    if (parentText.length < 180) parts.push(parentText);
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function inferFieldType(element) {
    const text = elementText(element);
    const type = (element.getAttribute("type") || "").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    const exactAutocomplete = {
      email: "email",
      username: "username",
      "current-password": "password",
      "new-password": "password",
      "one-time-code": "otp",
      "cc-number": "cardNumber",
      "cc-exp": "expiry",
      "cc-exp-month": "expiryMonth",
      "cc-exp-year": "expiryYear",
      "cc-csc": "cvv",
      "cc-name": "name",
      tel: "phone",
      "street-address": "address",
      "address-line1": "addressLine1",
      "address-line2": "addressLine2",
      "postal-code": "postal",
      "address-level2": "city",
      "address-level1": "state",
      country: "country",
      "country-name": "country"
    };
    if (exactAutocomplete[autocomplete]) return exactAutocomplete[autocomplete];
    if (/email|e-mail|邮箱/.test(text) || type === "email") return "email";
    if (/identifier|username|user name|login|账号|用户名/.test(text)) return "username";
    if (/passwd|password|密码/.test(text) || type === "password") return "password";
    if (/cc-number|field-numberinput|numberinput|cardnumber|card number|card-number|card no|1234\s+1234|卡号|银行卡/.test(text)) return "cardNumber";
    if (/cc-exp-month|expir.*month|月份|有效期月/.test(text)) return "expiryMonth";
    if (/cc-exp-year|expir.*year|年份|有效期年/.test(text)) return "expiryYear";
    if (/cc-exp|expiry|expiration|exp date|valid thru|有效期/.test(text)) return "expiry";
    if (/cc-csc|cvc|cvv|security code|安全码/.test(text)) return "cvv";
    if (/totp|otp|one[-\s]?time|one[-\s]?time code|authenticator|verification|verify code|login code|enter code|passcode|sms\s*code|text\s*code|auth\s*code|验证码|校验码|动态码|短信码|一次性密码|两步验证|安全码验证/.test(text)) return "otp";
    // Standalone "code" heuristic + numeric-short inputmode fallback. Excludes zip/postal/promo/coupon/country/area/etc.
    // Helps on 3DS / bank challenge pages where the field is just labelled "Code".
    if (
      /\bcode\b/.test(text)
      && !/(zip|postal|post\s*code|promo|coupon|discount|referral|country|area|dial|product|voucher|gift|store|tracking|ref(?:erence)?\s*code|invite|invitation)/.test(text)
    ) return "otp";
    const maxLenAttr = Number(element.getAttribute("maxlength") || 0);
    const inputmodeAttr = (element.getAttribute("inputmode") || "").toLowerCase();
    // maxlength 6-8 + numeric inputmode is a very strong OTP signal (avoid CVV's 3-4).
    if ((inputmodeAttr === "numeric" || inputmodeAttr === "decimal") && maxLenAttr >= 6 && maxLenAttr <= 8) return "otp";
    if (/cc-name|cardholder|name on card|holder name|持卡人|姓名/.test(text)) return "name";
    if (/tel|phone|mobile|手机号|电话/.test(text) || type === "tel") return "phone";
    if (/postal|zip|postcode|邮编/.test(text)) return "postal";
    if (/city|城市/.test(text)) return "city";
    if (/state|province|region|州|省/.test(text)) return "state";
    if (/country|国家/.test(text)) return "country";
    if (/address-line2|address line 2|address2|apt|apartment|suite|unit|地址2|地址 2|地址行2/.test(text)) return "addressLine2";
    if (/address-line1|address line 1|address1|street address|street|地址1|地址 1|地址行1/.test(text)) return "addressLine1";
    if (/street-address|billing address|address|地址/.test(text)) return "address";
    return "";
  }

  function formatExpiry(billing) {
    if (!billing) return "";
    if (billing.expiryMonth && billing.expiryYear) return `${billing.expiryMonth}/${String(billing.expiryYear).slice(-2)}`;
    if (billing.expiry) return billing.expiry;
    return "";
  }

  function splitAddress(address) {
    const text = String(address || "").trim();
    const parts = text.split(",").map((item) => item.trim()).filter(Boolean);
    const postal = firstMatch(text, [/\b(\d{5}(?:-\d{4})?)\b/]);
    const stateMatch = text.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
    const country = parts[parts.length - 1] || "";
    let line1 = parts[0] || text;
    let line2 = "";
    let city = "";
    let state = stateMatch?.[1] || "";

    if (parts.length >= 2) {
      const middle = parts[1].replace(postal, "").replace(/\b[A-Z]{2}\b(?=\s*$)/, "").trim();
      city = middle;
    }
    if (parts.length >= 4) {
      line2 = parts[1] || "";
      city = parts[2]?.replace(postal, "").trim() || city;
    }

    return {
      full: text,
      line1,
      line2,
      city,
      state: state || stateFromUsZip(postal),
      postal,
      country: normalizeCountry(country)
    };
  }

  function normalizeCountry(country) {
    const text = String(country || "").trim();
    if (/^(us|usa|u\.s\.a\.|united states|united states of america)$/i.test(text)) return "United States";
    return text;
  }

  function stateFromUsZip(postal) {
    const prefix = Number(String(postal || "").slice(0, 3));
    if (!Number.isFinite(prefix)) return "";
    const ranges = [
      [10, 27, "Massachusetts"], [28, 29, "Rhode Island"], [30, 38, "New Hampshire"], [39, 49, "Maine"],
      [50, 59, "Vermont"], [60, 69, "Connecticut"], [70, 89, "New Jersey"], [100, 149, "New York"],
      [150, 196, "Pennsylvania"], [197, 199, "Delaware"], [200, 205, "District of Columbia"], [206, 219, "Maryland"],
      [220, 246, "Virginia"], [247, 268, "West Virginia"], [270, 289, "North Carolina"], [290, 299, "South Carolina"],
      [300, 319, "Georgia"], [320, 349, "Florida"], [350, 369, "Alabama"], [370, 385, "Tennessee"],
      [386, 397, "Mississippi"], [398, 399, "Georgia"], [400, 427, "Kentucky"], [430, 459, "Ohio"],
      [460, 479, "Indiana"], [480, 499, "Michigan"], [500, 528, "Iowa"], [530, 549, "Wisconsin"],
      [550, 567, "Minnesota"], [570, 577, "South Dakota"], [580, 588, "North Dakota"], [590, 599, "Montana"],
      [600, 629, "Illinois"], [630, 658, "Missouri"], [660, 679, "Kansas"], [680, 693, "Nebraska"],
      [700, 714, "Louisiana"], [716, 729, "Arkansas"], [730, 749, "Oklahoma"], [750, 799, "Texas"],
      [800, 816, "Colorado"], [820, 831, "Wyoming"], [832, 838, "Idaho"], [840, 847, "Utah"],
      [850, 865, "Arizona"], [870, 884, "New Mexico"], [889, 898, "Nevada"], [900, 961, "California"],
      [967, 968, "Hawaii"], [970, 979, "Oregon"], [980, 994, "Washington"], [995, 999, "Alaska"]
    ];
    const match = ranges.find(([start, end]) => prefix >= start && prefix <= end);
    return match?.[2] || "";
  }

  async function getVaultBlob() {
    const data = await chrome.storage.local.get([STORAGE_KEYS.vaultBlob]);
    return data[STORAGE_KEYS.vaultBlob] || null;
  }

  async function getSessionVault() {
    const data = await chrome.storage.session.get([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]);
    return {
      vault: data[STORAGE_KEYS.sessionVault] ? normalizeVault(data[STORAGE_KEYS.sessionVault]) : null,
      keyB64: data[STORAGE_KEYS.sessionKey] || ""
    };
  }

  async function unlockVault(passphrase) {
    const blob = await getVaultBlob();
    if (!blob) {
      const created = await createEncryptedVault(passphrase);
      await chrome.storage.local.set({ [STORAGE_KEYS.vaultBlob]: created.blob });
      await chrome.storage.session.set({
        [STORAGE_KEYS.sessionVault]: created.vault,
        [STORAGE_KEYS.sessionKey]: created.keyB64
      });
      return { vault: created.vault, created: true };
    }

    const decrypted = await decryptVault(blob, passphrase);
    await chrome.storage.session.set({
      [STORAGE_KEYS.sessionVault]: decrypted.vault,
      [STORAGE_KEYS.sessionKey]: decrypted.keyB64
    });
    return { vault: decrypted.vault, created: false };
  }

  async function saveVault(vault) {
    const blob = await getVaultBlob();
    const session = await getSessionVault();
    if (!blob || !session.keyB64) {
      throw new Error("Vault is locked.");
    }
    const normalized = normalizeVault(vault);
    const nextBlob = await encryptVaultWithKeyB64(normalized, session.keyB64, blob.salt);
    await chrome.storage.local.set({ [STORAGE_KEYS.vaultBlob]: nextBlob });
    await chrome.storage.session.set({ [STORAGE_KEYS.sessionVault]: normalized });
    return normalized;
  }

  async function lockVault() {
    await chrome.storage.session.remove([STORAGE_KEYS.sessionVault, STORAGE_KEYS.sessionKey]);
  }

  async function hasVault() {
    return Boolean(await getVaultBlob());
  }

  globalThis.VaultUtils = {
    DEFAULT_VAULT,
    STORAGE_KEYS,
    clone,
    uid,
    makeBatch,
    cleanBatchLabel,
    activeBatchId,
    normalizeVault,
    createEncryptedVault,
    decryptVault,
    encryptVaultWithKeyB64,
    parseAccountLine,
    parseAccountLines,
    parseGithubLine,
    parseGithubLines,
    parseBillingText,
    parseBillingBlocks,
    parseExpiry,
    parseSmsCode,
    totpCode,
    inferFieldType,
    visibleElement,
    formatExpiry,
    splitAddress,
    maskValue,
    getVaultBlob,
    getSessionVault,
    unlockVault,
    saveVault,
    lockVault,
    hasVault
  };
})();
