'use strict';
/* اختبار HTTP شامل ضد dev-server على PORT 4000 — يبدأه تلقائيًا إن لم يكن يعمل
   ويعيد استخدام خادم قائم. يغطي:
   - إنشاء مهمة من روابط → process → done مع videoUrl
   - بث مع Range: bytes=0-99 → 206 + Content-Range
   - GET كامل بدون Range → 200
   - مهمة مختلطة (رابط + ملف مرفوع أجزاءً عبر /api/upload) → دمج
   - حذف → GET بعدها 404
   - JSON تالف → 400 | مصدر واحد → 400 | 11 مصدرًا → 400
   يطبع "PASS name" / "FAIL name: reason" لكل اختبار وسطر نهائي "HTTP: X/Y passed". */

require('dotenv').config();
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const PORT = 4000;
const BASE = 'http://127.0.0.1:' + PORT;
const URLS = [
  'https://www.w3schools.com/html/mov_bbb.mp4',
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4'
];

const results = [];
function record(name, pass, reason) {
  results.push(!!pass);
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : ': ' + (reason || '')));
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}
async function waitOpen(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function call(method, urlPath, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json';
  } else if (opts.raw !== undefined) {
    body = opts.raw;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
  }
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeout || 30000)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
  return { status: res.status, headers: res.headers, buf, json };
}

async function main() {
  // تشغيل dev-server تلقائيًا إن لم يكن يعمل (وإلا يُعاد استخدام الخادم القائم)
  let child = null;
  if (!(await portOpen(PORT))) {
    child = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'ignore', 'inherit']
    });
    const up = await waitOpen(PORT, 20000);
    if (!up) {
      console.log('FAIL dev-server: لم يبدأ خلال المهلة');
      console.log('HTTP: 0/10 passed');
      process.exitCode = 1;
      return;
    }
  }

  const created = [];
  try {
    // 1) إنشاء مهمة من روابط
    const r1 = await call('POST', '/api/jobs', { json: { videos: URLS } });
    const j1 = r1.json || {};
    record(
      'create-url-job',
      r1.status === 201 && !!j1.jobId && !!j1.statusUrl && !!j1.processUrl && !!j1.expiresAt && j1.status === 'queued',
      `status=${r1.status} body=${r1.buf.toString('utf8').slice(0, 200)}`
    );
    const id1 = j1.jobId;
    if (id1) created.push(id1);

    // 2) process متزامن → done مع videoUrl
    const r2 = await call('POST', `/api/jobs/${id1}/process`, { timeout: 240000 });
    const j2 = r2.json || {};
    record(
      'process-url-job',
      r2.status === 200 && j2.status === 'done' && /\/video$/.test(String(j2.videoUrl || ''))
        && j2.size > 0 && j2.duration > 0 && !!j2.resolution,
      `status=${r2.status} body=${r2.buf.toString('utf8').slice(0, 200)}`
    );

    // 3) بث مع Range: bytes=0-99 → 206 + Content-Range
    const r3 = await call('GET', `/api/jobs/${id1}/video`, { headers: { Range: 'bytes=0-99' } });
    const cr = String(r3.headers.get('content-range') || '');
    record(
      'video-range-206',
      r3.status === 206 && cr.indexOf('bytes 0-99/') === 0 && r3.buf.length === 100
        && String(r3.headers.get('content-type') || '').indexOf('video/mp4') === 0
        && String(r3.headers.get('accept-ranges') || '') === 'bytes',
      `status=${r3.status} content-range=${cr} len=${r3.buf.length}`
    );

    // 4) GET كامل بدون Range → 200
    const r4 = await call('GET', `/api/jobs/${id1}/video`, { timeout: 60000 });
    record(
      'video-full-200',
      r4.status === 200 && r4.buf.length > 1000,
      `status=${r4.status} len=${r4.buf.length}`
    );

    // 5) مهمة مختلطة: رابط + ملف مرفوع أجزاءً عبر /api/upload ثم دمج
    const dl = await fetch(URLS[0], { signal: AbortSignal.timeout(60000) });
    const fileBuf = Buffer.from(await dl.arrayBuffer());
    const r5 = await call('POST', '/api/jobs', {
      json: {
        sources: [
          { kind: 'url', url: URLS[1] },
          { kind: 'file', name: 'local.mp4', size: fileBuf.length, mime: 'video/mp4' }
        ]
      }
    });
    const j5 = r5.json || {};
    const id2 = j5.jobId;
    if (id2) created.push(id2);
    let uploadedOk = false;
    if (r5.status === 201 && id2 && Array.isArray(j5.uploads)) {
      const CH = 256 * 1024;
      const n = Math.ceil(fileBuf.length / CH);
      const entry = j5.uploads.find((u) => u.seq === 1) || {};
      uploadedOk = true;
      for (let k = 0; k < n && uploadedOk; k++) {
        const u = new URL(entry.url || `${BASE}/api/upload?job=${id2}&seq=1&chunk=0`, BASE);
        u.searchParams.set('chunk', String(k));
        const up = await call('POST', u.pathname + u.search, {
          raw: fileBuf.subarray(k * CH, Math.min(fileBuf.length, (k + 1) * CH)),
          contentType: 'application/octet-stream'
        });
        if (up.status !== 200) uploadedOk = false;
      }
    }
    const r5p = await call('POST', `/api/jobs/${id2}/process`, { timeout: 240000 });
    const j5p = r5p.json || {};
    record(
      'mixed-job-process',
      uploadedOk && r5p.status === 200 && j5p.status === 'done',
      `uploaded=${uploadedOk} status=${r5p.status} body=${r5p.buf.toString('utf8').slice(0, 200)}`
    );

    // 6) حذف فوري شامل
    const r6 = await call('DELETE', `/api/jobs/${id2}`);
    record(
      'delete-job',
      r6.status === 200 && r6.json && r6.json.ok === true,
      `status=${r6.status} body=${r6.buf.toString('utf8').slice(0, 200)}`
    );

    // 7) GET بعد الحذف → 404
    const r7 = await call('GET', `/api/jobs/${id2}`);
    record('get-after-delete-404', r7.status === 404, `status=${r7.status}`);

    // 8) JSON تالف → 400
    const r8 = await call('POST', '/api/jobs', { raw: Buffer.from('هذا ليس JSON'), contentType: 'application/json' });
    record('malformed-json-400', r8.status === 400, `status=${r8.status}`);

    // 9) مصدر واحد → 400
    const r9 = await call('POST', '/api/jobs', { json: { videos: [URLS[0]] } });
    record('single-source-400', r9.status === 400, `status=${r9.status}`);

    // 10) أحد عشر مصدرًا → 400
    const r10 = await call('POST', '/api/jobs', {
      json: { videos: Array.from({ length: 11 }, (_, i) => URLS[i % 2]) }
    });
    record('eleven-sources-400', r10.status === 400, `status=${r10.status}`);
  } catch (e) {
    record('unexpected', false, e && e.message);
  } finally {
    // تنظيف المهام المتبقية وإيقاف الخادم إن كنا من أطلقناه
    for (const id of created) {
      try { await call('DELETE', `/api/jobs/${id}`, { timeout: 15000 }); } catch (_) {}
    }
    if (child) { try { child.kill(); } catch (_) {} }
  }

  const passed = results.filter(Boolean).length;
  console.log(`HTTP: ${passed}/${results.length} passed`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main();
