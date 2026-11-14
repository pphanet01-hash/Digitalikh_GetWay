const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Ensure SQLite database is seeded and configured before 9router initializes
function ensureDatabaseReady() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || "", "9router");
    if (!dataDir) return;
    const dbDir = path.join(dataDir, "db");
    const dbPath = path.join(dbDir, "data.sqlite");

    const seedCandidates = [
      path.join(__dirname, "seed-data.sqlite"),
      path.join(__dirname, "..", "..", "assets", "seed-data.sqlite"),
      path.join(__dirname, "..", "..", "app.asar.unpacked", "assets", "seed-data.sqlite")
    ];
    const seedPath = seedCandidates.find((p) => fs.existsSync(p));

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    if (!fs.existsSync(dbPath) && seedPath) {
      fs.copyFileSync(seedPath, dbPath);
      console.log("[DB Init] Seeded fresh database from:", seedPath);
    }

    if (!fs.existsSync(dbPath)) return;

    const db = new DatabaseSync(dbPath);

    // Disable 403 suspended accounts from active routing and ensure valid string projectId to prevent [400] scalar field errors
    try {
      const antigravityRows = db.prepare("SELECT id, isActive, data FROM providerConnections WHERE provider = 'antigravity'").all();
      for (const r of antigravityRows) {
        const d = JSON.parse(r.data || "{}");
        let dataChanged = false;
        let nextActive = r.isActive;
        const lastErrStr = String(d.lastError || "");
        if (
          d.errorCode === 403 ||
          lastErrStr.includes("403") ||
          lastErrStr.toLowerCase().includes("disabled in this account") ||
          lastErrStr.toLowerCase().includes("verify your account")
        ) {
          nextActive = 0;
        }
        const rawProj = d.projectId;
        let cleanProj = "aicode-consumers";
        if (typeof rawProj === "string") {
          const s = rawProj.trim();
          if (s && s !== "[object Object]" && !s.startsWith("{")) {
            cleanProj = s;
          }
        } else if (rawProj && typeof rawProj === "object" && typeof rawProj.id === "string" && rawProj.id.trim()) {
          cleanProj = rawProj.id.trim();
        }
        if (d.projectId !== cleanProj) {
          d.projectId = cleanProj;
          dataChanged = true;
        }
        if (
          d.errorCode === 400 ||
          d.errorCode === 404 ||
          lastErrStr.includes("Starting an object on a scalar field") ||
          lastErrStr.includes("Requested entity was not found")
        ) {
          delete d.errorCode;
          delete d.lastError;
          delete d.lastErrorAt;
          d.testStatus = "active";
          for (const k of Object.keys(d)) {
            if (k.startsWith("modelLock_")) delete d[k];
          }
          dataChanged = true;
        }
        if (dataChanged || nextActive !== r.isActive) {
          db.prepare("UPDATE providerConnections SET isActive = ?, data = ? WHERE id = ?").run(
            nextActive,
            JSON.stringify(d),
            r.id
          );
        }
      }
    } catch (e) {}

    // Ensure settings has requireApiKey: false, requireLogin: false, gatewayMode, and anti-ban sticky session limit
    let activeGatewayMode = "hybrid";
    try {
      const sRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
      let sData = {};
      if (sRow && sRow.data) {
        try { sData = JSON.parse(sRow.data); } catch (e) {}
      }
      sData.requireApiKey = false;
      sData.requireLogin = false;
      sData.password = null;
      if (!sData.gatewayMode || !["hybrid", "gemini", "antigravity", "gemini-web"].includes(sData.gatewayMode)) {
        sData.gatewayMode = "hybrid";
      }
      activeGatewayMode = sData.gatewayMode;
      if (!sData.stickyRoundRobinLimit || sData.stickyRoundRobinLimit <= 10) {
        sData.stickyRoundRobinLimit = 20;
      }
      if (!sData.providerStrategies || typeof sData.providerStrategies !== "object") {
        sData.providerStrategies = {};
      }
      if (!sData.providerStrategies.antigravity || sData.providerStrategies.antigravity.stickyRoundRobinLimit <= 10) {
        sData.providerStrategies.antigravity = {
          ...(sData.providerStrategies.antigravity || {}),
          fallbackStrategy: "fill-first",
          stickyRoundRobinLimit: 20
        };
      }
      if (!sData.providerStrategies.gemini) {
        sData.providerStrategies.gemini = {
          fallbackStrategy: "round-robin",
          stickyRoundRobinLimit: 3
        };
      }
      db.prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(
        JSON.stringify(sData)
      );
    } catch (e) {}

    // Ensure sk-sastra and ls-digitalikh default API keys exist and are active
    try {
      const sk = db.prepare("SELECT id FROM apiKeys WHERE key = 'sk-sastra'").get();
      if (!sk) {
        db.prepare("INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(
          crypto.randomUUID(), "sk-sastra", "Sastra Default Key", "sastra-master", 1, new Date().toISOString()
        );
      } else {
        db.prepare("UPDATE apiKeys SET isActive = 1 WHERE key = 'sk-sastra'").run();
      }

      const lsdk = db.prepare("SELECT id FROM apiKeys WHERE key = 'ls-digitalikh'").get();
      if (!lsdk) {
        db.prepare("INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(
          crypto.randomUUID(), "ls-digitalikh", "Digitalikh Universal Key", "digitalikh-master", 1, new Date().toISOString()
        );
      } else {
        db.prepare("UPDATE apiKeys SET isActive = 1 WHERE key = 'ls-digitalikh'").run();
      }
    } catch (e) {}

    // Configure modelAliases and smart cross-provider combos (Antigravity + Gemini API Key Gateway)
    try {
      const agRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'antigravity' AND isActive = 1").get();
      const gmRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'gemini' AND isActive = 1").get();
      const agCount = Number(agRow?.c || 0);
      const gmCount = Number(gmRow?.c || 0);

      const useGeminiPrimary =
        gmCount > 0 &&
        (activeGatewayMode === "gemini" || (activeGatewayMode === "hybrid" && agCount === 0));

      const defaultAliases = {
        // Explicit Antigravity shorthand aliases
        "ag/4-argon": "ag/gemini-4-argon",
        "ag/4-carbon": "ag/gemini-4-carbon",
        "ag/3.5-flash-lite": "ag/gemini-3.5-flash-lite",
        "ag/3.8-flash": "ag/gemini-3.8-flash",
        "ag/3.1-pro": "ag/gemini-3.1-pro-high",
        "ag/gemini-3.6-flash": "ag/gemini-3.6-flash-high",
        "ag/gemini-3-flash-preview": "ag/gemini-3-flash",
        "ag/gemini-3.1-pro-preview": "ag/gemini-3.1-pro-high",
        "ag/gemini-3.1-flash-lite-preview": "ag/gemini-3.1-flash-lite",
        "ag/gemini-2.5-pro": "ag/gemini-3.1-pro-high",

        // Explicit Gemini API Key Gateway prefixed models (gm/... and gemini/...)
        "gm/gemini-2.5-flash": "gemini/gemini-2.5-flash",
        "gm/gemini-2.5-pro": "gemini/gemini-2.5-pro",
        "gm/gemini-2.5-flash-lite": "gemini/gemini-2.5-flash-lite",
        "gm/gemini-2.0-flash": "gemini/gemini-2.0-flash",
        "gm/gemini-3-flash": "gemini/gemini-3-flash-preview",
        "gm/gemini-3.1-pro": "gemini/gemini-3.1-pro-preview",
        "gm/gemini-3.8-flash": "gemini/gemini-2.5-flash",
        "gm/gemini-3.5-flash-lite": "gemini/gemini-2.5-flash-lite",
        "gemini/gemini-3-flash": "gemini/gemini-3-flash-preview",
        "gemini/gemini-1.5-flash": "gemini/gemini-2.5-flash",
        "gemini/gemini-1.5-pro": "gemini/gemini-2.5-pro",

        // Bare model names (Gmail / Antigravity Models + Gemini Gateway)
        "gemini-3.5-flash-lite": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.5-flash-lite",
        "gemini-3.5-flash-lite-high": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.5-flash-lite-high",
        "gemini-3.5-flash-lite-medium": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.5-flash-lite-medium",
        "gemini-3.5-flash-lite-low": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.5-flash-lite-low",
        "3.5-flash-lite": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.5-flash-lite",

        "gemini-3.8-flash": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash",
        "gemini-3.8-flash-high": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash-high",
        "gemini-3.8-flash-medium": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash-medium",
        "gemini-3.8-flash-low": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.8-flash-low",
        "gemini 3.8 flash low": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.8-flash-low",
        "Gemini 3.8 Flash Low": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.8-flash-low",
        "3.8-flash": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash",

        "gemini-3.1-pro": useGeminiPrimary ? "gemini/gemini-3.1-pro-preview" : "ag/gemini-3.1-pro-high",
        "gemini-3.1-pro-high": useGeminiPrimary ? "gemini/gemini-3.1-pro-preview" : "ag/gemini-3.1-pro-high",
        "gemini-3.1-pro-low": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.1-pro-low",
        "gemini-3.1-flash-lite": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.1-flash-lite",
        "3.1-pro": useGeminiPrimary ? "gemini/gemini-3.1-pro-preview" : "ag/gemini-3.1-pro-high",

        "gemini-4-argon": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-4-argon",
        "4-argon": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-4-argon",
        "gemini-4-carbon": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-4-carbon",
        "4-carbon": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-4-carbon",

        "gemini-3.6-flash": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.6-flash-high",
        "gemini-3.6-flash-high": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.6-flash-high",
        "gemini-3.6-flash-low": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-3.6-flash-low",
        "gemini-3-flash": useGeminiPrimary ? "gemini/gemini-3-flash-preview" : "ag/gemini-3-flash",
        "gemini-3-flash-preview": useGeminiPrimary ? "gemini/gemini-3-flash-preview" : "ag/gemini-3-flash",
        "gemini-2.5-flash": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-2.5-flash",
        "gemini-2.5-flash-lite": useGeminiPrimary ? "gemini/gemini-2.5-flash-lite" : "ag/gemini-2.5-flash-lite",
        "gemini-2.5-flash-thinking": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-2.5-flash-thinking",
        "gemini-2.5-pro": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-3.1-pro-high",
        "gemini-2.0-flash": useGeminiPrimary ? "gemini/gemini-2.0-flash" : "ag/gemini-3.8-flash",
        "gemini-1.5-flash": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash",
        "gemini-1.5-pro": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-3.1-pro-high",
        "claude-sonnet-4-6": "ag/claude-sonnet-4-6",
        "claude-opus-4-6-thinking": "ag/claude-opus-4-6-thinking",
        "claude-3-5-sonnet": "ag/claude-sonnet-4-6",
        "claude-3-7-sonnet": "ag/claude-sonnet-4-6",
        "gpt-oss-120b-medium": "ag/gpt-oss-120b-medium",
        "gpt-4o": useGeminiPrimary ? "gemini/gemini-2.5-pro" : "ag/gemini-3.8-flash-high",
        "gpt-4o-mini": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.5-flash-lite",
        "deepseek-chat": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash",
        "sastra-smart-pool": useGeminiPrimary ? "gemini/gemini-2.5-flash" : "ag/gemini-3.8-flash-high",
        "sastra-gemini-pool": "gemini/gemini-2.5-flash"
      };
      db.prepare("DELETE FROM kv WHERE scope = 'modelAliases'").run();
      const insKv = db.prepare("INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('modelAliases', ?, ?)");
      for (const [k, v] of Object.entries(defaultAliases)) {
        insKv.run(k, JSON.stringify(v));
      }

      // Clean and rebuild smart cross-provider combos when in Hybrid mode with both pools active
      db.prepare("DELETE FROM combos WHERE id LIKE 'sastra-combo-%'").run();
      if (activeGatewayMode === "hybrid" && agCount > 0 && gmCount > 0) {
        const nowIso = new Date().toISOString();
        const hybridCombos = {
          "sastra-smart-pool": ["ag/gemini-3.8-flash-high", "gemini/gemini-2.5-flash"],
          "gemini-3.5-flash-lite": ["ag/gemini-3.5-flash-lite", "gemini/gemini-2.5-flash-lite"],
          "gemini-3.5-flash-lite-high": ["ag/gemini-3.5-flash-lite-high", "gemini/gemini-2.5-flash"],
          "gemini-3.5-flash-lite-medium": ["ag/gemini-3.5-flash-lite-medium", "gemini/gemini-2.5-flash-lite"],
          "gemini-3.5-flash-lite-low": ["ag/gemini-3.5-flash-lite-low", "gemini/gemini-2.5-flash-lite"],
          "gemini-3.8-flash": ["ag/gemini-3.8-flash", "gemini/gemini-2.5-flash"],
          "gemini-3.8-flash-high": ["ag/gemini-3.8-flash-high", "gemini/gemini-2.5-flash"],
          "gemini-3.8-flash-medium": ["ag/gemini-3.8-flash-medium", "gemini/gemini-2.5-flash"],
          "gemini-3.8-flash-low": ["ag/gemini-3.8-flash-low", "gemini/gemini-2.5-flash-lite"],
          "gemini-3.1-pro": ["ag/gemini-3.1-pro-high", "gemini/gemini-3.1-pro-preview"],
          "gemini-3.1-pro-high": ["ag/gemini-3.1-pro-high", "gemini/gemini-3.1-pro-preview"],
          "gemini-3.1-pro-low": ["ag/gemini-3.1-pro-low", "gemini/gemini-2.5-flash"],
          "gemini-3.1-flash-lite": ["ag/gemini-3.1-flash-lite", "gemini/gemini-2.5-flash-lite"],
          "gemini-4-argon": ["ag/gemini-4-argon", "gemini/gemini-2.5-pro"],
          "gemini-4-carbon": ["ag/gemini-4-carbon", "gemini/gemini-2.5-pro"],
          "gemini-2.5-flash": ["ag/gemini-2.5-flash", "gemini/gemini-2.5-flash"],
          "gemini-2.5-pro": ["ag/gemini-3.1-pro-high", "gemini/gemini-2.5-pro"],
          "gemini-2.5-flash-lite": ["ag/gemini-2.5-flash-lite", "gemini/gemini-2.5-flash-lite"],
          "gemini-2.5-flash-thinking": ["ag/gemini-2.5-flash-thinking", "gemini/gemini-2.5-flash"],
          "gemini-2.0-flash": ["ag/gemini-3.8-flash", "gemini/gemini-2.0-flash"],
          "gemini-1.5-flash": ["ag/gemini-3.8-flash", "gemini/gemini-2.5-flash"],
          "gemini-1.5-pro": ["ag/gemini-3.1-pro-high", "gemini/gemini-2.5-pro"],
          "gemini-3-flash": ["ag/gemini-3-flash", "gemini/gemini-3-flash-preview"]
        };
        const insCombo = db.prepare(
          "INSERT OR REPLACE INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, 'fallback', ?, ?, ?)"
        );
        for (const [name, modelsArr] of Object.entries(hybridCombos)) {
          insCombo.run(`sastra-combo-${name}`, name, JSON.stringify(modelsArr), nowIso, nowIso);
        }
      }
    } catch (e) {}

    db.close();
  } catch (err) {
    console.error("[DB Init Error]:", err.message);
  }
}

ensureDatabaseReady();

const pendingOAuthStates = new Map();
const usageResponseCache = new Map();
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute server-side cache to block Quota Tracker auto-refresh bursts

// Cached Gateway Routing State for Gemini Web Chat Engine (refreshed every 1.5s)
let cachedGwState = { ts: 0, gatewayMode: "hybrid", agCount: 1, gmCount: 0, gwCount: 0 };
function getGatewayRoutingState() {
  const now = Date.now();
  if (now - cachedGwState.ts < 1500) return cachedGwState;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || "", "9router");
    const dbPath = path.join(dataDir, "db", "data.sqlite");
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      const sRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
      let gatewayMode = "hybrid";
      if (sRow && sRow.data) {
        try {
          const parsed = JSON.parse(sRow.data);
          if (parsed && parsed.gatewayMode) gatewayMode = parsed.gatewayMode;
        } catch (e) {}
      }
      const agRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'antigravity' AND isActive = 1").get();
      const gmRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'gemini' AND isActive = 1").get();
      const gwRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'gemini-web' AND isActive = 1").get();
      db.close();
      cachedGwState = {
        ts: now,
        gatewayMode,
        agCount: Number(agRow?.c || 0),
        gmCount: Number(gmRow?.c || 0),
        gwCount: Number(gwRow?.c || 0)
      };
    }
  } catch (e) {}
  return cachedGwState;
}

function extractPromptAndMeta(reqUrl, bodyObj) {
  let model = String(bodyObj?.model || "gemini-3.8-flash");
  const urlModelMatch = String(reqUrl || "").match(/\/models\/([^\/:?]+)/);
  if (urlModelMatch && urlModelMatch[1]) {
    model = decodeURIComponent(urlModelMatch[1]);
  }
  const isGeminiNative = String(reqUrl || "").includes("/v1beta/models/");
  const isAnthropic = String(reqUrl || "").startsWith("/v1/messages");
  const isStream = Boolean(bodyObj?.stream) || String(reqUrl || "").includes(":streamGenerateContent");

  const parts = [];
  let audio = null;

  // 1. OpenAI / Anthropic messages format
  if (Array.isArray(bodyObj?.messages)) {
    if (typeof bodyObj.system === "string" && bodyObj.system.trim()) {
      parts.push(`[System Instructions]:\n${bodyObj.system.trim()}`);
    } else if (Array.isArray(bodyObj.system)) {
      const sysTxt = bodyObj.system.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n").trim();
      if (sysTxt) parts.push(`[System Instructions]:\n${sysTxt}`);
    }
    const nonSystem = [];
    for (const msg of bodyObj.messages) {
      if (!msg) continue;
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textItems = [];
        for (const c of msg.content) {
          if (typeof c === "string") {
            textItems.push(c);
          } else if (c && typeof c === "object") {
            if (c.type === "input_audio" && c.input_audio?.data) {
              audio = {
                data: String(c.input_audio.data),
                format: String(c.input_audio.format || "wav").toLowerCase()
              };
            } else if ((c.inlineData || c.inline_data) && (c.inlineData?.data || c.inline_data?.data)) {
              const inl = c.inlineData || c.inline_data;
              const mime = String(inl.mimeType || inl.mime_type || "audio/wav").toLowerCase();
              if (mime.startsWith("audio/")) {
                audio = {
                  data: String(inl.data),
                  format: mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "wav"
                };
              }
            }
            const t = c.text || c.input_text || c.content || "";
            if (typeof t === "string" && t) textItems.push(t);
          }
        }
        text = textItems.join("\n");
      }
      if (!text.trim()) continue;
      if (msg.role === "system" || msg.role === "developer") {
        parts.push(`[System Instructions]:\n${text.trim()}`);
      } else {
        nonSystem.push({ role: msg.role || "user", text: text.trim() });
      }
    }
    if (nonSystem.length === 1) {
      parts.push(nonSystem[0].text);
    } else if (nonSystem.length > 1) {
      for (const m of nonSystem) {
        parts.push(m.role === "assistant" ? `[Assistant]:\n${m.text}` : `${m.text}`);
      }
    }
  }

  // 2. Native Gemini contents + systemInstruction format
  if (Array.isArray(bodyObj?.contents)) {
    const sysInst = bodyObj.systemInstruction || bodyObj.system_instruction;
    if (sysInst && Array.isArray(sysInst.parts)) {
      const sysTxt = sysInst.parts.map((p) => p?.text || "").join("\n").trim();
      if (sysTxt) parts.push(`[System Instructions]:\n${sysTxt}`);
    }
    for (const c of bodyObj.contents) {
      if (c && Array.isArray(c.parts)) {
        for (const p of c.parts) {
          const inl = p?.inlineData || p?.inline_data;
          if (inl && inl.data && String(inl.mimeType || inl.mime_type || "").toLowerCase().startsWith("audio/")) {
            const mime = String(inl.mimeType || inl.mime_type || "audio/wav").toLowerCase();
            audio = {
              data: String(inl.data),
              format: mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "wav"
            };
          }
        }
        const t = c.parts.map((p) => p?.text || "").join("\n").trim();
        if (t) parts.push(t);
      }
    }
  }

  // 3. Plain prompt / input format
  if (parts.length === 0) {
    if (typeof bodyObj?.prompt === "string") parts.push(bodyObj.prompt);
    else if (typeof bodyObj?.input === "string") parts.push(bodyObj.input);
  }

  return {
    prompt: parts.join("\n\n").trim(),
    model: model.replace(/^(?:gweb|web|gemini-web)\//i, ""),
    audio,
    isGeminiNative,
    isAnthropic,
    isStream
  };
}

function extractCleanJson(text) {
  if (!text) return text;
  const str = String(text).trim();
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = str.match(codeBlockRegex);
  if (match && match[1]) {
    const inner = match[1].trim();
    if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) {
      return inner;
    }
  }
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = str.slice(firstBrace, lastBrace + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (e) {}
  }
  return str;
}

async function transcribeAudioMultimodal(prompt, audio) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || "", "9router");
    const dbPath = path.join(dataDir, "db", "data.sqlite");
    if (!fs.existsSync(dbPath)) return null;

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, provider, email, isActive, data FROM providerConnections WHERE provider IN ('antigravity', 'gemini-cli', 'gemini') ORDER BY priority ASC, createdAt DESC").all();
    db.close();

    for (const r of rows) {
      const d = JSON.parse(r.data || "{}");
      if (d.errorCode === 403) continue;

      // 1. Direct Gemini API Key
      if (r.provider === "gemini" && d.apiKey) {
        try {
          const mime = audio.format === "mp3" ? "audio/mp3" : "audio/wav";
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(d.apiKey)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inlineData: { mimeType: mime, data: audio.data } }
                ]
              }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
              }
            }),
            signal: AbortSignal.timeout(60000)
          });
          if (res.ok) {
            const j = await res.json();
            const textOut = j?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
            if (textOut) {
              return { ok: true, text: textOut, email: r.email || r.name };
            }
          }
        } catch (e) {}
      }

      // 2. OAuth Google Account (Antigravity or Gemini CLI)
      if (d.refreshToken) {
        const clientId = r.provider === "gemini-cli"
          ? "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
          : "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
        const clientSecret = r.provider === "gemini-cli"
          ? "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"
          : "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";

        let token = d.accessToken;
        try {
          const tr = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: d.refreshToken,
              client_id: clientId,
              client_secret: clientSecret
            }),
            signal: AbortSignal.timeout(8000)
          });
          if (tr.ok) {
            const tj = await tr.json();
            if (tj.access_token) token = tj.access_token;
          }
        } catch (e) {}

        if (!token) continue;

        const endpoint = r.provider === "gemini-cli"
          ? "https://cloudcode-pa.googleapis.com/v1internal:generateContent"
          : "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent";

        const mime = audio.format === "mp3" ? "audio/mp3" : "audio/wav";

        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
              "User-Agent": r.provider === "gemini-cli" ? "gemini-cli/0.1.0" : "antigravity/1.104.0 win32/x64"
            },
            body: JSON.stringify({
              project: d.projectId || "aicode-consumers",
              model: r.provider === "gemini-cli" ? "gemini-2.5-flash" : "gemini-3-flash",
              userAgent: r.provider === "gemini-cli" ? "gemini-cli" : "antigravity",
              requestId: "agent-" + crypto.randomUUID(),
              request: {
                sessionId: crypto.randomUUID(),
                contents: [
                  {
                    role: "user",
                    parts: [
                      { text: prompt },
                      { inlineData: { mimeType: mime, data: audio.data } }
                    ]
                  }
                ],
                generationConfig: {
                  temperature: 0.1,
                  responseMimeType: "application/json"
                }
              }
            }),
            signal: AbortSignal.timeout(60000)
          });

          if (!res.ok) continue;
          const j = await res.json();
          const parts = j?.response?.candidates?.[0]?.content?.parts || j?.candidates?.[0]?.content?.parts || [];
          const textOut = parts.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("").trim();
          if (textOut) {
            return { ok: true, text: textOut, email: r.email || r.provider };
          }
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error("[transcribeAudioMultimodal Error]:", err.message);
  }
  return null;
}

function handleGeminiWebRequest(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
  req.on("end", async () => {
    let bodyObj = {};
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) bodyObj = JSON.parse(raw);
    } catch (e) {}

    const { prompt, model, audio, isGeminiNative, isAnthropic, isStream } = extractPromptAndMeta(req.url, bodyObj);
    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: "Empty prompt in Gemini Web request", type: "invalid_request_error" } }));
      return;
    }

    // MULTIMODAL AUDIO TRANSCRIPTION:
    // If request contains audio data, process via multimodal account pool so SastraAI gets real timed segments
    if (audio && audio.data) {
      console.log("[Multimodal Audio] Detected audio attachment in request. Transcribing via account pool...");
      const audioResult = await transcribeAudioMultimodal(prompt, audio);
      if (audioResult && audioResult.ok && audioResult.text) {
        const replyText = extractCleanJson(audioResult.text);
        const promptTokens = Math.max(1, Math.round(prompt.length / 4));
        const completionTokens = Math.max(1, Math.round(replyText.length / 4));
        const created = Math.floor(Date.now() / 1000);
        const msgId = "chatcmpl-audio-" + crypto.randomBytes(8).toString("hex");

        if (isGeminiNative) {
          const geminiPayload = {
            candidates: [
              {
                content: { parts: [{ text: replyText }], role: "model" },
                finishReason: "STOP",
                index: 0
              }
            ],
            usageMetadata: {
              promptTokenCount: promptTokens,
              candidatesTokenCount: completionTokens,
              totalTokenCount: promptTokens + completionTokens
            },
            modelVersion: model
          };
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(geminiPayload));
          return;
        }

        const openAiPayload = {
          id: msgId,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: replyText },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          }
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(openAiPayload));
        return;
      }
    }

    const requireJson = ["json_schema", "json_object"].includes(bodyObj?.response_format?.type) ||
      bodyObj?.generationConfig?.responseMimeType === "application/json" ||
      bodyObj?.generation_config?.response_mime_type === "application/json";
    const payload = JSON.stringify({ prompt, model, requireJson, ...(audio ? { audio } : {}) });
    const bridgePort = Number(process.env.GEMINI_WEB_BRIDGE_PORT) || 20129;

    const bReq = http.request(
      {
        hostname: "127.0.0.1",
        port: bridgePort,
        path: "/gemini-web/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 190000
      },
      (bRes) => {
        let bData = "";
        bRes.on("data", (d) => (bData += d.toString("utf8")));
        bRes.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(bData);
          } catch (e) {}

          if (bRes.statusCode !== 200 || !parsed || !parsed.ok) {
            const errMsg =
              parsed?.error ||
              "Gemini Web Chat មិនទាន់បានភ្ជាប់គណនី Gmail ទេ។ សូមចុចប៊ូតុង '🌐 + Gemini Web' នៅលើ SastraGetWay ដើម្បី Login Gmail ជាមុនសិន។";
            res.writeHead(bRes.statusCode && bRes.statusCode !== 200 ? bRes.statusCode : 502, {
              "Content-Type": "application/json; charset=utf-8"
            });
            res.end(
              JSON.stringify({
                error: {
                  message: errMsg,
                  type: "gemini_web_error",
                  code: "gemini_web_unavailable"
                }
              })
            );
            return;
          }

          const rawReply = String(parsed.text || "");
          const replyText = extractCleanJson(rawReply);
          const promptTokens = Math.max(1, Math.round(prompt.length / 4));
          const completionTokens = Math.max(1, Math.round(replyText.length / 4));
          const created = Math.floor(Date.now() / 1000);
          const msgId = "chatcmpl-gweb-" + crypto.randomBytes(8).toString("hex");

          if (isGeminiNative) {
            const geminiPayload = {
              candidates: [
                {
                  content: {
                    parts: [{ text: replyText }],
                    role: "model"
                  },
                  finishReason: "STOP",
                  index: 0
                }
              ],
              usageMetadata: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: completionTokens,
                totalTokenCount: promptTokens + completionTokens
              },
              modelVersion: model
            };
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(geminiPayload));
            return;
          }

          if (isAnthropic) {
            const anthPayload = {
              id: "msg_" + crypto.randomBytes(8).toString("hex"),
              type: "message",
              role: "assistant",
              model,
              content: [{ type: "text", text: replyText }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: promptTokens, output_tokens: completionTokens }
            };
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(anthPayload));
            return;
          }

          if (isStream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive"
            });
            const chunkSize = 120;
            for (let i = 0; i < replyText.length; i += chunkSize) {
              const piece = replyText.slice(i, i + chunkSize);
              const chunkObj = {
                id: msgId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: i === 0 ? { role: "assistant", content: piece } : { content: piece },
                    finish_reason: null
                  }
                ]
              };
              res.write(`data: ${JSON.stringify(chunkObj)}\n\n`);
            }
            const finalChunk = {
              id: msgId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens
              }
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          const openaiPayload = {
            id: msgId,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: replyText
                },
                finish_reason: "stop"
              }
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens
            }
          };
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(openaiPayload));
        });
      }
    );

    bReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: {
            message: "Gemini Web Bridge connection error: " + err.message,
            type: "gemini_web_bridge_error"
          }
        })
      );
    });
    bReq.write(payload);
    bReq.end();
  });
}

let cachedLocalAuthCookie = "";
function refreshLocalAuthCookie() {
  const targetPort = Number(process.env.PORT) || 20128;
  const postData = JSON.stringify({ password: process.env.INITIAL_PASSWORD || "123456" });
  const req = http.request({
    hostname: "127.0.0.1",
    port: targetPort,
    path: "/api/auth/login",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    }
  }, (res) => {
    const setCookie = res.headers["set-cookie"];
    if (setCookie) {
      const full = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
      const match = full.match(/auth_token=([^;]+)/);
      if (match) {
        cachedLocalAuthCookie = `auth_token=${match[1]}`;
      }
    }
  });
  req.on("error", () => {});
  req.write(postData);
  req.end();
}

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    // 0. Universal CORS headers & OPTIONS preflight for browser/extension/desktop AI tools
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-version, OpenAI-Beta, *");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Normalize common API endpoints if tool configured Base URL without /v1 or with /v1/v1beta
    if (req.url) {
      if (req.url.startsWith("/v1/v1beta/")) {
        req.url = req.url.slice(3);
      }
      const geminiActionMatch = req.url.match(/^\/(?:v1\/)?models\/(.+:(?:generateContent|streamGenerateContent|countTokens).*)$/i);
      if (geminiActionMatch) {
        req.url = "/v1beta/models/" + geminiActionMatch[1];
      } else if (
        req.url.startsWith("/chat/completions") ||
        req.url.startsWith("/completions") ||
        req.url.startsWith("/models") ||
        req.url.startsWith("/messages") ||
        req.url.startsWith("/responses") ||
        req.url.startsWith("/embeddings")
      ) {
        req.url = "/v1" + req.url;
      }
      // Ensure API requests always have a valid Bearer token if none was provided
      if (req.url.startsWith("/v1/") || req.url.startsWith("/v1beta/") || req.url.startsWith("/api/v1")) {
        if (!req.headers["authorization"] && !req.headers["x-api-key"] && !req.headers["x-goog-api-key"]) {
          req.headers["authorization"] = "Bearer sk-sastra";
        }
        // Default Accept to application/json when client sends */* so non-streaming requests return JSON instead of SSE
        if (!req.headers["accept"] || req.headers["accept"] === "*/*") {
          req.headers["accept"] = "application/json";
        }
      }

      // Real-Time In-Flight Telemetry Emitter for SastraGetWay Live Telemetry UI
      const isAiCompletionReq =
        req.method === "POST" &&
        (req.url.startsWith("/v1/chat/completions") ||
          req.url.startsWith("/v1/completions") ||
          req.url.startsWith("/v1/messages") ||
          req.url.startsWith("/v1/responses") ||
          req.url.startsWith("/v1beta/models/"));

      if (isAiCompletionReq) {
        const reqId = crypto.randomUUID();
        const startTime = Date.now();
        let detectedModel = "";
        const urlModelMatch = req.url.match(/\/models\/([^\/:?]+)/);
        if (urlModelMatch && urlModelMatch[1]) {
          detectedModel = urlModelMatch[1];
        }

        console.log(
          "[SASTRA_TELEMETRY]" +
            JSON.stringify({
              type: "start",
              reqId,
              timestamp: new Date(startTime).toISOString(),
              endpoint: req.url,
              model: detectedModel || "gemini-3.8-flash"
            })
        );

        let reqBuf = "";
        const origReqEmit = req.emit.bind(req);
        req.emit = function (ev, ...evArgs) {
          if (ev === "data" && evArgs[0] && reqBuf.length < 6000) {
            try {
              reqBuf += Buffer.isBuffer(evArgs[0]) ? evArgs[0].toString("utf8") : String(evArgs[0]);
              if (!detectedModel) {
                const mMatch = reqBuf.match(/"model"\s*:\s*"([^"]+)"/);
                if (mMatch && mMatch[1]) {
                  detectedModel = mMatch[1];
                  console.log(
                    "[SASTRA_TELEMETRY]" +
                      JSON.stringify({
                        type: "model",
                        reqId,
                        model: detectedModel
                      })
                  );
                }
              }
            } catch (e) {}
          }
          return origReqEmit(ev, ...evArgs);
        };

        let streamedBytes = 0;
        let chunkCount = 0;
        let lastProgressAt = 0;
        let ended = false;
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        res.write = function (chunk, ...wArgs) {
          if (chunk) {
            const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
            streamedBytes += len;
            chunkCount++;
            const now = Date.now();
            if (now - lastProgressAt >= 160) {
              lastProgressAt = now;
              console.log(
                "[SASTRA_TELEMETRY]" +
                  JSON.stringify({
                    type: "progress",
                    reqId,
                    model: detectedModel || "gemini-3.8-flash",
                    chunks: chunkCount,
                    estTokens: Math.max(1, Math.round(streamedBytes / 14)),
                    elapsedMs: now - startTime
                  })
              );
            }
          }
          return origWrite(chunk, ...wArgs);
        };

        const finishTelemetry = () => {
          if (ended) return;
          ended = true;
          console.log(
            "[SASTRA_TELEMETRY]" +
              JSON.stringify({
                type: "end",
                reqId,
                model: detectedModel || "gemini-3.8-flash",
                statusCode: res.statusCode || 200,
                elapsedMs: Date.now() - startTime
              })
          );
        };

        res.end = function (chunk, ...eArgs) {
          if (chunk) {
            const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
            streamedBytes += len;
          }
          const r = origEnd(chunk, ...eArgs);
          setTimeout(finishTelemetry, 180);
          return r;
        };

        res.once("close", () => setTimeout(finishTelemetry, 180));
      }
    }

    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;

    // Auto-authenticate localhost requests so users & oauth flow never get 401 Unauthorized
    if (isLoopbackProxy && cachedLocalAuthCookie) {
      if (!req.headers["cookie"]) {
        req.headers["cookie"] = cachedLocalAuthCookie;
      } else if (!req.headers["cookie"].includes("auth_token=")) {
        req.headers["cookie"] += `; ${cachedLocalAuthCookie}`;
      }
    }

    // 0.9 Intercept GET /api/usage/:id to cache quota checks for 5 minutes and prevent Quota Tracker auto-refresh from banning accounts
    const usageMatch = req.method === "GET" && req.url && req.url.match(/^\/api\/usage\/([^\/\?]+)/);
    if (usageMatch) {
      const connId = usageMatch[1];
      const cached = usageResponseCache.get(connId);
      if (cached && Date.now() - cached.timestamp < USAGE_CACHE_TTL_MS) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(cached.body);
        return;
      }
      let usageBody = "";
      const origUsageWrite = res.write;
      const origUsageEnd = res.end;
      res.write = function (chunk, ...args) {
        if (chunk) usageBody += chunk.toString();
        return origUsageWrite.call(this, chunk, ...args);
      };
      res.end = function (chunk, ...args) {
        if (chunk) usageBody += chunk.toString();
        if (res.statusCode === 200 && usageBody && usageBody.includes("quotas")) {
          usageResponseCache.set(connId, { timestamp: Date.now(), body: usageBody });
        }
        return origUsageEnd.call(this, chunk, ...args);
      };
    }

    // 1. Intercept /api/oauth/:provider/authorize to capture codeVerifier & state
    const authMatch = req.url && req.url.match(/\/api\/oauth\/([^\/\?]+)\/authorize/);
    if (authMatch) {
      const provider = authMatch[1];
      let authBody = "";
      const origResWrite = res.write;
      const origResEnd = res.end;
      res.write = function (chunk, ...args) {
        if (chunk) authBody += chunk.toString();
        return origResWrite.call(this, chunk, ...args);
      };
      res.end = function (chunk, ...args) {
        if (chunk) authBody += chunk.toString();
        try {
          const json = JSON.parse(authBody);
          if (json.state && json.codeVerifier) {
            pendingOAuthStates.set(json.state, {
              provider,
              codeVerifier: json.codeVerifier,
              redirectUri: json.redirectUri || "http://localhost:20128/callback",
              timestamp: Date.now()
            });
            console.log(`[OAuth Intercept] Stored session for ${provider}, state: ${json.state}`);
          }
        } catch (e) {}
        return origResEnd.call(this, chunk, ...args);
      };
    }

    // 2. Intercept GET /callback?code=... from Google and automatically perform exchange
    if (req.url && (req.url.startsWith("/callback?") || (req.url.includes("/callback") && req.url.includes("code=")))) {
      try {
        const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1:20128"}`);
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        if (code && state) {
          let session = pendingOAuthStates.get(state);

          // Read directly from SastraGetWay_Data pending_oauth.json written by Electron main process
          const sessionPath = path.join(process.env.APPDATA || "", "SastraGetWay_Data", "pending_oauth.json");
          if (fs.existsSync(sessionPath)) {
            try {
              const fileData = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
              if (fileData && fileData.codeVerifier) {
                session = fileData;
                console.log("[OAuth Read Session] Found codeVerifier from pending_oauth.json (length: " + fileData.codeVerifier.length + ")");
              }
            } catch (e) {}
          }

          if (!session && pendingOAuthStates.size > 0) {
            for (const [s, data] of pendingOAuthStates.entries()) {
              if (Date.now() - data.timestamp < 15 * 60 * 1000) {
                session = data;
                break;
              }
            }
          }

          const provider = session ? session.provider : "antigravity";
          const codeVerifier = session ? session.codeVerifier : null;
          const redirectUri = session ? session.redirectUri : "http://localhost:20128/callback";

          console.log(`[OAuth Intercept] Got code for ${provider}. codeVerifier present: ${!!codeVerifier}. Exchanging...`);

          const exchangePayload = JSON.stringify({
            code,
            state,
            redirectUri,
            ...(codeVerifier ? { codeVerifier } : {})
          });

          const targetPort = Number(process.env.PORT) || 20128;
          const exReq = http.request({
            hostname: "127.0.0.1",
            port: targetPort,
            path: `/api/oauth/${provider}/exchange`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(exchangePayload),
              ...(cachedLocalAuthCookie ? { "Cookie": cachedLocalAuthCookie } : {})
            }
          }, (exRes) => {
            let exBody = "";
            exRes.on("data", c => exBody += c);
            exRes.on("end", () => {
              console.log(`[OAuth Exchange Complete] HTTP ${exRes.statusCode}:`, exBody);
              if (state) pendingOAuthStates.delete(state);
              ensureDatabaseReady();
              let emailText = "";
              try {
                const parsed = JSON.parse(exBody);
                emailText = parsed?.connection?.email || parsed?.email || "";
              } catch (e) {}
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>SastraGetWay — Gmail Connected</title></head><body style="background:#060814;color:#f8fafc;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:rgba(15,20,40,0.9);border:1px solid rgba(6,182,212,0.4);border-radius:20px;padding:36px 48px;text-align:center;box-shadow:0 0 50px rgba(168,85,247,0.3);max-width:460px;"><h2 style="margin:0 0 12px;color:#38bdf8;font-size:22px;">Gmail Connected Successfully</h2><p style="margin:0 0 20px;color:#cbd5e1;font-size:14px;">${emailText ? `Account <b>${emailText}</b> is now active in your SastraGetWay Account Pool.` : "Your Google account has been added to SastraGetWay Account Pool."}</p><p style="margin:0;color:#94a3b8;font-size:12px;">You can close this browser tab and return to the SastraGetWay application.</p><script>setTimeout(()=>window.close(),2500);</script></div></body></html>`);
            });
          });
          exReq.on("error", err => {
            console.error("[OAuth Exchange Request Error]:", err.message);
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OAuth Exchange Error: " + err.message);
          });
          exReq.write(exchangePayload);
          exReq.end();
          return;
        }
      } catch (err) {
        console.error("[OAuth Intercept Callback Error]:", err.message);
      }
    }

    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";

    // 3. Intercept AI completion requests for Gemini Web Chat Engine (gemini.google.com/app)
    const isCompletionPost =
      req.method === "POST" &&
      req.url &&
      (req.url.startsWith("/v1/chat/completions") ||
        req.url.startsWith("/v1/completions") ||
        req.url.startsWith("/v1/messages") ||
        req.url.startsWith("/v1/responses") ||
        req.url.startsWith("/v1beta/models/"));

    if (isCompletionPost) {
      if (req.headers["x-sastra-bypass-gweb"] === "1") {
        return handler(req, res);
      }
      const gwState = getGatewayRoutingState();
      const urlHasGweb = /\/models\/(?:gweb|web|gemini-web)(?:\/|%2F)/i.test(req.url);
      if (
        urlHasGweb ||
        gwState.gatewayMode === "gemini-web" ||
        (gwState.gatewayMode === "hybrid" && gwState.agCount === 0 && gwState.gmCount === 0 && gwState.gwCount > 0)
      ) {
        handleGeminiWebRequest(req, res);
        return;
      }

      // Peek first chunk to support explicit "model": "gweb/..." even when in Hybrid/Antigravity/Gemini mode
      req.once("readable", () => {
        const chunk = req.read();
        if (chunk) {
          const preview = chunk.toString("utf8", 0, Math.min(chunk.length, 4096));
          if (/"model"\s*:\s*"(?:gweb|web|gemini-web)\//i.test(preview)) {
            req.unshift(chunk);
            handleGeminiWebRequest(req, res);
            return;
          }
          req.unshift(chunk);
        }
        handler(req, res);
      });
      return;
    }

    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
    setTimeout(refreshLocalAuthCookie, 1000);
    setInterval(refreshLocalAuthCookie, 6 * 3600 * 1000);
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
