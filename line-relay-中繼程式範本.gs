/* ============================================================
   LINE 回報中繼 + 群組 groupId 抓取（Google Apps Script Web App）
   一支程式同時做兩件事：
   (1) PWA 把報表丟來 → 用機器人推到 LINE（群組/廣播）
   (2) 當作機器人的 Webhook：機器人進群或群裡有訊息時，
       自動把該群的 groupId 回覆到群裡，並記起來。
   ------------------------------------------------------------
   部署：script.google.com → 貼上 → 填下面的值 →
   部署→新增部署作業→網頁應用程式（執行身分:我、存取:所有人）→ 取得 /exec 網址
   ※ 改完程式要「部署→管理部署作業→編輯(鉛筆)→版本選『新版本』→部署」才生效
   ============================================================ */

// 【必填】LINE Developers → Messaging API → Channel access token (long-lived)
const LINE_TOKEN = '貼上你的 Channel access token';

// 【群組推送】先留空 → 照下方步驟抓到 groupId 後，貼進這裡（例如 'Cxxxxxxxx...'）
//             留空時 = 廣播給所有加好友的人
const TARGET_ID = '';

// 【自訂】通關碼：要和 PWA ⚙ 設定的「通關碼」一致
const KEY = '改成你自訂的通關碼';

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var body = JSON.parse(raw);

    // (1) 這是 LINE 的 webhook 事件 → 抓 groupId
    if (body.events) {
      body.events.forEach(function (ev) {
        var src = (ev && ev.source) || {};
        if (src.groupId) {
          PropertiesService.getScriptProperties().setProperty('LAST_GROUP_ID', src.groupId);
          if (ev.replyToken) {
            UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'post', contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + LINE_TOKEN },
              payload: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: '✅ 這個群組的 groupId：\n' + src.groupId + '\n\n請複製貼到中繼程式的 TARGET_ID。' }] }),
              muteHttpExceptions: true
            });
          }
        } else if (src.userId) {
          PropertiesService.getScriptProperties().setProperty('LAST_USER_ID', src.userId);
        }
      });
      return out('webhook ok');
    }

    // (2) PWA 來的推送請求
    if (body.key !== KEY) return out('bad key');
    var text = String(body.text || '').slice(0, 4900);
    if (!text) return out('empty');

    var url, payload;
    if (TARGET_ID) {
      url = 'https://api.line.me/v2/bot/message/push';
      payload = { to: TARGET_ID, messages: [{ type: 'text', text: text }] };
    } else {
      url = 'https://api.line.me/v2/bot/message/broadcast';
      payload = { messages: [{ type: 'text', text: text }] };
    }
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_TOKEN },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    return out('line ' + resp.getResponseCode());
  } catch (err) {
    return out('err: ' + err);
  }
}

// 用瀏覽器開 /exec 可看到目前抓到的 groupId / userId
function doGet() {
  var p = PropertiesService.getScriptProperties();
  return out('relay alive\nlastGroupId=' + (p.getProperty('LAST_GROUP_ID') || '(尚未抓到)') + '\nlastUserId=' + (p.getProperty('LAST_USER_ID') || '(尚未抓到)'));
}
function out(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
