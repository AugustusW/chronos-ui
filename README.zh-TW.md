# ChronosUI

> Bring Order to Time —— 一個現代、跨平台的桌面 GUI，用來管理作業系統原生的排程器。

[English](./README.md) | 繁體中文

ChronosUI 直接「就地」管理你已經在用的排程器——**crontab**（macOS/Linux）與 **Windows 工作排程器**——
並補上它們缺的東西：執行歷史、輸出側錄、耗時、隨手手動執行。它是一個「管理＋觀測層」，**不是**另一個排程 daemon。

## 狀態

開發初期。架構與藍圖見設計 spec。

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

需要 Node 20+。

## 運作方式（預覽）

ChronosUI 讀取你的原生排程器、用乾淨的 GUI 呈現。要記錄「排程自動跑」的輸出，它可以「接管」一個 job——
用一個隨附的小程式（`schedmgr`）把指令包起來——完全透明（相同工作目錄、環境變數、exit code），且一鍵可還原。
完整細節與 `crontab` 改寫方式會在發佈前寫清楚。

## 授權

Apache-2.0，見 [LICENSE](./LICENSE) 與 [NOTICE](./NOTICE)。貢獻需 DCO sign-off（`git commit -s`），見 [CONTRIBUTING](./CONTRIBUTING.md)。
