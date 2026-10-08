# 演奏者智能照護系統 v2.0 — 更新說明

依《雙角色系統分析（初稿）》與交接摘要改版（2026-10-07）。

## 檔案（全部放在 GitHub Pages 同一層）

| 檔案 | 說明 | 狀態 |
|---|---|---|
| `login.html` / `login.css` | 登入、註冊（選身分＋兩種表單＋人體圖）、忘記密碼 | 改寫 |
| `index.html` / `styles.css` | 演奏者端 8 頁＋照護端 4 頁，依角色切換 | 改寫 |
| `app.js` | 核心：語言、DataAPI（Firestore 存取集中處）、角色、路由、基本資料、儀表板、歷史紀錄、分析計算 | 改寫 |
| `detection.js` | MediaPipe 偵測、calcCVA／calcShoulderTilt／calcElbowAngle、即時警示（畫面＋震動）、練習時間、單次報告 | 新增（由舊 app.js 拆出） |
| `features.js` | 肩背適能量表、IPAQ-SF、練習時間、就醫用藥、筆記、提醒、衛教、資料授權 | 新增 |
| `provider.js` | 照護端：個案名單、個案儀表板、多次比較、異常統計、照護建議、報告列印與歸檔 | 新增 |
| `bodymap.js` | 人體圖元件（登入頁與主系統共用） | 新增 |
| `i18n.js` | 中英文字典 APP_I18N（從 app.js 移出） | 新增 |
| `firebase-config.js` | Firebase 設定（兩頁共用） | 新增 |
| `firestore.rules` | Firestore 安全規則（需貼到 Firebase Console） | 新增 |

## 上線步驟

1. 把上表所有檔案上傳到 GitHub Pages（覆蓋舊的 index.html、app.js、styles.css、login.html、login.css）。
2. Firebase Console → Firestore Database → **規則** → 貼上 `firestore.rules` 全文 → 發布。**沒有發布規則，照護端讀不到個案資料。**
3. 確認 Firebase Authentication → 設定 → 授權網域已包含 GitHub Pages 網域。
4. 測試：註冊一個照護端帳號、一個演奏者帳號 → 演奏者在「資料授權管理」輸入照護者邀請碼 → 照護者在「個案總覽」接受 → 開啟個案儀表板。

## 依定案完成的修改

- 系統改名：演奏者智能照護系統／Performer Intelligent Care System；「靜態動作評估」→「標準動作辨識」（頁面保留、顯示尚未開放）。
- 用語：個案、建議、衛教與問答。
- 移除所有模擬數據（模擬骨架動畫、載入示範數據、肩對稱度、手腕、脊椎、靜態三項目）；未接偵測的欄位存 `null`。
- CVA 警戒值 52°：以原始 CVA < 52° 觸發警示與淡粉色色帶；Δ 值照樣記錄。
- 即時警示：連續不良姿勢 2 秒 → 畫面警示＋震動（iPhone Safari 不支援震動，只有畫面），兩次警示至少間隔 8 秒。
- 雙角色：`profile.roles` 陣列、註冊選身分、註冊後登出重新登入、角色切換器、可在系統內新增另一身分。
- 授權：`bindings/{演奏者uid}_{照護者uid}`，狀態 pending → active / declined / revoked。
- 配色改為日本傳統色（演奏者端 藍 AI、照護端 瑠璃紺）。

## 需要研究者確認／補資料的地方

| 項目 | 目前做法 | 修改位置 |
|---|---|---|
| 肩背適能量表題目 | 4 題**示意題目**，畫面有標示 | `features.js` → `SHOULDER_BACK_SCALE` |
| IPAQ 版本 | 短版 IPAQ-SF＋MET 計分 | `features.js` → `IPAQ_ITEMS`、`scoreIPAQ` |
| 人體圖 | SVG 示意輪廓，左側＝演奏者右側，僅正面 | `bodymap.js` → `BODY_MAP_IMAGES`（填入圖檔路徑）、`BODY_REGIONS` |
| 健康度評分公式 | 100 −（0.4×CVA 低於警戒比例＋0.3×肩超過比例＋0.3×手肘超過比例） | `detection.js` → `calcHealthScore` |
| 肩傾斜、手肘警戒值 | 肩傾斜 Δ 絕對值 > 3°、手肘 70–160°（沿用現行，待文獻／Delphi） | `detection.js` → `ALERT_THRESHOLDS` |
| 超過警戒值天數 | 當日演奏中超過幀數 ≥ 20% 記為超過；分母＝有錄製的天數；≥ 30% 標「需關注」 | `app.js` → `SYSTEM_RULES` |
| 練習提醒 | 累計 45 分鐘提醒休息；不良姿勢累計 5 分鐘提醒 | `detection.js` → `PRACTICE_RULES` |
| 衛教內容 | 6 則一般性保健文字，標示「待審核」 | `i18n.js` → `edu_*` |
| 智慧問答（LLM） | 只有介面，輸入框停用 | — |

## 與舊資料的相容

- 舊帳號沒有 `roles` 時自動視為演奏者並補上。
- 舊評估紀錄（只有 CVA Δ）仍可在歷史紀錄檢視，標示「舊版紀錄」；舊靜態評估標示為舊資料、不納入分析。
- 新紀錄仍保留 `details.cva.{stage}`、`details.shoulderData`、`details.elbowData` 舊結構，另加 `details.stages`、`details.summary`、`practice`。
