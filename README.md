# 退貨系統（iPhone PWA 網頁 App）

鏡頭掃描物流編號（TW＋13 碼）→ **對照預期清單即時防呆比對** → 本地存檔（IndexedDB）。
iPhone 用 Safari 開網址後「**加入主畫面**」，就變成一個 icon、點下去全螢幕像 App。

## 功能
- **雙模式掃描**：模式 A 二維碼（BarcodeDetector，iOS 自動後備 jsQR）／模式 B 物流編號 OCR（Tesseract.js）。右下 FAB 切換。
- **防呆比對**：先「匯入清單」載入預期編號（CSV／Excel／貼上）。掃到時：
  - 在清單且未掃 → 框線轉**綠**＋成功音（標記已完成）。
  - 不在清單／重複 → 框線轉**紅**＋錯誤音（列入異常或提示已掃描）。
- **清單對照表**：異常 → 已完成 → 等待，狀態一眼看完；計數器顯示「已完成 X / 總數」。
- **匯出異常**：把「掃到但不在清單」的編號匯成 CSV 供稽核。
- **複製已完成**：複製已核對成功的編號，貼到電腦端工具帶進 ERP。

## 部署（GitHub Pages）
把本資料夾**所有檔案**上傳到 repo（`index.html / app.js / style.css / sw.js / manifest.webmanifest / icon-192.png / icon-512.png`）→ Settings → Pages → `main` `/(root)` → Save。
> 整個資料夾都可以直接上傳；`icons/` 子資料夾為舊版重複檔，不影響運作（可留可刪）。

## iPhone 安裝
Safari 開 `https://你的帳號.github.io/scan-return/` → 分享 → **加入主畫面** → 從桌面 icon 開啟 → 點「開啟鏡頭」允許相機。
> OCR／條碼後備函式庫從 CDN 載入，第一次需有網路；之後黃框條碼可離線。

## 與公司 ERP（USale）的銜接
本 PWA 不直接連 ERP（跨網域＋登入限制）。流程是：手機掃描收集 → 「複製已完成／匯出」帶到電腦 → 電腦上用 **Tampermonkey 腳本**（`usale-return-helper.user.js`，放在上層 ClaudeCode\ 資料夾）填入 USale 搜尋框查詢，退貨人工確認。
