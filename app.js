/* 退貨系統 PWA — 手機收集物流編號，帶到電腦匯入 ERP
   - 模式 A：BarcodeDetector（後備 jsQR）掃二維碼
   - 模式 B：Tesseract OCR，嚴格 /^TW[A-Za-z0-9]{13}$/
   - 掃到→存 IndexedDB（防重掃）；可複製清單 / 匯出 CSV / 清除
   - 無核對清單，純收集
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;

let mode = 'A';
let stream = null, scanning = false, lastHitAt = 0, bd = null;
let ocrWorker = null, ocrBusy = false, ocrTimer = null;
let actx = null;
let db = null;
const seen = new Set(); // 已收集的編號（防重掃）

const video = $('video');
const canvas = $('frame-canvas');
const cctx = canvas.getContext('2d', { willReadFrequently: true });

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('returns-db', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'code' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (m) => db.transaction('records', m).objectStore('records');
function dbAll() {
  return new Promise((res) => {
    const out = []; const c = store('readonly').openCursor();
    c.onsuccess = (e) => { const cur = e.target.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
  });
}
function dbAdd(rec) { return new Promise((res, rej) => { const r = store('readwrite').add(rec); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); }); }
function dbDel(code) { return new Promise((res) => { store('readwrite').delete(code).onsuccess = () => res(); }); }
function dbClear() { return new Promise((res) => { store('readwrite').clear().onsuccess = () => res(); }); }

/* ---------- 收集一筆（含防重掃） ---------- */
async function addCode(raw, m) {
  const code = (raw || '').trim();
  if (!code) return;
  if (Date.now() - lastHitAt < 1200) return;
  lastHitAt = Date.now();
  if (seen.has(code)) { flashFrame('err'); beep(false); toast('重複，已略過：' + code, true); return; }
  try {
    await dbAdd({ code, mode: m, ts: nowStr() });
    seen.add(code);
    flashFrame('ok'); beep(true); toast('✅ ' + code);
    render();
  } catch (e) { flashFrame('err'); beep(false); toast('重複，已略過：' + code, true); }
}

/* ---------- 鏡頭與辨識 ---------- */
async function startCamera() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
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
      if (value) addCode(value, 'A');
    } catch (e) {}
  }
  requestAnimationFrame(loop);
}
function frameImageData() {
  const w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
  canvas.width = w; canvas.height = h; cctx.drawImage(video, 0, 0, w, h);
  return cctx.getImageData(0, 0, w, h);
}
/* 模式B 直式長條：裁切畫面中央的「直立」區域給 OCR */
function cropCenterStrip() {
  const w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
  const cw = Math.round(w * 0.42), ch = Math.round(h * 0.62);
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
  const c = cropCenterStrip(); if (!c) return;
  ocrBusy = true;
  try {
    const { data } = await ocrWorker.recognize(c);
    const text = (data.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = text.match(/TW[A-Z0-9]{13}/);
    if (m && RE_TW.test(m[0])) addCode(m[0], 'B');
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
  clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove(state), 700);
}

/* ---------- 清單渲染 ---------- */
async function render() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1)); // 由舊到新
  $('cnt').textContent = all.length;
  $('hdr-count').textContent = '已掃 ' + all.length;
  $('counter').textContent = `已掃描 ${all.length} 筆`;
  $('empty').hidden = all.length > 0;

  const list = $('list'); list.innerHTML = '';
  all.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span class="idx">#${i + 1}</span><span class="code">${r.code}</span><span class="time">${timeShort(r.ts)}</span><span class="mode-tag">模式${r.mode}</span><button class="del" data-code="${r.code}" aria-label="刪除">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.del').forEach(b => b.onclick = async () => { await dbDel(b.dataset.code); seen.delete(b.dataset.code); render(); });
  list.scrollTop = list.scrollHeight;

  $('copy-list').disabled = all.length === 0;
  $('export-csv').disabled = all.length === 0;
  $('clear-all').disabled = all.length === 0;
}
function timeShort(ts) { return (ts || '').split(' ')[1] || ts; }

/* ---------- 複製 / 匯出 / 清除 ---------- */
async function copyList() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可複製。', [{ label: '知道了' }]); return; }
  try { await navigator.clipboard.writeText(all.map(r => r.code).join('\n')); toast(`已複製 ${all.length} 筆`); }
  catch (e) { dialog('複製失敗，請改用「匯出 CSV」。', [{ label: '知道了' }]); }
}
async function exportCSV() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可匯出。', [{ label: '知道了' }]); return; }
  const rows = [['序號', '物流編號', '模式', '時間']];
  all.forEach((r, i) => rows.push([i + 1, r.code, '模式' + r.mode, r.ts]));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `退貨清單_${nowStr().replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已匯出 ${all.length} 筆 CSV`);
}
async function clearAll() {
  const all = await dbAll();
  if (!all.length) return;
  dialog(`確定清除全部 ${all.length} 筆？（無法復原）`, [
    { label: '取消' },
    { label: '清除全部', danger: true, onClick: async () => { await dbClear(); seen.clear(); render(); } }
  ]);
}

/* ---------- 小工具 ---------- */
let toastT = null;
function toast(msg, warn) { const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
/* 提示音（加大音量）：成功高音、重複低音 */
function beep(ok) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'square';
    o.frequency.value = ok ? 1000 : 300;
    g.gain.value = 0.0001; o.connect(g); g.connect(actx.destination);
    const t0 = actx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);   // 音量加大
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (ok ? 0.18 : 0.32));
    o.start(t0); o.stop(t0 + (ok ? 0.2 : 0.34));
  } catch (e) {}
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
  (await dbAll()).forEach(r => seen.add(r.code));
  if ('BarcodeDetector' in window) { try { bd = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { bd = null; } }
  setMode('A'); render();

  $('start-cam').onclick = startCamera;
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('copy-list').onclick = copyList;
  $('export-csv').onclick = exportCSV;
  $('clear-all').onclick = clearAll;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
