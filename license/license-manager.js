const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DEFAULT_FIREBASE_URL = 'https://digitalikh-getway-default-rtdb.asia-southeast1.firebasedatabase.app';
const DEFAULT_NAMESPACE = 'sastragetway_v2';
const DEFAULT_TELEGRAM_URL = '@DigitalLicenseKHBot';

// 12 hours max offline grace before requiring online re-verification
const MAX_OFFLINE_GRACE_MS = 12 * 60 * 60 * 1000;
// 5 minutes tolerance for minor clock drift; larger backward jump = clock rollback
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
// Consider a user "Online Live" in Admin Dashboard if heartbeat was within the last 65 seconds
const ONLINE_HEARTBEAT_WINDOW_MS = 65 * 1000;

let cachedMachineId = null;

function getAppDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(base, 'SastraGetWay_Data');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }
  return dir;
}

function getCloudConfigPaths() {
  const appDataConfig = path.join(getAppDataDir(), 'cloud-config.json');
  const bundledConfig = path.join(__dirname, 'cloud-config.json');
  const unpackedConfig = process.resourcesPath
    ? path.join(process.resourcesPath, 'app', 'license', 'cloud-config.json')
    : bundledConfig;
  return { appDataConfig, bundledConfig, unpackedConfig };
}

function loadCloudConfig() {
  const { appDataConfig, bundledConfig, unpackedConfig } = getCloudConfigPaths();
  let config = {
    cloudDatabaseUrl: DEFAULT_FIREBASE_URL,
    firebaseNamespace: DEFAULT_NAMESPACE,
    telegramUrl: DEFAULT_TELEGRAM_URL
  };

  for (const candidate of [unpackedConfig, bundledConfig, appDataConfig]) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          if (parsed.cloudDatabaseUrl) config.cloudDatabaseUrl = String(parsed.cloudDatabaseUrl).trim().replace(/\/+$/, '');
          if (parsed.firebaseNamespace) config.firebaseNamespace = String(parsed.firebaseNamespace).trim().replace(/^\/+|\/+$/g, '');
          if (parsed.telegramUrl) config.telegramUrl = String(parsed.telegramUrl).trim();
        }
      }
    } catch (e) {}
  }
  return config;
}

function saveCloudConfig(newConfig = {}) {
  const current = loadCloudConfig();
  const merged = {
    cloudDatabaseUrl: String(newConfig.cloudDatabaseUrl || current.cloudDatabaseUrl || DEFAULT_FIREBASE_URL).trim().replace(/\/+$/, ''),
    firebaseNamespace: String(newConfig.firebaseNamespace || current.firebaseNamespace || DEFAULT_NAMESPACE).trim().replace(/^\/+|\/+$/g, ''),
    telegramUrl: String(newConfig.telegramUrl || current.telegramUrl || DEFAULT_TELEGRAM_URL).trim()
  };

  const { appDataConfig, bundledConfig } = getCloudConfigPaths();
  try {
    fs.writeFileSync(appDataConfig, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {}
  try {
    fs.writeFileSync(bundledConfig, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {}
  return merged;
}

function buildFirebaseUrl(subPath = '') {
  const cfg = loadCloudConfig();
  const baseUrl = cfg.cloudDatabaseUrl.replace(/\/+$/, '');
  const ns = cfg.firebaseNamespace || DEFAULT_NAMESPACE;
  const cleanSub = String(subPath || '').replace(/^\/+|\/+$/g, '');
  const fullPath = cleanSub ? `${ns}/${cleanSub}` : ns;
  return `${baseUrl}/${fullPath}.json`;
}

async function firebaseRequest(subPath, method = 'GET', body = undefined, timeoutMs = 9000) {
  const url = buildFirebaseUrl(subPath);
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firebase HTTP ${res.status}: ${errText.slice(0, 180)}`);
  }
  return await res.json();
}

// ============================================================================
// 1. HARDWARE MACHINE ID & AES-256-GCM HARDWARE-BOUND SESSION ENCRYPTION
// ============================================================================

function getMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const cachePath = path.join(getAppDataDir(), 'machine_id.txt');

  let rawSeed = '';
  if (process.platform === 'win32') {
    try {
      const regOut = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        encoding: 'utf8',
        timeout: 2000,
        windowsHide: true
      });
      const match = regOut.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (match && match[1]) {
        rawSeed = match[1].trim();
      }
    } catch (e) {}
  }

  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) || 'CPU';
  const hwComposite = `${rawSeed}|${os.hostname()}|${os.platform()}|${os.arch()}|${cpuModel}`;
  const hash = crypto.createHash('sha256').update(hwComposite).digest('hex').toUpperCase().slice(0, 12);
  cachedMachineId = `DIGITALIKH-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}`;

  try {
    fs.writeFileSync(cachePath, cachedMachineId, 'utf8');
  } catch (e) {}
  return cachedMachineId;
}

function getDeviceName() {
  const host = os.hostname() || 'Windows-PC';
  return host;
}

function getSessionFilePath() {
  return path.join(getAppDataDir(), 'license-session.json');
}

function deriveHardwareAesKey(machineId = getMachineId()) {
  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) || 'CPU';
  const hwSecret = `${machineId}|${os.hostname()}|${cpuModel}|SASTRA_AES256GCM_HW_LOCK_2026`;
  return crypto.scryptSync(hwSecret, 'sastra-quantum-hw-salt-v2', 32);
}

function saveEncryptedSession(sessionPayload) {
  const filePath = getSessionFilePath();
  const key = deriveHardwareAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = JSON.stringify({
    ...sessionPayload,
    machineId: getMachineId(),
    savedAt: Date.now()
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = {
    v: 2,
    alg: 'AES-256-GCM-HWID',
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    data: encrypted.toString('base64')
  };

  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
  return true;
}

function loadEncryptedSession() {
  const filePath = getSessionFilePath();
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || raw.v !== 2 || !raw.iv || !raw.tag || !raw.data) {
      clearEncryptedSession();
      return null;
    }

    const currentMid = getMachineId();
    const legacyMid = currentMid.replace(/^DIGITALIKH-/, 'SASTRA-');

    let parsed = null;
    let usedLegacy = false;

    const iv = Buffer.from(raw.iv, 'base64');
    const authTag = Buffer.from(raw.tag, 'base64');
    const encrypted = Buffer.from(raw.data, 'base64');

    // 1. Try decrypting with current DIGITALIKH key
    try {
      const key = deriveHardwareAesKey(currentMid);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      parsed = JSON.parse(decrypted);
    } catch (e1) {
      // 2. Fallback: try decrypting with legacy SASTRA key
      try {
        const legacyKey = deriveHardwareAesKey(legacyMid);
        const decipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
        parsed = JSON.parse(decrypted);
        usedLegacy = true;
      } catch (e2) {}
    }

    if (!parsed || !parsed.email || !parsed.sessionToken) {
      clearEncryptedSession();
      return null;
    }

    // Verify machineId matches (either DIGITALIKH- or legacy SASTRA-)
    const parsedMidNorm = (parsed.machineId || '').replace(/^SASTRA-/, 'DIGITALIKH-');
    if (parsedMidNorm !== currentMid) {
      clearEncryptedSession();
      return null;
    }

    // Upgrade and re-save session with new DIGITALIKH machineId if needed
    if (usedLegacy || parsed.machineId !== currentMid) {
      parsed.machineId = currentMid;
      saveEncryptedSession(parsed);
      console.log('[License Migration] Session machineId successfully upgraded to:', currentMid);
    }

    return parsed;
  } catch (err) {
    clearEncryptedSession();
    return null;
  }
}

function clearEncryptedSession() {
  const filePath = getSessionFilePath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
  // Also remove legacy license.json if present so old keys don't interfere
  const legacyPath = path.join(getAppDataDir(), 'license.json');
  try {
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
  } catch (e) {}
}

// ============================================================================
// 2. PASSWORD HASHING (crypto.scryptSync + Random Salt) & HELPERS
// ============================================================================

function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  const cleanPass = String(password || '');
  const derived = crypto.scryptSync(cleanPass, saltHex, 64).toString('hex');
  return `${saltHex}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) return false;
  const [saltHex, originalHex] = storedHash.split(':');
  if (!saltHex || !originalHex) return false;
  try {
    const candidateHex = crypto.scryptSync(String(password || ''), saltHex, 64).toString('hex');
    const a = Buffer.from(originalHex, 'hex');
    const b = Buffer.from(candidateHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function normalizeEmail(email) {
  let clean = String(email || '').trim().toLowerCase();
  if (clean && !clean.includes('@')) {
    clean = `${clean}@gmail.com`;
  }
  return clean;
}

function isValidGmail(email) {
  const clean = normalizeEmail(email);
  return /^[a-z0-9._%+-]+@gmail\.com$/i.test(clean);
}

function emailToFirebaseKey(email) {
  return Buffer.from(normalizeEmail(email), 'utf8').toString('base64url');
}

const KEY_HMAC_SECRET = 'SASTRA_GETWAY_QUANTUM_HMAC_KEY_SIGNER_2026_V3';

function computeTokenSignature(payloadB64) {
  return crypto
    .createHmac('sha512', KEY_HMAC_SECRET)
    .update(String(payloadB64))
    .digest('base64url');
}

function generateSignedLicenseKey({ durationDays = 30, isLifetime = false, customerName = '' } = {}) {
  const randHex = crypto.randomBytes(6).toString('hex').toUpperCase();
  const kid = `KEY-${randHex.slice(0, 4)}-${randHex.slice(4, 8)}-${randHex.slice(8, 12)}`;
  const now = Date.now();
  const isLife = Boolean(isLifetime || Number(durationDays) === 0);
  const days = isLife ? 0 : Math.max(1, parseInt(durationDays, 10) || 30);
  const cleanName = String(customerName || '').trim() || 'VIP Customer';

  const payloadObj = {
    kid,
    mid: '*',
    type: 'account',
    name: cleanName,
    plan: isLife ? 'Lifetime' : `${days} Days`,
    durationDays: days,
    iat: now,
    exp: isLife ? 0 : now + days * 86400000
  };

  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sigB64 = computeTokenSignature(payloadB64);
  const licenseKey = `${payloadB64}.${sigB64}`;

  return { kid, licenseKey, payload: payloadObj };
}

function normalizeLicenseKey(rawKey) {
  const trimmed = String(rawKey || '').trim().replace(/\s+/g, '');
  if (!trimmed) return '';

  // Signed Base64URL token format: eyJ... . signature (case-sensitive!)
  if (trimmed.startsWith('eyJ') && trimmed.includes('.')) {
    return trimmed;
  }

  // Legacy uppercase key formats
  const clean = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.startsWith('KEY') && clean.length === 15) {
    const body = clean.slice(3);
    return `KEY-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }
  const body = clean.startsWith('DIGITALIKH') ? clean.slice(10) : (clean.startsWith('SASTRA') ? clean.slice(6) : clean);
  if (body.length === 25) {
    return `DIGITALIKH-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}-${body.slice(20, 25)}`;
  }
  return trimmed;
}

function validateLicenseKeyCryptographically(rawKey) {
  const cleanKey = normalizeLicenseKey(rawKey);
  if (!cleanKey) {
    return { valid: false, cleanKey: '', keyId: '', reason: 'សូមបញ្ចូល License Key ដែលទទួលបានពី Admin។' };
  }

  // 1. Primary Signed Token Format: eyJ<base64url>.<hmac-sha512-base64url>
  if (cleanKey.startsWith('eyJ') && cleanKey.includes('.')) {
    const parts = cleanKey.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, cleanKey, keyId: '', reason: 'ទម្រង់ License Key Token មិនត្រឹមត្រូវ!' };
    }
    const [payloadB64, sigB64] = parts;
    let payload = null;
    try {
      const jsonStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
      payload = JSON.parse(jsonStr);
    } catch (e) {
      return { valid: false, cleanKey, keyId: '', reason: 'មិនអាចអានទិន្នន័យ License Key Token បានទេ (Invalid Payload)!' };
    }

    if (!payload || !payload.kid) {
      return { valid: false, cleanKey, keyId: '', reason: 'License Key Token ខ្វះលេខសម្គាល់ (kid)!' };
    }

    const expectedSig = computeTokenSignature(payloadB64);
    if (sigB64 !== expectedSig) {
      return {
        valid: false,
        cleanKey,
        keyId: '',
        reason: 'លេខកូដ License Key មិនត្រឹមត្រូវ ឬត្រូវបានកែប្រែក្លែងបន្លំ (Invalid Digital Signature)!'
      };
    }

    const keyId = String(payload.kid).replace(/[^A-Za-z0-9_-]/g, '');
    return { valid: true, cleanKey, keyId, payload };
  }

  // 2. Fallback support for legacy keys already in Firebase
  if (/^(KEY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}|SASTRA-[A-Z0-9-]{29}|DIGITALIKH-[A-Z0-9-]{29})$/.test(cleanKey)) {
    return {
      valid: true,
      cleanKey,
      keyId: cleanKey.replace(/[^A-Z0-9-]/g, ''),
      payload: null
    };
  }

  return {
    valid: false,
    cleanKey,
    keyId: '',
    reason: 'ទម្រង់ License Key មិនត្រឹមត្រូវ! សូមចម្លង (Copy/Paste) កូដ License Key ទាំងស្រុងពី Admin។'
  };
}

function keyToFirebaseId(key) {
  const check = validateLicenseKeyCryptographically(key);
  if (check.keyId) return check.keyId;
  const raw = String(key || '').trim();
  if (raw.startsWith('eyJ') && raw.includes('.')) {
    try {
      const p = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8'));
      if (p && p.kid) return String(p.kid).replace(/[^A-Za-z0-9_-]/g, '');
    } catch (e) {}
  }
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function formatPlanLabel(days, isLifetime) {
  if (isLifetime || Number(days) === 0) return 'LIFETIME';
  const d = Number(days) || 30;
  if (d === 7) return '7 ថ្ងៃ (7 Days)';
  if (d === 30) return '1 ខែ (30 Days)';
  if (d === 90) return '3 ខែ (90 Days)';
  if (d === 180) return '6 ខែ (180 Days)';
  if (d === 365) return '1 ឆ្នាំ (365 Days)';
  return `${d} ថ្ងៃ (${d} Days)`;
}

function computeRemainingInfo(expiresAt, isLifetime, now = Date.now()) {
  if (isLifetime) {
    return {
      isExpired: false,
      remainingDays: null,
      remainingHours: null,
      remainingText: 'Lifetime (ប្រើបានរហូត)'
    };
  }
  const exp = Number(expiresAt) || 0;
  const diff = exp - now;
  if (diff <= 0) {
    return {
      isExpired: true,
      remainingDays: 0,
      remainingHours: 0,
      remainingText: 'ផុតកំណត់ (Expired)'
    };
  }
  const remainingDays = Math.ceil(diff / 86400000);
  const remainingHours = Math.ceil(diff / 3600000);
  return {
    isExpired: false,
    remainingDays,
    remainingHours,
    remainingText: remainingDays > 1 ? `នៅសល់ ${remainingDays} ថ្ងៃ` : `នៅសល់ ${remainingHours} ម៉ោង`
  };
}

function formatStatusResponse(session, extra = {}) {
  const machineId = getMachineId();
  const deviceName = getDeviceName();
  if (!session || !session.email) {
    return {
      valid: false,
      machineId,
      deviceName,
      telegramUrl: loadCloudConfig().telegramUrl,
      reason: extra.reason || 'សូមចូលគណនី (Login) ឬចុះឈ្មោះជាមួយ Gmail ដើម្បីប្រើប្រាស់កម្មវិធី',
      ...extra
    };
  }

  const rem = computeRemainingInfo(session.expiresAt, session.isLifetime);
  if (rem.isExpired) {
    return {
      valid: false,
      expired: true,
      code: 'EXPIRED',
      email: session.email,
      machineId,
      deviceName,
      plan: session.plan || 'PRO',
      expiresAt: session.expiresAt,
      telegramUrl: loadCloudConfig().telegramUrl,
      reason: extra.reason || 'គណនី Gmail របស់អ្នកបានផុតកំណត់ថ្ងៃប្រើប្រាស់ហើយ! សូមបញ្ចូល License Key ថ្មីដើម្បីបន្តសុពលភាព។',
      ...extra
    };
  }

  return {
    valid: true,
    email: session.email,
    customerName: session.customerName || session.email.split('@')[0],
    customer: session.customerName ? `${session.customerName} (${session.email})` : session.email,
    plan: session.plan || (session.isLifetime ? 'LIFETIME' : 'PRO'),
    isLifetime: Boolean(session.isLifetime),
    isUniversal: true,
    expiresAt: session.isLifetime ? null : session.expiresAt,
    remainingDays: rem.remainingDays,
    remainingHours: rem.remainingHours,
    remainingText: rem.remainingText,
    machineId,
    deviceName,
    sessionToken: session.sessionToken,
    serialId: (session.lastKey || 'CLOUD').slice(-6),
    lastKey: session.lastKey || '',
    telegramUrl: loadCloudConfig().telegramUrl,
    ...extra
  };
}

// ============================================================================
// 3. CLIENT AUTHENTICATION: REGISTER, LOGIN, RENEW, HEARTBEAT & LOGOUT
// ============================================================================

async function registerWithGmailAndKey({ email, password, licenseKey }) {
  const cleanEmail = normalizeEmail(email);
  const rawPass = String(password || '');
  const keyCheck = validateLicenseKeyCryptographically(licenseKey);
  const cleanKey = keyCheck.cleanKey;
  const machineId = getMachineId();
  const deviceName = getDeviceName();

  if (!isValidGmail(cleanEmail)) {
    return { ok: false, reason: 'សូមបញ្ចូលអាសយដ្ឋាន Gmail ឱ្យបានត្រឹមត្រូវ (ឧទាហរណ៍៖ name@gmail.com)' };
  }
  if (rawPass.length < 4) {
    return { ok: false, reason: 'សូមដាក់ពាក្យសម្ងាត់ (Password) យ៉ាងតិច ៤ តួអក្សរឡើងទៅ' };
  }
  if (!keyCheck.valid) {
    return { ok: false, reason: keyCheck.reason };
  }

  const emailKey = emailToFirebaseKey(cleanEmail);
  const keyId = keyCheck.keyId || keyToFirebaseId(cleanKey);

  try {
    const existingAcc = await firebaseRequest(`accounts/${emailKey}`, 'GET');
    if (existingAcc && existingAcc.email) {
      return {
        ok: false,
        code: 'EMAIL_EXISTS',
        reason: `គណនី ${cleanEmail} ធ្លាប់បានចុះឈ្មោះរួចហើយ! សូមចុចផ្ទាំង «Sign In» វិញ។`
      };
    }

    const keyRecord = await firebaseRequest(`keys/${keyId}`, 'GET');
    if (!keyRecord || (!keyRecord.key && !keyRecord.licenseKey)) {
      return {
        ok: false,
        code: 'INVALID_KEY',
        reason: 'លេខកូដ License Key នេះមិនមានក្នុងប្រព័ន្ធទេ! សូមពិនិត្យម្ដងទៀត ឬទាក់ទង Admin។'
      };
    }

    if (keyRecord.used || keyRecord.claimedBy) {
      return {
        ok: false,
        code: 'KEY_USED',
        reason: `License Key នេះត្រូវបានប្រើប្រាស់រួចហើយ (${keyRecord.usedByEmail || keyRecord.claimedBy || 'គណនីផ្សេង'})! 1 Key ប្រើបានតែ 1 គណនី Gmail គត់។`
      };
    }

    // Trial Anti-Abuse Check: One Free Trial per Machine ID
    if (keyRecord.isTrial) {
      const safeMid = machineId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const trialRecord = await firebaseRequest(`trialDevices/${safeMid}`, 'GET');
      if (trialRecord && trialRecord.usedAt) {
        return {
          ok: false,
          code: 'TRIAL_ALREADY_USED',
          reason: 'កុំព្យូទ័រនេះធ្លាប់បានប្រើប្រាស់ Free Trial រួចហើយ! មិនអាចប្រើ Free Trial លើកទីពីរបានទេ (សូមទាក់ទង Admin ដើម្បីទិញ Key ពេញលេញ)។'
        };
      }
    }

    const now = Date.now();
    const isLifetime = Boolean(keyRecord.isLifetime || Number(keyRecord.durationDays) === 0);
    const days = Number(keyRecord.durationDays) || 30;
    const expiresAt = isLifetime ? null : now + days * 86400000;
    const plan = keyRecord.plan || formatPlanLabel(days, isLifetime);
    const sessionToken = crypto.randomUUID();
    const passwordHash = hashPassword(rawPass);

    const customerName = String(
      keyCheck.payload?.name ||
      keyRecord.customerName ||
      keyRecord.name ||
      keyRecord.note ||
      cleanEmail.split('@')[0]
    ).trim();

    const accountData = {
      email: cleanEmail,
      customerName,
      passwordHash,
      status: 'active',
      isLifetime,
      durationDays: isLifetime ? 0 : days,
      plan,
      createdAt: now,
      expiresAt,
      lastKeyId: keyId,
      lastKey: cleanKey,
      activatedKeys: [keyId],
      activeDevice: {
        machineId,
        deviceName,
        sessionToken,
        loginAt: now,
        lastSeenAt: now
      }
    };

    // Mark key as used & save account in Firebase
    await firebaseRequest(`keys/${keyId}`, 'PATCH', {
      used: true,
      usedByEmail: cleanEmail,
      usedByMachineId: machineId,
      usedAt: now
    });

    await firebaseRequest(`accounts/${emailKey}`, 'PUT', accountData);

    // Record trial device permanently in Firebase
    if (keyRecord.isTrial) {
      const safeMid = machineId.replace(/[^a-zA-Z0-9_-]/g, '_');
      await firebaseRequest(`trialDevices/${safeMid}`, 'PUT', {
        machineId,
        email: cleanEmail,
        keyId,
        usedAt: now
      });
    }

    const localSession = {
      email: cleanEmail,
      customerName,
      sessionToken,
      isLifetime,
      expiresAt,
      plan,
      lastKey: cleanKey,
      lastVerifiedTime: now
    };
    saveEncryptedSession(localSession);

    return {
      ok: true,
      status: formatStatusResponse(localSession)
    };
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      reason: `មិនអាចភ្ជាប់ទៅកាន់ Cloud Server បានទេ សូមពិនិត្យអ៊ីនធឺណិតរបស់អ្នក (${err.message})`
    };
  }
}

async function loginWithGmail({ email, password, newLicenseKey = '' }) {
  const cleanEmail = normalizeEmail(email);
  const rawPass = String(password || '');
  const cleanNewKey = newLicenseKey ? normalizeLicenseKey(newLicenseKey) : '';
  const machineId = getMachineId();
  const deviceName = getDeviceName();

  if (!isValidGmail(cleanEmail)) {
    return { ok: false, reason: 'សូមបញ្ចូលអាសយដ្ឋាន Gmail ឱ្យបានត្រឹមត្រូវ (ឧទាហរណ៍៖ name@gmail.com)' };
  }
  if (!rawPass) {
    return { ok: false, reason: 'សូមបញ្ចូលពាក្យសម្ងាត់ (Password) របស់អ្នក' };
  }

  const emailKey = emailToFirebaseKey(cleanEmail);

  try {
    const acc = await firebaseRequest(`accounts/${emailKey}`, 'GET');
    if (!acc || !acc.email) {
      return {
        ok: false,
        code: 'ACCOUNT_NOT_FOUND',
        reason: 'មិនพบគណនី Gmail នេះក្នុងប្រព័ន្ធទេ! សូមចុចផ្ទាំង «ចុះឈ្មោះថ្មី (Register)» ដើម្បីចុះឈ្មោះជាមួយ License Key។'
      };
    }

    if (!verifyPassword(rawPass, acc.passwordHash)) {
      return {
        ok: false,
        code: 'WRONG_PASSWORD',
        reason: 'ពាក្យសម្ងាត់ (Password) មិនត្រឹមត្រូវទេ! សូមពិនិត្យម្តងទៀត ឬទាក់ទង Admin។'
      };
    }

    if (acc.status === 'disabled') {
      return {
        ok: false,
        code: 'ACCOUNT_DISABLED',
        reason: 'គណនី Gmail នេះត្រូវបានផ្អាកសិទ្ធិប្រើប្រាស់ដោយ Admin។ សូមទាក់ទង Admin តាម Telegram។'
      };
    }

    const now = Date.now();
    let isLifetime = Boolean(acc.isLifetime);
    let expiresAt = acc.expiresAt ? Number(acc.expiresAt) : null;
    let plan = acc.plan || (isLifetime ? 'LIFETIME' : 'PRO');
    let lastKey = acc.lastKey || '';
    let customerName = acc.customerName || cleanEmail.split('@')[0];
    const activatedKeys = Array.isArray(acc.activatedKeys) ? [...acc.activatedKeys] : [];

    // Handle Renew / Extend License Key if provided
    if (cleanNewKey) {
      const renewCheck = validateLicenseKeyCryptographically(cleanNewKey);
      if (!renewCheck.valid) {
        return { ok: false, reason: renewCheck.reason };
      }
      const keyId = renewCheck.keyId || keyToFirebaseId(renewCheck.cleanKey);
      const keyRecord = await firebaseRequest(`keys/${keyId}`, 'GET');
      if (!keyRecord || (!keyRecord.key && !keyRecord.licenseKey)) {
        return { ok: false, reason: 'លេខកូដ License Key ថ្មីនេះមិនមានក្នុងប្រព័ន្ធទេ!' };
      }
      if (keyRecord.used || keyRecord.claimedBy) {
        return { ok: false, reason: `License Key នេះត្រូវបានប្រើប្រាស់រួចហើយ (${keyRecord.usedByEmail || keyRecord.claimedBy || 'គណនីផ្សេង'})!` };
      }
      if (keyRecord.isTrial) {
        return { ok: false, reason: 'License Key ប្រភេទ Free Trial មិនអាចប្រើសម្រាប់ពន្យារថ្ងៃគណនីចាស់បានទេ (សូមទិញ Key ពេញលេញ)!' };
      }

      const keyIsLifetime = Boolean(keyRecord.isLifetime || Number(keyRecord.durationDays) === 0);
      const addDays = Number(keyRecord.durationDays) || 30;
      if (keyIsLifetime) {
        isLifetime = true;
        expiresAt = null;
        plan = 'LIFETIME';
      } else {
        const baseTime = expiresAt && expiresAt > now ? expiresAt : now;
        expiresAt = baseTime + addDays * 86400000;
        plan = keyRecord.plan || formatPlanLabel(addDays, false);
      }
      if (renewCheck.payload?.name || keyRecord.customerName) {
        customerName = renewCheck.payload?.name || keyRecord.customerName;
      }
      lastKey = renewCheck.cleanKey;
      if (!activatedKeys.includes(keyId)) activatedKeys.push(keyId);

      await firebaseRequest(`keys/${keyId}`, 'PATCH', {
        used: true,
        usedByEmail: cleanEmail,
        usedByMachineId: machineId,
        usedAt: now
      });
    }

    // Check expiration if not lifetime
    if (!isLifetime && (!expiresAt || now >= expiresAt)) {
      return {
        ok: false,
        code: 'EXPIRED',
        email: cleanEmail,
        reason: 'គណនី Gmail របស់អ្នកបានផុតកំណត់ថ្ងៃប្រើប្រាស់ហើយ! សូមបញ្ចូល License Key ថ្មីនៅក្នុងប្រអប់ខាងក្រោមដើម្បីបន្តសុពលភាព។'
      };
    }

    // Generate new sessionToken and bind this PC as the sole activeDevice (auto-kicking any previous PC!)
    const sessionToken = crypto.randomUUID();
    const previousDevice = acc.activeDevice || null;
    const switchedFromOtherPc = Boolean(previousDevice && previousDevice.machineId && previousDevice.machineId !== machineId);

    const updatedFields = {
      customerName,
      isLifetime,
      expiresAt,
      plan,
      lastKey,
      activatedKeys,
      activeDevice: {
        machineId,
        deviceName,
        sessionToken,
        loginAt: now,
        lastSeenAt: now
      }
    };

    await firebaseRequest(`accounts/${emailKey}`, 'PATCH', updatedFields);

    const localSession = {
      email: cleanEmail,
      customerName,
      sessionToken,
      isLifetime,
      expiresAt,
      plan,
      lastKey,
      lastVerifiedTime: now
    };
    saveEncryptedSession(localSession);

    return {
      ok: true,
      switchedFromOtherPc,
      previousDeviceName: previousDevice?.deviceName || null,
      status: formatStatusResponse(localSession)
    };
  } catch (err) {
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      reason: `មិនអាចភ្ជាប់ទៅកាន់ Cloud Server បានទេ សូមពិនិត្យអ៊ីនធឺណិតរបស់អ្នក (${err.message})`
    };
  }
}

function getLocalLicenseStatusSync() {
  const session = loadEncryptedSession();
  if (!session) {
    return formatStatusResponse(null);
  }
  const now = Date.now();
  // Anti-Clock-Rollback check
  if (session.lastVerifiedTime && now < session.lastVerifiedTime - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return formatStatusResponse(null, {
      code: 'CLOCK_ROLLBACK',
      reason: 'រកឃើញការកែប្រែម៉ោងកុំព្យូទ័រថយក្រោយ! សូមកំណត់ម៉ោងកុំព្យូទ័រឱ្យត្រឹមត្រូវ រួច Login ម្តងទៀត។'
    });
  }
  // Offline grace limit check
  if (session.lastVerifiedTime && now - session.lastVerifiedTime > MAX_OFFLINE_GRACE_MS) {
    return formatStatusResponse(null, {
      code: 'OFFLINE_EXCEEDED',
      reason: 'កម្មវិធីបានដាច់អ៊ីនធឺណិតលើសកំណត់ (១២ ម៉ោង)។ សូមភ្ជាប់អ៊ីនធឺណិតដើម្បីផ្ទៀងផ្ទាត់គណនីឡើងវិញ។'
    });
  }
  return formatStatusResponse(session);
}

async function verifySessionWithCloud() {
  const session = loadEncryptedSession();
  if (!session) {
    return formatStatusResponse(null, { code: 'NO_SESSION' });
  }

  const now = Date.now();
  const machineId = getMachineId();
  const deviceName = getDeviceName();

  // 1. Anti-Clock-Rollback check
  if (session.lastVerifiedTime && now < session.lastVerifiedTime - CLOCK_ROLLBACK_TOLERANCE_MS) {
    clearEncryptedSession();
    return formatStatusResponse(null, {
      code: 'CLOCK_ROLLBACK',
      reason: 'រកឃើញការសារ៉េម៉ោងកុំព្យូទ័រថយក្រោយខុសប្រក្រតី! សូមកំណត់ម៉ោងឱ្យត្រឹមត្រូវ រួច Login ឡើងវិញ។'
    });
  }

  const emailKey = emailToFirebaseKey(session.email);

  try {
    const acc = await firebaseRequest(`accounts/${emailKey}`, 'GET', undefined, 7000);

    if (!acc || !acc.email) {
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'ACCOUNT_DELETED',
        reason: 'គណនី Gmail នេះត្រូវបានលុបចេញពីប្រព័ន្ធដោយ Admin។'
      });
    }

    if (acc.status === 'disabled') {
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'ACCOUNT_DISABLED',
        reason: 'គណនី Gmail របស់អ្នកត្រូវបានផ្អាកសិទ្ធិប្រើប្រាស់ដោយ Admin។'
      });
    }

    // 2. Single-Device Session Check (Auto-Logout if logged in on another PC or logged out by Admin)
    if (!acc.activeDevice || !acc.activeDevice.sessionToken) {
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'REMOTE_LOGOUT',
        email: acc.email,
        reason: 'គណនីរបស់អ្នកត្រូវបាន Logout ពីចម្ងាយដោយ Admin។ សូម Login ម្តងទៀត។'
      });
    }

    const cloudMid = acc.activeDevice.machineId || '';
    const isSameMachine =
      cloudMid === machineId ||
      cloudMid.replace(/^SASTRA-/, 'DIGITALIKH-') === machineId ||
      cloudMid === machineId.replace(/^DIGITALIKH-/, 'SASTRA-');

    if (acc.activeDevice.sessionToken !== session.sessionToken || !isSameMachine) {
      const otherPc = acc.activeDevice.deviceName || acc.activeDevice.machineId || 'កុំព្យូទ័រផ្សេង';
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'KICKED_OTHER_PC',
        email: acc.email,
        otherDevice: otherPc,
        reason: `គណនី ${acc.email} ត្រូវបាន Login នៅលើកុំព្យូទ័រផ្សេង (${otherPc})! ម៉ាស៊ីនចាស់ត្រូវបាន Logout ដោយស្វ័យប្រវត្តិ (1 Gmail ប្រើបានតែ 1 ម៉ាស៊ីន)។`
      });
    }

    // 3. Sync latest expiration & plan from Cloud (in case Admin added days or upgraded to Lifetime)
    const isLifetime = Boolean(acc.isLifetime);
    const expiresAt = acc.expiresAt ? Number(acc.expiresAt) : null;
    const plan = acc.plan || (isLifetime ? 'LIFETIME' : 'PRO');

    if (!isLifetime && (!expiresAt || now >= expiresAt)) {
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'EXPIRED',
        expired: true,
        email: acc.email,
        reason: 'គណនី Gmail របស់អ្នកបានផុតកំណត់ថ្ងៃប្រើប្រាស់ហើយ! សូមបញ្ចូល License Key ថ្មីដើម្បីបន្តសុពលភាព។'
      });
    }

    // 4. Update lastSeenAt heartbeat on Cloud & update local encrypted session
    firebaseRequest(`accounts/${emailKey}/activeDevice`, 'PATCH', {
      lastSeenAt: now,
      deviceName,
      machineId
    }, 5000).catch(() => {});

    const updatedSession = {
      ...session,
      customerName: acc.customerName || session.customerName || acc.email.split('@')[0],
      isLifetime,
      expiresAt,
      plan,
      lastKey: acc.lastKey || session.lastKey || '',
      lastVerifiedTime: now
    };
    saveEncryptedSession(updatedSession);

    return formatStatusResponse(updatedSession);
  } catch (err) {
    // Offline fallback within MAX_OFFLINE_GRACE_MS (12 hours) if not expired
    const elapsedOffline = now - (Number(session.lastVerifiedTime) || 0);
    if (elapsedOffline > MAX_OFFLINE_GRACE_MS) {
      clearEncryptedSession();
      return formatStatusResponse(null, {
        code: 'OFFLINE_EXCEEDED',
        reason: 'បានដាច់ការភ្ជាប់អ៊ីនធឺណិតលើស ១២ ម៉ោង! សូមភ្ជាប់អ៊ីនធឺណិត រួច Login ផ្ទៀងផ្ទាត់ឡើងវិញ។'
      });
    }
    return formatStatusResponse(session, { offlineMode: true });
  }
}

async function logoutCurrentSession() {
  const session = loadEncryptedSession();
  clearEncryptedSession();

  if (session && session.email && session.sessionToken) {
    const emailKey = emailToFirebaseKey(session.email);
    try {
      const acc = await firebaseRequest(`accounts/${emailKey}`, 'GET', undefined, 5000);
      if (acc && acc.activeDevice && acc.activeDevice.sessionToken === session.sessionToken) {
        await firebaseRequest(`accounts/${emailKey}`, 'PATCH', { activeDevice: null }, 5000);
      }
    } catch (e) {}
  }
  return { ok: true, status: formatStatusResponse(null) };
}

// ============================================================================
// 4. ADMIN CONTROL CENTER API (FIREBASE 24/7 MANAGEMENT)
// ============================================================================

async function generateAdminLicenseKey({ durationDays = 30, isLifetime = false, isTrial = false, customerName = '', note = '' }) {
  const isLife = Boolean(!isTrial && (isLifetime || Number(durationDays) === 0));
  const days = isLife ? 0 : Math.max(1, parseInt(durationDays, 10) || 30);
  const cleanUser = String(customerName || note || (isTrial ? 'Trial Guest' : 'VIP Customer')).trim() || (isTrial ? 'Trial Guest' : 'VIP Customer');
  const cleanNote = String(note || (isTrial ? 'Free Trial' : '')).trim();
  const { kid, licenseKey, payload } = generateSignedLicenseKey({
    durationDays: days,
    isLifetime: isLife,
    customerName: cleanUser
  });
  const now = payload.iat;
  const plan = isTrial ? `${days}-Day Free Trial` : formatPlanLabel(days, isLife);
  const keySha256 = crypto.createHash('sha256').update(licenseKey).digest('hex');

  const keyData = {
    keyId: kid,
    key: licenseKey,
    licenseKey,
    keySha256,
    machineId: '*',
    name: cleanUser,
    customerName: cleanUser,
    durationDays: days,
    isLifetime: isLife,
    isTrial: Boolean(isTrial),
    plan,
    note: cleanNote,
    issuedAt: now,
    createdAt: now,
    exp: payload.exp,
    used: false,
    revoked: false,
    usedByEmail: null,
    usedByMachineId: null,
    usedAt: null
  };

  await firebaseRequest(`keys/${kid}`, 'PUT', keyData);
  return keyData;
}

async function generateBulkAdminLicenseKeys({ count = 10, durationDays = 30, isLifetime = false, isTrial = false, customerName = '', note = '' }) {
  const safeCount = Math.max(1, Math.min(100, parseInt(count, 10) || 10));
  const keys = [];
  const baseName = customerName || (isTrial ? 'Trial Guest' : 'VIP Customer');

  for (let i = 1; i <= safeCount; i++) {
    const itemNote = note ? `${note} (#${i})` : `Bulk #${i}`;
    const itemName = `${baseName} #${i}`;
    const keyData = await generateAdminLicenseKey({
      durationDays,
      isLifetime,
      isTrial,
      customerName: itemName,
      note: itemNote
    });
    keys.push(keyData);
  }

  return { ok: true, count: keys.length, plan: keys[0]?.plan || '', keys };
}

async function fetchAdminOverview() {
  const now = Date.now();
  const data = (await firebaseRequest('', 'GET')) || {};
  const rawAccounts = data.accounts || {};
  const rawKeys = data.keys || {};

  const accounts = Object.entries(rawAccounts).map(([id, acc]) => {
    const isLifetime = Boolean(acc.isLifetime);
    const expiresAt = acc.expiresAt ? Number(acc.expiresAt) : null;
    const rem = computeRemainingInfo(expiresAt, isLifetime, now);
    const rawDev = acc.activeDevice || null;
    const dev = rawDev ? {
      ...rawDev,
      machineId: String(rawDev.machineId || '').replace(/^SASTRA-/, 'DIGITALIKH-')
    } : null;
    const lastSeenAt = dev?.lastSeenAt ? Number(dev.lastSeenAt) : 0;
    const isOnline = Boolean(dev && dev.sessionToken && now - lastSeenAt <= ONLINE_HEARTBEAT_WINDOW_MS);

    let computedState = 'active';
    if (acc.status === 'disabled') computedState = 'disabled';
    else if (rem.isExpired) computedState = 'expired';

    return {
      id,
      email: acc.email || '',
      customerName: acc.customerName || (acc.email ? acc.email.split('@')[0] : ''),
      status: acc.status || 'active',
      computedState,
      isLifetime,
      plan: acc.plan || (isLifetime ? 'LIFETIME' : 'PRO'),
      createdAt: acc.createdAt || now,
      expiresAt,
      remainingDays: rem.remainingDays,
      remainingText: rem.remainingText,
      lastKey: acc.lastKey || '',
      activeDevice: dev,
      isOnline,
      lastSeenAt: lastSeenAt || null
    };
  }).sort((a, b) => (b.lastSeenAt || b.createdAt || 0) - (a.lastSeenAt || a.createdAt || 0));

  const keys = Object.values(rawKeys)
    .filter(k => k && k.key)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const kpi = {
    totalAccounts: accounts.length,
    activeLicenses: accounts.filter(a => a.computedState === 'active').length,
    unusedKeys: keys.filter(k => !k.used).length,
    onlineDevices: accounts.filter(a => a.isOnline).length
  };

  return {
    ok: true,
    cloudConfig: loadCloudConfig(),
    kpi,
    accounts,
    keys
  };
}

async function testAndSaveCloudDatabase(cloudDatabaseUrl, telegramUrl) {
  const cleanUrl = String(cloudDatabaseUrl || '').trim().replace(/\/+$/, '');
  if (!cleanUrl.startsWith('https://')) {
    return { ok: false, reason: 'URL ត្រូវតែផ្តើមដោយ https:// (ឧទាហរណ៍ https://...firebasedatabase.app)' };
  }
  const prev = loadCloudConfig();
  saveCloudConfig({
    cloudDatabaseUrl: cleanUrl,
    telegramUrl: telegramUrl || prev.telegramUrl
  });

  try {
    const pingTime = Date.now();
    await firebaseRequest('meta/lastAdminPing', 'PUT', pingTime, 7000);
    return {
      ok: true,
      cloudConfig: loadCloudConfig(),
      message: 'ភ្ជាប់ និងរក្សាទុក Firebase Realtime Database បានជោគជ័យ (24/7 Online)!'
    };
  } catch (err) {
    saveCloudConfig(prev);
    return {
      ok: false,
      reason: `មិនអាចភ្ជាប់ទៅ Firebase URL នេះបានទេ៖ ${err.message}`
    };
  }
}

async function adminAddDays(email, addDays) {
  const emailKey = emailToFirebaseKey(email);
  const acc = await firebaseRequest(`accounts/${emailKey}`, 'GET');
  if (!acc || !acc.email) throw new Error('Account not found');

  const days = Number(addDays) || 30;
  const now = Date.now();
  const baseTime = acc.expiresAt && Number(acc.expiresAt) > now ? Number(acc.expiresAt) : now;
  const newExpiresAt = baseTime + days * 86400000;

  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', {
    isLifetime: false,
    expiresAt: newExpiresAt,
    status: 'active',
    plan: formatPlanLabel(days, false)
  });
  return { ok: true, expiresAt: newExpiresAt };
}

async function adminSetLifetime(email) {
  const emailKey = emailToFirebaseKey(email);
  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', {
    isLifetime: true,
    expiresAt: null,
    status: 'active',
    plan: 'LIFETIME'
  });
  return { ok: true };
}

async function adminResetPassword(email, newPassword) {
  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('ពាក្យសម្ងាត់ថ្មីត្រូវមានយ៉ាងតិច ៤ តួអក្សរ');
  }
  const emailKey = emailToFirebaseKey(email);
  const passwordHash = hashPassword(String(newPassword));
  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', { passwordHash });
  return { ok: true };
}

async function adminForceLogoutDevice(email) {
  const emailKey = emailToFirebaseKey(email);
  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', { activeDevice: null });
  return { ok: true };
}

async function adminToggleAccountStatus(email) {
  const emailKey = emailToFirebaseKey(email);
  const acc = await firebaseRequest(`accounts/${emailKey}`, 'GET');
  if (!acc || !acc.email) throw new Error('Account not found');
  const nextStatus = acc.status === 'disabled' ? 'active' : 'disabled';
  const patch = { status: nextStatus };
  if (nextStatus === 'disabled') {
    patch.activeDevice = null;
  }
  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', patch);
  return { ok: true, status: nextStatus };
}

async function adminDeleteAccount(email) {
  const emailKey = emailToFirebaseKey(email);
  await firebaseRequest(`accounts/${emailKey}`, 'DELETE');
  return { ok: true };
}

async function adminUpdateCustomerName(email, customerName) {
  const emailKey = emailToFirebaseKey(email);
  const cleanName = String(customerName || '').trim();
  await firebaseRequest(`accounts/${emailKey}`, 'PATCH', { customerName: cleanName });
  return { ok: true, customerName: cleanName };
}

async function adminDeleteUnusedKey(key) {
  const keyId = keyToFirebaseId(key);
  await firebaseRequest(`keys/${keyId}`, 'DELETE');
  return { ok: true };
}

module.exports = {
  MAX_OFFLINE_GRACE_MS,
  ONLINE_HEARTBEAT_WINDOW_MS,
  loadCloudConfig,
  saveCloudConfig,
  getMachineId,
  getDeviceName,
  getSessionFilePath,
  saveEncryptedSession,
  loadEncryptedSession,
  clearEncryptedSession,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  normalizeLicenseKey,
  validateLicenseKeyCryptographically,
  generateSignedLicenseKey,
  getLocalLicenseStatusSync,
  registerWithGmailAndKey,
  loginWithGmail,
  verifySessionWithCloud,
  logoutCurrentSession,
  generateAdminLicenseKey,
  generateBulkAdminLicenseKeys,
  fetchAdminOverview,
  testAndSaveCloudDatabase,
  adminAddDays,
  adminSetLifetime,
  adminResetPassword,
  adminForceLogoutDevice,
  adminToggleAccountStatus,
  adminDeleteAccount,
  adminUpdateCustomerName,
  adminDeleteUnusedKey
};
