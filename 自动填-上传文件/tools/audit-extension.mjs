import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const ROOT = new URL("../", import.meta.url);

function read(name) {
  return fs.readFileSync(new URL(name, ROOT), "utf8");
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function createSharedSandbox(extra = {}) {
  const sandbox = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    ...extra
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), sandbox);
  return sandbox;
}

function runParsingAudit() {
  const sandbox = createSharedSandbox();
  const U = sandbox.VaultUtils;

  const gmailLine = "test.user.autofill@gmail.com|ExamplePass123|recovery@example.com|JBSWY3DPEHPK3PXP|2023|South Korea";
  const githubLine = "example-user----ExamplePass123----JBSWY3DPEHPK3PXP";
  const billingText = `卡号 Card Number: 4242424242424242
有效期 Expiry: 2030/4
CVV: 051
电话 Phone: +15555550123
姓名 Name: TEST USER
地址 Address: 123 TEST ST,NEW YORK 10001,US
接码 API: https://example.com/api/get_sms?key=TEST_KEY`;

  const account = U.parseAccountLine(gmailLine);
  assert(account?.email === "test.user.autofill@gmail.com", "Gmail email parse failed", account);
  assert(account?.password === "ExamplePass123", "Gmail password parse failed", account);
  assert(account?.recoveryEmail === "recovery@example.com", "Gmail recovery email parse failed", account);
  assert(account?.totpSecret === "JBSWY3DPEHPK3PXP", "Gmail TOTP parse failed", account);

  const github = U.parseGithubLine(githubLine);
  assert(github?.username === "example-user", "GitHub username parse failed", github);
  assert(github?.password === "ExamplePass123", "GitHub password parse failed", github);
  assert(github?.totpSecret === "JBSWY3DPEHPK3PXP", "GitHub TOTP parse failed", github);

  const billing = U.parseBillingText(billingText);
  assert(billing?.cardNumber === "4242424242424242", "Billing card parse failed", billing);
  assert(billing?.expiryMonth === "04" && billing?.expiryYear === "2030", "Billing expiry parse failed", billing);
  assert(billing?.cvv === "051", "Billing CVV parse failed", billing);
  assert(billing?.phone === "+15555550123", "Billing phone parse failed", billing);
  assert(billing?.name === "TEST USER", "Billing name parse failed", billing);
  assert(Boolean(billing?.smsApi), "Billing SMS API parse failed", billing);

  const address = U.splitAddress(billing.address);
  assert(address.line1 === "123 TEST ST", "Address line1 split failed", address);
  assert(address.city === "NEW YORK", "Address city split failed", address);
  assert(address.postal === "10001", "Address postal split failed", address);
  assert(address.country === "United States", "Address country normalize failed", address);

  const smsJson = U.parseSmsCode(JSON.stringify({ message: "Your verification code is 493812." }));
  assert(smsJson.code === "493812", "SMS JSON code parse failed", smsJson);
  const noSms = U.parseSmsCode(JSON.stringify({ phone: "+15555550123", status: "pending" }));
  assert(noSms.code === "", "SMS parser should not use phone number as code", noSms);

  return { account, github, billing, address };
}

function runFieldInferenceAudit() {
  const sandbox = createSharedSandbox({
    document: { querySelector: () => null },
    CSS: { escape: (value) => value }
  });
  const U = sandbox.VaultUtils;
  // [attrs, parentText, expected-type]
  const cases = [
    [{ autocomplete: "postal-code" }, "Billing address Postal", "postal"],
    [{ autocomplete: "address-level2" }, "Billing address City", "city"],
    [{ autocomplete: "address-level1" }, "Billing address State", "state"],
    [{ id: "Field-numberInput", name: "number", placeholder: "1234 1234 1234 1234" }, "", "cardNumber"],
    [{ id: "Field-expiryInput", name: "expiry", placeholder: "MM / YY" }, "", "expiry"],
    [{ id: "Field-cvcInput", name: "cvc", placeholder: "CVC" }, "", "cvv"],
    [{ name: "code", placeholder: "Enter code", maxlength: "6" }, "Verification", "otp"],
    // Broader OTP signals added in the fix for Bug B.
    [{ name: "verificationCode", placeholder: "6-digit code" }, "Enter the code we sent to your phone", "otp"],
    [{ inputmode: "numeric", maxlength: "6", type: "tel" }, "One time code", "otp"],
    // Negative guard: inputmode=numeric but max 5 = still zip-like, not OTP.
    [{ inputmode: "numeric", maxlength: "5", name: "zip" }, "Postal code", "postal"],
    // Negative guard: the word "code" inside "Reference code" / "Promo code" / "Area code" shouldn't be OTP.
    [{ name: "promo", placeholder: "Enter promo code" }, "Have a promo code?", ""],
    [{ name: "area", placeholder: "Area code" }, "", ""],
    // Stripe cvc has maxlength 3 and type=tel — must NOT be treated as OTP (CVV wins).
    [{ id: "Field-cvcInput", name: "cvc", placeholder: "CVC", inputmode: "numeric", maxlength: "3" }, "", "cvv"]
  ];
  for (const [attrs, parentText, expected] of cases) {
    const actual = U.inferFieldType(new MockInput(attrs, parentText));
    assert(actual === expected, `Field inference failed for expected=${expected}`, { attrs, parentText, actual });
  }
}

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class MockInput {
  constructor(attrs = {}, parentText = "") {
    this.attrs = attrs;
    this.parentText = parentText;
    this.id = attrs.id || "";
    this.tagName = "INPUT";
    this.disabled = false;
    this.readOnly = false;
    this.events = [];
    this._value = attrs.value || "";
    // Optional: a sentinel form reference so multi-form tests can pretend this
    // field lives inside a specific <form>. closest("form") returns it.
    this._form = attrs.form || null;
  }

  getAttribute(name) {
    return this.attrs[name] || "";
  }

  closest(selector) {
    if (selector === "[class]") return { innerText: this.parentText };
    if (selector === "label") return null;
    if (selector === "form") return this._form;
    if (selector === "[role='form']") return null;
    return null;
  }

  querySelectorAll(_selector) {
    // Used when content.js scopes to a form; the mock "form" object has its own
    // querySelectorAll that the test wires up. Plain inputs never become the
    // scope root, so this is a no-op.
    return [];
  }

  getBoundingClientRect() {
    return { width: 120, height: 22, left: 0, top: 0 };
  }

  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }

  get isContentEditable() {
    return false;
  }

  focus() { this.events.push("focus"); }
  blur() { this.events.push("blur"); }
}

Object.defineProperty(MockInput.prototype, "value", {
  get() {
    return this._value;
  },
  set(value) {
    this._value = String(value ?? "");
  }
});

function createContentSandbox(fields, options = {}) {
  const listeners = [];
  const storageListeners = [];
  const body = {
    querySelectorAll: () => fields,
    closest: () => null,
    innerText: ""
  };
  // When tests pass `options.billingFields` we also respond to the specific
  // selectors that content.js's billingFormScopes() uses to discover
  // card-number-bearing forms. Otherwise we just return the generic list.
  const billingSelectorRe = /cc-number|card.*number|cardnumber|cc-csc|cc-exp/i;
  const documentMock = {
    body,
    documentElement: {
      appendChild: () => {}
    },
    createElement: (tagName) => ({
      tagName: String(tagName).toUpperCase(),
      className: "",
      dataset: {},
      style: {},
      textContent: "",
      type: "",
      title: "",
      hidden: false,
      append: () => {},
      appendChild: () => {},
      addEventListener: () => {},
      remove: () => {},
      getBoundingClientRect: () => ({ width: 120, height: 36, left: 0, top: 0 })
    }),
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (options.billingFields && billingSelectorRe.test(String(selector || ""))) {
        return options.billingFields;
      }
      return fields;
    },
    addEventListener: () => {}
  };
  const sandbox = createSharedSandbox({
    window: {},
    document: documentMock,
    location: {
      hostname: "app.kiro.dev",
      pathname: "/home",
      href: "https://app.kiro.dev/home",
      origin: "https://app.kiro.dev"
    },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    CSS: { escape: (value) => value },
    Event: MockEvent,
    InputEvent: MockEvent,
    KeyboardEvent: MockEvent,
    HTMLInputElement: MockInput,
    HTMLTextAreaElement: MockInput,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    chrome: {
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.push(listener)
        },
        sendMessage: async (message) => {
          if (message?.type === "getVaultSnapshot") {
            return { ok: true, unlocked: true, vault: { accounts: [], githubs: [], billings: [], settings: {} } };
          }
          if (message?.type === "fillAllFrames") return { ok: true, filled: 0 };
          if (message?.type === "fetchSmsCode") return { ok: true, code: "493812", status: 200 };
          return { ok: true };
        }
      },
      storage: {
        local: {
          get: async () => ({ gba_plain_vault: { settings: { autoFillOnHover: false }, accounts: [], githubs: [], billings: [] } }),
          set: async () => {}
        },
        onChanged: {
          addListener: (listener) => storageListeners.push(listener)
        }
      }
    },
    localStorage: {
      clear: () => {}
    },
    sessionStorage: {
      clear: () => {}
    },
    caches: {
      keys: async () => ["kiro-cache"],
      delete: async () => true
    },
    indexedDB: {
      databases: async () => [{ name: "kiro-db" }],
      deleteDatabase: () => {
        const request = {};
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      }
    },
    navigator: {
      clipboard: {
        writeText: async () => {}
      },
      serviceWorker: {
        getRegistrations: async () => [{ unregister: async () => true }]
      }
    }
  });
  sandbox.window = sandbox;
  sandbox.document = documentMock;
  vm.runInContext(read("content.js"), sandbox);
  return { listeners, fields };
}

async function sendContentMessage(listener, message) {
  return new Promise((resolve) => {
    listener(message, { tab: { id: 1 } }, resolve);
  });
}

async function runContentAudit(billing) {
  const fields = [
    new MockInput({ autocomplete: "cc-number" }),
    new MockInput({ autocomplete: "cc-exp" }),
    new MockInput({ autocomplete: "cc-csc" }),
    new MockInput({ autocomplete: "cc-name" }),
    new MockInput({ autocomplete: "tel" }),
    new MockInput({ autocomplete: "address-line1" }),
    new MockInput({ autocomplete: "address-level2" }, "Billing address City"),
    new MockInput({ autocomplete: "address-level1" }, "Billing address State"),
    new MockInput({ autocomplete: "postal-code" }, "Billing address Postal"),
    new MockInput({ autocomplete: "country-name" }),
    new MockInput({ autocomplete: "one-time-code" })
  ];
  const { listeners } = createContentSandbox(fields);
  assert(listeners.length === 1, "Content script did not register one message listener", listeners.length);
  const listener = listeners[0];

  const fillResponse = await sendContentMessage(listener, {
    type: "fillFromPopup",
    kind: "billing",
    billing,
    settings: { overwriteExisting: false }
  });
  assert(fillResponse.ok === true, "Billing fill response not ok", fillResponse);
  assert(fillResponse.filled >= 10, "Billing fill missed fields", {
    filled: fillResponse.filled,
    values: fields.map((field) => field.value)
  });
  assert(fields[0].value === "4242424242424242", "Card number not filled", fields[0].value);
  assert(/\b04\s*\/\s*30\b|\b0430\b/.test(fields[1].value), "Expiry not filled in accepted format", fields[1].value);
  assert(fields[2].value === "051", "CVV not filled", fields[2].value);
  assert(fields[3].value === "TEST USER", "Name not filled", fields[3].value);
  assert(fields[5].value === "123 TEST ST", "Address line1 not filled", fields[5].value);
  assert(fields[6].value === "NEW YORK", "City not filled", fields[6].value);
  assert(fields[7].value === "New York", "State not filled", fields[7].value);
  assert(fields[8].value === "10001", "Postal not filled", fields[8].value);

  const smsResponse = await sendContentMessage(listener, {
    type: "fillFromPopup",
    kind: "smsCode",
    code: "493812",
    settings: { overwriteExisting: true }
  });
  assert(smsResponse.ok === true && smsResponse.filled === 1, "SMS code fill failed", smsResponse);
  assert(fields[10].value === "493812", "SMS code value incorrect", fields[10].value);

  const purgeResponse = await sendContentMessage(listener, { type: "purgeFrameStorage" });
  assert(purgeResponse.ok === true, "Frame purge failed", purgeResponse);
  assert(purgeResponse.result.caches === 1, "Frame cache purge did not run", purgeResponse);
  assert(purgeResponse.result.indexedDB === 1, "Frame IndexedDB purge did not run", purgeResponse);
  assert(purgeResponse.result.serviceWorkers === 1, "Frame service worker purge did not run", purgeResponse);
}

// New: regression for Bug A (masked card stub) and the "overwrite" toggle.
async function runOverwritePolicyAudit(billing) {
  // Scenario 1: a masked "•••• 4242" remnant is present in the card field.
  // Even with overwriteExisting=false we should still replace it with the real card.
  {
    const fields = [new MockInput({ autocomplete: "cc-number", value: "•••• 4242" })];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: { overwriteExisting: false }
    });
    assert(r.ok && r.filled === 1, "Masked stub should not block refill", { r, value: fields[0].value });
    assert(fields[0].value === "4242424242424242", "Masked stub was not replaced with full card", fields[0].value);
  }

  // Scenario 2: the same (full) card is already in the field. No-op, no extra write.
  {
    const fields = [new MockInput({ autocomplete: "cc-number", value: "4242424242424242" })];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: { overwriteExisting: false }
    });
    assert(r.ok && r.filled === 0, "Identical value should not be rewritten", r);
  }

  // Scenario 3: a DIFFERENT full card sits there. With overwriteExisting=false, we
  // leave it alone (we never want to clobber equal-length mystery data silently).
  // With overwriteExisting=true, we replace it.
  {
    const fields = [new MockInput({ autocomplete: "cc-number", value: "4000056655665556" })];
    const { listeners } = createContentSandbox(fields);
    const r1 = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: { overwriteExisting: false }
    });
    assert(r1.filled === 0 && fields[0].value === "4000056655665556", "Different full card must not be silently overwritten", { r1, value: fields[0].value });

    const fields2 = [new MockInput({ autocomplete: "cc-number", value: "4000056655665556" })];
    const { listeners: l2 } = createContentSandbox(fields2);
    const r2 = await sendContentMessage(l2[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: { overwriteExisting: true }
    });
    assert(r2.filled === 1 && fields2[0].value === "4242424242424242", "overwriteExisting=true must replace even equal-length card", { r2, value: fields2[0].value });
  }
}

// New: OTP single-box AND 6-box segmented flow.
async function runOtpFillAudit() {
  // Single box: autocomplete=one-time-code, full 6-digit code goes in.
  {
    const fields = [new MockInput({ autocomplete: "one-time-code", maxlength: "6" })];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "smsCode",
      code: "493812",
      settings: {}
    });
    assert(r.filled === 1, "Single-box OTP should count as 1 filled", r);
    assert(fields[0].value === "493812", "Single-box OTP value wrong", fields[0].value);
    // beforeinput is now dispatched alongside input to wake up React/Stripe handlers.
    assert(fields[0].events.includes("beforeinput"), "beforeinput event was not dispatched", fields[0].events);
  }

  // Segmented: 6 x maxlength=1, numeric inputmode. Each box gets one char;
  // structured details report it as a single logical fill ("验证码（N 格）").
  {
    const fields = Array.from({ length: 6 }, () => new MockInput({ maxlength: "1", inputmode: "numeric", type: "tel" }, "Enter the 6-digit code"));
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "smsCode",
      code: "493812",
      settings: {}
    });
    assert(r.filled === 1, "Segmented OTP should report as 1 logical fill", r);
    assert(Array.isArray(r.details?.filled) && r.details.filled[0]?.kind === "otp", "Segmented OTP details.filled shape wrong", r.details);
    assert(/6 格/.test(r.details.filled[0].label), "Segmented OTP label should mention 格 count", r.details.filled[0]);
    assert(fields.map((field) => field.value).join("") === "493812", "Segmented OTP values wrong", fields.map((field) => field.value));
    // The last filled box must have blurred (we call blur() at the end).
    assert(fields[5].events.includes("blur"), "Segmented OTP should blur the last box", fields[5].events);
    // At least one keydown/keyup pair was sent to advance focus.
    assert(fields[0].events.includes("keydown") && fields[0].events.includes("keyup"), "Segmented OTP must dispatch keydown/keyup", fields[0].events);
  }

  // Mixed: a single full-code input wins over segmented ones.
  {
    const full = new MockInput({ autocomplete: "one-time-code", maxlength: "6" });
    const segmented = Array.from({ length: 6 }, () => new MockInput({ maxlength: "1", inputmode: "numeric" }, "Enter the 6-digit code"));
    const fields = [full, ...segmented];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "smsCode",
      code: "493812",
      settings: {}
    });
    assert(r.filled === 1 && full.value === "493812", "Full OTP box should be preferred over segmented", { r, full: full.value, segmented: segmented.map((s) => s.value) });
    // Segmented boxes stay empty.
    assert(segmented.every((s) => s.value === ""), "Segmented boxes must not be touched when a single box wins", segmented.map((s) => s.value));
  }
}

// New: structured {filled[], skipped[], alreadyMatching, warnings} contract.
async function runStructuredDetailsAudit(billing) {
  // Case 1: empty page, fresh fill — details.filled carries {kind,label} objects
  // with a label that's a user-facing string.
  {
    const fields = [
      new MockInput({ autocomplete: "cc-number" }),
      new MockInput({ autocomplete: "cc-csc" }),
      new MockInput({ autocomplete: "cc-name" })
    ];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: {}
    });
    assert(r.details, "Response must carry details object", r);
    assert(Array.isArray(r.details.filled), "details.filled must be an array", r.details);
    assert(r.details.filled.every((item) => typeof item.kind === "string" && typeof item.label === "string"),
      "Every filled entry must be {kind:string, label:string}", r.details.filled);
    assert(r.details.filled.some((item) => item.kind === "cardNumber"), "cardNumber should appear in filled", r.details.filled);
    assert(r.details.filled.some((item) => item.label === "CVV"), "CVV label should be human-readable", r.details.filled);
    assert(Array.isArray(r.details.skipped) && r.details.skipped.length === 0, "skipped empty on empty page", r.details);
    assert(r.details.alreadyMatching === 0, "alreadyMatching=0 on first pass", r.details);
    assert(Array.isArray(r.details.warnings), "warnings must be an array", r.details);
    // Legacy filled mirrors details.filled.length.
    assert(r.filled === r.details.filled.length, "Legacy filled count must match details.filled.length", r);
  }

  // Case 2: second fill against the just-filled fields — everything matches, so
  // filled=0, alreadyMatching > 0, no skipped (identical values aren't skipped,
  // they're "alreadyMatching"). This is the "why did nothing happen?" case.
  {
    const fields = [
      new MockInput({ autocomplete: "cc-number", value: "4242424242424242" }),
      new MockInput({ autocomplete: "cc-csc", value: "051" }),
      new MockInput({ autocomplete: "cc-name", value: "TEST USER" })
    ];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: {}
    });
    assert(r.details.filled.length === 0, "Nothing should be filled when all values already match", r.details);
    assert(r.details.skipped.length === 0, "Identical values are alreadyMatching, not skipped", r.details);
    assert(r.details.alreadyMatching >= 3, "Three fields should each contribute 1 to alreadyMatching", r.details);
  }

  // Case 3: field holds a DIFFERENT value and user didn't opt in to overwrite.
  // Expect it to land in `skipped` with reason="has-value", not silently dropped.
  {
    const fields = [new MockInput({ autocomplete: "cc-name", value: "OLD HOLDER" })];
    const { listeners } = createContentSandbox(fields);
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: { overwriteExisting: false }
    });
    assert(r.details.filled.length === 0, "Name must not be overwritten without user opt-in", r.details);
    const entry = r.details.skipped.find((item) => item.kind === "name");
    assert(entry && entry.reason === "has-value", "skipped[] must record {kind:'name', reason:'has-value'}", r.details);
    assert(fields[0].value === "OLD HOLDER", "Existing name must be preserved", fields[0].value);
  }

  // Case 4: billingFormScopes() picks a single form. When two billing forms
  // exist, details.warnings includes 'multi-form' and only the first form's
  // fields are filled. The audit wires up a fake "current billing form" +
  // "secondary billing form" via the options.billingFields hook.
  {
    const formA = {
      querySelectorAll: () => formA.fields,
      fields: [
        new MockInput({ autocomplete: "cc-number" }),
        new MockInput({ autocomplete: "cc-csc" })
      ]
    };
    const formB = {
      querySelectorAll: () => formB.fields,
      fields: [
        new MockInput({ autocomplete: "cc-number" }),
        new MockInput({ autocomplete: "cc-csc" })
      ]
    };
    // Link each field's closest("form") back to its parent form.
    for (const field of formA.fields) field._form = formA;
    for (const field of formB.fields) field._form = formB;

    // billingFormScopes() does a single document.querySelectorAll across all
    // billing-selectors; we feed it fields from BOTH forms. When the scope is
    // later picked (formA), content.js calls fieldsNear(formA) which falls
    // through to formA.querySelectorAll().
    const allBillingFields = [...formA.fields, ...formB.fields];
    // The generic field walk (when no form is picked) also sees everything —
    // but after the multi-form branch, only formA is walked.
    const { listeners } = createContentSandbox(allBillingFields, { billingFields: allBillingFields });
    const r = await sendContentMessage(listeners[0], {
      type: "fillFromPopup",
      kind: "billing",
      billing,
      settings: {}
    });
    assert(r.details.warnings.includes("multi-form"),
      "Multi-form page must emit warnings:['multi-form']", r.details);
    // Only formA was filled; formB's cc-number stays empty.
    assert(formA.fields[0].value === "4242424242424242",
      "First billing form should be filled", formA.fields[0].value);
    assert(formB.fields[0].value === "",
      "Secondary billing form must be left alone", formB.fields[0].value);
  }
}

async function runBackgroundVaultPrecedenceAudit() {
  const listeners = [];
  const removedSessionKeys = [];
  const localVault = {
    version: 1,
    accounts: [],
    billings: [],
    githubs: [{ id: "gh_new", username: "new-github", password: "new-pass", createdAt: new Date().toISOString() }],
    batches: [],
    settings: { selectedGithubId: "gh_new" }
  };
  const sessionVault = {
    version: 1,
    accounts: [],
    billings: [],
    githubs: [{ id: "gh_old", username: "old-github", password: "old-pass", createdAt: new Date().toISOString() }],
    batches: [],
    settings: { selectedGithubId: "gh_old" }
  };
  const sandbox = {
    console,
    self: null,
    importScripts: (name) => {
      vm.runInContext(read(name), sandbox);
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({ gba_plain_vault: localVault })
        },
        session: {
          get: async () => ({ gba_session_vault: sessionVault, gba_session_key: "legacy" }),
          remove: async (keys) => {
            removedSessionKeys.push(...keys);
          }
        }
      },
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.push(listener)
        }
      },
      browsingData: { remove: () => {} },
      webNavigation: { getAllFrames: async () => [] },
      tabs: { sendMessage: async () => ({ ok: true, filled: 0 }), reload: () => {} }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => "" }),
    TextEncoder,
    TextDecoder,
    URL,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: webcrypto
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("background.js"), sandbox);
  assert(listeners.length === 1, "Background did not register one message listener", listeners.length);
  const response = await new Promise((resolve) => {
    listeners[0]({ type: "getVaultSnapshot" }, { tab: { id: 1 } }, resolve);
  });
  const github = response?.vault?.githubs?.find((item) => item.id === response.vault.settings.selectedGithubId);
  assert(github?.username === "new-github", "Background returned stale session GitHub instead of local vault", response);
  assert(removedSessionKeys.includes("gba_session_vault"), "Legacy session vault was not cleared", removedSessionKeys);
}

// Smoke-test the Kiro Session export path end-to-end in a service-worker
// sandbox: mock chrome.cookies / chrome.tabs / chrome.storage.local, then
// hit the same message handlers the popup uses (exportKiroSession,
// saveKiroSession, listKiroSessions). Validate the returned JSON against
// the documented schema.
async function runKiroSessionExportAudit() {
  const listeners = [];
  const storage = {}; // stand-in for chrome.storage.local

  // Simulated cookie jar. Real Chrome returns one row per (domain,name,path);
  // we include an "IdP" row as well to exercise the case-insensitive
  // cookie-name mapping.
  const cookieJar = [
    { domain: ".kiro.dev", name: "AccessToken", path: "/", value: "aoa.EXAMPLE.access.token.value-xxxxxxxxxxxxxxxxxxxxx" },
    { domain: ".kiro.dev", name: "RefreshToken", path: "/", value: "aor.EXAMPLE.refresh.token.value-yyyyyyyyyyyyyyyyyy" },
    { domain: ".kiro.dev", name: "UserId", path: "/", value: "d-abc123def456" },
    { domain: ".kiro.dev", name: "kiro-visitor-id", path: "/", value: "1716530000000-d4e5f6a7-b8c9-0a1b" },
    { domain: "app.kiro.dev", name: "IdP", path: "/", value: "Google" },
    // Unrelated cookie that must be ignored.
    { domain: ".kiro.dev", name: "analytics_session", path: "/", value: "don't ship me" }
  ];

  const sandbox = {
    console,
    self: null,
    importScripts: (name) => {
      vm.runInContext(read(name), sandbox);
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(storage) : [keys];
            for (const k of list) if (k in storage) out[k] = storage[k];
            return out;
          },
          set: async (obj) => { Object.assign(storage, obj); }
        },
        session: {
          get: async () => ({}),
          remove: async () => {}
        }
      },
      runtime: {
        onMessage: {
          addListener: (listener) => listeners.push(listener)
        }
      },
      cookies: {
        // Emulate the { domain } filter: returns cookies whose .domain
        // suffix-matches the queried domain (how real Chrome behaves too).
        getAll: async (filter) => {
          const dom = String(filter?.domain || "").toLowerCase();
          if (!dom) return cookieJar.slice();
          return cookieJar.filter((c) => {
            const d = String(c.domain || "").toLowerCase();
            return d === dom || d === `.${dom}` || d.endsWith(`.${dom}`);
          });
        }
      },
      tabs: {
        query: async () => [
          { id: 42, url: "https://app.kiro.dev/home" }
        ],
        sendMessage: async (_tabId, msg) => {
          if (msg?.type === "getCsrfAndProfileArn") {
            return {
              ok: true,
              csrfToken: "EXAMPLE-CSRF-TOKEN-abc123-xyz789-abcdef123456",
              profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/EXAMPLEPROFILE01",
              csrfSource: "localStorage:kiro_csrf_token",
              href: "https://app.kiro.dev/home",
              host: "app.kiro.dev"
            };
          }
          return { ok: true };
        },
        reload: () => {}
      },
      browsingData: { remove: () => {} },
      webNavigation: { getAllFrames: async () => [] }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => "" }),
    TextEncoder,
    TextDecoder,
    URL,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: webcrypto
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("background.js"), sandbox);
  assert(listeners.length === 1, "Background did not register a single message listener", listeners.length);
  const listener = listeners[0];

  function send(message) {
    return new Promise((resolve) => listener(message, { tab: { id: 1 } }, resolve));
  }

  // Step 1: exportKiroSession — assemble JSON from cookies + content script.
  const exportRes = await send({ type: "exportKiroSession", name: "Smoke Test" });
  assert(exportRes?.ok, "exportKiroSession must return ok:true", exportRes);
  const { session, missing } = exportRes;
  assert(session && typeof session === "object", "session must be an object", exportRes);
  // Field mapping from cookie names to schema keys.
  assert(session.access_token.startsWith("aoa."), "access_token must come from AccessToken cookie", session);
  assert(session.refresh_token.startsWith("aor."), "refresh_token must come from RefreshToken cookie", session);
  assert(session.user_id === "d-abc123def456", "user_id must come from UserId cookie", session);
  assert(session.visitor_id.startsWith("1716530000000-"), "visitor_id must come from kiro-visitor-id cookie", session);
  assert(session.idp === "Google", "idp must come from Idp cookie (case-insensitive)", session);
  assert(session.csrf_token.length > 8, "csrf_token must come from content script", session);
  assert(/^arn:aws:codewhisperer:/.test(session.profile_arn), "profile_arn must come from content script", session);
  assert(typeof session.exported_at === "string" && !Number.isNaN(Date.parse(session.exported_at)),
    "exported_at must be ISO", session);
  assert(session.name === "Smoke Test", "name must propagate from the request", session);
  assert(Array.isArray(missing) && missing.length === 0, "no missing fields when cookies + content script are healthy", exportRes);

  // Step 2: saveKiroSession — persists into chrome.storage.local under kiro_sessions_vault.
  const saveRes = await send({ type: "saveKiroSession", session });
  assert(saveRes?.ok && saveRes.count === 1, "saveKiroSession must persist and return count", saveRes);
  assert(Array.isArray(storage.kiro_sessions_vault), "kiro_sessions_vault must hold an array", storage);
  assert(storage.kiro_sessions_vault.length === 1, "kiro_sessions_vault must contain 1 session", storage);

  // Step 3: listKiroSessions round-trip.
  const listRes = await send({ type: "listKiroSessions" });
  assert(listRes?.ok && listRes.sessions.length === 1, "listKiroSessions must return 1 session", listRes);
  assert(listRes.sessions[0].user_id === "d-abc123def456", "listKiroSessions returned wrong session", listRes);

  // Step 4: schema guard — refuse to save a session with a bogus profile_arn.
  const bogus = { ...session, profile_arn: "not-an-arn" };
  const rejectRes = await send({ type: "saveKiroSession", session: bogus });
  assert(rejectRes?.ok === false && /profile_arn/.test(rejectRes.error || ""),
    "saveKiroSession must reject malformed profile_arn", rejectRes);
  assert(storage.kiro_sessions_vault.length === 1,
    "Rejected save must not bloat the vault", storage);

  // Step 5: fallback path — when content script can't supply csrf/profile_arn,
  // export still succeeds but flags the missing fields so the popup can prompt.
  sandbox.chrome.tabs.sendMessage = async () => ({ ok: true, csrfToken: "", profileArn: "", csrfSource: "" });
  const degraded = await send({ type: "exportKiroSession", name: "" });
  assert(degraded.ok && degraded.missing.includes("csrf_token") && degraded.missing.includes("profile_arn"),
    "Missing csrf/profile_arn must be reported so the popup can fall back to prompt", degraded);
  // Name must default to the timestamp when empty.
  assert(degraded.session.name === degraded.session.exported_at, "Empty name must fall back to timestamp", degraded.session);
}

function runManifestAudit() {
  const manifest = JSON.parse(read("manifest.json"));
  assert(manifest.version === "0.1.8", "Manifest version mismatch", manifest.version);
  assert(manifest.permissions.includes("webNavigation"), "webNavigation permission missing", manifest.permissions);
  // The `scripting` permission was removed along with the dead execution path in
  // the encrypted-vault cleanup. Guard against it creeping back.
  assert(!manifest.permissions.includes("scripting"), "Unused `scripting` permission should not be declared", manifest.permissions);
  // The `cookies` permission was added for the Kiro Session export feature.
  assert(manifest.permissions.includes("cookies"), "cookies permission missing (required by Kiro Session export)", manifest.permissions);
  // `<all_urls>` is too broad for what this extension does.
  assert(!manifest.host_permissions.includes("<all_urls>"), "<all_urls> must not appear in host_permissions", manifest.host_permissions);
  // Kiro / Stripe / Google / GitHub plus loopback are required.
  for (const required of [
    "https://accounts.google.com/*",
    "https://github.com/*",
    "https://kiro.dev/*",
    "https://*.kiro.dev/*",
    "https://*.stripe.com/*",
    "https://*.stripe.network/*",
    "http://127.0.0.1:37621/*"
  ]) {
    assert(manifest.host_permissions.includes(required), `Missing host permission: ${required}`, manifest.host_permissions);
  }
  assert(manifest.content_scripts?.[0]?.all_frames === true, "Content script must run in all frames", manifest.content_scripts?.[0]);
  assert(manifest.content_scripts?.[0]?.matches.includes("https://app.kiro.dev/*") || manifest.content_scripts?.[0]?.matches.includes("https://*.kiro.dev/*"), "Kiro app host missing", manifest.content_scripts?.[0]?.matches);
  assert(manifest.content_scripts?.[0]?.matches.includes("https://*.stripe.network/*"), "Stripe network frames missing", manifest.content_scripts?.[0]?.matches);

  // Kiro Session export needs its own content script at document_start on
  // kiro.dev and a web-accessible MAIN-world capturer.
  const kiroContentScript = (manifest.content_scripts || []).find((entry) => (entry.js || []).includes("kiro-session-content.js"));
  assert(kiroContentScript, "manifest.content_scripts missing kiro-session-content.js entry", manifest.content_scripts);
  assert(kiroContentScript.run_at === "document_start", "kiro-session-content.js must run at document_start", kiroContentScript);
  assert((kiroContentScript.matches || []).includes("https://*.kiro.dev/*"), "kiro-session-content.js must target *.kiro.dev", kiroContentScript);
  const war = manifest.web_accessible_resources || [];
  const exposesCapture = war.some((entry) => (entry.resources || []).includes("kiro-capture.js"));
  assert(exposesCapture, "kiro-capture.js must be web-accessible for MAIN-world injection", war);
}

async function main() {
  runManifestAudit();
  const parsed = runParsingAudit();
  runFieldInferenceAudit();
  await runContentAudit(parsed.billing);
  await runOverwritePolicyAudit(parsed.billing);
  await runOtpFillAudit();
  await runStructuredDetailsAudit(parsed.billing);
  await runBackgroundVaultPrecedenceAudit();
  await runKiroSessionExportAudit();
  console.log("AUDIT PASS");
}

main().catch((error) => {
  console.error("AUDIT FAIL");
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
