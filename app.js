// 掃碼退貨 PWA — 藍牙掃碼器(HID)收集條碼、去重、本地存檔、退貨上傳
const $ = (id) => document.getElementById(id);
const LS_LIST = 'sr_list', LS_EP = 'sr_endpoint';
const DEF_TIP = '藍牙掃碼器（HID 鍵盤模式）配對後，掃描即自動加入；重複會自動略過。';

let items = [];
try { items = JSON.parse(localStorage.getItem(LS_LIST) || '[]') || []; } catch (e) { items = []; }
let seen = new Set(items.map((x) => x.code));

const scan = $('scan'), listEl = $('list'), countEl = $('count'), tip = $('tip');

const persist = () => { try { localStorage.setItem(LS_LIST, JSON.stringify(items)); } catch (e) {} };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function render() {
  listEl.innerHTML = items.map((it, i) => `<div class="row"><span class="no">${i + 1}</span><span class="code">${esc(it.code)}</span><button class="del" data-i="${i}" aria-label="刪除">✕</button></div>`).join('');
  countEl.textContent = items.length;
}
let tipTimer = null;
function flash(msg, cls) {
  tip.textContent = msg; tip.className = 'tip' + (cls ? ' ' + cls : '');
  clearTimeout(tipTimer); tipTimer = setTimeout(() => { tip.textContent = DEF_TIP; tip.className = 'tip'; }, 2600);
}
function add(raw) {
  const code = String(raw || '').trim(); if (!code) return;
  if (seen.has(code)) { flash('重複條碼，已略過：' + code, 'dup'); return; }   // 防呆：重複不寫入
  seen.add(code); items.push({ code, t: Date.now() }); persist(); render();
  flash('已加入：' + code, 'ok');
  listEl.scrollTop = listEl.scrollHeight;
}

// 掃碼器以鍵盤輸入結尾通常帶 Enter
scan.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(scan.value); scan.value = ''; } });
// 保險：部分掃碼器不送 Enter，停止輸入 120ms 後自動收單
let idle = null;
scan.addEventListener('input', () => { clearTimeout(idle); idle = setTimeout(() => { if (scan.value.trim()) { add(scan.value); scan.value = ''; } }, 120); });

listEl.addEventListener('click', (e) => {
  const b = e.target.closest('.del'); if (!b) return;
  const i = +b.dataset.i, it = items[i]; if (it) seen.delete(it.code);
  items.splice(i, 1); persist(); render(); scan.focus();
});

$('cancel').onclick = () => { if (!items.length || confirm('清空目前掃描的條碼？')) { items = []; seen = new Set(); persist(); render(); scan.focus(); } };
$('save').onclick = () => { persist(); flash('已儲存 ' + items.length + ' 筆到本機。', 'ok'); };

$('return').onclick = async () => {
  if (!items.length) { flash('沒有可退貨的條碼。', 'dup'); return; }
  const ep = (localStorage.getItem(LS_EP) || '').trim();
  if (!ep) { flash('尚未設定上傳網址，請先點右上 ⚙ 設定。', 'dup'); $('settings').hidden = false; return; }
  if (!confirm(`確定要把這 ${items.length} 筆上傳退貨嗎？`)) return;
  const ret = $('return'); ret.disabled = true; flash('上傳中…');
  try {
    const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), count: items.length, items }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    flash('已上傳 ' + items.length + ' 筆退貨 ✓（清單已保留，確認後可按取消清空）', 'ok');
  } catch (err) {
    flash('上傳失敗：' + (err.message || err) + '（清單已保留）', 'dup');
  } finally { ret.disabled = false; }
};

// 設定
$('settings-btn').onclick = () => { $('endpoint').value = localStorage.getItem(LS_EP) || ''; $('settings').hidden = false; };
const closeSettings = () => { $('settings').hidden = true; scan.focus(); };
$('settings-close').onclick = closeSettings;
$('settings-cancel').onclick = closeSettings;
$('settings-save').onclick = () => { localStorage.setItem(LS_EP, $('endpoint').value.trim()); $('settings').hidden = true; flash('已儲存設定。', 'ok'); };
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });

// 讓掃碼器的鍵盤輸入始終進到掃描框（點空白處自動聚焦）
document.addEventListener('click', (e) => { if (!e.target.closest('.modal') && !e.target.closest('button') && !e.target.closest('input')) scan.focus(); });

render();
setTimeout(() => scan.focus(), 100);

// PWA：註冊 service worker（離線可用）
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(() => {}); }
