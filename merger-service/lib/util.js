'use strict';
/* أدوات مشتركة لكل نقاط الدخول: ترويسات CORS + معالج OPTIONS، ردود JSON،
   قراءة الجسم الخام (يستخدم req.body إن وُفر من dev-server/Vercel وإلا يجمع من
   التدفق)، بناء الـ origin من الترويسات، توليد المعرفات، وأدوات زمنية،
   ورسائل الأخطاء العربية الموحدة {"error":"..."} */

const crypto = require('crypto');

// CORS مفتوح على كل النقاط حسب المواصفة
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400'
};

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024; // 4MB — الحد الأقصى لجزء الرفع الواحد
const BLOB_CHUNK_BYTES = 2 * 1024 * 1024;   // 2MB — حد صف Blob الواحد في Turso
const BLOB_PAGE_ROWS = 8;                   // القراءة التدفقية بصفحات من 8 صفوف

function applyCors(res) {
  for (const k of Object.keys(CORS_HEADERS)) res.setHeader(k, CORS_HEADERS[k]);
}

/* يعالج طلب OPTIONS ويكتب الرد (204) — يرجع true إن تولّى الطلب */
function handleOptions(req, res) {
  if (req.method !== 'OPTIONS') return false;
  applyCors(res);
  res.statusCode = 204;
  res.end();
  return true;
}

function sendJson(res, status, obj) {
  applyCors(res);
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
}

/* كل الأخطاء بصيغة عربية موحدة */
function sendError(res, status, messageAr) {
  sendJson(res, status, { error: messageAr });
}

function arabicError(messageAr, status) {
  const e = new Error(messageAr);
  e.arabic = true;
  if (status) e.status = status;
  return e;
}

/* قراءة الجسم الخام:
   - req.body موجود كـ Buffer (octet-stream في dev-server) → يعاد كما هو
   - req.body كائن/نص (JSON محلول) → يُسلسَل إلى Buffer
   - غير ذلك يُجمع من تدفق الطلب (سلوك Vercel الخام)
   - حماية من التعليق إذا كان التدفق قد استُهلك سابقًا (readableEnded) */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) return resolve(req.body);
      if (typeof req.body === 'string') return resolve(Buffer.from(req.body, 'utf8'));
      try { return resolve(Buffer.from(JSON.stringify(req.body))); }
      catch (e) { return reject(e); }
    }
    if (req.readableEnded) return resolve(Buffer.alloc(0));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* تحليل جسم JSON مع حد حجم ورسائل عربية (400 لـ JSON تالف، 413 للتجاوز) */
async function readJsonBody(req, limitBytes) {
  const raw = await readRawBody(req);
  if (limitBytes && raw.length > limitBytes) throw arabicError('حجم الطلب يتجاوز الحد المسموح', 413);
  if (!raw.length) throw arabicError('الطلب فارغ', 400);
  try { return JSON.parse(raw.toString('utf8')); }
  catch (_) { throw arabicError('JSON تالف', 400); }
}

/* origin من ترويسات الوكيل (x-forwarded-proto + host) أو من رابط الطلب نفسه */
function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    const scheme = proto || (req.socket && req.socket.encrypted ? 'https' : 'http');
    return `${scheme}://${host}`;
  }
  try { return new URL(req.url, 'http://localhost').origin; } catch (_) { return ''; }
}

function genId() { return crypto.randomBytes(9).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function addHours(iso, hours) { return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString(); }

/* تحقق مشترك من قائمة المصادر — يرجع رسالة عربية عند الرفض أو null */
function validateJobSources(sources, maxSources) {
  if (!Array.isArray(sources) || sources.length < 2) return 'يلزم مقطعان على الأقل للدمج';
  if (sources.length > maxSources) return `أقصى عدد مقاطع هو ${maxSources}`;
  for (const s of sources) {
    if (!s || typeof s !== 'object') return 'صيغة المصادر غير صحيحة';
    if (s.kind === 'file') continue; // الملفات تُرفع أجزاءً لاحقًا
    if (!/^https?:\/\//i.test(String(s.url || ''))) return 'رابط المصدر غير صالح، يلزم http/https';
  }
  return null;
}

module.exports = {
  CORS_HEADERS,
  UPLOAD_CHUNK_BYTES,
  BLOB_CHUNK_BYTES,
  BLOB_PAGE_ROWS,
  applyCors,
  handleOptions,
  sendJson,
  sendError,
  arabicError,
  readRawBody,
  readJsonBody,
  getOrigin,
  genId,
  nowIso,
  addHours,
  validateJobSources
};
