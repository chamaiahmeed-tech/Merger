'use strict';
/* طبقة قاعدة البيانات — Turso (libSQL):
   - المخطط (CREATE TABLE IF NOT EXISTS) للمهام والمصادر وأجزاء المصادر والناتج
   - CRUD كامل + كتابة الناتج على صفوف 2MB (حد HTTP في Turso) وقراءة متصفحة من 8 صفوف
   - ادّعاء ذري للمهمة (UPDATE ... WHERE status != 'processing' ثم فحص rowsAffected)
   - تنظيف المهام المنتهية من كل الجداول
   ملاحظة توافق مهمة: @libsql/client v0.14 يعيد عدد الصفوف المتأثرة في
   rowsAffected (camelCase) — لا يُستخدم rows_affected — وكل استدعاء execute
   يمرر args حتى لو كانت مصفوفة فارغة لأن الشكل execute({sql}) فقط يرمي خطأ. */

require('dotenv').config();
const { createClient } = require('@libsql/client');
const { BLOB_CHUNK_BYTES, BLOB_PAGE_ROWS, nowIso } = require('./util');

let _client = null;
function db() {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error('TURSO_DATABASE_URL غير مضبوط في البيئة');
    const cfg = { url };
    if (process.env.TURSO_AUTH_TOKEN) cfg.authToken = process.env.TURSO_AUTH_TOKEN;
    _client = createClient(cfg);
  }
  return _client;
}

let _schemaPromise = null;
function ensureSchema() {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      await db().execute({
        sql: `CREATE TABLE IF NOT EXISTS jobs(
          id TEXT PRIMARY KEY,
          status TEXT,
          progress INTEGER DEFAULT 0,
          error TEXT,
          video_url TEXT,
          size INTEGER,
          duration REAL,
          resolution TEXT,
          created_at TEXT,
          updated_at TEXT,
          expires_at TEXT)`,
        args: []
      });
      await db().execute({
        sql: `CREATE TABLE IF NOT EXISTS sources(
          job_id TEXT,
          seq INTEGER,
          kind TEXT,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          uploaded_bytes INTEGER DEFAULT 0,
          PRIMARY KEY(job_id, seq))`,
        args: []
      });
      await db().execute({
        sql: `CREATE TABLE IF NOT EXISTS source_chunks(
          job_id TEXT,
          seq INTEGER,
          chunk INTEGER,
          data BLOB,
          PRIMARY KEY(job_id, seq, chunk))`,
        args: []
      });
      await db().execute({
        sql: `CREATE TABLE IF NOT EXISTS output_chunks(
          job_id TEXT,
          chunk INTEGER,
          data BLOB,
          PRIMARY KEY(job_id, chunk))`,
        args: []
      });
    })().catch((e) => { _schemaPromise = null; throw e; });
  }
  return _schemaPromise;
}

/* ============================ المهام ============================ */

async function createJob({ id, status, createdAt, expiresAt }) {
  await ensureSchema();
  await db().execute({
    sql: 'INSERT INTO jobs (id, status, progress, created_at, updated_at, expires_at) VALUES (?, ?, 0, ?, ?, ?)',
    args: [id, status, createdAt, createdAt, expiresAt]
  });
}

async function getJob(id) {
  const r = await db().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return r.rows[0] || null;
}

const JOB_FIELDS = ['status', 'progress', 'error', 'video_url', 'size', 'duration', 'resolution', 'updated_at', 'expires_at'];

/* تحديث ديناميكي آمن — القائمة البيضاء فقط تُسمح في جملة SET */
async function updateJob(id, fields) {
  const keys = Object.keys(fields).filter((k) => JOB_FIELDS.includes(k));
  if (!keys.length) return;
  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await db().execute({ sql, args: [...keys.map((k) => fields[k]), id] });
}

/* ادّعاء ذري: نداءات process المتزامنة — الأول يغير الحالة وrowsAffected=1
   والباقي rowsAffected=0 → يعيد المعالج 202 {"status":"processing"} */
async function claimJob(id) {
  const r = await db().execute({
    sql: `UPDATE jobs SET status = 'processing', progress = 0, error = NULL, updated_at = ?
          WHERE id = ? AND status != 'processing'`,
    args: [nowIso(), id]
  });
  return r.rowsAffected > 0;
}

async function deleteJobAll(id) {
  // حذف شامل: source_chunks ثم output_chunks ثم sources ثم jobs
  await db().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] });
  await db().execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] });
  await db().execute({ sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] });
  const r = await db().execute({ sql: 'DELETE FROM jobs WHERE id = ?', args: [id] });
  return r.rowsAffected; // 1 إذا كانت المهمة موجودة فعلًا
}

/* تنظيف كسول/cron: حذف كل المهام التي expires_at < الآن من كل الجداول */
async function cleanupExpired() {
  const now = nowIso();
  const r = await db().execute({
    sql: 'SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at < ?',
    args: [now]
  });
  let deleted = 0;
  for (const row of r.rows) deleted += await deleteJobAll(String(row.id));
  return deleted;
}

/* ============================ المصادر ============================ */

async function insertSource(jobId, seq, s) {
  await db().execute({
    sql: `INSERT OR REPLACE INTO sources (job_id, seq, kind, url, name, size, mime, uploaded_bytes)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [jobId, seq, s.kind, s.url || null, s.name || null, Math.max(0, Number(s.size) || 0), s.mime || null]
  });
}

async function getSource(jobId, seq) {
  const r = await db().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? AND seq = ?',
    args: [jobId, seq]
  });
  return r.rows[0] || null;
}

async function getSources(jobId) {
  const r = await db().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC',
    args: [jobId]
  });
  return r.rows;
}

/* ======================= أجزاء المصادر (BLOB) ======================= */

/* upsert: إعادة رفع نفس رقم الجزء تستبدل القديم بدل تكراره */
async function upsertSourceChunk(jobId, seq, chunk, data) {
  await db().execute({
    sql: `INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)
          ON CONFLICT(job_id, seq, chunk) DO UPDATE SET data = excluded.data`,
    args: [jobId, seq, chunk, data]
  });
}

async function getSourceUploadedBytes(jobId, seq) {
  const r = await db().execute({
    sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM source_chunks WHERE job_id = ? AND seq = ?',
    args: [jobId, seq]
  });
  return Number(r.rows[0].n || 0);
}

async function countSourceChunks(jobId, seq) {
  const r = await db().execute({
    sql: 'SELECT COUNT(*) AS n FROM source_chunks WHERE job_id = ? AND seq = ?',
    args: [jobId, seq]
  });
  return Number(r.rows[0].n || 0);
}

async function updateSourceUploadedBytes(jobId, seq, total) {
  await db().execute({
    sql: 'UPDATE sources SET uploaded_bytes = ? WHERE job_id = ? AND seq = ?',
    args: [total, jobId, seq]
  });
}

async function deleteSourceChunks(jobId) {
  // بعد نجاح الدمج لا حاجة لإبقاء أجزاء المصادر (توفير حصة Turso)
  await db().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
}

/* ======================= ناتج الدمج (BLOB) ======================= */

async function getOutputSize(jobId) {
  const r = await db().execute({
    sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM output_chunks WHERE job_id = ?',
    args: [jobId]
  });
  return Number(r.rows[0].n || 0);
}

/* كتابة الناتج على صفوف 2MB (حد HTTP في Turso) — تحذف أي صفوف قديمة أولًا */
async function writeOutputBlob(jobId, buffer) {
  await db().execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
  const rows = Math.ceil(buffer.length / BLOB_CHUNK_BYTES);
  for (let i = 0; i < rows; i++) {
    const piece = buffer.subarray(i * BLOB_CHUNK_BYTES, Math.min(buffer.length, (i + 1) * BLOB_CHUNK_BYTES));
    await db().execute({
      sql: 'INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)',
      args: [jobId, i, piece]
    });
  }
  return rows;
}

module.exports = {
  db,
  BLOB_CHUNK_BYTES,
  BLOB_PAGE_ROWS,
  ensureSchema,
  createJob,
  getJob,
  updateJob,
  claimJob,
  deleteJobAll,
  cleanupExpired,
  insertSource,
  getSource,
  getSources,
  upsertSourceChunk,
  getSourceUploadedBytes,
  countSourceChunks,
  updateSourceUploadedBytes,
  deleteSourceChunks,
  getOutputSize,
  writeOutputBlob
};
