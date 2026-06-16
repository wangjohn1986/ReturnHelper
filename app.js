/* 退貨系統 PWA
   - 模式 A：BarcodeDetector（後備 jsQR）掃描二維碼
   - 模式 B：Tesseract.js OCR，嚴格匹配 /^TW[A-Za-z0-9]{13}$/
   - 資料一律進 IndexedDB：pending(暫存) → saved(待上傳) → 上傳後刪除
   - 防重掃：同一碼不重複錄入（IndexedDB 以 code 為主鍵）
*/
const $ = (id) => document.getElementById(id);
const RE_TW = /^TW[A-Za-z0-9]{13}$/;
const LS_EP = 'sr_endpoint';
const LS_TARGET = 'sr_target';
let target = parseInt(localStorage.getItem(LS_TARGET) || '50', 10) || 50;

let mode = 'A';                 // 'A' 條碼 / 'B' OCR
let stream = null, scanning = false, lastHitAt = 0;
let bd = null;                  // 原生 BarcodeDetector
let ocrWorker = null, ocrBusy = false, ocrTimer = null;
let db = null;
const seen = new Set();         // 已在 DB 中的 code（防重掃用）

const video = $('video');
const canvas = $('frame-canvas');
const cctx = canvas.getContext('2d', { willReadFrequently: true });

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('returns-db', 1);
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
function dbPut(rec) { return new Promise((res) => { store('readwrite').put(rec).onsuccess = () => res(); }); }
function dbDel(code) { return new Promise((res) => { store('readwrite').delete(code).onsuccess = () => res(); }); }

/* ---------- 寫入一筆（含防重掃） ---------- */
async function addCode(code, srcMode) {
  code = (code || '').trim();
  if (!code) return;
  if (seen.has(code)) { toast('重複，已略過：' + code, true); buzz(false); return; }
  const rec = { code, mode: srcMode, status: 'pending', ts: nowStr() };
  try {
    await dbAdd(rec);
    seen.add(code);
    toast('已暫存：' + code);
    buzz(true);
    await render();
  } catch (e) { toast('重複，已略過：' + code, true); buzz(false); }
}

/* ---------- 鏡頭 ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('start-cam').hidden = true;
    scanning = true;
    loop();
    if (mode === 'B') startOcr();
  } catch (e) {
    dialog('無法開啟鏡頭：' + (e && e.message ? e.message : e) + '\n請確認已允許相機權限，且使用 HTTPS 開啟。', [{ label: '知道了' }]);
  }
}

/* 模式 A 主迴圈：每一幀偵測二維碼 */
async function loop() {
  if (!scanning) return;
  if (mode === 'A' && video.readyState >= 2 && Date.now() - lastHitAt > 1200) {
    try {
      let value = null;
      if (bd) {
        const codes = await bd.detect(video);
        if (codes && codes.length) value = codes[0].rawValue;
      } else if (window.jsQR) {
        const v = drawFrameToCanvas();
        if (v) { const r = jsQR(v.data, v.width, v.height); if (r) value = r.data; }
      }
      if (value) { lastHitAt = Date.now(); addCode(value, 'A'); }
    } catch (e) { /* 單幀失敗略過 */ }
  }
  requestAnimationFrame(loop);
}

/* 把目前畫面畫到 canvas，回傳 ImageData（給 jsQR / OCR 用） */
function drawFrameToCanvas() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w; canvas.height = h;
  cctx.drawImage(video, 0, 0, w, h);
  return cctx.getImageData(0, 0, w, h);
}

/* 擷取畫面中央長方形區域（給 OCR，提高準確率） */
function cropCenterBand() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const cw = Math.round(w * 0.8), ch = Math.round(h * 0.18);
  const sx = Math.round((w - cw) / 2), sy = Math.round((h - ch) / 2);
  canvas.width = cw; canvas.height = ch;
  cctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch);
  return canvas;
}

/* ---------- 模式 B：OCR ---------- */
async function ensureOcr() {
  if (ocrWorker || !window.Tesseract) return;
  ocrWorker = await Tesseract.createWorker('eng');
  await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' });
}
function startOcr() {
  $('ocr-hint').hidden = false;
  ensureOcr();
  clearInterval(ocrTimer);
  ocrTimer = setInterval(runOcr, 1500);
}
function stopOcr() { clearInterval(ocrTimer); ocrTimer = null; $('ocr-hint').hidden = true; }
async function runOcr() {
  if (mode !== 'B' || !scanning || ocrBusy || !ocrWorker) return;
  if (Date.now() - lastHitAt < 1200) return;
  const c = cropCenterBand();
  if (!c) return;
  ocrBusy = true;
  try {
    const { data } = await ocrWorker.recognize(c);
    const text = (data.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // 從辨識結果中找出符合 TW + 13 碼 的片段
    const m = text.match(/TW[A-Z0-9]{13}/);
    if (m && RE_TW.test(m[0])) { lastHitAt = Date.now(); addCode(m[0], 'B'); }
  } catch (e) { /* 略過 */ } finally { ocrBusy = false; }
}

/* ---------- 模式切換 ---------- */
function setMode(m) {
  mode = m;
  const frame = $('frame'), fab = $('fab');
  frame.classList.toggle('mode-a', m === 'A');
  frame.classList.toggle('mode-b', m === 'B');
  fab.classList.toggle('mode-b', m === 'B');
  $('fab-mode').textContent = m;
  $('fab-label').textContent = m === 'A' ? '條碼' : '文字';
  $('guide').textContent = m === 'A' ? '請掃描二維碼' : '請掃描物流編號';
  lastHitAt = Date.now();
  if (m === 'B') { if (scanning) startOcr(); } else { stopOcr(); }
}

/* ---------- 清單渲染 ---------- */
async function render() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1)); // 由舊到新，編號穩定
  const pending = all.filter(r => r.status === 'pending');
  const saved = all.filter(r => r.status === 'saved');
  $('cnt-pending').textContent = pending.length;
  $('cnt-saved').textContent = saved.length;
  $('pending-up').textContent = saved.length;
  $('sync-pill').hidden = saved.length === 0;
  $('empty').hidden = all.length > 0;
  $('counter').textContent = `已掃描 ${all.length} / ${target}`;
  $('counter').classList.toggle('full', target > 0 && all.length >= target);

  const list = $('list'); list.innerHTML = '';
  all.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'row';
    const badge = r.status === 'pending' ? '<span class="badge pending">暫存</span>' : '<span class="badge saved">待傳</span>';
    row.innerHTML = `<span class="idx">#${i + 1}</span><span class="code">${r.code}</span><span class="time">${timeShort(r.ts)}</span>${badge}<button class="del" data-code="${r.code}" aria-label="刪除">✕</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('.del').forEach(b => b.onclick = async () => { await dbDel(b.dataset.code); seen.delete(b.dataset.code); render(); });
  list.scrollTop = list.scrollHeight; // 捲到最新一筆

  $('save').disabled = pending.length === 0;
  $('upload').disabled = saved.length === 0;
  $('export-csv').disabled = pending.length === 0;
  $('copy-list').disabled = all.length === 0;
  $('clear-all').disabled = all.length === 0;
}
function timeShort(ts) { return (ts || '').split(' ')[1] || ts; }

/* 匯出所有 pending 為 CSV */
async function exportCSV() {
  const pend = (await dbAll()).filter(r => r.status === 'pending').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!pend.length) { dialog('沒有暫存資料可匯出。', [{ label: '知道了' }]); return; }
  const rows = [['序號', '物流編號', '模式', '時間']];
  pend.forEach((r, i) => rows.push([i + 1, r.code, '模式' + r.mode, r.ts]));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `退貨暫存_${nowStr().replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已匯出 ${pend.length} 筆 CSV`);
}

/* 複製清單：把所有碼複製成純文字（一行一筆），方便用 LINE/Email 帶到電腦貼上 */
async function copyList() {
  const all = (await dbAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!all.length) { dialog('沒有資料可複製。', [{ label: '知道了' }]); return; }
  const text = all.map(r => r.code).join('\n');
  try { await navigator.clipboard.writeText(text); toast(`已複製 ${all.length} 筆，貼到 LINE/Email 帶到電腦`); }
  catch (e) { dialog('複製失敗，請改用「匯出 CSV」。', [{ label: '知道了' }]); }
}

/* 清除全部（含待上傳） */
async function clearAll() {
  const all = await dbAll();
  if (!all.length) return;
  dialog(`確定清除全部 ${all.length} 筆資料？（含待上傳，無法復原）`, [
    { label: '取消' },
    { label: '清除全部', danger: true, onClick: async () => { for (const r of all) { await dbDel(r.code); } seen.clear(); render(); } }
  ]);
}

/* ---------- 底部動作 ---------- */
async function doSave() {
  const all = await dbAll();
  const pend = all.filter(r => r.status === 'pending');
  if (!pend.length) return;
  for (const r of pend) { r.status = 'saved'; await dbPut(r); }
  toast(`已儲存 ${pend.length} 筆，待上傳`);
  render();
}
async function doUpload() {
  const ep = localStorage.getItem(LS_EP) || '';
  const all = await dbAll();
  const saved = all.filter(r => r.status === 'saved');
  if (!saved.length) return;
  if (!navigator.onLine) { dialog('目前離線，請連上網路後再上傳。', [{ label: '知道了' }]); return; }
  if (!ep) { dialog('尚未設定 ERP 上傳網址，請先到右上角 ⚙ 設定。', [{ label: '知道了' }]); return; }
  dialog(`確定上傳 ${saved.length} 筆退貨資料到 ERP？`, [
    { label: '取消' },
    { label: '上傳', onClick: async () => {
      try {
        const payload = saved.map(r => ({ code: r.code, mode: r.mode, scannedAt: r.ts }));
        const resp = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returns: payload }) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        for (const r of saved) { await dbDel(r.code); seen.delete(r.code); }
        toast(`已上傳 ${saved.length} 筆`);
        render();
      } catch (e) {
        dialog('上傳失敗：' + (e && e.message ? e.message : e) + '\n資料仍保留在本機，可稍後重試。', [{ label: '知道了' }]);
      }
    } }
  ]);
}

/* ---------- 小工具：toast / 震動 / 彈窗 / 時間 ---------- */
let toastT = null;
function toast(msg, warn) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('warn', !!warn); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600);
}
function buzz(ok) { try { navigator.vibrate && navigator.vibrate(ok ? 50 : [30, 40, 30]); } catch (e) {} }
function nowStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dialog(text, buttons) {
  const box = $('dialog'); $('dialog-text').textContent = text;
  const foot = $('dialog-foot'); foot.innerHTML = '';
  buttons.forEach(b => {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.danger ? 'up' : b.onClick ? 'save' : 'cancel');
    if (b.danger) el.style.background = 'var(--red)';
    el.textContent = b.label;
    el.onclick = () => { box.hidden = true; if (b.onClick) b.onClick(); };
    foot.appendChild(el);
  });
  box.hidden = false;
}

/* ---------- 設定 ---------- */
function openSettings() {
  $('endpoint').value = localStorage.getItem(LS_EP) || '';
  $('target-count').value = target;
  $('settings').hidden = false;
}
function closeSettings() { $('settings').hidden = true; }
function saveSettings() {
  localStorage.setItem(LS_EP, $('endpoint').value.trim());
  const t = parseInt($('target-count').value, 10);
  if (t > 0) { target = t; localStorage.setItem(LS_TARGET, String(t)); }
  closeSettings(); render(); toast('設定已儲存');
}

/* ---------- 啟動 ---------- */
async function init() {
  db = await openDB();
  (await dbAll()).forEach(r => seen.add(r.code));
  if ('BarcodeDetector' in window) {
    try { bd = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { bd = null; }
  }
  setMode('A');
  await render();

  $('start-cam').onclick = startCamera;
  $('fab').onclick = () => setMode(mode === 'A' ? 'B' : 'A');
  $('save').onclick = doSave;
  $('upload').onclick = doUpload;
  $('clear-all').onclick = clearAll;
  $('export-csv').onclick = exportCSV;
  $('copy-list').onclick = copyList;
  $('settings-btn').onclick = openSettings;
  $('settings-close').onclick = closeSettings;
  $('settings-cancel').onclick = closeSettings;
  $('settings-save').onclick = saveSettings;
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
