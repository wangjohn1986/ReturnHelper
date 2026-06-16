/* 退貨系統 PWA — 防呆比對版
   - 匯入「預期清單」(CSV/Excel/貼上)
   - 連續辨識（模式A BarcodeDetector→jsQR / 模式B Tesseract OCR），嚴格 TW+13 碼
   - validateBarcode()：在清單且未掃→綠(成功)；不在清單或重複→紅(錯誤)
   - IndexedDB 紀錄每筆辨識(含 is_valid)；可匯出「異常清單」
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;

let mode = 'A';
let stream = null, scanning = false, lastHitAt = 0, bd = null;
let ocrWorker = null, ocrBusy = false, ocrTimer = null;
let actx = null;
let db = null;
let expected = new Map();   // code -> {code, status:'pending'|'done', doneTs}
let anomalies = new Map();  // code -> {code, mode, ts}  (掃到但不在清單 / is_valid=false)

const video = $('video');
const canvas = $('frame-canvas');
const cctx = canvas.getContext('2d', { willReadFrequently: true });

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('returns-db', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('expected')) d.createObjectStore('expected', { keyPath: 'code' });
      if (!d.objectStoreNames.contains('scans')) d.createObjectStore('scans', { keyPath: 'code' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (name, m) => db.transaction(name, m).objectStore(name);
function dbAll(name) {
  return new Promise((res) => {
    const out = []; const c = store(name, 'readonly').openCursor();
    c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
  });
}
function dbPut(name, rec) { return new Promise((res) => { store(name, 'readwrite').put(rec).onsuccess = () => res(); }); }
function dbClear(name) { return new Promise((res) => { store(name, 'readwrite').clear().onsuccess = () => res(); }); }

/* ---------- 比對核心 ---------- */
function validateBarcode(code) {
  code = (code || '').trim().toUpperCase();
  if (!RE_TW.test(code)) return { state: 'bad', code, msg: '格式不符（需 TW＋13碼）' };
  const exp = expected.get(code);
  if (!exp) return { state: 'invalid', code, msg: '不在預期清單' };
  if (exp.status === 'done') return { state: 'dup', code, msg: '重複，已掃描' };
  return { state: 'ok', code, msg: '正確' };
}

async function handleCode(raw, m) {
  if (Date.now() - lastHitAt < 1200) return;
  const v = validateBarcode(raw);
  if (v.state === 'bad') return;           // 非 TW 直接忽略，維持掃描純度
  lastHitAt = Date.now();
  if (v.state === 'ok') {
    const exp = expected.get(v.code);
    exp.status = 'done'; exp.doneTs = nowStr();
    await dbPut('expected', exp);
    await dbPut('scans', { code: v.code, mode: m, is_valid: true, ts: exp.doneTs });
    flashFrame('ok'); beep(true); toast('✅ ' + v.code);
  } else if (v.state === 'invalid') {
    const rec = { code: v.code, mode: m, is_valid: false, ts: nowStr() };
    anomalies.set(v.code, rec); await dbPut('scans', rec);
    flashFrame('err'); beep(false); toast('❌ 不在清單：' + v.code, true);
  } else { // dup
    flashFrame('err'); beep(false); toast('⚠️ 重複，已掃描：' + v.code, true);
  }
  render();
}

/* ---------- 鏡頭與辨識 ---------- */
async function startCamera() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    video.srcObject = stream; await video.play();
    $('start-cam').hidden = true;
    scanning = true; loop();
    if (mode === 'B') startOcr();
  } catch (e) {
    dialog('無法開啟鏡頭：' + (e && e.message ? e.message : e) + '\n請確認已允許相機權限，且使用 HTTPS 開啟。', [{ label: '知道了' }]);
  }
}
async function loop() {
  if (!scanning) return;
  if (mode === 'A' && video.readyState >= 2 && Date.now() - lastHitAt > 1200) {
    try {
      let value = null;
      if (bd) { const codes = await bd.detect(video); if (codes && codes.length) value = codes[0].rawValue; }
      else if (window.jsQR) { const v = frameImageData(); if (v) { const r = jsQR(v.data, v.width, v.height); if (r) value = r.data; } }
      if (value) handleCode(value, 'A');
    } catch (e) {}
  }
  requestAnimationFrame(loop);
}
function frameImageData() {
  const w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
  canvas.width = w; canvas.height = h; cctx.drawImage(video, 0, 0, w, h);
  return cctx.getImageData(0, 0, w, h);
}
function cropCenterBand() {
  const w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
  const cw = Math.round(w * 0.8), ch = Math.round(h * 0.18);
  const sx = Math.round((w - cw) / 2), sy = Math.round((h - ch) / 2);
  canvas.width = cw; canvas.height = ch; cctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
  return canvas;
}
async function ensureOcr() {
  if (ocrWorker || !window.Tesseract) return;
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
}
function startOcr() { $('ocr-hint').hidden = false; ensureOcr(); clearInterval(ocrTimer); ocrTimer = setInterval(runOcr, 1500); }
function stopOcr() { clearInterval(ocrTimer); ocrTimer = null; $('ocr-hint').hidden = true; }
async function runOcr() {
  if (mode !== 'B' || !scanning || ocrBusy || !ocrWorker) return;
  if (Date.now() - lastHitAt < 1200) return;
  const c = cropCenterBand(); if (!c) return;
  ocrBusy = true;
  try {
    const { data } = await ocrWorker.recognize(c);
    const text = (data.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = text.match(/TW[A-Z0-9]{13}/);
    if (m) handleCode(m[0], 'B');
  } catch (e) {} finally { ocrBusy = false; }
}

/* ---------- 模式切換 / 框色 ---------- */
function setMode(m) {
  mode = m;
  $('frame').classList.toggle('mode-a', m === 'A');
  $('frame').classList.toggle('mode-b', m === 'B');
  $('fab').classList.toggle('mode-b', m === 'B');
  $('fab-mode').textContent = m;
  $('fab-label').textContent = m === 'A' ? '條碼' : '文字';
  $('guide').textContent = m === 'A' ? '請掃描二維碼' : '請掃描物流編號';
  lastHitAt = Date.now();
  if (m === 'B') { if (scanning) startOcr(); } else stopOcr();
}
function flashFrame(state) {
  const f = $('frame'); f.classList.remove('ok', 'err'); void f.offsetWidth; f.classList.add(state);
  clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove(state), 800);
}

/* ---------- 清單渲染 ---------- */
function render() {
  const list = [...expected.values()];
  const done = list.filter(x => x.status === 'done').sort((a, b) => (a.doneTs < b.doneTs ? 1 : -1)); // 最新完成在上
  const pending = list.filter(x => x.status !== 'done');
  const bad = [...anomalies.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));

  $('cnt-done').textContent = done.length;
  $('cnt-total').textContent = list.length;
  $('cnt-bad').textContent = bad.length;
  $('hdr-prog').textContent = `${done.length} / ${list.length}`;
  $('counter').textContent = `已完成 ${done.length} / ${list.length}`;
  $('counter').classList.toggle('full', list.length > 0 && done.length === list.length);
  $('empty').hidden = (list.length + bad.length) > 0;

  const el = $('list'); el.innerHTML = '';
  bad.forEach(r => el.appendChild(row('bad', r.code, '異常', '模式' + r.mode)));
  done.forEach(r => el.appendChild(row('done', r.code, '已完成', '')));
  pending.forEach(r => el.appendChild(row('pending', r.code, '等待', '')));

  $('copy-done').disabled = done.length === 0;
  $('export-bad').disabled = bad.length === 0;
  $('reset-btn').disabled = (done.length + bad.length) === 0;
}
function row(kind, code, label, tag) {
  const d = document.createElement('div'); d.className = 'row ' + kind;
  d.innerHTML = `<span class="badge ${kind}">${label}</span><span class="code">${code}</span>${tag ? `<span class="mode-tag">${tag}</span>` : ''}`;
  return d;
}

/* ---------- 匯入預期清單 ---------- */
function openImport() { $('import-text').value = ''; $('import-file').value = ''; $('import-modal').hidden = false; }
function closeImport() { $('import-modal').hidden = true; }
function extractCodes(text) {
  const seen = new Set(); const out = [];
  (text || '').split(/[\s,，、;]+/).forEach(s => { const up = s.trim().toUpperCase(); if (RE_TW.test(up) && !seen.has(up)) { seen.add(up); out.push(up); } });
  return out;
}
function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      let all = [];
      wb.SheetNames.forEach(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }).forEach(r => r.forEach(c => all.push(String(c)))));
      applyExpected(extractCodes(all.join(' ')));
    } catch (err) { dialog('讀檔失敗：' + err, [{ label: '知道了' }]); }
  };
  reader.readAsArrayBuffer(file);
}
async function applyExpected(codes) {
  if (!codes.length) { dialog('找不到符合 TW＋13碼 的編號。', [{ label: '知道了' }]); return; }
  const run = async () => {
    await dbClear('expected'); await dbClear('scans');
    expected = new Map(); anomalies = new Map();
    for (const code of codes) { const rec = { code, status: 'pending', doneTs: '' }; expected.set(code, rec); await dbPut('expected', rec); }
    closeImport(); render(); toast(`已匯入 ${codes.length} 筆預期清單`);
  };
  if (expected.size > 0) {
    dialog(`匯入會清掉目前清單與進度，改用新的 ${codes.length} 筆。確定？`, [{ label: '取消' }, { label: '確定匯入', danger: true, onClick: run }]);
  } else { run(); }
}

/* ---------- 匯出 / 複製 / 清除 ---------- */
function csvDownload(rows, name) {
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportBad() {
  const bad = [...anomalies.values()];
  if (!bad.length) { dialog('沒有異常資料。', [{ label: '知道了' }]); return; }
  const rows = [['序號', '物流編號', '模式', '時間', '狀態']];
  bad.forEach((r, i) => rows.push([i + 1, r.code, '模式' + r.mode, r.ts, '不在預期清單']));
  csvDownload(rows, `退貨異常清單_${nowStr().replace(/[: ]/g, '-')}.csv`);
  toast(`已匯出異常 ${bad.length} 筆`);
}
async function copyDone() {
  const done = [...expected.values()].filter(x => x.status === 'done');
  if (!done.length) { dialog('尚無已完成項目。', [{ label: '知道了' }]); return; }
  const text = done.map(r => r.code).join('\n');
  try { await navigator.clipboard.writeText(text); toast(`已複製 ${done.length} 筆已完成`); }
  catch (e) { dialog('複製失敗，請改用匯出。', [{ label: '知道了' }]); }
}
function resetProgress() {
  if (!expected.size && !anomalies.size) return;
  dialog('清除所有掃描進度與異常（保留預期清單）？', [
    { label: '取消' },
    { label: '清除進度', danger: true, onClick: async () => {
      anomalies = new Map(); await dbClear('scans');
      for (const rec of expected.values()) { rec.status = 'pending'; rec.doneTs = ''; await dbPut('expected', rec); }
      render(); toast('已清除進度');
    } }
  ]);
}

/* ---------- 小工具 ---------- */
let toastT = null;
function toast(msg, warn) { const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function beep(ok) {
  try { if (actx) { const o = actx.createOscillator(), g = actx.createGain(); o.connect(g); g.connect(actx.destination); o.frequency.value = ok ? 880 : 240; g.gain.value = 0.06; o.start(); setTimeout(() => o.stop(), ok ? 120 : 200); } } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [40, 40, 40]); } catch (e) {}
}
function nowStr() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function dialog(text, buttons) {
  const box = $('dialog'); $('dialog-text').textContent = text; const foot = $('dialog-foot'); foot.innerHTML = '';
  buttons.forEach(b => { const el = document.createElement('button'); el.className = 'btn ' + (b.danger ? 'up' : b.onClick ? 'save' : 'cancel'); if (b.danger) el.style.background = 'var(--red)'; el.textContent = b.label; el.onclick = () => { box.hidden = true; if (b.onClick) b.onClick(); }; foot.appendChild(el); });
  box.hidden = false;
}

/* ---------- 啟動 ---------- */
async function init() {
  db = await openDB();
  (await dbAll('expected')).forEach(r => expected.set(r.code, r));
  (await dbAll('scans')).forEach(r => { if (!r.is_valid) anomalies.set(r.code, r); });
  if ('BarcodeDetector' in window) { try { bd = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { bd = null; } }
  setMode('A'); render();

  $('start-cam').onclick = startCamera;
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('import-btn').onclick = openImport;
  $('import-close').onclick = closeImport;
  $('import-cancel').onclick = closeImport;
  $('import-apply').onclick = () => {
    const f = $('import-file').files[0];
    if (f) importFromFile(f);
    else applyExpected(extractCodes($('import-text').value));
  };
  $('copy-done').onclick = copyDone;
  $('export-bad').onclick = exportBad;
  $('reset-btn').onclick = resetProgress;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
