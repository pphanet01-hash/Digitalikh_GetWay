const http = require('http');
const fs = require('fs');
const path = require('path');

let cachedLmMtime = 0;
let licenseManager = require('./license-manager');
function getLicenseManager() {
  try {
    const lmPath = require.resolve('./license-manager');
    const mtime = fs.statSync(lmPath).mtimeMs;
    if (mtime !== cachedLmMtime) {
      delete require.cache[lmPath];
      licenseManager = require('./license-manager');
      cachedLmMtime = mtime;
    }
  } catch (e) {}
  return licenseManager;
}

const DEFAULT_ADMIN_PORT = 20130;

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 256) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function startAdminServer(initialPort = DEFAULT_ADMIN_PORT) {
  return new Promise((resolve, reject) => {
    let port = initialPort;

    function tryBind() {
      const server = http.createServer(async (req, res) => {
        try {
          const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
          const pathname = parsedUrl.pathname;

          // 1. Serve Fonts (/fonts/*)
          if (req.method === 'GET' && pathname.startsWith('/fonts/')) {
            const fontFile = path.basename(pathname);
            const fontPath = path.join(__dirname, '..', 'fonts', fontFile);
            if (fs.existsSync(fontPath)) {
              const buf = fs.readFileSync(fontPath);
              let contentType = 'font/woff2';
              if (fontFile.endsWith('.ttf')) contentType = 'font/ttf';
              else if (fontFile.endsWith('.woff')) contentType = 'font/woff';
              else if (fontFile.endsWith('.otf')) contentType = 'font/otf';
              res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=31536000, immutable'
              });
              return res.end(buf);
            }
            res.writeHead(404);
            return res.end('Font not found');
          }

          // 2. Serve Logo Asset
          if (req.method === 'GET' && (pathname === '/assets/icon.png' || pathname === '/assets/logo.png')) {
            const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
            if (fs.existsSync(iconPath)) {
              res.writeHead(200, { 'Content-Type': 'image/png' });
              return res.end(fs.readFileSync(iconPath));
            }
          }

          // 3. Serve Admin Control Center HTML (license/dashboard.html) with CSP font-src 'self' data:
          if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard.html')) {
            const htmlPath = path.join(__dirname, 'dashboard.html');
            const html = fs.readFileSync(htmlPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self' https://*.firebasedatabase.app;"
            });
            return res.end(html);
          }

          // 4. REST API Endpoints for Admin Control Center
          const lm = getLicenseManager();
          if (req.method === 'GET' && pathname === '/api/overview') {
            const data = await lm.fetchAdminOverview();
            return sendJson(res, 200, data);
          }

          if (req.method === 'POST' && pathname === '/api/keys/generate') {
            const body = await parseJsonBody(req);
            const keyData = await lm.generateAdminLicenseKey({
              durationDays: body.durationDays,
              isLifetime: Boolean(body.isLifetime),
              isTrial: Boolean(body.isTrial),
              customerName: body.customerName || '',
              note: body.note || ''
            });
            return sendJson(res, 200, { ok: true, keyData });
          }

          if (req.method === 'POST' && pathname === '/api/keys/generate-bulk') {
            const body = await parseJsonBody(req);
            const result = await lm.generateBulkAdminLicenseKeys({
              count: body.count || 10,
              durationDays: body.durationDays || 30,
              isLifetime: Boolean(body.isLifetime),
              isTrial: Boolean(body.isTrial),
              customerName: body.customerName || '',
              note: body.note || ''
            });
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/update-name') {
            const body = await parseJsonBody(req);
            const result = await lm.adminUpdateCustomerName(body.email, body.customerName);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/keys/delete') {
            const body = await parseJsonBody(req);
            await lm.adminDeleteUnusedKey(body.key);
            return sendJson(res, 200, { ok: true });
          }

          if (req.method === 'POST' && pathname === '/api/cloud/save') {
            const body = await parseJsonBody(req);
            const result = await lm.testAndSaveCloudDatabase(body.cloudDatabaseUrl, body.telegramUrl);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/add-days') {
            const body = await parseJsonBody(req);
            const result = await lm.adminAddDays(body.email, body.days);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/lifetime') {
            const body = await parseJsonBody(req);
            const result = await lm.adminSetLifetime(body.email);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/password') {
            const body = await parseJsonBody(req);
            const result = await lm.adminResetPassword(body.email, body.newPassword);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/logout-device') {
            const body = await parseJsonBody(req);
            const result = await lm.adminForceLogoutDevice(body.email);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/toggle-status') {
            const body = await parseJsonBody(req);
            const result = await lm.adminToggleAccountStatus(body.email);
            return sendJson(res, 200, result);
          }

          if (req.method === 'POST' && pathname === '/api/accounts/delete') {
            const body = await parseJsonBody(req);
            const result = await lm.adminDeleteAccount(body.email);
            return sendJson(res, 200, result);
          }

          sendJson(res, 404, { ok: false, reason: 'Not found' });
        } catch (err) {
          sendJson(res, 500, { ok: false, reason: err.message || 'Internal Server Error' });
        }
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          port++;
          if (port < initialPort + 10) {
            tryBind();
          } else {
            resolve({ server: null, url: `http://127.0.0.1:${initialPort}` });
          }
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        resolve({ server, url: `http://127.0.0.1:${port}` });
      });
    }

    tryBind();
  });
}

if (require.main === module) {
  startAdminServer(DEFAULT_ADMIN_PORT).then(({ url }) => {
    console.log(`[Sastra Admin Control Center] Running at ${url}`);
  });
}

module.exports = { startAdminServer, DEFAULT_ADMIN_PORT };
