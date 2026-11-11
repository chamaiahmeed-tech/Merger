'use strict';
/* خادم تطوير نقي (http) يحاكي بيئة Vercel محليًا:
   - يخدم ملفات public/ الثابتة
   - يوجّه /api/* مع حلّ المسارات الديناميكية (/api/jobs/:id/process, /api/jobs/:id/video, /api/jobs/:id)
   - يضع معاملات الاستعلام + معرف المسار في req.query
   - يوفر جسمًا خامًا (Buffer) لـ application/octet-stream وJSON محلولًا لغيره في req.body
     (وJSON التالف يُترك خامًا ليعيد المُعالج رفضه بـ 400)
   - يستدعي دوال api/ مباشرة (كل ملف يصدّر دالة (req,res) وتتحقق من req.method بنفسه) */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API_DIR = path.join(__dirname, '..', 'api');

const ROUTES = [
  { re: /^\/api\/jobs\/([^/]+)\/process$/, file: path.join('jobs', '[id]', 'process.js'), param: 'id' },
  { re: /^\/api\/jobs\/([^/]+)\/video$/, file: path.join('jobs', '[id]', 'video.js'), param: 'id' },
  { re: /^\/api\/jobs\/([^/]+)$/, file: path.join('jobs', '[id].js'), param: 'id' },
  { re: /^\/api\/jobs\/?$/, file: 'jobs.js' },
  { re: /^\/api\/upload$/, file: 'upload.js' },
  { re: /^\/api\/config$/, file: 'config.js' },
  { re: /^\/api\/cron$/, file: 'cron.js' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const handlerCache = new Map();
function loadHandler(relFile) {
  if (!handlerCache.has(relFile)) handlerCache.set(relFile, require(path.join(API_DIR, relFile)));
  return handlerCache.get(relFile);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJsonRaw(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    const data = await fs.promises.readFile(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  } catch (_) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  let pathname = '/';
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) {}
  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const u = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(u.searchParams);

      // تجهيز الجسم: خام لـ octet-stream، محلول للـ JSON، خام عند التلف
      const raw = await readBody(req);
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct === 'application/octet-stream') {
        req.body = raw;
      } else {
        const text = raw.toString('utf8');
        try { req.body = text ? JSON.parse(text) : Buffer.alloc(0); }
        catch (_) { req.body = raw; }
      }

      for (const route of ROUTES) {
        const m = route.re.exec(pathname);
        if (!m) continue;
        if (route.param) req.query[route.param] = m[1];
        const handler = loadHandler(route.file);
        try {
          await handler(req, res);
        } catch (e) {
          console.error(`[dev-server] خطأ في ${route.file}:`, e && e.stack || e); // تسجيل الخطأ الحقيقي أثناء التطوير
          if (!res.headersSent) sendJsonRaw(res, 500, { error: 'خطأ داخلي في الخادم' });
          else { try { res.destroy(); } catch (_) {} }
        }
        return;
      }
      return sendJsonRaw(res, 404, { error: 'النقطة غير موجودة' });
    }
    return await serveStatic(res, pathname);
  } catch (_) {
    if (!res.headersSent) sendJsonRaw(res, 500, { error: 'خطأ داخلي في الخادم' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`dev-server: يستمع على http://localhost:${PORT}`);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { server };
