# ChronosUI — Icon Pack

兩個方向的應用程式圖示，含 SVG 母檔、PNG 尺寸組與單色 template 版。
標誌主題：Chronos（希臘時間之神）× 排程器 × *Bring Order to Time* — 以「均分的刻度／節拍」把「時間被切成精確區間」這件事視覺化。

品牌色沿用 spec accent `#4f7fc1`，底磚為 graphite，呼應 app 的 always-dark nav（design spec §9.3）。

---

## 內容

```
chronos-icon-pack/
├─ ordered-dial/                推薦主標誌：刻度錶盤
│  ├─ ordered-dial.svg          1024 母檔（graphite 底磚）
│  ├─ ordered-dial-mono.svg     單色字符（透明底，menu-bar / tray template）
│  └─ png/                      16 / 32 / 48 / 64 / 128 / 256 / 512 / 1024
├─ cron-beats/                  備選：cron 節拍環
│  ├─ cron-beats.svg
│  ├─ cron-beats-mono.svg
│  └─ png/                      同上尺寸
└─ README.md
```

| 圖示 | 概念 | 用途建議 |
|---|---|---|
| **Ordered Dial** | 時鐘 + 精確刻度環。最直覺、縮到 16px 仍清晰。 | 主應用程式圖示 / dock / favicon |
| **Cron Beats** | 節拍環，亮起的是 active beat。更抽象、更「排程器」。 | 次要標記、loading 動畫起點、社群頭像 |

---

## 用法

**Electron（electron-builder）** — 給 1024 PNG 即可自動產生各平台格式：

```jsonc
// electron-builder 設定
"mac":   { "icon": "build/ordered-dial-1024.png" },   // 產出 .icns
"win":   { "icon": "build/ordered-dial-256.png" },    // 產出 .ico
"linux": { "icon": "build/ordered-dial-512.png" }
```

**menu-bar / tray（macOS template image）** — 用 `*-mono.svg`（或由它輸出 `Template.png` / `Template@2x.png`，黑色 + 透明底，系統會自動反色）。

**favicon / 文件** — 直接用 `png/*-32.png` 或 SVG。

> 需要直接打包好的 `.icns` / `.ico`，或要把目前的圖示改色（accent）/ 改細節密度，跟我說一聲，我可以再輸出一份。

---

## 設計建議（spec / design system 調整）

1. **補上 tray / template icon 規範。** §10 packaging 目前沒涵蓋 macOS menu-bar / Windows 系統匣圖示——對「GUI 關閉時 schedmgr 在背景執行」的產品其實重要。本包已附單色 template 版，建議在 spec 補一小節。

2. **刻度／節拍 motif 可延伸成品牌語彙。** Accent `#4f7fc1` 偏安全的企業藍；與其只靠顏色，不如把標誌的「刻度環 / 節拍」沿用到 loading skeleton、running 轉圈、空狀態插圖，讓識別更一致。或加一個古銅色 `--color-accent-2` 做古典點綴（記得過 WCAG AA）。

3. **Nav 純黑 `#0a0a0a`（grey-1000）→ 退一階到 `grey-900 #1a1a1f`。** 與白色內容反差較柔和、less「黑洞」。純微調。

4. **狀態色 warn/timeout `#c9962e` 與 danger `#c0493f`** 在小圓點時對色盲者偏近——你已用 icon＋形狀輔助，維持即可。

5. **首次空狀態（§9.5）放大 icon＋tagline。** 它是新使用者第一個畫面，順勢介紹「讀取原生排程器」模型；刻度環剛好呼應 *order to time*。

---

授權：圖示隨 ChronosUI 採 Apache-2.0。
