const { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execSync } = require('child_process');
const sqlite = require('node:sqlite');

// 1. Isolate User Data Directory to prevent SingletonLock collisions
app.name = 'DIGITALIKH GETWAY';
if (process.platform === 'win32') {
  app.setAppUserModelId('com.sastraai.sastragetway');
}
const userDataPath = path.join(app.getPath('appData'), 'SastraGetWay_Data');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

// 1.5 Cloud Gmail Account + License Key + Single-Device Auto-Logout (Hardware AES-256-GCM)
const licenseManager = require('./license/license-manager');
let lastAuthNoticeStatus = null;

function getMachineId() {
  const mid = licenseManager.getMachineId();
  return String(mid || '').replace(/^SASTRA-/, 'DIGITALIKH-');
}

function getLicenseStatus() {
  const status = licenseManager.getLocalLicenseStatusSync();
  if (status && status.machineId) {
    status.machineId = String(status.machineId).replace(/^SASTRA-/, 'DIGITALIKH-');
  }
  if (!status.valid && lastAuthNoticeStatus) {
    return {
      ...status,
      ...lastAuthNoticeStatus,
      valid: false
    };
  }
  return status;
}

function getAssetPath(filename) {
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', filename),
    path.join(process.resourcesPath || '', 'assets', filename),
    path.join(process.resourcesPath || '', 'engine', 'app', filename),
    path.join(__dirname, 'assets', filename),
    path.join(__dirname, 'engine', 'app', filename)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, 'assets', filename);
}

const PORT = 20128;
const HOST = '127.0.0.1';
const SERVER_URL = `http://${HOST}:${PORT}`;

let mainWindow = null;
let activateWindow = null;
let heartbeatTimer = null;
let tray = null;
let engineProcess = null;
let isQuitting = false;

// 2. Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  const targetWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : activateWindow;
  if (targetWin && !targetWin.isDestroyed()) {
    if (targetWin.isMinimized()) targetWin.restore();
    targetWin.show();
    targetWin.focus();
  }
});

// Helper to ensure database, accounts, settings, and sk-sastra are ready for immediate usage
function ensureDefaultApiKey() {
  const dbDir = path.join(app.getPath('appData'), '9router', 'db');
  const dbPath = path.join(dbDir, 'data.sqlite');
  const seedPath = getAssetPath('seed-data.sqlite');

  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    if (!fs.existsSync(dbPath) && fs.existsSync(seedPath)) {
      fs.copyFileSync(seedPath, dbPath);
      console.log('[DB Seed] Initialized fresh database from:', seedPath);
    }
  } catch (e) {
    console.error('[DB Seed Copy Error]:', e.message);
  }

  if (!fs.existsSync(dbPath)) return;
  try {
    const db = new sqlite.DatabaseSync(dbPath);

    // Ensure settings has requireApiKey: false, requireLogin: false, and safe anti-ban defaults
    try {
      const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      let sData = {};
      if (sRow && sRow.data) {
        try { sData = JSON.parse(sRow.data); } catch (e) { }
      }
      const needsInitStrategy = !sData.providerStrategies || !sData.providerStrategies.antigravity || sData.providerStrategies.antigravity.stickyRoundRobinLimit === 1;
      if (
        sData.requireApiKey !== false ||
        sData.requireLogin !== false ||
        needsInitStrategy
      ) {
        sData.requireApiKey = false;
        sData.requireLogin = false;
        sData.password = null;
        sData.stickyRoundRobinLimit = 20;
        if (!sData.providerStrategies || typeof sData.providerStrategies !== 'object') {
          sData.providerStrategies = {};
        }
        sData.providerStrategies.antigravity = {
          ...(sData.providerStrategies.antigravity || {}),
          fallbackStrategy: 'fill-first',
          stickyRoundRobinLimit: 20
        };
        db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
          JSON.stringify(sData)
        );
      }
    } catch (e) { }

    // Sanitize antigravity accounts: ensure projectId is a valid string ("aicode-consumers") and disable 403 suspended/unverified accounts
    try {
      const agRows = db.prepare("SELECT id, isActive, data FROM providerConnections WHERE provider = 'antigravity'").all();
      for (const r of agRows) {
        const d = JSON.parse(r.data || '{}');
        let changed = false;
        let nextActive = r.isActive;
        const lastErrStr = String(d.lastError || '');
        if (
          d.errorCode === 403 ||
          lastErrStr.includes('403') ||
          lastErrStr.toLowerCase().includes('disabled in this account') ||
          lastErrStr.toLowerCase().includes('verify your account')
        ) {
          nextActive = 0;
        }
        const rawProj = d.projectId;
        let cleanProj = 'aicode-consumers';
        if (typeof rawProj === 'string') {
          const s = rawProj.trim();
          if (s && s !== '[object Object]' && !s.startsWith('{')) {
            cleanProj = s;
          }
        } else if (rawProj && typeof rawProj === 'object' && typeof rawProj.id === 'string' && rawProj.id.trim()) {
          cleanProj = rawProj.id.trim();
        }
        if (d.projectId !== cleanProj) {
          d.projectId = cleanProj;
          changed = true;
        }
        if (
          d.errorCode === 400 ||
          d.errorCode === 404 ||
          lastErrStr.includes('Starting an object on a scalar field') ||
          lastErrStr.includes('Requested entity was not found')
        ) {
          delete d.errorCode;
          delete d.lastError;
          delete d.lastErrorAt;
          d.testStatus = 'active';
          for (const k of Object.keys(d)) {
            if (k.startsWith('modelLock_')) delete d[k];
          }
          changed = true;
        }
        if (changed || nextActive !== r.isActive) {
          db.prepare('UPDATE providerConnections SET isActive = ?, data = ? WHERE id = ?').run(nextActive, JSON.stringify(d), r.id);
        }
      }
    } catch (e) { }

    const existing = db.prepare('SELECT * FROM apiKeys WHERE key = ?').get('sk-sastra');
    if (!existing) {
      const crypto = require('crypto');
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, 'sk-sastra', 'Sastra Default Key', 'sastra-master', 1, new Date().toISOString()
      );
      console.log('[API Key] Ensured sk-sastra exists in database.');
    }

    const existingLs = db.prepare('SELECT * FROM apiKeys WHERE key = ?').get('ls-digitalikh');
    if (!existingLs) {
      const crypto = require('crypto');
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, 'ls-digitalikh', 'Digitalikh Universal Key', 'digitalikh-master', 1, new Date().toISOString()
      );
      console.log('[API Key] Ensured ls-digitalikh exists in database.');
    } else if (!existingLs.isActive) {
      db.prepare("UPDATE apiKeys SET isActive = 1 WHERE key = 'ls-digitalikh'").run();
    }
    db.close();
  } catch (e) {
    console.error('[API Key Error]:', e.message);
  }
}

// 3. Live Quota and Telemetry Caching (5-minute anti-burst cache for upstream Google Quota API)
let quotaCache = {
  timestamp: 0,
  data: null,
  refreshing: false
};
let UPSTREAM_QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

function formatRemainingTime(resetAt) {
  if (!resetAt) return null;
  const now = Date.now();
  const target = typeof resetAt === 'number' ? resetAt : new Date(resetAt).getTime();
  const diffMs = target - now;
  if (diffMs <= 0) return 'Ready';

  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function parseErrorReset(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.match(/Resets in (\d+)h(?:(\d+)m)?/i);
  if (match) {
    const totalH = parseInt(match[1], 10);
    const mins = parseInt(match[2] || '0', 10);
    const d = Math.floor(totalH / 24);
    const h = totalH % 24;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${mins}m`;
    return `${mins}m`;
  }
  return null;
}

async function fetchLiveQuotaStats() {
  const now = Date.now();
  if (quotaCache.refreshing) {
    return quotaCache.data || {
      todayTokens: 0,
      todayRequests: 0,
      allTimeTokens: 0,
      allTimeRequests: 0,
      allTimeCost: "0.00",
      poolUsed: 0,
      poolTotal: 0,
      usagePercent: "0.0",
      remainingPercent: "100.0",
      accountQuotas: {}
    };
  }
  if (quotaCache.data && (now - quotaCache.timestamp < UPSTREAM_QUOTA_CACHE_TTL_MS)) {
    return quotaCache.data;
  }
  quotaCache.refreshing = true;
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) {
    return {
      todayTokens: 0,
      todayRequests: 0,
      allTimeTokens: 0,
      allTimeRequests: 0,
      allTimeCost: "0.00",
      poolUsed: 0,
      poolTotal: 0,
      usagePercent: "0.0",
      remainingPercent: "100.0",
      accountQuotas: {}
    };
  }

  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const allTime = db.prepare(`
      SELECT 
        COUNT(*) AS totalRequests,
        COALESCE(SUM(promptTokens), 0) AS promptTokens,
        COALESCE(SUM(completionTokens), 0) AS completionTokens,
        COALESCE(SUM(cost), 0) AS totalCost
      FROM usageHistory
    `).get() || { totalRequests: 0, promptTokens: 0, completionTokens: 0, totalCost: 0 };

    const allTimeTokens = (allTime.promptTokens || 0) + (allTime.completionTokens || 0);

    const todayKey = new Date().toISOString().slice(0, 10);
    const todayRow = db.prepare('SELECT data FROM usageDaily WHERE dateKey = ?').get(todayKey);
    let todayTokens = 0;
    let todayRequests = 0;
    if (todayRow && todayRow.data) {
      try {
        const parsed = JSON.parse(todayRow.data);
        todayRequests = parsed.requests || 0;
        todayTokens = (parsed.promptTokens || 0) + (parsed.completionTokens || 0);
      } catch (e) { }
    }

    // If upstream Google quota cache is fresh (within 5 minutes) or currently refreshing, return cached quotas with fresh local SQLite token counts
    if (quotaCache.data && ((now - quotaCache.timestamp < UPSTREAM_QUOTA_CACHE_TTL_MS) || quotaCache.refreshing)) {
      db.close();
      const merged = {
        ...quotaCache.data,
        todayTokens,
        todayRequests,
        allTimeTokens,
        allTimeRequests: allTime.totalRequests || 0,
        allTimeCost: (allTime.totalCost || 0).toFixed(2)
      };
      quotaCache.data = merged;
      return merged;
    }

    const antigravityRows = db.prepare("SELECT id, name, isActive, data FROM providerConnections WHERE provider = 'antigravity'").all();
    db.close();

    quotaCache.refreshing = true;
    let authCookie = "";
    try {
      const loginRes = await fetch(`http://${HOST}:${PORT}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '123456' }),
        signal: AbortSignal.timeout(1200)
      });
      const setCookie = loginRes.headers.get('set-cookie');
      if (setCookie) {
        authCookie = setCookie.split(';')[0];
      }
    } catch (e) { }

    let poolUsed = 0;
    let poolTotal = 0;
    const accountQuotas = { ...(quotaCache.data?.accountQuotas || {}) };

    // Sequential staggered polling (never Promise.all) to prevent multi-account burst bans from Google Cloud
    for (const r of antigravityRows) {
      let isSuspended = !r.isActive;
      try {
        const d = JSON.parse(r.data || '{}');
        if (
          d.errorCode === 403 ||
          (d.lastError && (String(d.lastError).includes('403') || String(d.lastError).toLowerCase().includes('disabled in this account')))
        ) {
          isSuspended = true;
        }
      } catch (e) { }
      if (isSuspended) continue;

      try {
        const headers = authCookie ? { Cookie: authCookie } : {};
        const res = await fetch(`http://${HOST}:${PORT}/api/usage/` + r.id, { headers, signal: AbortSignal.timeout(2000) });
        const data = await res.json();
        if (data && data.quotas) {
          const quotaValues = Object.values(data.quotas);
          let q = quotaValues.find(item => item.remainingPercentage === 0)
            || data.quotas['gemini-3.8-flash-high']
            || data.quotas['gemini_weekly']
            || data.quotas['gemini_session']
            || quotaValues[0];

          if (q) {
            const used = Math.round(q.used || 0);
            const total = Math.round(q.total || 1000);
            const remainingPct = typeof q.remainingPercentage === 'number' ? Math.round(q.remainingPercentage) : Math.round(((total - used) / total) * 100);
            const resetAt = q.resetAt || null;
            const resetTime = formatRemainingTime(resetAt);
            accountQuotas[r.id] = { used, total, remainingPct, resetAt, resetTime, displayName: q.displayName };
            poolUsed += used;
            poolTotal += total;
          }
        }
      } catch (e) { }
      // Stagger 650ms between accounts so Google never sees simultaneous multi-account bursts from the same IP
      await new Promise(resolve => setTimeout(resolve, 650));
    }

    const usagePercent = poolTotal > 0 ? ((poolUsed / poolTotal) * 100).toFixed(1) : '0.0';
    const remainingPercent = poolTotal > 0 ? (100 - parseFloat(usagePercent)).toFixed(1) : '100.0';

    const result = {
      todayTokens,
      todayRequests,
      allTimeTokens,
      allTimeRequests: allTime.totalRequests || 0,
      allTimeCost: (allTime.totalCost || 0).toFixed(2),
      poolUsed,
      poolTotal,
      usagePercent,
      remainingPercent,
      accountQuotas
    };

    quotaCache = { timestamp: Date.now(), data: result, refreshing: false };
    return result;
  } catch (err) {
    quotaCache.refreshing = false;
    console.error('[fetchLiveQuotaStats Error]:', err.message);
    return quotaCache.data || {
      todayTokens: 0,
      todayRequests: 0,
      allTimeTokens: 0,
      allTimeRequests: 0,
      allTimeCost: "0.00",
      poolUsed: 0,
      poolTotal: 0,
      usagePercent: "0.0",
      remainingPercent: "100.0",
      accountQuotas: {}
    };
  }
}

const pendingEligibilityChecks = new Set();
const activeVerifySessions = new Set();

async function resolveAccountEligibility(id) {
  if (!id || pendingEligibilityChecks.has(id) || activeVerifySessions.has(id)) return;
  pendingEligibilityChecks.add(id);
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  try {
    if (!fs.existsSync(dbPath)) return;
    const db = new sqlite.DatabaseSync(dbPath);
    const r = db.prepare('SELECT id, email, name, isActive, data FROM providerConnections WHERE id = ?').get(id);
    db.close();
    if (!r) return;

    const d = JSON.parse(r.data || '{}');
    let token = d.accessToken;
    if (d.refreshToken) {
      try {
        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: d.refreshToken,
            client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
            client_secret: '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'
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (tr.ok) {
          const tj = await tr.json();
          if (tj.access_token) {
            token = tj.access_token;
            d.accessToken = token;
          }
        }
      } catch (e) { }
    }

    let nextActive = r.isActive;
    let foundStatus = false;

    try {
      const lcaRes = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.104.0 win32/x64'
        },
        body: JSON.stringify({ metadata: { ideType: 9, platform: 5, pluginType: 2 }, mode: 1 }),
        signal: AbortSignal.timeout(8000)
      });

      if (lcaRes.status === 403) {
        const errText = await lcaRes.text().catch(() => '');
        d.errorCode = 403;
        d.testStatus = 'unavailable';
        d.lastError = errText.toLowerCase().includes('disabled in this account') || errText.toLowerCase().includes('terms of service')
          ? 'This service has been disabled in this account for violation of Terms of Service.'
          : 'Verify your account to continue (VALIDATION_REQUIRED)';
        d.eligibilityChecked = true;
        nextActive = 0;
        foundStatus = true;
      } else if (lcaRes.ok) {
        const lcaJson = await lcaRes.json().catch(() => ({}));
        const vTier = Array.isArray(lcaJson.ineligibleTiers)
          ? lcaJson.ineligibleTiers.find(t => t?.reasonCode === 'VALIDATION_REQUIRED' || t?.validationUrl || String(t?.reasonMessage || '').toLowerCase().includes('verify your account'))
          : null;
        if (vTier) {
          d.errorCode = 403;
          d.testStatus = 'unavailable';
          d.lastError = vTier.reasonMessage || 'Verify your account to continue (VALIDATION_REQUIRED)';
          if (vTier.validationUrl) d.validationUrl = vTier.validationUrl;
          d.eligibilityChecked = true;
          nextActive = 0;
          foundStatus = true;
        }
      }
    } catch (e) { }

    if (!foundStatus) {
      try {
        const genRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.104.0 win32/x64'
          },
          body: JSON.stringify({
            project: 'aicode-consumers',
            model: 'gemini-3-flash',
            userAgent: 'antigravity',
            requestId: 'agent/11111111-1111-4111-8111-111111111111/' + Date.now() + '/22222222-2222-4222-8222-222222222222/1',
            request: {
              contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
              sessionId: '11111111-1111-4111-8111-111111111111'
            }
          }),
          signal: AbortSignal.timeout(8000)
        });

        if (genRes.ok) {
          if (d.errorCode === 403 || d.validationUrl) {
            delete d.errorCode;
            delete d.lastError;
            delete d.lastErrorAt;
            delete d.validationUrl;
            d.testStatus = 'active';
            nextActive = 1;
          }
          d.projectId = 'aicode-consumers';
          d.eligibilityChecked = true;
        } else if (genRes.status === 403) {
          const errJson = await genRes.json().catch(() => ({}));
          const msg = errJson?.error?.message || 'Verify your account to continue';
          const vUrl =
            errJson?.error?.details?.find(x => x?.metadata?.validation_url)?.metadata?.validation_url ||
            errJson?.error?.details?.find(x => Array.isArray(x?.links))?.links?.[0]?.url ||
            d.validationUrl;
          d.errorCode = 403;
          d.testStatus = 'unavailable';
          d.lastError = msg;
          if (vUrl) d.validationUrl = vUrl;
          d.eligibilityChecked = true;
          nextActive = 0;
        }
      } catch (e) { }
    }

    const dbSave = new sqlite.DatabaseSync(dbPath);
    dbSave.prepare('UPDATE providerConnections SET isActive = ?, data = ? WHERE id = ?').run(nextActive, JSON.stringify(d), id);
    dbSave.close();
  } catch (e) {
  } finally {
    setTimeout(() => pendingEligibilityChecks.delete(id), 10000);
  }
}

// Helper to read local SQLite accounts
function getLocalAccounts() {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    try { db.exec('PRAGMA busy_timeout = 3000;'); } catch (e) { }
    const rows = db.prepare("SELECT id, name, email, provider, isActive, data, updatedAt FROM providerConnections ORDER BY priority ASC, createdAt DESC").all();
    const liveQuotas = quotaCache.data?.accountQuotas || {};

    let lastConnectionId = null;
    let lastUsedTime = null;
    try {
      const lastUsage = db.prepare("SELECT connectionId, timestamp FROM usageHistory ORDER BY id DESC LIMIT 1").get();
      if (lastUsage) {
        lastConnectionId = lastUsage.connectionId;
        lastUsedTime = lastUsage.timestamp;
      }
    } catch (e) { }
    try { db.close(); } catch (e) { }

    return rows.map(r => {
      let status = r.isActive ? 'active' : 'standby';
      let cooldown = null;
      let errorMsg = null;
      let quotaRemaining = undefined;
      let quotaUsed = undefined;
      let quotaTotal = undefined;
      let resetAt = null;
      let resetTime = null;

      if (liveQuotas[r.id]) {
        quotaRemaining = liveQuotas[r.id].remainingPct;
        quotaUsed = liveQuotas[r.id].used;
        quotaTotal = liveQuotas[r.id].total;
        resetAt = liveQuotas[r.id].resetAt;
        resetTime = liveQuotas[r.id].resetTime;
        if (quotaRemaining === 0 && status !== 'disabled') {
          status = 'cooling';
          cooldown = resetTime || 'Cooling';
          errorMsg = 'Individual quota limit reached';
        }
      }

      let displayEmail = r.email || r.name;
      let normalizedProvider = r.provider === 'gemini-cli' ? 'gemini' : r.provider;
      let authType = r.provider === 'gemini-web' ? 'web' : 'oauth';

      try {
        if (r.data) {
          const d = JSON.parse(r.data);
          if (d.apiKey) {
            authType = 'apikey';
            const k = String(d.apiKey).trim();
            const maskedKey = k.length > 12 ? `${k.slice(0, 6)}...${k.slice(-4)}` : k;
            if (!displayEmail || displayEmail.startsWith('AIza')) {
              displayEmail = r.name && !r.name.startsWith('AIza') ? `${r.name} (${maskedKey})` : maskedKey;
            }
          }
          if (r.provider === 'antigravity' && !d.eligibilityChecked) {
            resolveAccountEligibility(r.id);
          }
          const lastErrLower = String(d.lastError || '').toLowerCase();
          if (
            d.errorCode === 403 ||
            (d.lastError && (String(d.lastError).includes('403') || lastErrLower.includes('disabled in this account') || lastErrLower.includes('verify your account') || lastErrLower.includes('validation_required') || lastErrLower.includes('api_key_invalid') || lastErrLower.includes('api key not valid')))
          ) {
            status = 'disabled';
            if (normalizedProvider === 'gemini' && authType === 'apikey') {
              errorMsg = 'Invalid / Disabled API Key (403)';
            } else {
              const isTosSuspended = lastErrLower.includes('disabled in this account') || lastErrLower.includes('violation of terms of service');
              errorMsg = isTosSuspended
                ? 'Suspended by Google (ToS 403)'
                : 'Verify Google Account (403)';
              if (!isTosSuspended && !lastErrLower.includes('verify your account') && !lastErrLower.includes('validation_required')) {
                resolveAccountEligibility(r.id);
              }
            }
          } else if (d.errorCode === 429) {
            status = 'cooling';
            const parsedTime = parseErrorReset(d.lastError);
            resetTime = resetTime || parsedTime;
            cooldown = resetTime || cooldown || 'Quota 429';
            errorMsg = errorMsg || 'Individual quota limit reached';
          } else if (d.testStatus === 'unavailable' && status !== 'cooling' && status !== 'disabled') {
            status = 'cooling';
            const parsedTime = parseErrorReset(d.lastError);
            resetTime = resetTime || parsedTime;
            cooldown = resetTime || cooldown || 'Cooling';
          }
        }
      } catch (e) { }

      if ((normalizedProvider === 'gemini' || normalizedProvider === 'gemini-web') && quotaRemaining === undefined) {
        quotaRemaining = status === 'cooling' || status === 'disabled' ? 0 : 100;
      }

      return {
        id: r.id,
        name: r.name,
        email: displayEmail,
        provider: normalizedProvider, // "antigravity", "gemini", or "gemini-web"
        rawProvider: r.provider,
        authType,
        status,
        cooldown,
        errorMsg,
        quotaRemaining,
        quotaUsed,
        quotaTotal,
        resetAt,
        resetTime,
        isLastUsed: (r.id === lastConnectionId),
        lastUsedTime
      };
    });
  } catch (e) {
    console.error('[DB Read Error]:', e.message);
    return [];
  }
}

// Helper to synchronize Gateway Mode (hybrid | gemini | antigravity | gemini-web), modelAliases, and combos in SQLite
function syncGatewayRoutingInDb(db, gatewayModeOverride = null) {
  let activeGatewayMode = 'hybrid';
  try {
    const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
    let sData = {};
    if (sRow && sRow.data) {
      try { sData = JSON.parse(sRow.data); } catch (e) { }
    }
    if (gatewayModeOverride && ['hybrid', 'gemini', 'antigravity', 'gemini-web'].includes(gatewayModeOverride)) {
      sData.gatewayMode = gatewayModeOverride;
    } else if (!sData.gatewayMode || !['hybrid', 'gemini', 'antigravity', 'gemini-web'].includes(sData.gatewayMode)) {
      sData.gatewayMode = 'hybrid';
    }
    activeGatewayMode = sData.gatewayMode;
    if (!sData.providerStrategies || typeof sData.providerStrategies !== 'object') {
      sData.providerStrategies = {};
    }
    if (!sData.providerStrategies.gemini) {
      sData.providerStrategies.gemini = {
        fallbackStrategy: 'round-robin',
        stickyRoundRobinLimit: 3
      };
    }
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
      JSON.stringify(sData)
    );

    const agRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'antigravity' AND isActive = 1").get();
    const gmRow = db.prepare("SELECT COUNT(*) as c FROM providerConnections WHERE provider = 'gemini' AND isActive = 1").get();
    const agCount = Number(agRow?.c || 0);
    const gmCount = Number(gmRow?.c || 0);

    const useGeminiPrimary =
      gmCount > 0 &&
      (activeGatewayMode === 'gemini' || (activeGatewayMode === 'hybrid' && agCount === 0));

    const defaultAliases = {
      'ag/4-argon': 'ag/gemini-4-argon',
      'ag/4-carbon': 'ag/gemini-4-carbon',
      'ag/3.5-flash-lite': 'ag/gemini-3.5-flash-lite',
      'ag/3.8-flash': 'ag/gemini-3.8-flash',
      'ag/3.1-pro': 'ag/gemini-3.1-pro-high',
      'ag/gemini-3.6-flash': 'ag/gemini-3.6-flash-high',
      'ag/gemini-3-flash-preview': 'ag/gemini-3-flash',
      'ag/gemini-3.1-pro-preview': 'ag/gemini-3.1-pro-high',
      'ag/gemini-3.1-flash-lite-preview': 'ag/gemini-3.1-flash-lite',
      'ag/gemini-2.5-pro': 'ag/gemini-3.1-pro-high',

      'gm/gemini-2.5-flash': 'gemini/gemini-2.5-flash',
      'gm/gemini-2.5-pro': 'gemini/gemini-2.5-pro',
      'gm/gemini-2.5-flash-lite': 'gemini/gemini-2.5-flash-lite',
      'gm/gemini-2.0-flash': 'gemini/gemini-2.0-flash',
      'gm/gemini-3-flash': 'gemini/gemini-3-flash-preview',
      'gm/gemini-3.1-pro': 'gemini/gemini-3.1-pro-preview',
      'gm/gemini-3.8-flash': 'gemini/gemini-2.5-flash',
      'gm/gemini-3.5-flash-lite': 'gemini/gemini-2.5-flash-lite',
      'gemini/gemini-3-flash': 'gemini/gemini-3-flash-preview',
      'gemini/gemini-1.5-flash': 'gemini/gemini-2.5-flash',
      'gemini/gemini-1.5-pro': 'gemini/gemini-2.5-pro',

      'gemini-3.5-flash-lite': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.5-flash-lite',
      'gemini-3.5-flash-lite-high': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.5-flash-lite-high',
      'gemini-3.5-flash-lite-medium': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.5-flash-lite-medium',
      'gemini-3.5-flash-lite-low': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.5-flash-lite-low',
      '3.5-flash-lite': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.5-flash-lite',

      'gemini-3.8-flash': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash',
      'gemini-3.8-flash-high': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash-high',
      'gemini-3.8-flash-medium': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash-medium',
      'gemini-3.8-flash-low': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.8-flash-low',
      'gemini 3.8 flash low': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.8-flash-low',
      'Gemini 3.8 Flash Low': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.8-flash-low',
      '3.8-flash': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash',

      'gemini-3.1-pro': useGeminiPrimary ? 'gemini/gemini-3.1-pro-preview' : 'ag/gemini-3.1-pro-high',
      'gemini-3.1-pro-high': useGeminiPrimary ? 'gemini/gemini-3.1-pro-preview' : 'ag/gemini-3.1-pro-high',
      'gemini-3.1-pro-low': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.1-pro-low',
      'gemini-3.1-flash-lite': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.1-flash-lite',
      '3.1-pro': useGeminiPrimary ? 'gemini/gemini-3.1-pro-preview' : 'ag/gemini-3.1-pro-high',

      'gemini-4-argon': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-4-argon',
      '4-argon': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-4-argon',
      'gemini-4-carbon': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-4-carbon',
      '4-carbon': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-4-carbon',

      'gemini-3.6-flash': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.6-flash-high',
      'gemini-3.6-flash-high': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.6-flash-high',
      'gemini-3.6-flash-low': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-3.6-flash-low',
      'gemini-3-flash': useGeminiPrimary ? 'gemini/gemini-3-flash-preview' : 'ag/gemini-3-flash',
      'gemini-3-flash-preview': useGeminiPrimary ? 'gemini/gemini-3-flash-preview' : 'ag/gemini-3-flash',
      'gemini-2.5-flash': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-2.5-flash',
      'gemini-2.5-flash-lite': useGeminiPrimary ? 'gemini/gemini-2.5-flash-lite' : 'ag/gemini-2.5-flash-lite',
      'gemini-2.5-flash-thinking': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-2.5-flash-thinking',
      'gemini-2.5-pro': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-3.1-pro-high',
      'gemini-2.0-flash': useGeminiPrimary ? 'gemini/gemini-2.0-flash' : 'ag/gemini-3.8-flash',
      'gemini-1.5-flash': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash',
      'gemini-1.5-pro': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-3.1-pro-high',
      'claude-sonnet-4-6': 'ag/claude-sonnet-4-6',
      'claude-opus-4-6-thinking': 'ag/claude-opus-4-6-thinking',
      'claude-3-5-sonnet': 'ag/claude-sonnet-4-6',
      'claude-3-7-sonnet': 'ag/claude-sonnet-4-6',
      'gpt-oss-120b-medium': 'ag/gpt-oss-120b-medium',
      'gpt-4o': useGeminiPrimary ? 'gemini/gemini-2.5-pro' : 'ag/gemini-3.8-flash-high',
      'gpt-4o-mini': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.5-flash-lite',
      'deepseek-chat': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash',
      'sastra-smart-pool': useGeminiPrimary ? 'gemini/gemini-2.5-flash' : 'ag/gemini-3.8-flash-high',
      'sastra-gemini-pool': 'gemini/gemini-2.5-flash'
    };
    db.prepare("DELETE FROM kv WHERE scope = 'modelAliases'").run();
    const insKv = db.prepare("INSERT OR REPLACE INTO kv (scope, key, value) VALUES ('modelAliases', ?, ?)");
    for (const [k, v] of Object.entries(defaultAliases)) {
      insKv.run(k, JSON.stringify(v));
    }

    db.prepare("DELETE FROM combos WHERE id LIKE 'sastra-combo-%'").run();
    if (activeGatewayMode === 'hybrid' && agCount > 0 && gmCount > 0) {
      const nowIso = new Date().toISOString();
      const hybridCombos = {
        'sastra-smart-pool': ['ag/gemini-3.8-flash-high', 'gemini/gemini-2.5-flash'],
        'gemini-3.5-flash-lite': ['ag/gemini-3.5-flash-lite', 'gemini/gemini-2.5-flash-lite'],
        'gemini-3.5-flash-lite-high': ['ag/gemini-3.5-flash-lite-high', 'gemini/gemini-2.5-flash'],
        'gemini-3.5-flash-lite-medium': ['ag/gemini-3.5-flash-lite-medium', 'gemini/gemini-2.5-flash-lite'],
        'gemini-3.5-flash-lite-low': ['ag/gemini-3.5-flash-lite-low', 'gemini/gemini-2.5-flash-lite'],
        'gemini-3.8-flash': ['ag/gemini-3.8-flash', 'gemini/gemini-2.5-flash'],
        'gemini-3.8-flash-high': ['ag/gemini-3.8-flash-high', 'gemini/gemini-2.5-flash'],
        'gemini-3.8-flash-medium': ['ag/gemini-3.8-flash-medium', 'gemini/gemini-2.5-flash'],
        'gemini-3.8-flash-low': ['ag/gemini-3.8-flash-low', 'gemini/gemini-2.5-flash-lite'],
        'gemini-3.1-pro': ['ag/gemini-3.1-pro-high', 'gemini/gemini-3.1-pro-preview'],
        'gemini-3.1-pro-high': ['ag/gemini-3.1-pro-high', 'gemini/gemini-3.1-pro-preview'],
        'gemini-3.1-pro-low': ['ag/gemini-3.1-pro-low', 'gemini/gemini-2.5-flash'],
        'gemini-3.1-flash-lite': ['ag/gemini-3.1-flash-lite', 'gemini/gemini-2.5-flash-lite'],
        'gemini-4-argon': ['ag/gemini-4-argon', 'gemini/gemini-2.5-pro'],
        'gemini-4-carbon': ['ag/gemini-4-carbon', 'gemini/gemini-2.5-pro'],
        'gemini-2.5-flash': ['ag/gemini-2.5-flash', 'gemini/gemini-2.5-flash'],
        'gemini-2.5-pro': ['ag/gemini-3.1-pro-high', 'gemini/gemini-2.5-pro'],
        'gemini-2.5-flash-lite': ['ag/gemini-2.5-flash-lite', 'gemini/gemini-2.5-flash-lite'],
        'gemini-2.5-flash-thinking': ['ag/gemini-2.5-flash-thinking', 'gemini/gemini-2.5-flash'],
        'gemini-2.0-flash': ['ag/gemini-3.8-flash', 'gemini/gemini-2.0-flash'],
        'gemini-1.5-flash': ['ag/gemini-3.8-flash', 'gemini/gemini-2.5-flash'],
        'gemini-1.5-pro': ['ag/gemini-3.1-pro-high', 'gemini/gemini-2.5-pro'],
        'gemini-3-flash': ['ag/gemini-3-flash', 'gemini/gemini-3-flash-preview']
      };
      const insCombo = db.prepare(
        "INSERT OR REPLACE INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, 'fallback', ?, ?, ?)"
      );
      for (const [name, modelsArr] of Object.entries(hybridCombos)) {
        insCombo.run(`sastra-combo-${name}`, name, JSON.stringify(modelsArr), nowIso, nowIso);
      }
    }
  } catch (e) {
    console.error('[syncGatewayRoutingInDb Error]:', e.message);
  }
  return activeGatewayMode;
}

// Helper to delete an account from local SQLite
function deleteLocalAccount(id) {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    db.prepare("DELETE FROM providerConnections WHERE id = ?").run(id);
    syncGatewayRoutingInDb(db);
    db.close();
    return true;
  } catch (e) {
    console.error('[DB Delete Error]:', e.message);
    return false;
  }
}

// 4. Kill Engine Process Cleanly on Windows
function stopEngine() {
  if (engineProcess && engineProcess.pid) {
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${engineProcess.pid} /t /f`, () => { });
      } else {
        engineProcess.kill('SIGTERM');
      }
    } catch (e) { }
    engineProcess = null;
  }
}

// 5. Start SastraGetWay Router Engine (Only runs when License Key is valid)
function startEngine(onReady) {
  stopEngine();
  const lic = getLicenseStatus();
  if (!lic.valid) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine-log', '[License Lock] API Engine 127.0.0.1:20128 is locked until a valid License Key is activated.');
    }
    return;
  }
  ensureDefaultApiKey();

  const isPackaged = app.isPackaged;
  const baseDir = isPackaged ? process.resourcesPath : __dirname;
  let scriptPath = path.join(baseDir, 'engine', 'app', 'custom-server.js');
  let workingDir = path.join(baseDir, 'engine', 'app');

  if (!fs.existsSync(scriptPath)) {
    scriptPath = path.join(__dirname, 'engine', 'app', 'custom-server.js');
    workingDir = path.join(__dirname, 'engine', 'app');
  }

  const env = {
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: HOST,
    INITIAL_PASSWORD: '123456',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--max-old-space-size=768'
  };

  const defaultNode = 'C:\\Program Files\\nodejs\\node.exe';
  const nodeBinary = (!isPackaged && fs.existsSync(defaultNode)) ? defaultNode : process.execPath;

  engineProcess = spawn(nodeBinary, [scriptPath], {
    cwd: workingDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logDir = app.getPath('userData');
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'engine.log');
    fs.writeFileSync(logFile, `[${new Date().toISOString()}] Starting engine: ${nodeBinary} ${scriptPath} in ${workingDir}\n`);
  } catch (e) { }
  const logFile = path.join(logDir, 'engine.log');

  engineProcess.stdout.on('data', (d) => {
    const raw = d.toString();
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith('[SASTRA_TELEMETRY]')) {
        try {
          const payload = JSON.parse(text.slice('[SASTRA_TELEMETRY]'.length));
          if (payload.type === 'start') {
            const accs = getLocalAccounts();
            const mStr = String(payload.model || '').toLowerCase();
            const isExplicitGemini = mStr.startsWith('gemini/') || mStr.startsWith('gm/') || mStr.startsWith('gc/') || mStr === 'sastra-gemini-pool';
            const preferredAcc = isExplicitGemini
              ? (accs.find(a => a.provider === 'gemini' && a.isLastUsed && a.status === 'active') ||
                accs.find(a => a.provider === 'gemini' && a.status === 'active') ||
                accs.find(a => a.status === 'active'))
              : (accs.find(a => a.isLastUsed && a.status === 'active') ||
                accs.find(a => a.provider === 'antigravity' && a.status === 'active') ||
                accs.find(a => a.provider === 'gemini' && a.status === 'active') ||
                accs.find(a => a.status === 'active'));
            payload.email = preferredAcc ? (preferredAcc.email || preferredAcc.name) : 'Sastra Gateway Pool';
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry-event', payload);
          }
        } catch (e) { }
        continue;
      }
      try { fs.appendFileSync(logFile, `[stdout] ${text}\n`); } catch (e) { }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-log', text);
      }
    }
  });

  engineProcess.stderr.on('data', (d) => {
    const text = d.toString().trim();
    try { fs.appendFileSync(logFile, `[stderr] ${text}\n`); } catch (e) { }
    if (mainWindow && !mainWindow.isDestroyed() && text) {
      mainWindow.webContents.send('engine-log', '[Error] ' + text);
    }
  });

  engineProcess.on('exit', (code, signal) => {
    try { fs.appendFileSync(logFile, `[exit] Engine process exited with code ${code}, signal ${signal}\n`); } catch (e) { }
    engineProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine-log', `[Engine Offline] Process stopped (code: ${code}).`);
    }
  });

  engineProcess.on('error', (err) => {
    try { fs.appendFileSync(logFile, `[error] Engine process error: ${err.message}\n`); } catch (e) { }
    engineProcess = null;
  });

  // Poll until HTTP server is ready
  let attempts = 0;
  const maxAttempts = 50;
  const checkInterval = setInterval(() => {
    attempts++;
    const req = http.get(SERVER_URL, () => {
      clearInterval(checkInterval);
      if (onReady) onReady();
    });

    req.on('error', () => {
      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
      }
    });

    req.setTimeout(500, () => req.destroy());
  }, 300);
}

// 6. Setup IPC Handlers
ipcMain.handle('get-accounts', async () => {
  // Trigger live quota stats refresh in background without blocking instant account loading
  fetchLiveQuotaStats().catch(() => { });
  return getLocalAccounts();
});

ipcMain.handle('get-quota-stats', async () => {
  return await fetchLiveQuotaStats();
});

ipcMain.handle('get-request-logs', async () => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const rows = db.prepare(`
      SELECT u.id, u.timestamp, u.provider, u.model, u.connectionId, u.endpoint, u.promptTokens, u.completionTokens, u.cost, u.tokens, u.status, p.email, p.name 
      FROM usageHistory u 
      LEFT JOIN providerConnections p ON u.connectionId = p.id 
      ORDER BY u.id DESC LIMIT 60
    `).all();
    return rows;
  } catch (e) {
    console.error('[get-request-logs Error]:', e.message);
    return [];
  }
});

ipcMain.handle('test-account', async (_event, id) => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      const acc = db.prepare('SELECT id, email, name, provider, isActive, data FROM providerConnections WHERE id = ?').get(id);
      db.close();

      if (acc && acc.provider === 'gemini-web') {
        let isValid = false;
        let errMsg = '';
        try {
          const win = await ensureGeminiWebWindow(acc, false);
          for (let i = 0; i < 15; i++) {
            if (win.isDestroyed()) throw new Error('Gemini Web window closed');
            const u = win.webContents.getURL() || '';
            if (u.includes('accounts.google.com')) {
              throw new Error('Session expired (Google Login required)');
            }
            if (isGeminiWebAppUrl(u)) break;
            await new Promise(r => setTimeout(r, 300));
          }

          const check = await win.webContents.executeJavaScript(`
            (() => {
              const wiz = window.WIZ_global_data || {};
              const isEditor = !!document.querySelector('rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]');
              const hasWiz = !!(wiz.SNlM0e);
              const isLogin = window.location.href.includes('accounts.google.com');
              return { valid: !isLogin && (isEditor || hasWiz), isLogin };
            })()
          `).catch(() => ({ valid: false }));

          if (check && check.valid) {
            isValid = true;
          } else if (check && check.isLogin) {
            errMsg = 'Google Login required';
          } else {
            errMsg = 'Gemini Web chat is not ready';
          }
        } catch (e) {
          errMsg = e.message;
        }

        const dbUpdate = new sqlite.DatabaseSync(dbPath);
        const rowNow = dbUpdate.prepare('SELECT data FROM providerConnections WHERE id = ?').get(id);
        let d = {};
        try { d = JSON.parse(rowNow?.data || '{}'); } catch (e) { }

        if (isValid) {
          delete d.lastError;
          delete d.lastErrorAt;
          d.testStatus = 'active';
          dbUpdate.prepare('UPDATE providerConnections SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
          dbUpdate.close();
          return { valid: true };
        } else {
          d.testStatus = 'error';
          d.lastError = errMsg || 'Gemini Web connection failed';
          d.lastErrorAt = new Date().toISOString();
          dbUpdate.prepare('UPDATE providerConnections SET data = ? WHERE id = ?').run(JSON.stringify(d), id);
          dbUpdate.close();
          return { valid: false, error: d.lastError };
        }
      }
    } catch (dbErr) {
      console.error('[test-account gemini-web check error]:', dbErr.message);
    }
  }

  try {
    const res = await fetch(`http://127.0.0.1:20128/api/providers/${id}/test`, { method: 'POST' });
    const json = await res.json();
    return json;
  } catch (e) {
    return { valid: false, error: e.message };
  }
});

ipcMain.handle('verify-google-account', async (_event, id) => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'Database not found' };
  }
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const r = db.prepare('SELECT id, email, name, isActive, data FROM providerConnections WHERE id = ?').get(id);
    if (!r) {
      db.close();
      return { ok: false, error: 'Account not found' };
    }
    const d = JSON.parse(r.data || '{}');
    const accountEmail = r.email || d.email || r.name || '';

    const checkAndActivateIfVerified = async () => {
      const dbCheck = new sqlite.DatabaseSync(dbPath);
      const rowNow = dbCheck.prepare('SELECT id, email, name, isActive, data FROM providerConnections WHERE id = ?').get(id);
      if (!rowNow) {
        dbCheck.close();
        return { verified: false };
      }
      const dNow = JSON.parse(rowNow.data || '{}');
      let token = dNow.accessToken;
      if (dNow.refreshToken) {
        try {
          const tr = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: dNow.refreshToken,
              client_id: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
              client_secret: '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'
            }),
            signal: AbortSignal.timeout(8000)
          });
          if (tr.ok) {
            const tj = await tr.json();
            if (tj.access_token) {
              token = tj.access_token;
              dNow.accessToken = token;
            }
          }
        } catch (e) { }
      }

      // Try onboarding free-tier first
      try {
        await fetch('https://cloudcode-pa.googleapis.com/v1internal:onboardUser', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.104.0 win32/x64'
          },
          body: JSON.stringify({ tierId: 'free-tier', metadata: { ideType: 9, platform: 5, pluginType: 2 } }),
          signal: AbortSignal.timeout(8000)
        });
      } catch (e) { }

      const genRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'antigravity/1.104.0 win32/x64'
        },
        body: JSON.stringify({
          project: 'aicode-consumers',
          model: 'gemini-3-flash',
          userAgent: 'antigravity',
          requestId: 'agent/11111111-1111-4111-8111-111111111111/' + Date.now() + '/22222222-2222-4222-8222-222222222222/1',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
            sessionId: '11111111-1111-4111-8111-111111111111'
          }
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (genRes.ok) {
        delete dNow.errorCode;
        delete dNow.lastError;
        delete dNow.lastErrorAt;
        dNow.testStatus = 'active';
        dNow.projectId = 'aicode-consumers';
        dbCheck.prepare('UPDATE providerConnections SET isActive = 1, data = ? WHERE id = ?').run(JSON.stringify(dNow), rowNow.id);
        dbCheck.close();
        quotaCache.timestamp = 0;
        return { verified: true };
      }

      const errJson = await genRes.json().catch(() => ({}));
      const vUrl =
        errJson?.error?.details?.find(x => x?.metadata?.validation_url)?.metadata?.validation_url ||
        errJson?.error?.details?.find(x => Array.isArray(x?.links))?.links?.[0]?.url ||
        'https://myaccount.google.com/security';
      dbCheck.close();
      return { verified: false, validationUrl: vUrl };
    };

    db.close();
    const initialCheck = await checkAndActivateIfVerified();
    if (initialCheck.verified) {
      return {
        ok: true,
        status: 'verified',
        email: accountEmail,
        message: 'គណនីបាន Verify រួចរាល់ និងបើកដំណើរការ (Active) វិញហើយ!'
      };
    }

    let rawVUrl = initialCheck.validationUrl || d.validationUrl || 'https://myaccount.google.com/security';
    let targetUrl = rawVUrl;
    if (accountEmail && accountEmail.includes('@')) {
      const encodedEmail = encodeURIComponent(accountEmail);
      if (rawVUrl.endsWith('&authuser')) {
        rawVUrl = rawVUrl.replace(/&authuser$/, `&authuser=${encodedEmail}`);
      }
      targetUrl = `https://accounts.google.com/AccountChooser?Email=${encodedEmail}&continue=${encodeURIComponent(rawVUrl)}`;
    }

    clipboard.writeText(targetUrl);

    // Find real Google Chrome or Microsoft Edge so Google's built-in attestation extensions complete QR code handshakes smoothly
    const browserCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')
    ];
    const realBrowserExe = browserCandidates.find(p => p && fs.existsSync(p));

    if (realBrowserExe) {
      activeVerifySessions.add(id);
      const profileDir = path.join(app.getPath('appData'), 'SastraGetWay_Data', `chrome_verify_${id}`);
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }
      let hash = 0;
      for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
      const debugPort = 20210 + (Math.abs(hash) % 80);

      const chromeProc = spawn(realBrowserExe, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=620,780',
        `--app=${targetUrl}`
      ], {
        detached: false,
        stdio: 'ignore'
      });

      let isChecking = false;
      let finished = false;

      const finishVerification = async () => {
        if (finished || isChecking) return false;
        isChecking = true;
        try {
          const recheck = await checkAndActivateIfVerified();
          if (recheck.verified) {
            finished = true;
            clearInterval(tabWatcher);
            activeVerifySessions.delete(id);
            try { chromeProc.kill(); } catch (e) { }
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('engine-log', `[Verified] Account ${accountEmail} is now verified and Active!`);
            }
            return true;
          }
        } catch (e) { }
        isChecking = false;
        return false;
      };

      // Poll local Chrome DevTools JSON (never touches Google's servers, so QR code plt token stays 100% valid)
      const tabWatcher = setInterval(async () => {
        if (finished) return;
        try {
          const res = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(1000) });
          if (!res.ok) return;
          const tabs = await res.json();
          const reachedSuccess = Array.isArray(tabs) && tabs.some(t =>
            t?.url && (
              t.url.includes('auth_success_gemini') ||
              t.url.includes('developers.google.com/gemini-code-assist') ||
              t.url.includes('myaccount.google.com')
            )
          );
          if (reachedSuccess) {
            await finishVerification();
          }
        } catch (e) { }
      }, 1200);

      chromeProc.on('exit', () => {
        clearInterval(tabWatcher);
        activeVerifySessions.delete(id);
        if (!finished) {
          finishVerification();
        }
      });

      return {
        ok: true,
        status: 'opened_window',
        email: accountEmail,
        validationUrl: targetUrl,
        message: `បានបើកផ្ទាំង Chrome ដាច់ដោយឡែកសម្រាប់ ${accountEmail}! សូមស្កេន QR លើទូរស័ព្ទ ពេលផ្ទាំង Chrome លោតជោគជ័យ វានឹងបើក Active ស្វ័យប្រវត្តិ។`
      };
    }

    // Fallback: Open in an isolated Electron Window
    activeVerifySessions.add(id);
    const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const verifyWin = new BrowserWindow({
      width: 580,
      height: 780,
      parent: mainWindow || undefined,
      title: `Verify Google Account: ${accountEmail}`,
      backgroundColor: '#0f172a',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: `persist:google_verify_${id}`
      }
    });

    verifyWin.webContents.setUserAgent(chromeUA);
    verifyWin.loadURL(targetUrl, { userAgent: chromeUA });

    let isChecking = false;
    const runLiveCheck = async () => {
      if (isChecking) return false;
      isChecking = true;
      try {
        const recheck = await checkAndActivateIfVerified();
        if (recheck.verified) {
          activeVerifySessions.delete(id);
          if (!verifyWin.isDestroyed()) verifyWin.close();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('engine-log', `[Verified] Account ${accountEmail} is now verified and Active!`);
          }
          return true;
        }
      } catch (e) { }
      isChecking = false;
      return false;
    };

    const handleUrlCheck = async (urlStr) => {
      if (!urlStr) return;
      if (urlStr.includes('auth_success_gemini') || urlStr.includes('developers.google.com/gemini-code-assist') || urlStr.includes('myaccount.google.com')) {
        await runLiveCheck();
      }
    };

    verifyWin.webContents.on('did-navigate', (_e, urlStr) => handleUrlCheck(urlStr));
    verifyWin.webContents.on('did-finish-load', () => {
      if (!verifyWin.isDestroyed()) {
        handleUrlCheck(verifyWin.webContents.getURL());
      }
    });
    verifyWin.on('closed', () => {
      activeVerifySessions.delete(id);
      runLiveCheck();
    });

    return {
      ok: true,
      status: 'opened_window',
      email: accountEmail,
      validationUrl: targetUrl,
      message: `បានបើកផ្ទាំង Verify ផ្ទាល់សម្រាប់ ${accountEmail}!`
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('delete-account', async (_event, id) => {
  try {
    await fetch(`http://127.0.0.1:20128/api/providers/${id}`, { method: 'DELETE' });
  } catch (e) { }
  return deleteLocalAccount(id);
});

ipcMain.handle('rename-account', async (_event, { id, name }) => {
  if (!id || !name) return { ok: false, error: 'Missing parameters' };
  const cleanName = String(name).trim();
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return { ok: false, error: 'Database not found' };
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    db.prepare("UPDATE providerConnections SET name = ?, email = ?, updatedAt = ? WHERE id = ?")
      .run(cleanName, cleanName, new Date().toISOString(), id);
    syncGatewayRoutingInDb(db);
    db.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('toggle-account-active', async (_event, { id, isActive }) => {
  if (!id) return { success: false };
  const activeVal = isActive ? 1 : 0;
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      db.prepare('UPDATE providerConnections SET isActive = ?, updatedAt = ? WHERE id = ?').run(
        activeVal,
        new Date().toISOString(),
        id
      );
      syncGatewayRoutingInDb(db);
      db.close();
    }
  } catch (e) {
    console.error('[toggle-account-active DB Error]:', e.message);
  }
  try {
    await fetch(`http://${HOST}:${PORT}/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: Boolean(isActive) }),
      signal: AbortSignal.timeout(1500)
    });
  } catch (e) { }
  return { success: true, id, isActive: Boolean(isActive) };
});

ipcMain.handle('get-pool-settings', async () => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  let fallbackStrategy = 'fill-first';
  let stickyRoundRobinLimit = 20;
  let quotaCacheMinutes = Math.max(1, Math.round(UPSTREAM_QUOTA_CACHE_TTL_MS / 60000));
  let autoDisable403 = true;
  let gatewayMode = 'hybrid';

  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      if (sRow && sRow.data) {
        const sData = JSON.parse(sRow.data);
        const ag = sData.providerStrategies?.antigravity || {};
        fallbackStrategy = ag.fallbackStrategy || sData.fallbackStrategy || 'fill-first';
        stickyRoundRobinLimit = Number(ag.stickyRoundRobinLimit || sData.stickyRoundRobinLimit || 20);
        if (sData.gatewayMode && ['hybrid', 'gemini', 'antigravity', 'gemini-web'].includes(sData.gatewayMode)) {
          gatewayMode = sData.gatewayMode;
        }
        if (sData.quotaCacheMinutes) {
          quotaCacheMinutes = Number(sData.quotaCacheMinutes) || 5;
          UPSTREAM_QUOTA_CACHE_TTL_MS = quotaCacheMinutes * 60 * 1000;
        }
        if (sData.autoDisable403 !== undefined) {
          autoDisable403 = Boolean(sData.autoDisable403);
        }
      }
      db.close();
    }
  } catch (e) { }

  return {
    fallbackStrategy,
    stickyRoundRobinLimit,
    quotaCacheMinutes,
    autoDisable403,
    gatewayMode
  };
});

ipcMain.handle('save-pool-settings', async (_event, newSettings = {}) => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  const fallbackStrategy = newSettings.fallbackStrategy === 'round-robin' ? 'round-robin' : 'fill-first';
  const stickyRoundRobinLimit = Math.max(1, Math.min(200, Number(newSettings.stickyRoundRobinLimit) || 20));
  const quotaCacheMinutes = Math.max(1, Math.min(60, Number(newSettings.quotaCacheMinutes) || 5));
  const autoDisable403 = newSettings.autoDisable403 !== false;
  const gatewayMode = ['hybrid', 'gemini', 'antigravity', 'gemini-web'].includes(newSettings.gatewayMode)
    ? newSettings.gatewayMode
    : 'hybrid';

  UPSTREAM_QUOTA_CACHE_TTL_MS = quotaCacheMinutes * 60 * 1000;

  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      let sData = {};
      if (sRow && sRow.data) {
        try { sData = JSON.parse(sRow.data); } catch (e) { }
      }
      sData.requireApiKey = false;
      sData.requireLogin = false;
      sData.password = null;
      sData.fallbackStrategy = fallbackStrategy;
      sData.stickyRoundRobinLimit = stickyRoundRobinLimit;
      sData.quotaCacheMinutes = quotaCacheMinutes;
      sData.autoDisable403 = autoDisable403;
      sData.gatewayMode = gatewayMode;
      if (!sData.providerStrategies || typeof sData.providerStrategies !== 'object') {
        sData.providerStrategies = {};
      }
      sData.providerStrategies.antigravity = {
        ...(sData.providerStrategies.antigravity || {}),
        fallbackStrategy,
        stickyRoundRobinLimit
      };
      sData.providerStrategies.gemini = {
        ...(sData.providerStrategies.gemini || {}),
        fallbackStrategy: 'round-robin',
        stickyRoundRobinLimit: 3
      };
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
        JSON.stringify(sData)
      );
      syncGatewayRoutingInDb(db, gatewayMode);
      db.close();
    }
  } catch (e) {
    console.error('[save-pool-settings DB Error]:', e.message);
  }

  try {
    await fetch(`http://${HOST}:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fallbackStrategy,
        stickyRoundRobinLimit,
        providerStrategies: {
          antigravity: { fallbackStrategy, stickyRoundRobinLimit },
          gemini: { fallbackStrategy: 'round-robin', stickyRoundRobinLimit: 3 }
        }
      }),
      signal: AbortSignal.timeout(1500)
    });
  } catch (e) { }

  return {
    success: true,
    fallbackStrategy,
    stickyRoundRobinLimit,
    quotaCacheMinutes,
    autoDisable403,
    gatewayMode
  };
});

ipcMain.handle('set-gateway-mode', async (_event, mode) => {
  const gatewayMode = ['hybrid', 'gemini', 'antigravity', 'gemini-web'].includes(mode) ? mode : 'hybrid';
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      syncGatewayRoutingInDb(db, gatewayMode);
      db.close();
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, gatewayMode };
});

let globalModelAliases = {
  'gpt-4o': 'ag/gemini-3.8-flash-high',
  'gpt-4': 'ag/gemini-3.8-flash-high',
  'gemini-3.8-flash': 'ag/gemini-3.8-flash-high',
  'claude-3-7-sonnet': 'ag/claude-sonnet-4-6',
  'claude-3-5-sonnet': 'ag/claude-sonnet-4-6',
  'claude-sonnet-4-6': 'ag/claude-sonnet-4-6',
  'claude-opus': 'ag/claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking': 'ag/claude-opus-4-6-thinking',
  'o1': 'ag/claude-opus-4-6-thinking',
  'o3-mini': 'ag/claude-opus-4-6-thinking',
  'gpt-oss': 'ag/gpt-oss-120b-medium',
  'gpt-oss-120b-medium': 'ag/gpt-oss-120b-medium',
  'gpt-4o-mini': 'ag/gpt-oss-120b-medium',
  'gemini-pro': 'ag/gemini-3.8-flash-high'
};

function resolveModelAlias(model) {
  if (!model) return model;
  const m = String(model).toLowerCase().trim();
  return globalModelAliases[m] || model;
}

ipcMain.handle('get-model-aliases', async () => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      db.close();
      if (row && row.data) {
        const d = JSON.parse(row.data);
        if (d.modelAliases) {
          globalModelAliases = { ...globalModelAliases, ...d.modelAliases };
        }
      }
    }
  } catch (e) { }
  return globalModelAliases;
});

ipcMain.handle('save-model-aliases', async (_event, newAliases = {}) => {
  globalModelAliases = { ...globalModelAliases, ...newAliases };
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  try {
    if (fs.existsSync(dbPath)) {
      const db = new sqlite.DatabaseSync(dbPath);
      const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      let d = {};
      if (row && row.data) {
        try { d = JSON.parse(row.data); } catch (e) { }
      }
      d.modelAliases = globalModelAliases;
      db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(d));
      db.close();
    }
  } catch (e) { }
  return { ok: true, aliases: globalModelAliases };
});

ipcMain.handle('add-gemini-keys', async (_event, payload = {}) => {
  const rawKeys = String(payload?.rawKeys || '').trim();
  const labelPrefix = String(payload?.labelPrefix || 'Gemini Key').trim() || 'Gemini Key';
  if (!rawKeys) {
    return { ok: false, error: 'សូមបញ្ចូល Gemini API Key (AIzaSy...) យ៉ាងហោចណាស់ ១ គ្រាប់!' };
  }

  // Extract AIza... tokens or line/comma/space-separated keys
  const regexMatches = rawKeys.match(/AIza[0-9A-Za-z_\-]{25,}/g) || [];
  const rawTokens = regexMatches.length > 0
    ? regexMatches
    : rawKeys.split(/[\r\n,\s;]+/).map(s => s.trim()).filter(s => s.length >= 20);

  const uniqueKeys = [...new Set(rawTokens)];
  if (uniqueKeys.length === 0) {
    return { ok: false, error: 'រកមិនឃើញទម្រង់ Gemini API Key (AIzaSy...) ត្រឹមត្រូវទេ!' };
  }

  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'Database មិនទាន់រួចរាល់ទេ សូមរង់ចាំបន្តិច!' };
  }

  let addedCount = 0;
  let duplicateCount = 0;
  let invalidCount = 0;
  const errors = [];

  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const existingRows = db.prepare("SELECT id, data FROM providerConnections WHERE provider = 'gemini'").all();
    const existingApiKeys = new Set();
    for (const r of existingRows) {
      try {
        const d = JSON.parse(r.data || '{}');
        if (d.apiKey) existingApiKeys.add(String(d.apiKey).trim());
      } catch (e) { }
    }

    let nextIdx = existingRows.length + 1;
    const crypto = require('crypto');

    for (const apiKey of uniqueKeys) {
      if (existingApiKeys.has(apiKey)) {
        duplicateCount++;
        continue;
      }

      const masked = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
      let isValid = false;
      let errReason = '';
      try {
        const testRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(7000)
        });
        if (testRes.ok) {
          isValid = true;
        } else {
          const errJson = await testRes.json().catch(() => ({}));
          errReason = errJson?.error?.message || `HTTP ${testRes.status}`;
        }
      } catch (e) {
        errReason = e.message || 'Network error';
      }

      if (!isValid) {
        invalidCount++;
        errors.push(`${masked}: ${errReason || 'Key មិនត្រឹមត្រូវ'}`);
        continue;
      }

      const id = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const keyLabel = `${labelPrefix} #${nextIdx}`;
      const displayEmail = `${masked} • ${keyLabel}`;
      const dataObj = {
        apiKey,
        testStatus: 'active',
        verifiedAt: nowIso
      };

      db.prepare(`
        INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
        VALUES (?, 'gemini', 'apikey', ?, ?, ?, 1, ?, ?, ?)
      `).run(id, keyLabel, displayEmail, nextIdx, JSON.stringify(dataObj), nowIso, nowIso);

      existingApiKeys.add(apiKey);
      nextIdx++;
      addedCount++;
    }

    syncGatewayRoutingInDb(db);
    db.close();

    return {
      ok: addedCount > 0 || duplicateCount > 0,
      addedCount,
      duplicateCount,
      invalidCount,
      errors,
      accounts: getLocalAccounts()
    };
  } catch (e) {
    console.error('[add-gemini-keys Error]:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('add-gemini-oauth', async () => {
  return new Promise((resolve) => {
    const redirectUri = 'http://localhost:20128/callback';
    const reqUrl = `http://127.0.0.1:20128/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;
    http.get(reqUrl, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const authUrl = json.data?.authUrl || json.authUrl;
          const state = json.data?.state || json.state;
          const codeVerifier = json.data?.codeVerifier || json.codeVerifier;
          if (authUrl) {
            const sessionPath = path.join(app.getPath('appData'), 'SastraGetWay_Data', 'pending_oauth.json');
            fs.writeFileSync(sessionPath, JSON.stringify({
              state,
              codeVerifier: codeVerifier || '',
              redirectUri,
              provider: 'antigravity',
              timestamp: Date.now()
            }, null, 2));
            shell.openExternal(authUrl);
            resolve({ success: true, authUrl });
            return;
          }
        } catch (e) { }
        shell.openExternal('https://aistudio.google.com/app/apikey');
        resolve({ success: true });
      });
    }).on('error', () => {
      shell.openExternal('https://aistudio.google.com/app/apikey');
      resolve({ success: false });
    });
  });
});

// ============================================================================
// 🌐 GEMINI WEB CHAT GATEWAY (Direct https://gemini.google.com/app Bridge)
// ============================================================================
const geminiWebWindows = new Map();
let geminiWebRoundRobinIdx = 0;
let geminiWebBridgeServer = null;
const GEMINI_WEB_BRIDGE_PORT = 20129;
const geminiWebAccountTails = new Map();

function geminiWebAccountIndexFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'gemini.google.com') return '';
    const pathAccount = url.pathname.match(/^\/u\/(\d{1,2})\/app(?:\/|$)/);
    if (pathAccount) return pathAccount[1];
    const queryAccount = url.searchParams.get('authuser') || '';
    return /^\d{1,2}$/.test(queryAccount) ? queryAccount : '';
  } catch (e) { return ''; }
}

function isGeminiWebAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === 'gemini.google.com' && /^\/(?:u\/\d{1,2}\/)?app(?:\/|$)/.test(url.pathname);
  } catch (e) { return false; }
}

function geminiWebAppUrl(accRow) {
  try {
    const data = JSON.parse(accRow.data || '{}');
    if (/^\d{1,2}$/.test(String(data.authuser || ''))) {
      return `https://gemini.google.com/u/${data.authuser}/app`;
    }
  } catch (e) { }
  return 'https://gemini.google.com/app';
}

async function runGeminiWebAccountRequest(accRow, promptText, requestedModel) {
  const previous = geminiWebAccountTails.get(accRow.id);
  let release;
  const current = new Promise(resolve => { release = resolve; });
  geminiWebAccountTails.set(accRow.id, current);
  if (previous) await previous;
  try {
    return await executeGeminiWebPrompt(accRow, promptText, requestedModel);
  } finally {
    release();
    if (geminiWebAccountTails.get(accRow.id) === current) geminiWebAccountTails.delete(accRow.id);
  }
}

async function ensureGeminiWebWindow(accRow, showWindow = false) {
  const id = accRow.id;
  let d = {};
  try { d = JSON.parse(accRow.data || '{}'); } catch (e) { }
  const partition = d.partition || `persist:gemini_web_${id}`;

  let win = geminiWebWindows.get(id);
  if (win && !win.isDestroyed()) {
    if (showWindow) {
      win.show();
      win.focus();
    }
    const currUrl = win.webContents.getURL() || '';
    const expectedAccount = /^\d{1,2}$/.test(String(d.authuser || '')) ? String(d.authuser) : '';
    if (!isGeminiWebAppUrl(currUrl) || (expectedAccount && geminiWebAccountIndexFromUrl(currUrl) !== expectedAccount)) {
      const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      await win.loadURL(geminiWebAppUrl(accRow), { userAgent: chromeUA }).catch(() => { });
    }
    return win;
  }

  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  win = new BrowserWindow({
    width: 1020,
    height: 780,
    show: showWindow,
    title: `DIGITALIKH GETWAY — Gemini Web Chat (${accRow.email || accRow.name || 'Gmail'})`,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition
    }
  });

  win.webContents.setUserAgent(chromeUA);
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'notifications') return callback(false);
      callback(true);
    });
    win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'notifications') return false;
      return true;
    });
  } catch (e) { }
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    geminiWebWindows.delete(id);
  });

  geminiWebWindows.set(id, win);
  await win.loadURL(geminiWebAppUrl(accRow), { userAgent: chromeUA }).catch(() => { });
  return win;
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
    } catch (e) { }
  }
  return str;
}

async function executeGeminiWebPrompt(accRow, promptText, requestedModel = 'gweb/gemini-3.8-flash') {
  const win = await ensureGeminiWebWindow(accRow, false);
  // Wait briefly if page is still loading
  for (let i = 0; i < 15; i++) {
    if (win.isDestroyed()) throw new Error('Gemini Web window closed');
    const urlNow = win.webContents.getURL() || '';
    if (isGeminiWebAppUrl(urlNow)) break;
    await new Promise(r => setTimeout(r, 400));
  }

  // If in an existing conversation thread (/app/<id>), reset to /app for a fresh clean slate
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const urlNow = win.webContents.getURL() || '';
  if (urlNow.includes('/app/') && !urlNow.endsWith('/app')) {
    await win.loadURL(geminiWebAppUrl(accRow), { userAgent: chromeUA }).catch(() => { });
    await new Promise(r => setTimeout(r, 700));
  }

  const safePromptJson = JSON.stringify(String(promptText || ''));
  const safeModelJson = JSON.stringify(String(requestedModel || ''));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const promptText = ${safePromptJson};
      const reqModel = ${safeModelJson}.toLowerCase();
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // Block HTML5 desktop notifications so Windows never shows toast popups
      try {
        window.Notification = class {
          constructor() { return { close: () => {} }; }
          static get permission() { return 'denied'; }
          static async requestPermission() { return 'denied'; }
        };
        if (window.Notification) {
          window.Notification.permission = 'denied';
          window.Notification.requestPermission = async () => 'denied';
        }
      } catch (e) {}

      // Verify logged in via WIZ_global_data or chat editor presence
      const wiz = window.WIZ_global_data || {};
      const findEditor = () => document.querySelector(
        'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
      );

      let editor = findEditor();
      for (let w = 0; w < 12 && !editor; w++) {
        await sleep(350);
        editor = findEditor();
      }

      // TRACK 1: Real Live DOM Chat in gemini.google.com/app
      if (editor) {
        try {
          // ALWAYS reset to clean New Chat if previous responses exist so Gemini doesn't get confused
          const existingResponses = document.querySelectorAll('model-response');
          if (existingResponses.length > 0) {
            const newChatBtn = document.querySelector(
              'a[href="/app"], a[href^="/u/"][href$="/app"], [aria-label*="New chat"], [aria-label*="ជជែកថ្មី"], button.new-chat-button, div[role="button"][aria-label*="New chat"]'
            );
            if (newChatBtn) {
              newChatBtn.click();
              await sleep(650);
              const freshEditor = findEditor();
              if (freshEditor) editor = freshEditor;
            }
          }

          const getResponseEls = () => Array.from(document.querySelectorAll(
            'model-response message-content, model-response .markdown, message-content.model-response-text, .model-response-text'
          ));
          const beforeEls = getResponseEls();
          const beforeCount = beforeEls.length;
          const beforeLastText = beforeCount > 0 ? (beforeEls[beforeCount - 1].innerText || '').trim() : '';

          editor.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);

          try {
            const dt = new DataTransfer();
            dt.setData('text/plain', promptText);
            const pasteEv = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            editor.dispatchEvent(pasteEv);
          } catch (e) {}

          if (!editor.innerText || editor.innerText.trim().length < Math.min(4, promptText.length)) {
            document.execCommand('insertText', false, promptText);
          }
          if (!editor.innerText || editor.innerText.trim().length < Math.min(4, promptText.length)) {
            editor.textContent = promptText;
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptText }));
          }

          await sleep(260);

          const sendBtn = document.querySelector(
            'button.send-button:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="ផ្ញើ"]:not([disabled]), button[mattooltip*="Send"]:not([disabled])'
          );
          if (sendBtn) {
            sendBtn.click();
          } else {
            editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }

          let stableTicks = 0;
          let lastCandidate = '';
          for (let tick = 0; tick < 260; tick++) {
            await sleep(350);
            const nowEls = getResponseEls();
            const isNewEl = nowEls.length > beforeCount;
            const latestEl = nowEls.length > 0 ? nowEls[nowEls.length - 1] : null;
            const currText = latestEl ? (latestEl.innerText || '').trim() : '';

            const stopBtn = document.querySelector(
              'button.send-button.stop, button[aria-label*="Stop"], button[aria-label*="បញ្ឈប់"], button[mattooltip*="Stop"], button[aria-label*="stop generating"]'
            );

            if ((isNewEl || (currText && currText !== beforeLastText)) && currText.length > 0) {
              const isStillStreaming = Boolean(stopBtn);
              const isJsonLooking = currText.trim().startsWith('{') || currText.includes('{"segments"');
              const isJsonIncomplete = isJsonLooking && (!currText.trim().endsWith('}') || !currText.includes(']}'));

              if (currText === lastCandidate && !isStillStreaming && !isJsonIncomplete) {
                stableTicks++;
                if (stableTicks >= 4) {
                  return { ok: true, text: currText, method: 'dom' };
                }
              } else {
                lastCandidate = currText;
                stableTicks = 0;
              }
            }
          }
          if (lastCandidate && lastCandidate.length > 0) {
            return { ok: true, text: lastCandidate, method: 'dom-partial' };
          }
        } catch (domErr) {}
      }

      // TRACK 2: Direct In-Page StreamGenerate RPC Fallback
      const at = wiz.SNlM0e;
      const bl = wiz.cfb2h || 'boq_assistant-bard-web-server_20260510.00_p0';
      const fsid = wiz.FdrFJe || '';
      if (at) {
        const reqId = Math.floor(100000 + Math.random() * 900000);
        const inner = JSON.stringify([
          [promptText, 0, null, null, null, null, 0],
          ["km"],
          ["", "", ""],
          null,
          null,
          null,
          [1],
          1,
          null,
          null,
          1,
          0
        ]);
        const freq = JSON.stringify([null, inner]);
        const url = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=' +
          encodeURIComponent(bl) + '&f.sid=' + encodeURIComponent(fsid) + '&hl=km&_reqid=' + reqId + '&rt=c';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ 'f.req': freq, 'at': at }).toString(),
          credentials: 'include'
        });
        if (res.ok) {
          const raw = await res.text();
          let bestText = '';
          for (const line of raw.split('\\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('[[')) continue;
            try {
              const outer = JSON.parse(trimmed);
              for (const item of outer) {
                if (Array.isArray(item) && item[0] === 'wrb.fr' && typeof item[2] === 'string') {
                  const payload = JSON.parse(item[2]);
                  const candidate = payload?.[4]?.[0]?.[1]?.[0];
                  if (typeof candidate === 'string' && candidate.length >= bestText.length) {
                    bestText = candidate;
                  }
                }
              }
            } catch (e) {}
          }
          if (bestText && bestText.trim()) {
            return { ok: true, text: bestText.trim(), method: 'rpc' };
          }
        }
      }

      return { ok: false, error: 'គណនី Gemini Web មិនទាន់ Login ចូល gemini.google.com/app ឬមិនអាចទាញចម្លើយបានទេ។' };
    })()
  `);

  if (result && result.ok && accRow.name && accRow.name.startsWith('Gemini Web #')) {
    win.webContents.executeJavaScript(`
      (() => {
        try {
          const selectors = [
            'a[href*="SignOutOptions"]',
            'a[aria-label*="@gmail.com"]',
            'a[aria-label*="@"]',
            'button[aria-label*="@gmail.com"]',
            'button[aria-label*="@"]',
            'img[alt*="@gmail.com"]',
            '[aria-label*="@gmail.com"]'
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) {
              const txt = el.getAttribute('aria-label') || el.getAttribute('alt') || el.innerText || '';
              const m = txt.match(/[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}/);
              if (m) return m[0];
            }
          }
          if (window.WIZ_global_data && window.WIZ_global_data.oPEP7c) return window.WIZ_global_data.oPEP7c;
        } catch (e) {}
        return '';
      })()
    `).then(detected => {
      if (detected && detected.includes('@')) {
        const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
        if (fs.existsSync(dbPath)) {
          const db = new sqlite.DatabaseSync(dbPath);
          db.prepare("UPDATE providerConnections SET name = ?, email = ? WHERE id = ?").run(detected, detected, accRow.id);
          syncGatewayRoutingInDb(db);
          db.close();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-updated', { id: accRow.id, email: detected });
          }
        }
      }
    }).catch(() => { });
  }

  if (result && result.ok && result.text) {
    result.text = extractCleanJson(result.text);
  }

  return result;
}

function parseFlexibleCookiesInput(rawInput) {
  const cookies = [];
  if (!rawInput) return cookies;

  if (Array.isArray(rawInput)) {
    for (const item of rawInput) {
      if (item && item.name && item.value !== undefined) {
        cookies.push({
          name: String(item.name).trim(),
          value: String(item.value).trim(),
          domain: item.domain || '.google.com',
          path: item.path || '/',
          secure: item.secure !== false,
          httpOnly: Boolean(item.httpOnly),
          hostOnly: Boolean(item.hostOnly),
          sameSite: item.sameSite || 'unspecified',
          expirationDate: item.expirationDate || item.expiration || undefined
        });
      }
    }
    return cookies;
  }

  const text = String(rawInput || '').trim();
  if (!text) return cookies;

  // 1. JSON array or object (Cookie-Editor JSON export)
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cookies) ? parsed.cookies : [parsed]);
      for (const item of arr) {
        if (item && item.name && item.value !== undefined) {
          cookies.push({
            name: String(item.name).trim(),
            value: String(item.value).trim(),
            domain: item.domain || '.google.com',
            path: item.path || '/',
            secure: item.secure !== false,
            httpOnly: Boolean(item.httpOnly),
            hostOnly: Boolean(item.hostOnly),
            sameSite: item.sameSite || 'unspecified',
            expirationDate: item.expirationDate || item.expiration || undefined
          });
        }
      }
      if (cookies.length > 0) return cookies;
    } catch (e) { }
  }

  // 2. Netscape cookies.txt format (tab-separated lines)
  if (text.includes('\t')) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split('\t');
      if (parts.length >= 7) {
        cookies.push({
          domain: parts[0] || '.google.com',
          path: parts[2] || '/',
          secure: parts[3].toUpperCase() === 'TRUE',
          name: parts[5].trim(),
          value: parts[6].trim(),
          httpOnly: false
        });
      }
    }
    if (cookies.length > 0) return cookies;
  }

  // 3. Header string format: name=value; name2=value2
  if (text.includes('=')) {
    const pairs = text.replace(/^cookie\s*:\s*/i, '').split(/[;\r\n]+/);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const name = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        if (name && value) {
          cookies.push({
            name,
            value,
            domain: '.google.com',
            path: '/',
            secure: true,
            httpOnly: name.startsWith('__Secure-') || name === 'SID' || name === 'HSID' || name === 'SSID'
          });
        }
      }
    }
    if (cookies.length > 0) return cookies;
  }

  // 4. Bare __Secure-1PSID token value (e.g., g.a000...)
  if (text.length > 25 && !text.includes(' ')) {
    cookies.push({
      name: '__Secure-1PSID',
      value: text,
      domain: '.google.com',
      path: '/',
      secure: true,
      httpOnly: true
    });
  }

  return cookies;
}

async function importGeminiWebCookiesToPool(rawCookiesInput, emailHint = '', authuser = '') {
  const { session } = require('electron');
  const crypto = require('crypto');
  const selectedAuthuser = /^\d{1,2}$/.test(String(authuser)) ? String(authuser) : '';

  let inputToParse = rawCookiesInput;
  if (!inputToParse || (typeof inputToParse === 'string' && !inputToParse.trim())) {
    inputToParse = clipboard.readText() || '';
  }

  const parsedCookies = parseFlexibleCookiesInput(inputToParse);
  const hasGoogleAuth = parsedCookies.some(c =>
    c.name === '__Secure-1PSID' || c.name === 'SID' || c.name === '__Secure-3PSID' || c.name === 'SAPISID'
  );

  if (parsedCookies.length === 0 || !hasGoogleAuth) {
    return {
      ok: false,
      error: 'រកមិនឃើញ Cookie គណនី Google (__Secure-1PSID / SID) នៅក្នុង Clipboard ទេ! សូមចុចរូប 🍪 Cookie-Editor នៅលើទំព័រ gemini.google.com ក្នុង Chrome រួចចុច Export (Copy) ជាមុនសិន។'
    };
  }

  const tempId = crypto.randomUUID();
  const partition = `persist:gemini_web_${tempId}`;
  const ses = session.fromPartition(partition);
  const expDate = Math.floor(Date.now() / 1000) + 365 * 86400;
  let importedCookieCount = 0;
  let importedAuthCookie = false;

  for (const c of parsedCookies) {
    if (!c.name || !c.value) continue;
    const cleanDomain = String(c.domain || '.google.com').trim();
    const host = cleanDomain.replace(/^\./, '').toLowerCase();
    if (host !== 'google.com' && !host.endsWith('.google.com')) continue;
    const isHostOnly = c.hostOnly === true || c.name.startsWith('__Host-');
    const sameSite = ['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite)
      ? c.sameSite : 'unspecified';
    const expirationDate = Number(c.expirationDate);
    try {
      await ses.cookies.set({
        url: `https://${host}${String(c.path || '/').startsWith('/') ? c.path || '/' : '/'}`,
        name: c.name,
        value: c.value,
        ...(isHostOnly ? {} : { domain: cleanDomain.startsWith('.') ? cleanDomain : `.${host}` }),
        path: isHostOnly ? '/' : c.path || '/',
        secure: c.secure !== false,
        httpOnly: Boolean(c.httpOnly),
        sameSite,
        expirationDate: Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000 ? expirationDate : expDate
      });
      importedCookieCount++;
      if (['__Secure-1PSID', 'SID', '__Secure-3PSID', 'SAPISID'].includes(c.name)) importedAuthCookie = true;
    } catch (e) { }
  }

  if (!importedAuthCookie) {
    return { ok: false, error: 'មិនអាចផ្ទេរ Google Login Cookies ទៅ Gemini Web បានទេ។ សូមសាក Chrome Connector ម្ដងទៀត។' };
  }

  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const win = new BrowserWindow({
    width: 1020,
    height: 760,
    show: false,
    title: 'DIGITALIKH GETWAY — Gemini Web Chat Engine',
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition
    }
  });
  win.webContents.setUserAgent(chromeUA);
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'notifications') return callback(false);
      callback(true);
    });
    win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'notifications') return false;
      return true;
    });
  } catch (e) { }
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  const selectedUrl = selectedAuthuser
    ? `https://gemini.google.com/u/${selectedAuthuser}/app`
    : 'https://gemini.google.com/app';
  await win.loadURL(selectedUrl, { userAgent: chromeUA }).catch(() => { });

  let info = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 450));
    if (win.isDestroyed()) break;
    if (!isGeminiWebAppUrl(win.webContents.getURL())) continue;
    info = await win.webContents.executeJavaScript(`
      (() => {
        const wiz = window.WIZ_global_data || {};
        const snlm0e = wiz.SNlM0e || '';
        const hasEditor = !!document.querySelector('rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]');
        let email = wiz.oPEP7c || '';
        if (!email) {
          const ariaEl = document.querySelector('[aria-label*="@gmail.com"], [aria-label*="@"]');
          if (ariaEl) {
            const m = (ariaEl.getAttribute('aria-label') || '').match(/[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}/);
            if (m) email = m[0];
          }
        }
        if (!email) {
          const bodyMatch = (document.body?.innerHTML || '').match(/[\\w.+-]+@gmail\\.com/);
          if (bodyMatch) email = bodyMatch[0];
        }
        return {
          snlm0e,
          hasEditor,
          cfb2h: wiz.cfb2h || '',
          fdrfje: wiz.FdrFJe || '',
          email: email || ''
        };
      })()
    `).catch(() => null);
    if (info && (info.snlm0e || info.hasEditor)) break;
  }

  const finalUrl = win.isDestroyed() ? '' : win.webContents.getURL();
  const actualAuthuser = geminiWebAccountIndexFromUrl(finalUrl);
  if (!isGeminiWebAppUrl(finalUrl) || (!info?.snlm0e && !info?.hasEditor)) {
    if (!win.isDestroyed()) win.destroy();
    return { ok: false, error: 'មិនអាចផ្ទៀងផ្ទាត់ Gemini Web Login បានទេក្នុងកម្មវិធី។ សូម Reload Chrome Connector រួចសាកម្ដងទៀត។' };
  }
  if (selectedAuthuser && actualAuthuser !== selectedAuthuser) {
    if (!win.isDestroyed()) win.destroy();
    return { ok: false, error: `Gemini Web បានបើកគណនីលេខ ${actualAuthuser || 'ផ្សេង'} ជំនួសលេខ ${selectedAuthuser}។ សូមសាកម្ដងទៀត។` };
  }

  const detectedEmail = (info && info.email) || (emailHint && emailHint.trim()) || '';
  const emailLabel = detectedEmail
    ? detectedEmail
    : `Gemini Web Chrome #${Math.floor(100 + Math.random() * 900)}`;

  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  let finalId = tempId;
  const nowIso = new Date().toISOString();

  if (fs.existsSync(dbPath)) {
    const db = new sqlite.DatabaseSync(dbPath);
    const existing = detectedEmail && detectedEmail.includes('@')
      ? db.prepare("SELECT id FROM providerConnections WHERE provider = 'gemini-web' AND email = ?").get(detectedEmail)
      : null;

    const dataObj = {
      partition,
      authuser: selectedAuthuser || actualAuthuser,
      snlm0e: info?.snlm0e || '',
      cfb2h: info?.cfb2h || '',
      fdrfje: info?.fdrfje || '',
      cookieCount: importedCookieCount,
      testStatus: 'active',
      connectedAt: nowIso
    };

    if (existing) {
      finalId = existing.id;
      db.prepare("UPDATE providerConnections SET isActive = 1, name = ?, email = ?, data = ?, updatedAt = ? WHERE id = ?")
        .run(emailLabel, emailLabel, JSON.stringify(dataObj), nowIso, finalId);
    } else {
      db.prepare(`
        INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
        VALUES (?, 'gemini-web', 'web', ?, ?, 1, 1, ?, ?, ?)
      `).run(finalId, emailLabel, emailLabel, JSON.stringify(dataObj), nowIso, nowIso);
    }
    syncGatewayRoutingInDb(db);
    db.close();
  }

  geminiWebWindows.set(finalId, win);
  win.setTitle(`DIGITALIKH GETWAY — Gemini Web Chat (${emailLabel})`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gemini-web-connected', {
      id: finalId,
      email: emailLabel
    });
    mainWindow.webContents.send('engine-log', `[Gemini Web] Imported Chrome session for ${emailLabel} (${importedCookieCount} cookies)!`);
  }

  return {
    ok: true,
    id: finalId,
    email: emailLabel,
    cookieCount: importedCookieCount,
    message: `បានភ្ជាប់គណនី ${emailLabel} ពី Chrome ចូលទៅក្នុង Gemini Web Pool ដោយជោគជ័យ!`
  };
}

function startGeminiWebBridgeServer() {
  if (geminiWebBridgeServer) return;
  geminiWebBridgeServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, *');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/gemini-web/import-cookies') {
      let bStr = '';
      req.on('data', c => { bStr += c.toString(); });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(bStr || '{}');
          const out = await importGeminiWebCookiesToPool(parsed.cookies || parsed.rawCookies || '', parsed.email || '', parsed.authuser || '');
          res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/gemini-web/chat') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk.toString(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyStr || '{}');
        const promptText = String(body.prompt || '').trim();
        const rawRequestedModel = String(body.model || 'gweb/gemini-3.8-flash');
        const requestedModel = resolveModelAlias(rawRequestedModel);
        const requireJson = body.requireJson === true;

        const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
        if (!fs.existsSync(dbPath)) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Database not ready' }));
          return;
        }

        const db = new sqlite.DatabaseSync(dbPath);
        const rows = db.prepare("SELECT id, name, email, provider, isActive, data FROM providerConnections WHERE provider = 'gemini-web' AND isActive = 1 ORDER BY priority ASC, createdAt DESC").all();
        db.close();

        if (!rows || rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: 'មិនទាន់មានគណនី Gemini Web (gemini.google.com/app) នៅក្នុង Pool ទេ! សូមចុចប៊ូតុង "🌐 + Gemini Web" ដើម្បី Login Gmail ជាមុនសិន។'
          }));
          return;
        }

        const startIdx = geminiWebRoundRobinIdx++ % rows.length;
        // Structured translation callers retry failures themselves. Trying every
        // browser account here can exceed their request deadline before they can retry.
        const maxAccountAttempts = requireJson ? 1 : rows.length;
        let lastErr = '';

        for (let attempt = 0; attempt < maxAccountAttempts; attempt++) {
          const accRow = rows[(startIdx + attempt) % rows.length];
          const reqId = require('crypto').randomUUID();
          const startTime = Date.now();

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry-event', {
              type: 'start',
              reqId,
              timestamp: new Date(startTime).toISOString(),
              endpoint: '/v1/chat/completions (Gemini Web)',
              model: requestedModel,
              email: accRow.email || accRow.name || 'Gemini Web Gmail'
            });
          }

          try {
            const out = await runGeminiWebAccountRequest(accRow, promptText, requestedModel);
            if (out && out.ok && out.text) {
              let replyText = out.text;
              if (requireJson) {
                replyText = extractCleanJson(replyText);
                try { JSON.parse(replyText); }
                catch {
                  throw new Error('Gemini Web returned incomplete JSON; retrying another account.');
                }
              }
              const promptTokens = Math.max(1, Math.round(promptText.length / 4));
              const completionTokens = Math.max(1, Math.round(replyText.length / 4));
              const totalTokens = promptTokens + completionTokens;
              const nowIso = new Date().toISOString();

              try {
                const dbLog = new sqlite.DatabaseSync(dbPath);
                dbLog.prepare(`
                  INSERT INTO usageHistory (timestamp, provider, model, connectionId, endpoint, promptTokens, completionTokens, cost, tokens, status)
                  VALUES (?, 'gemini-web', ?, ?, '/v1/chat/completions', ?, ?, 0, ?, '200')
                `).run(nowIso, requestedModel, accRow.id, promptTokens, completionTokens, totalTokens);
                dbLog.close();
              } catch (e) { }

              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('telemetry-event', {
                  type: 'end',
                  reqId,
                  model: requestedModel,
                  statusCode: 200,
                  elapsedMs: Date.now() - startTime
                });
              }

              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({
                ok: true,
                text: replyText,
                method: out.method,
                email: accRow.email || accRow.name,
                model: requestedModel,
                promptTokens,
                completionTokens,
                totalTokens
              }));
              return;
            }
            lastErr = out?.error || 'Empty response from Gemini Web';
          } catch (err) {
            lastErr = err.message || String(err);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('telemetry-event', {
              type: 'end',
              reqId,
              model: requestedModel,
              statusCode: 503,
              elapsedMs: Date.now() - startTime
            });
          }
        }

        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: lastErr || 'All Gemini Web accounts failed' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  });

  geminiWebBridgeServer.on('error', (err) => {
    console.error('[GeminiWebBridge Error]:', err.message);
  });
  geminiWebBridgeServer.listen(GEMINI_WEB_BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[GeminiWebBridge] Listening on http://127.0.0.1:${GEMINI_WEB_BRIDGE_PORT}`);
  });
}

ipcMain.handle('add-gemini-web', async () => {
  const crypto = require('crypto');
  const tempId = crypto.randomUUID();
  const partition = `persist:gemini_web_${tempId}`;
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const loginWin = new BrowserWindow({
    width: 1020,
    height: 780,
    parent: mainWindow || undefined,
    title: 'ភ្ជាប់គណនី Gmail ចូល Gemini Web (gemini.google.com/app)',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition
    }
  });

  loginWin.webContents.setUserAgent(chromeUA);
  try {
    loginWin.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'notifications') return callback(false);
      callback(true);
    });
    loginWin.webContents.session.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'notifications') return false;
      return true;
    });
  } catch (e) { }
  loginWin.loadURL('https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fgemini.google.com%2Fapp', { userAgent: chromeUA }).catch(() => { });

  let connected = false;
  let checking = false;

  const checkLoginStatus = async () => {
    if (connected || checking || loginWin.isDestroyed()) return;
    const currUrl = loginWin.webContents.getURL() || '';
    if (!isGeminiWebAppUrl(currUrl)) return;

    checking = true;
    try {
      const info = await loginWin.webContents.executeJavaScript(`
        (() => {
          const wiz = window.WIZ_global_data || {};
          const snlm0e = wiz.SNlM0e || '';
          if (!snlm0e) return null;
          let email = wiz.oPEP7c || '';
          if (!email) {
            const ariaEl = document.querySelector('[aria-label*="@gmail.com"], [aria-label*="@"]');
            if (ariaEl) {
              const m = (ariaEl.getAttribute('aria-label') || '').match(/[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}/);
              if (m) email = m[0];
            }
          }
          if (!email) {
            const bodyMatch = (document.body?.innerHTML || '').match(/[\\w.+-]+@gmail\\.com/);
            if (bodyMatch) email = bodyMatch[0];
          }
          return {
            snlm0e,
            cfb2h: wiz.cfb2h || '',
            fdrfje: wiz.FdrFJe || '',
            email: email || 'Gemini Web Gmail'
          };
        })()
      `).catch(() => null);

      if (info && info.snlm0e) {
        connected = true;
        clearInterval(poller);

        const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
        let finalId = tempId;
        const nowIso = new Date().toISOString();
        let emailLabel = info.email && info.email.includes('@') ? info.email : '';
        if (!emailLabel) {
          for (let emAttempt = 0; emAttempt < 10; emAttempt++) {
            await new Promise(r => setTimeout(r, 450));
            if (loginWin.isDestroyed()) break;
            const em = await loginWin.webContents.executeJavaScript(`
              (() => {
                const selectors = [
                  'a[href*="SignOutOptions"]',
                  'a[aria-label*="@gmail.com"]',
                  'a[aria-label*="@"]',
                  'button[aria-label*="@gmail.com"]',
                  'button[aria-label*="@"]',
                  'img[alt*="@gmail.com"]',
                  '[aria-label*="@gmail.com"]'
                ];
                for (const s of selectors) {
                  const el = document.querySelector(s);
                  if (el) {
                    const txt = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
                    const m = txt.match(/[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}/);
                    if (m) return m[0];
                  }
                }
                if (window.WIZ_global_data && window.WIZ_global_data.oPEP7c) return window.WIZ_global_data.oPEP7c;
                const matches = (document.body?.innerHTML || '').match(/[\\w.+-]+@gmail\\.com/g) || [];
                const valid = matches.filter(e => !e.includes('support') && !e.includes('help') && !e.includes('google.com'));
                return valid.length > 0 ? valid[0] : '';
              })()
            `).catch(() => '');
            if (em && em.includes('@')) {
              emailLabel = em;
              break;
            }
          }
        }
        if (!emailLabel) {
          emailLabel = `Gemini Web #${Math.floor(100 + Math.random() * 900)}`;
        }

        if (fs.existsSync(dbPath)) {
          const db = new sqlite.DatabaseSync(dbPath);
          const existing = info.email && info.email.includes('@')
            ? db.prepare("SELECT id, data FROM providerConnections WHERE provider = 'gemini-web' AND email = ?").get(info.email)
            : null;

          const dataObj = {
            partition,
            authuser: geminiWebAccountIndexFromUrl(loginWin.webContents.getURL()),
            snlm0e: info.snlm0e,
            cfb2h: info.cfb2h,
            fdrfje: info.fdrfje,
            testStatus: 'active',
            connectedAt: nowIso
          };

          if (existing) {
            finalId = existing.id;
            db.prepare("UPDATE providerConnections SET isActive = 1, name = ?, email = ?, data = ?, updatedAt = ? WHERE id = ?")
              .run(emailLabel, emailLabel, JSON.stringify(dataObj), nowIso, finalId);
          } else {
            db.prepare(`
              INSERT INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
              VALUES (?, 'gemini-web', 'web', ?, ?, 1, 1, ?, ?, ?)
            `).run(finalId, emailLabel, emailLabel, JSON.stringify(dataObj), nowIso, nowIso);
          }
          syncGatewayRoutingInDb(db);
          db.close();
        }

        // Keep window in background pool for instant live chat execution
        geminiWebWindows.set(finalId, loginWin);
        loginWin.removeAllListeners('close');
        loginWin.on('close', (e) => {
          if (!isQuitting) {
            e.preventDefault();
            loginWin.hide();
          }
        });
        loginWin.setTitle(`DIGITALIKH GETWAY — Gemini Web Chat (${emailLabel})`);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('gemini-web-connected', {
            id: finalId,
            email: emailLabel
          });
          mainWindow.webContents.send('engine-log', `[Gemini Web] Connected account ${emailLabel} to gemini.google.com/app pool!`);
        }
      }
    } catch (e) { }
    checking = false;
  };

  const poller = setInterval(checkLoginStatus, 1200);
  loginWin.on('closed', () => {
    clearInterval(poller);
  });

  return {
    ok: true,
    message: 'បានបើកផ្ទាំង gemini.google.com/app! សូម Login គណនី Gmail របស់បង ប្រព័ន្ធនឹងភ្ជាប់ចូល Pool ដោយស្វ័យប្រវត្តិ។'
  };
});

ipcMain.handle('open-gemini-web-window', async (_event, id) => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return { ok: false, error: 'Database not found' };
  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const row = db.prepare("SELECT id, name, email, provider, isActive, data FROM providerConnections WHERE id = ?").get(id);
    db.close();
    if (!row) return { ok: false, error: 'Account not found' };
    await ensureGeminiWebWindow(row, true);
    return { ok: true, email: row.email || row.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('import-gemini-web-cookies', async (_event, payload = {}) => {
  try {
    const rawCookies = payload && typeof payload === 'object' ? (payload.rawCookies || payload.cookies || '') : String(payload || '');
    const emailHint = payload && typeof payload === 'object' ? (payload.email || payload.label || '') : '';
    const authuser = payload && typeof payload === 'object' ? (payload.authuser || '') : '';
    return await importGeminiWebCookiesToPool(rawCookies, emailHint, authuser);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function findChromeExecutable() {
  return [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ].find(p => p && fs.existsSync(p));
}

ipcMain.handle('open-chrome-gemini-web', async () => {
  const geminiUrl = 'https://gemini.google.com/app?sastra_connect=1';
  const targetUrl = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(geminiUrl)}`;
  const chromeExe = findChromeExecutable();
  try {
    if (chromeExe) {
      const browser = spawn(chromeExe, [targetUrl], { detached: true, stdio: 'ignore', windowsHide: true });
      browser.unref();
    } else {
      await shell.openExternal(targetUrl);
    }
    return { ok: true, url: targetUrl, browser: chromeExe ? 'chrome' : 'default' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-chrome-extension-folder', async () => {
  try {
    const extSrcCandidates = [
      path.join(__dirname, 'chrome-extension'),
      path.join(process.resourcesPath || '', 'app', 'chrome-extension'),
      'C:\\SastraGetWay\\chrome-extension'
    ];
    const srcDir = extSrcCandidates.find(p => fs.existsSync(p));
    if (!srcDir) return { ok: false, error: 'Chrome Connector files not found' };
    const destDir = path.join(app.getPath('appData'), 'SastraGetWay_Data', 'chrome-extension');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    if (srcDir !== destDir) {
      for (const file of ['manifest.json', 'background.js', 'content.js']) {
        const sp = path.join(srcDir, file);
        if (fs.existsSync(sp)) {
          fs.copyFileSync(sp, path.join(destDir, file));
        }
      }
    }
    clipboard.writeText(destDir);
    await shell.openPath(destDir);
    const chromeExe = findChromeExecutable();
    if (chromeExe) {
      const browser = spawn(chromeExe, ['chrome://extensions'], { detached: true, stdio: 'ignore', windowsHide: true });
      browser.unref();
    }
    return { ok: true, path: destDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('run-pool-action', async (_event, { action, payload } = {}) => {
  const dbPath = path.join(app.getPath('appData'), '9router', 'db', 'data.sqlite');
  if (!fs.existsSync(dbPath)) return { success: false, message: 'Database not found' };

  try {
    const db = new sqlite.DatabaseSync(dbPath);
    const liveQuotas = quotaCache.data?.accountQuotas || {};
    const rows = db.prepare("SELECT id, email, name, provider, isActive, data FROM providerConnections WHERE provider = 'antigravity' ORDER BY priority ASC, createdAt DESC").all();

    const isRow403 = (r) => {
      try {
        const d = JSON.parse(r.data || '{}');
        return Boolean(
          d.errorCode === 403 ||
          (d.lastError && (String(d.lastError).includes('403') || String(d.lastError).toLowerCase().includes('disabled in this account')))
        );
      } catch (e) {
        return false;
      }
    };

    const isRowEmptyOrCooling = (r) => {
      if (liveQuotas[r.id] && liveQuotas[r.id].remainingPct === 0) return true;
      try {
        const d = JSON.parse(r.data || '{}');
        if (d.errorCode === 429 || d.testStatus === 'unavailable') return true;
      } catch (e) { }
      return false;
    };

    if (action === 'turn-off-empty') {
      let count = 0;
      for (const r of rows) {
        if (r.isActive && (isRow403(r) || isRowEmptyOrCooling(r))) {
          db.prepare('UPDATE providerConnections SET isActive = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), r.id);
          count++;
        }
      }
      db.close();
      return { success: true, count, message: `Turned OFF ${count} empty / cooling / disabled account(s).` };
    }

    if (action === 'turn-on-available') {
      const maxActive = Number(payload?.maxActive) || 8;
      let activeNow = rows.filter(r => r.isActive && !isRow403(r) && !isRowEmptyOrCooling(r)).length;
      let count = 0;
      for (const r of rows) {
        if (isRow403(r) || isRowEmptyOrCooling(r)) {
          if (r.isActive) {
            db.prepare('UPDATE providerConnections SET isActive = 0, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), r.id);
          }
          continue;
        }
        if (!r.isActive && activeNow < maxActive) {
          db.prepare('UPDATE providerConnections SET isActive = 1, updatedAt = ? WHERE id = ?').run(new Date().toISOString(), r.id);
          activeNow++;
          count++;
        }
      }
      db.close();
      return { success: true, count, activeNow, message: `Enabled ${count} available account(s) (${activeNow} total active within safe limit).` };
    }

    if (action === 'clean-disabled-403') {
      let count = 0;
      for (const r of rows) {
        if (isRow403(r)) {
          db.prepare('DELETE FROM providerConnections WHERE id = ?').run(r.id);
          count++;
        }
      }
      db.close();
      return { success: true, count, message: `Removed ${count} Google-suspended (403) account(s).` };
    }

    if (action === 'apply-antiban-preset') {
      // 1. Set Fill-First (Round Robin OFF), Sticky = 25, Cache = 5m
      UPSTREAM_QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
      const sRow = db.prepare('SELECT data FROM settings WHERE id = 1').get();
      let sData = {};
      if (sRow && sRow.data) {
        try { sData = JSON.parse(sRow.data); } catch (e) { }
      }
      sData.requireApiKey = false;
      sData.requireLogin = false;
      sData.password = null;
      sData.fallbackStrategy = 'fill-first';
      sData.stickyRoundRobinLimit = 25;
      sData.quotaCacheMinutes = 5;
      sData.autoDisable403 = true;
      if (!sData.providerStrategies || typeof sData.providerStrategies !== 'object') {
        sData.providerStrategies = {};
      }
      sData.providerStrategies.antigravity = {
        ...(sData.providerStrategies.antigravity || {}),
        fallbackStrategy: 'fill-first',
        stickyRoundRobinLimit: 25
      };
      db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
        JSON.stringify(sData)
      );

      // 2. Sanitize projectId and keep up to 6 healthy accounts active
      let healthyActive = 0;
      for (const r of rows) {
        const d = JSON.parse(r.data || '{}');
        if (!d.projectId || String(d.projectId).trim() === '') {
          d.projectId = 'aicode-consumers';
        }
        let nextActive = r.isActive;
        if (isRow403(r) || isRowEmptyOrCooling(r)) {
          nextActive = 0;
        } else if (nextActive) {
          if (healthyActive < 6) {
            healthyActive++;
          } else {
            nextActive = 0;
          }
        }
        db.prepare('UPDATE providerConnections SET isActive = ?, data = ?, updatedAt = ? WHERE id = ?').run(
          nextActive,
          JSON.stringify(d),
          new Date().toISOString(),
          r.id
        );
      }
      db.close();
      return {
        success: true,
        message: 'Anti-Ban Shield Activated: Safe Fill-First mode, Sticky 25, 5m Quota Cache, and healthy pool protection applied.'
      };
    }

    db.close();
    if (action === 'refresh-quotas-safe') {
      quotaCache.timestamp = 0;
      await fetchLiveQuotaStats();
      return { success: true, message: 'Safely refreshed pool quotas one-by-one.' };
    }

    return { success: false, message: 'Unknown pool action' };
  } catch (e) {
    console.error('[run-pool-action Error]:', e.message);
    return { success: false, message: e.message };
  }
});

ipcMain.handle('add-google-account', async () => {
  return new Promise(async (resolve) => {
    const redirectUri = 'http://localhost:20128/callback';
    const reqUrl = `http://127.0.0.1:20128/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

    // 1. Ensure Router Engine on 20128 is online; start it if down
    const pingEngine = () => new Promise((r) => {
      const p = http.get(SERVER_URL, () => r(true));
      p.on('error', () => r(false));
      p.setTimeout(600, () => { p.destroy(); r(false); });
    });

    let isUp = await pingEngine();
    if (!isUp) {
      console.log('[Add Gmail] Router Engine is offline. Auto-starting engine...');
      if (getLicenseStatus().valid) {
        startEngine();
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if (await pingEngine()) {
            isUp = true;
            console.log('[Add Gmail] Engine came online successfully.');
            break;
          }
        }
      }
    }

    if (!isUp) {
      const msg = 'Router Engine (127.0.0.1:20128) មិនទាន់ Ready ទេ។ សូមរង់ចាំ ២-៣ វិនាទី រួចចុចម្តងទៀត!';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-log', '[Error] ' + msg);
      }
      resolve({ success: false, error: msg });
      return;
    }

    // 2. Fetch OAuth Authorize URL from Engine
    http.get(reqUrl, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const authUrl = json.data?.authUrl || json.authUrl;
          const state = json.data?.state || json.state;
          const codeVerifier = json.data?.codeVerifier || json.codeVerifier;

          if (authUrl) {
            const sessionPath = path.join(app.getPath('appData'), 'SastraGetWay_Data', 'pending_oauth.json');
            fs.writeFileSync(sessionPath, JSON.stringify({
              state: state || '',
              codeVerifier: codeVerifier || '',
              redirectUri,
              provider: 'antigravity',
              timestamp: Date.now()
            }, null, 2));
            console.log('[OAuth Session Saved] codeVerifier stored to:', sessionPath);

            shell.openExternal(authUrl);
            resolve({ success: true, authUrl });
            return;
          }
        } catch (e) {
          console.error('[OAuth Authorize Parse Error]:', e.message);
        }
        const errDesc = 'Could not obtain Google OAuth URL from engine.';
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine-log', '[OAuth Error] ' + errDesc);
        }
        resolve({ success: false, error: errDesc });
      });
    }).on('error', (err) => {
      console.error('[OAuth Authorize Req Error]:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-log', '[OAuth Error] Connection failed: ' + err.message);
      }
      resolve({ success: false, error: err.message });
    });
  });
});


ipcMain.handle('open-external', (_event, url) => {
  if (url) shell.openExternal(url);
  return true;
});

ipcMain.handle('copy-to-clipboard', (_event, text) => {
  if (text) {
    clipboard.writeText(String(text));
    return true;
  }
  return false;
});

ipcMain.handle('get-engine-status', () => {
  const lic = getLicenseStatus();
  return { online: Boolean(lic.valid && engineProcess), port: PORT, host: HOST, licensed: lic.valid };
});

ipcMain.handle('get-license-status', () => {
  return getLicenseStatus();
});

ipcMain.handle('register-account', async (_event, payload) => {
  const res = await licenseManager.registerWithGmailAndKey(payload || {});
  if (res && res.ok) {
    lastAuthNoticeStatus = null;
    transitionToMainWindow(res.status);
  }
  return res;
});

ipcMain.handle('login-account', async (_event, payload) => {
  const res = await licenseManager.loginWithGmail(payload || {});
  if (res && res.ok) {
    lastAuthNoticeStatus = null;
    transitionToMainWindow(res.status);
  }
  return res;
});

ipcMain.handle('logout-account', async () => {
  const res = await licenseManager.logoutCurrentSession();
  lastAuthNoticeStatus = null;
  transitionToActivateWindow(res.status);
  return res.status;
});

ipcMain.handle('activate-license', async (_event, rawKey) => {
  return getLicenseStatus();
});

ipcMain.handle('deactivate-license', async () => {
  const res = await licenseManager.logoutCurrentSession();
  lastAuthNoticeStatus = null;
  transitionToActivateWindow(res.status);
  return res.status;
});

// 6.5 GitHub Auto-Update System (https://github.com/pphanet01-hash/Digitalikh_GetWay)
const GITHUB_REPO = 'pphanet01-hash/Digitalikh_GetWay';
const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;

function getCurrentAppVersion() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) return String(pkg.version).replace(/^v/i, '').trim();
    }
  } catch (e) { }
  return String(app.getVersion() || '2.0.5').replace(/^v/i, '').trim();
}

function compareVersions(v1, v2) {
  const p1 = String(v1 || '0.0.0').replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const p2 = String(v2 || '0.0.0').replace(/^v/i, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

async function checkForGitHubUpdates() {
  const currentVersion = getCurrentAppVersion();
  const headers = {
    'User-Agent': 'SastraGetWay-Updater/2.0',
    'Accept': 'application/vnd.github.v3+json',
    'Cache-Control': 'no-cache'
  };

  // 1. Check GitHub Releases API first
  try {
    const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(8000)
    });
    if (relRes.ok) {
      const rel = await relRes.json();
      const latestVersion = String(rel.tag_name || rel.name || '').replace(/^v/i, '').trim();
      if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
        const exeAsset = Array.isArray(rel.assets)
          ? rel.assets.find(a => a.name && a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().includes('blockmap'))
          : null;
        return {
          hasUpdate: true,
          currentVersion,
          latestVersion,
          mode: exeAsset ? 'installer' : 'hot',
          downloadUrl: exeAsset ? exeAsset.browser_download_url : null,
          assetName: exeAsset ? exeAsset.name : null,
          releaseNotes: rel.body || `Version v${latestVersion} is available on GitHub.`,
          htmlUrl: rel.html_url || GITHUB_REPO_URL,
          branch: 'main'
        };
      }
    }
  } catch (e) { }

  // 2. Check raw latest.yml or package.json on main / master branch for direct repository updates
  for (const branch of ['main', 'master']) {
    try {
      const ymlRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${branch}/latest.yml?t=${Date.now()}`, {
        headers: { 'User-Agent': 'SastraGetWay-Updater/2.0', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(6000)
      });
      if (ymlRes.ok) {
        const ymlText = await ymlRes.text();
        const verMatch = ymlText.match(/^version:\s*['"]?v?([0-9.]+)['"]?/m);
        const remoteVersion = verMatch ? verMatch[1].trim() : '';
        if (remoteVersion && compareVersions(remoteVersion, currentVersion) > 0) {
          return {
            hasUpdate: true,
            currentVersion,
            latestVersion: remoteVersion,
            mode: 'installer',
            downloadUrl: `${GITHUB_REPO_URL}/releases/download/v${remoteVersion}/DigitalikhGetWay.Setup.${remoteVersion}.exe`,
            assetName: `DigitalikhGetWay Setup ${remoteVersion}.exe`,
            releaseNotes: `New version v${remoteVersion} is available.`,
            htmlUrl: `${GITHUB_REPO_URL}/releases`,
            branch
          };
        }
      }
    } catch (e) { }

    try {
      const rawRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${branch}/package.json?t=${Date.now()}`, {
        headers: { 'User-Agent': 'SastraGetWay-Updater/2.0', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(6000)
      });
      if (rawRes.ok) {
        const pkg = await rawRes.json();
        const remoteVersion = String(pkg.version || '').replace(/^v/i, '').trim();
        if (remoteVersion && compareVersions(remoteVersion, currentVersion) > 0) {
          return {
            hasUpdate: true,
            currentVersion,
            latestVersion: remoteVersion,
            mode: 'hot',
            downloadUrl: null,
            releaseNotes: pkg.releaseNotes || `New version v${remoteVersion} pushed to ${GITHUB_REPO} (${branch}).`,
            htmlUrl: GITHUB_REPO_URL,
            branch
          };
        }
        return {
          hasUpdate: false,
          currentVersion,
          latestVersion: remoteVersion || currentVersion,
          htmlUrl: GITHUB_REPO_URL,
          branch
        };
      }
    } catch (e) { }
  }

  return {
    hasUpdate: false,
    currentVersion,
    latestVersion: currentVersion,
    htmlUrl: GITHUB_REPO_URL,
    branch: 'main'
  };
}

function downloadFileWithProgress(url, destPath, onProgress) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const request = (targetUrl, redirects = 0) => {
      if (redirects > 6) return reject(new Error('Too many redirects'));
      https.get(targetUrl, { headers: { 'User-Agent': 'SastraGetWay-Updater/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            const pct = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress(pct, downloadedBytes, totalBytes);
          }
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });
        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => { });
          reject(err);
        });
      }).on('error', reject);
    };
    request(url);
  });
}

async function performGitHubUpdate(updateInfo) {
  try {
    const info = updateInfo || (await checkForGitHubUpdates());

    // Mode 1: Full NSIS Installer (.exe) from GitHub Releases
    if (info && info.mode === 'installer' && info.downloadUrl) {
      const destInstaller = path.join(app.getPath('temp'), `DigitalikhGetWay-Setup-${info.latestVersion || 'latest'}.exe`);
      sendUpdateStatus({ state: 'downloading', percent: 5, message: `Downloading ${info.assetName || 'Update Installer'}...` });

      await downloadFileWithProgress(info.downloadUrl, destInstaller, (pct) => {
        sendUpdateStatus({ state: 'downloading', percent: pct, message: `Downloading update installer... ${pct}%` });
      });

      sendUpdateStatus({ state: 'installing', percent: 100, message: 'Launching installer and restarting...' });
      setTimeout(() => {
        isQuitting = true;
        stopEngine();
        const child = spawn(destInstaller, [], { detached: true, stdio: 'ignore' });
        child.unref();
        app.quit();
      }, 900);
      return { success: true, mode: 'installer' };
    }

    // Mode 2: Fast Direct Hot-Update from GitHub Repository (biggdoqq6/Sastra_GetWay)
    const branch = (info && info.branch) || 'main';
    const filesToSync = [
      { remote: 'dashboard.html', local: path.join(__dirname, 'dashboard.html') },
      { remote: 'activate.html', local: path.join(__dirname, 'activate.html') },
      { remote: 'activate.js', local: path.join(__dirname, 'activate.js') },
      { remote: 'license/license-manager.js', local: path.join(__dirname, 'license', 'license-manager.js') },
      { remote: 'license/cloud-config.json', local: path.join(__dirname, 'license', 'cloud-config.json') },
      { remote: 'preload.js', local: path.join(__dirname, 'preload.js') },
      { remote: 'main.js', local: path.join(__dirname, 'main.js') },
      { remote: 'engine/app/custom-server.js', local: app.isPackaged ? path.join(process.resourcesPath, 'engine', 'app', 'custom-server.js') : path.join(__dirname, 'engine', 'app', 'custom-server.js') },
      { remote: 'package.json', local: path.join(__dirname, 'package.json') }
    ];

    let updatedCount = 0;
    for (let i = 0; i < filesToSync.length; i++) {
      const item = filesToSync[i];
      const pct = Math.round(((i + 1) / filesToSync.length) * 90);
      sendUpdateStatus({ state: 'downloading', percent: pct, message: `Syncing ${item.remote} from GitHub...` });
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${branch}/${item.remote}?t=${Date.now()}`, {
          headers: { 'User-Agent': 'SastraGetWay-Updater/2.0', 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const content = await res.text();
          if (content && content.length > 20) {
            fs.writeFileSync(item.local, content, 'utf8');
            updatedCount++;
          }
        }
      } catch (e) { }
    }

    if (updatedCount > 0) {
      sendUpdateStatus({ state: 'completed', percent: 100, message: 'Update complete! Restarting DIGITALIKH GETWAY...' });
      setTimeout(() => {
        isQuitting = true;
        stopEngine();
        app.relaunch();
        app.exit(0);
      }, 1200);
      return { success: true, mode: 'hot', updatedCount };
    }

    // If repository has no matching raw files yet, open GitHub Releases page
    shell.openExternal(`${GITHUB_REPO_URL}/releases`);
    sendUpdateStatus({ state: 'idle', percent: 0, message: 'Opened GitHub Releases page in browser.' });
    return { success: true, mode: 'browser' };
  } catch (err) {
    sendUpdateStatus({ state: 'error', percent: 0, message: `Update error: ${err.message}` });
    return { success: false, error: err.message };
  }
}

ipcMain.handle('check-for-updates', async () => {
  return await checkForGitHubUpdates();
});

ipcMain.handle('perform-update', async (_event, updateInfo) => {
  return await performGitHubUpdate(updateInfo);
});

ipcMain.handle('take-screenshot', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const img = await mainWindow.webContents.capturePage();
      const savePath = path.join('C:\\Users\\heang\\.gemini\\antigravity\\brain\\f96e42e4-775d-4021-a2a9-7de8f6202016', 'sastra_orbit_live.png');
      fs.writeFileSync(savePath, img.toPNG());
      return { success: true, path: savePath };
    }
  } catch (err) {
    console.error('[take-screenshot error]:', err.message);
  }
  return { success: false };
});

ipcMain.handle('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow || activateWindow;
  if (win && !win.isDestroyed()) {
    win.minimize();
  }
  return true;
});

ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (win && !win.isDestroyed()) {
    if (win.isMaximized()) {
      win.unmaximize();
      return { maximized: false };
    } else {
      win.maximize();
      return { maximized: true };
    }
  }
  return { maximized: false };
});

ipcMain.handle('window-close', (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (senderWin && senderWin === activateWindow) {
    isQuitting = true;
    stopEngine();
    app.quit();
    return true;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  return true;
});

// 7.A Create Activate / Login Window (980 x 670 Frameless Modern Glassmorphic Studio)
function createActivateWindow(initialNotice = null) {
  if (initialNotice) {
    lastAuthNoticeStatus = initialNotice;
  }
  if (activateWindow && !activateWindow.isDestroyed()) {
    activateWindow.show();
    activateWindow.focus();
    activateWindow.webContents.send('license-status', getLicenseStatus());
    return activateWindow;
  }

  const winIconPath = fs.existsSync(getAssetPath('icon.ico')) ? getAssetPath('icon.ico') : getAssetPath('icon.png');
  const winIcon = nativeImage.createFromPath(winIconPath);

  activateWindow = new BrowserWindow({
    width: 1024,
    height: 590,
    minWidth: 920,
    minHeight: 550,
    resizable: true,
    maximizable: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#080716',
    autoHideMenuBar: true,
    title: 'DIGITALIKH GETWAY — Cloud Gmail & License Portal',
    icon: winIcon.isEmpty() ? winIconPath : winIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  if (!winIcon.isEmpty() && process.platform === 'win32') {
    try { activateWindow.setIcon(winIcon); } catch (e) { }
  }

  activateWindow.loadFile(path.join(__dirname, 'activate.html'));

  activateWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  activateWindow.on('closed', () => {
    activateWindow = null;
  });

  return activateWindow;
}

function transitionToMainWindow(status) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('license-status', status || getLicenseStatus());
  }

  if (activateWindow && !activateWindow.isDestroyed()) {
    activateWindow.destroy();
    activateWindow = null;
  }

  startCloudHeartbeatLoop();
}

function transitionToActivateWindow(noticeStatus) {
  lastAuthNoticeStatus = noticeStatus || null;
  stopCloudHeartbeatLoop();
  stopEngine();

  // Open activate.html window FIRST and destroy mainWindow without quitting the app
  createActivateWindow(lastAuthNoticeStatus);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }
}

let heartbeatInProgress = false;
async function runCloudHeartbeat() {
  if (heartbeatInProgress) return;
  heartbeatInProgress = true;
  try {
    const cloudStatus = await licenseManager.verifySessionWithCloud();
    if (cloudStatus.valid) {
      lastAuthNoticeStatus = null;
      if (!engineProcess) {
        startEngine(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('engine-log', '[Engine Online] 127.0.0.1:20128 ready for OpenAI API requests.');
          }
        });
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('license-status', cloudStatus);
      }
    } else {
      // Kicked by another PC, logged out by Admin, disabled, or expired -> Auto-Logout immediately!
      transitionToActivateWindow(cloudStatus);
    }
  } catch (e) {
  } finally {
    heartbeatInProgress = false;
  }
}

function startCloudHeartbeatLoop() {
  stopCloudHeartbeatLoop();
  // Verify every 25 seconds with Firebase Realtime Database
  heartbeatTimer = setInterval(() => {
    runCloudHeartbeat();
  }, 25000);
}

function stopCloudHeartbeatLoop() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 7.B Create Main Desktop Window
function createWindow() {
  const winIconPath = fs.existsSync(getAssetPath('icon.ico')) ? getAssetPath('icon.ico') : getAssetPath('icon.png');
  const winIcon = nativeImage.createFromPath(winIconPath);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#040611',
    autoHideMenuBar: true,
    title: 'DIGITALIKH GETWAY — Neural AI Gateway & Account Pool',
    icon: winIcon.isEmpty() ? winIconPath : winIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  if (!winIcon.isEmpty() && process.platform === 'win32') {
    try { mainWindow.setIcon(winIcon); } catch (e) { }
  }

  mainWindow.loadFile(path.join(__dirname, 'dashboard.html'));

  // Auto-reload UI when dashboard.html is modified (in development)
  if (!app.isPackaged) {
    fs.watchFile(path.join(__dirname, 'dashboard.html'), { interval: 600 }, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reloadIgnoringCache();
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('focus', () => {
    runCloudHeartbeat();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  const initialLicense = getLicenseStatus();
  if (initialLicense.valid) {
    startEngine(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-log', '[Engine Online] 127.0.0.1:20128 ready for OpenAI API requests.');
      }
    });
    startCloudHeartbeatLoop();
    setTimeout(() => runCloudHeartbeat(), 800);
  }
}

// 8. Setup System Tray
function setupTray() {
  const iconPath = fs.existsSync(getAssetPath('icon.ico')) ? getAssetPath('icon.ico') : getAssetPath('icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('DIGITALIKH GETWAY — Active on 127.0.0.1:20128');

  const showActiveAppWindow = () => {
    const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : activateWindow;
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else {
      const lic = getLicenseStatus();
      if (lic.valid) createWindow();
      else createActivateWindow(lic);
    }
  };

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open DIGITALIKH GETWAY',
      click: showActiveAppWindow
    },
    {
      label: 'Copy API URL (http://127.0.0.1:20128/v1)',
      click: () => {
        clipboard.writeText('http://127.0.0.1:20128/v1');
      }
    },
    { type: 'separator' },
    {
      label: 'Engine: Active on Port 20128',
      enabled: false
    },
    {
      label: 'Restart Engine',
      click: () => {
        if (getLicenseStatus().valid) startEngine();
      }
    },
    {
      label: 'Check for Updates (GitHub)',
      click: async () => {
        showActiveAppWindow();
        const info = await checkForGitHubUpdates();
        if (info.hasUpdate) {
          await performGitHubUpdate(info);
        } else {
          sendUpdateStatus({ state: 'up-to-date', percent: 100, message: `You are on the latest version (v${info.currentVersion}).` });
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit DIGITALIKH GETWAY',
      click: () => {
        isQuitting = true;
        stopCloudHeartbeatLoop();
        stopEngine();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : activateWindow;
    if (win && !win.isDestroyed()) {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    } else {
      showActiveAppWindow();
    }
  });
}

// 9. Application Lifecycle
app.whenReady().then(async () => {
  try {
    if (session && session.defaultSession) {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        if (permission === 'notifications') return callback(false);
        callback(true);
      });
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        if (permission === 'notifications') return false;
        return true;
      });
    }
  } catch (e) { }
  setupTray();
  startGeminiWebBridgeServer();
  const localLic = getLicenseStatus();
  if (localLic.valid) {
    createWindow();
  } else {
    createActivateWindow(localLic);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const lic = getLicenseStatus();
      if (lic.valid) createWindow();
      else createActivateWindow(lic);
    } else {
      const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : activateWindow;
      if (win && !win.isDestroyed()) win.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopCloudHeartbeatLoop();
  stopEngine();
  try {
    if (geminiWebBridgeServer) geminiWebBridgeServer.close();
  } catch (e) { }
  try {
    for (const [, win] of geminiWebWindows.entries()) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    geminiWebWindows.clear();
  } catch (e) { }
});

app.on('window-all-closed', () => {
  // Never call app.quit() here so logging out from mainWindow to activateWindow never terminates the app!
});
