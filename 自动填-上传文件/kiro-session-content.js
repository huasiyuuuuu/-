// Isolated-world content script on kiro.dev / *.kiro.dev.
//
// Responsibilities:
//   1. Inject `kiro-capture.js` into the MAIN world at document_start, so the
//      page's fetch / XHR responses become visible.
//   2. On message { type: "getCsrfAndProfileArn" }, scan localStorage for
//      anything that looks like a CSRF token, read the cached profileArn from
//      sessionStorage, and return both to the background page.
//
// Everything here is Kiro-export-specific and does not touch the autofill
// pipeline. The autofill content.js is loaded separately by manifest.json.

(() => {
  if (window.__kiroSessionContentInstalled) return;
  window.__kiroSessionContentInstalled = true;

  // --- Inject MAIN-world capturer ------------------------------------------
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("kiro-capture.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (_) { /* MAIN-world injection can fail on chrome:// etc. */ }

  // --- Helpers --------------------------------------------------------------

  // Matches anything a Kiro/OIDC stack is likely to call a CSRF token under.
  // We deliberately accept multiple casings and separators; the real key
  // isn't documented, so fuzzy-matching buys us resilience.
  const CSRF_KEY_RE = /csrf|xsrf/i;
  const ARN_RE = /arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Z0-9]+/;

  function scanLocalStorageForCsrf() {
    try {
      const hits = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !CSRF_KEY_RE.test(key)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        hits.push({ key, value: raw });
      }
      // Prefer the longest value — shorter values are often enabled flags
      // or per-request nonces rather than the session-wide token.
      hits.sort((a, b) => String(b.value).length - String(a.value).length);
      for (const hit of hits) {
        const token = extractStringToken(hit.value);
        if (token) return { token, source: `localStorage:${hit.key}` };
      }
    } catch (_) { /* localStorage can be locked in sandboxed frames */ }
    return { token: "", source: "" };
  }

  function extractStringToken(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    // Plain string? Already the token.
    if (!text.startsWith("{") && !text.startsWith("[") && !text.startsWith('"')) {
      return text;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        // Walk shallowly for a string that looks like a CSRF token: alnum,
        // dashes, and 16+ chars. This rules out things like `{ enabled: true }`.
        for (const key of Object.keys(parsed)) {
          const value = parsed[key];
          if (typeof value === "string" && value.length >= 16 && /^[A-Za-z0-9_\-\.=:+/]+$/.test(value)) {
            return value;
          }
        }
      }
    } catch (_) { /* treat as plain string */ }
    return text;
  }

  function scanMetaForCsrf() {
    try {
      const metas = document.querySelectorAll('meta[name*="csrf" i], meta[name*="xsrf" i]');
      for (const meta of metas) {
        const value = meta.getAttribute("content");
        if (value && value.length >= 8) {
          return { token: value, source: `meta:${meta.getAttribute("name")}` };
        }
      }
    } catch (_) { /* ignore */ }
    return { token: "", source: "" };
  }

  function readCapturedProfileArn() {
    try {
      const arn = sessionStorage.getItem("kiro_captured_profile_arn") || "";
      if (arn && ARN_RE.test(arn)) return arn;
    } catch (_) { /* ignore */ }
    // Fallback: some pages render ARN into a script/body text node.
    try {
      const bodyText = document.body?.innerText || "";
      const match = bodyText.match(ARN_RE);
      if (match) return match[0];
    } catch (_) { /* ignore */ }
    return "";
  }

  function collectPayload() {
    const fromLocal = scanLocalStorageForCsrf();
    const fromMeta = fromLocal.token ? { token: "", source: "" } : scanMetaForCsrf();
    const csrfToken = fromLocal.token || fromMeta.token || "";
    const csrfSource = fromLocal.source || fromMeta.source || "";
    const profileArn = readCapturedProfileArn();
    return {
      ok: true,
      csrfToken,
      csrfSource,
      profileArn,
      href: location.href,
      host: location.host
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "getCsrfAndProfileArn") return false;
    try {
      sendResponse(collectPayload());
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
})();
