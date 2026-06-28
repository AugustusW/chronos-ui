# ChronosUI

> **Bring observability to native schedulers.**

[English](./README.md) | 繁體中文

[![CI](https://github.com/AugustusW/chronos-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/AugustusW/chronos-ui/actions/workflows/ci.yml)

一個給你「已經在用」的排程器用的桌面控制中心——**crontab**（macOS/Linux）與 **Windows 工作排程器**。
不裝 daemon、不綁定、不用搬家。ChronosUI 不取代 cron / launchd / 工作排程器，而是讓它們**看得見**：
執行歷史、輸出側錄、耗時、隨手手動執行。

> 你已經有排程器了，缺的只是「看得見」。

<!-- TODO: hero GIF — 打開 → 接管 → 執行 → 歷史 → 完成（約 15 秒）。錄製為後續工作。 -->

## 下載

到 [**Releases**](https://github.com/AugustusW/chronos-ui/releases/latest) 頁抓最新安裝檔：

- **macOS** — `.dmg`（已簽章 + 公證；Apple Silicon）
- **Windows** — `.exe` 安裝檔（NSIS）。目前未簽章，首次開啟請點 *More info → Run anyway* 略過 SmartScreen。

或[從原始碼建置](#開發)。

## 為什麼？

每個開發者最後都會累積一堆自動化：每日備份、AI agent、爬蟲、裝置同步、資料收集、清 log。
全部塞進 cron。幾個月後你 ssh 進機器、打開 `crontab -e`，然後愣住：*「這是哪個 job？還活著嗎？」*

ChronosUI 的存在，是因為「透過 ssh、log、`crontab` 管自動化」這個流程很糟——不是因為排程器不好。
它們其實很好，只是沒有 UI。

```text
沒有 ChronosUI                     有 ChronosUI
─────────────                     ───────────
ssh 進機器                         打開 app
crontab -e                        看到每個 job、上次執行 + 輸出
grep、tail -f、用猜的             隨手手動跑任何 job
vim、重來一遍                     翻執行歷史
「…這到底是哪個 job？」           完成
```

## 功能

- ✓ 探索你已經有的 cron / 工作排程器 job
- ✓ 無痛接管（不裝新 daemon，完全可還原）
- ✓ 隨手手動執行任何 job
- ✓ 執行歷史：側錄 stdout/stderr + 耗時
- ✓ 預設 SQLite，可選 PostgreSQL
- ✓ 跨平台（macOS、Windows；Linux 走 cron）

## 運作方式

ChronosUI 讀取你的原生排程器、用乾淨的 GUI 呈現。要記錄「排程自動跑」的輸出，它可以「接管」一個 job——
用一個隨附的小程式（`schedmgr`）把指令包起來——完全透明（相同工作目錄、環境變數、exit code），且一鍵可還原。
完整細節與 `crontab` 改寫方式會在發佈前寫清楚。

## 開發

```bash
git clone https://github.com/AugustusW/chronos-ui.git
cd chronos-ui
npm install
npm run dev      # 啟動 app
npm test         # 單元測試
npm run lint     # lint
npm run build    # 生產建置
```

需要 Node 20+。發佈流程見 [RELEASING.md](./RELEASING.md)。

## 狀態

開發初期——資料層、排程器 adapter、執行歷史已就位；UI 與打包仍在收斂。歡迎 issue 與 PR。

## 授權

Apache-2.0，見 [LICENSE](./LICENSE) 與 [NOTICE](./NOTICE)。貢獻需 DCO sign-off（`git commit -s`），見 [CONTRIBUTING](./CONTRIBUTING.md)。

---

> 你不需要再多一個排程器。你需要的是看懂你已經有的那一個。
