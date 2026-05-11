// Runs in the MAIN world at document_start on kiro.dev / *.kiro.dev.
//
// Purpose: the `profile_arn` value we need for Kiro Session export does not
// live in cookies or localStorage. It only shows up in responses from the
// Kiro web-portal API. We watch every fetch() and XMLHttpRequest response,
// look for `profileArn` anywhere in the parsed JSON payload, and cache the
// first hit in sessionStorage under `kiro_captured_profile_arn`.
//
// The ISOLATED-world content script (`kiro-session-content.js`) reads that
// sessionStorage key plus a CSRF token and answers messages from the popup.
//
// Keep this file self-contained: no imports, no chrome.* calls. It runs in
// page context, so anything it touches is visible to the page. We only read
// responses and write sessionStorage — no page state is mutated.

(() => {
  if (window.__kiroCaptureInstalled) return;
  window.__kiroCaptureInstalled = true;

  const STORAGE_KEY = "kiro_captured_profile_arn";
  const STORAGE_META = "kiro_captured_profile_arn_at";
  const URL_MATCH = /\/service\/KiroWebPortalService\/operation\//i;
  const ARN_RE = /arn:aws:codewhisperer:[a-z0-9-]+:\d+:profile\/[A-Z0-9]+/;

  function rememberArn(arn) {
    if (!arn || typeof arn !== "string") return;
    if (!ARN_RE.test(arn)) return;
    try {
      if (sessionStorage.getItem(STORAGE_KEY) === arn) return;
      sessionStorage.setItem(STORAGE_KEY, arn);
      sessionStorage.setItem(STORAGE_META, new Date().toISOString());
    } catch (_) { /* sessionStorage can be disabled; ignore */ }
  }

  function findArn(value) {
    if (!value) return "";
    if (typeof value === "string") {
      const match = value.match(ARN_RE);
      return match ? match[0] : "";
    }
    if (typeof value === "object") {
      try {
        const serialized = JSON.stringify(value);
        const match = serialized.match(ARN_RE);
        return match ? match[0] : "";
      } catch (_) {
        return "";
      }
    }
    return "";
  }

  // --- fetch patch ----------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const result = nativeFetch.apply(this, args);
      result.then((response) => {
        try {
          const url = response?.url || "";
          if (!URL_MATCH.test(url)) return;
          // Clone so we don't consume the page's body.
          response.clone().text().then((text) => {
            const arn = findArn(text);
            if (arn) rememberArn(arn);
          }).catch(() => {});
        } catch (_) { /* ignore */ }
      }).catch(() => {});
      return result;
    };
  }

  // --- XHR patch ------------------------------------------------------------
  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === "function") {
    const origOpen = NativeXHR.prototype.open;
    const origSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      try { this.__kiroCaptureUrl = String(url || ""); } catch (_) { /* ignore */ }
      return origOpen.call(this, method, url, ...rest);
    };
    NativeXHR.prototype.send = function patchedSend(...args) {
      try {
        if (URL_MATCH.test(this.__kiroCaptureUrl || "")) {
          this.addEventListener("load", () => {
            try {
              const arn = findArn(this.responseText || "");
              if (arn) rememberArn(arn);
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return origSend.apply(this, args);
    };
  }
})();
