const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = 37621;
const ROOT = __dirname;
const DATA_ROOT = path.join(ROOT, "data", "batches");

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function slug(value) {
  return String(value || "default")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "default";
}

function cleanString(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*(点击复制|复制|一键复制|点此复制|click to copy|copy)\s*$/i, "")
    .trim();
}

function cleanRecord(record) {
  const next = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value == null) continue;
    if (typeof value === "string") next[key] = cleanString(value);
    else next[key] = value;
  }
  return next;
}

function pickBatch(vault, batchId) {
  const batches = Array.isArray(vault.batches) ? vault.batches : [];
  return batches.find((item) => item.id === batchId) || batches[0] || {
    id: "default",
    label: "默认批次"
  };
}

function groupByBatch(vault, key) {
  const rows = Array.isArray(vault[key]) ? vault[key] : [];
  const groups = new Map();
  for (const row of rows) {
    const batch = pickBatch(vault, row.batchId || vault.settings?.activeBatchId);
    const batchKey = batch.id || "default";
    if (!groups.has(batchKey)) {
      groups.set(batchKey, { batch, rows: [] });
    }
    groups.get(batchKey).rows.push(cleanRecord(row));
  }
  return groups;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function saveVault(vault) {
  const normalized = {
    version: vault.version || 1,
    exportedAt: new Date().toISOString(),
    batches: Array.isArray(vault.batches) ? vault.batches.map(cleanRecord) : [],
    settings: {
      activeBatchId: vault.settings?.activeBatchId || ""
    }
  };

  const groups = {
    accounts: groupByBatch(vault, "accounts"),
    githubs: groupByBatch(vault, "githubs"),
    billings: groupByBatch(vault, "billings")
  };

  const written = [];
  const batchIds = new Set([
    ...groups.accounts.keys(),
    ...groups.githubs.keys(),
    ...groups.billings.keys()
  ]);

  for (const batchId of batchIds) {
    const batch = pickBatch(vault, batchId);
    const dirName = `${slug(batch.label)}_${slug(batch.id).slice(0, 18)}`;
    const batchDir = path.join(DATA_ROOT, dirName);
    const gmailRows = groups.accounts.get(batchId)?.rows || [];
    const githubRows = groups.githubs.get(batchId)?.rows || [];
    const billingRows = groups.billings.get(batchId)?.rows || [];
    const batchInfo = cleanRecord(batch);

    await writeJson(path.join(batchDir, "batch.json"), batchInfo);
    await writeJson(path.join(batchDir, "gmail-accounts.json"), gmailRows);
    await writeJson(path.join(batchDir, "github-accounts.json"), githubRows);
    await writeJson(path.join(batchDir, "billing-cards.json"), billingRows);
    await writeJson(path.join(batchDir, "combined.json"), {
      batch: batchInfo,
      gmailAccounts: gmailRows,
      githubAccounts: githubRows,
      billingCards: billingRows
    });
    written.push(batchDir);
  }

  await writeJson(path.join(ROOT, "data", "vault-index.json"), normalized);
  return {
    dataRoot: path.join(ROOT, "data"),
    written
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, dataRoot: path.join(ROOT, "data") });
      return;
    }

    if (req.method === "POST" && req.url === "/save") {
      const body = await readBody(req);
      const parsed = JSON.parse(body || "{}");
      if (!parsed.vault || typeof parsed.vault !== "object") {
        sendJson(res, 400, { ok: false, error: "Missing vault." });
        return;
      }
      const result = await saveVault(parsed.vault);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local save API listening on http://127.0.0.1:${PORT}`);
  console.log(`Data folder: ${path.join(ROOT, "data")}`);
});
