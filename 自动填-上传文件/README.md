# 账号填充清洗助手

一个本地 Chrome / Edge 扩展（MV3）。核心流程：**粘贴一段卡密 / 账号 / 账单文本 → 自动识别 → 一键填进 Google / GitHub / Kiro / Stripe 的表单**。没有云端、没有账号登录、不上传任何东西。

> ⚠️ **不是密码管理器。** 本项目针对的是"短期批量开号 / 代付测试"场景，不追求 Bitwarden 那样的加密金库。请务必读完底下的"安全边界与威胁模型"一节再决定是否使用。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [识别格式](#识别格式)
- [关于"覆盖已有字段"](#关于覆盖已有字段)
- [关于短信 / OTP 验证码](#关于短信--otp-验证码)
- [关于"深度清理站点"](#关于深度清理站点)
- [保存到本地文件夹（可选）](#保存到本地文件夹可选)
- [安全边界与威胁模型](#安全边界与威胁模型)
- [目标站点](#目标站点)
- [开发](#开发)

---

## 功能

- **粘贴即识别**：Gmail 行 / GitHub 行 / 账单段落（卡号、有效期、CVV、地址、接码 API 等）。
- **TOTP / 2FA**：Base32 密钥本地计算 `otpauth://` 6 位动态码（HMAC-SHA1，RFC 6238）。
- **一键填当前页**：在 Google 登录、GitHub 登录、Kiro / Stripe 结账页按上下文选择填 Gmail / GitHub / 账单。
- **验证码填充**：从接码 API 拉取短信码，复制到剪贴板，并在 12 秒窗口内轮询页面等 3DS iframe 挂上后自动填入。
- **分格 OTP 支持**：6 个 `maxlength=1` 的 input 也能正确拆字 + 触发 keydown/keyup 推进焦点。
- **深度清理当前站点**：清 Cookie / cache / localStorage / IndexedDB / service worker（本地侧；服务器侧的登录态不会被动）。
- **本地导出**：可选择启动一个 `127.0.0.1:37621` 的 Node 小服务，把 vault 写入项目 `data/batches/`。

---

## 安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开**开发者模式**。
3. 点**加载已解压的扩展程序**。
4. 选择本项目的 `自动填-上传文件/` 目录。

---

## 使用

弹窗从上到下：

1. **粘贴卡密 / 账号 / 账单文本** 文本框 — 粘进去 **自动识别**，或点"读剪贴板并识别"。
2. **识别结果卡片** — 默认折叠，只显示概要（如 `账单 · •••• 4242`、`Gmail · xxx@gmail.com`）。点标题展开看字段 chips，chip 就是"点一下复制"。
   - 每张卡片右上角的下拉用来在多条同类记录之间切换（只有超过 1 条才显示）。
   - `✕` 按钮删掉当前记录。
3. **一键填当前页**（主按钮，超大号）— 根据当前 URL 自动选 Gmail / GitHub / 账单。
4. **填账单** / **取并填验证码** — 专项触发。
5. **更多工具**（默认折叠）— 识别当前页、打开 Kiro、保存到文件夹、导出密码 CSV、**深度清理当前站点**（红色警告按钮）。
6. **两个开关**：
   - 右侧悬浮 Fill 按钮（页内 dock）。
   - **覆盖已有字段**（默认关）。见下节。

页面内的 **dock** 只剩三颗：`⋮⋮`（拖动）`Fill`（填当前页）`⋯`（展开：Gmail / GitHub / 账单 / Copy 2FA / 取短信码 / 深清）。

---

## 识别格式

**Gmail：**

```text
email@gmail.com|password|recovery@example.com|BASE32TOTPSECRET|2023|Country
```

分隔符用 `|`。字段顺序不严格，解析器按语义猜（带 `@` 的当邮箱 / 恢复邮箱，全大写 Base32 当密钥，4 位数字当年份）。

**GitHub：**

```text
username----password----BASE32TOTPSECRET
```

或 `|` 分隔也可，或写成 `GitHub账号: xxx\nGitHub密码: xxx\nGitHub 2FA: xxx` 多行。

**账单文本**（直接整段粘贴）：

```text
卡号 CARD NUMBER
4111 1111 1111 1111 点击复制
有效期 EXPIRY
2030/3 点击复制
CVV
123 点击复制
姓名 NAME
TEST USER
地址 ADDRESS
123 TEST ST, NEW YORK 10001, US
接码 API
https://...
```

识别后的 chips：`卡号 / 有效期 / 月 / 年 / CVV / 电话 / 姓名 / 地址 1 / 地址 2 / 接码 API / 取短信码`。

---

## 关于"覆盖已有字段"

默认**关闭**。行为：

- **空**或**看起来是掩码**（`••••`, `****`, `XXXX`, 空格 / 短横 / `·` 组合）的字段 → 总是填。
- 已填的字段 → 仅当新值比现有的**更完整**时覆盖（比如新卡号有 16 位、当前只有 4 位数字残留）。
- 两个值**完全相同** → 不写，但也不提醒。

**勾上之后**：无条件覆盖所有可写字段。适合 Stripe 把一半卡号残留在页面上导致新卡填不进去的场景。

---

## 关于短信 / OTP 验证码

- 点 **取并填验证码** 后做两件事：
  1. 调 `billing.smsApi` 获取短信码（后台 10 秒超时）。
  2. 拿到码后**复制到剪贴板**，然后在 12 秒窗口内反复向所有 frame 广播一次"填 OTP"——这是为了处理 Stripe 3DS challenge iframe 要等用户点 Pay 才挂载的时序。
- **分格输入**（Google 恢复码、部分银行 3DS 6 个单字符框）：识别连续的 `maxlength=1` 输入组，逐位填入 + 派发 `keydown` / `keyup` 让聚焦跟着走。
- **识别宽度**：除了 `autocomplete="one-time-code"` / `otp` / `totp` / `验证码` 等常规命中，还加了：
  - 独立 `code` 标签，但会**排除** `zip / postal / promo / coupon / country / area / reference / invite` 等同样带 code 的字段，避免误填。
  - `inputmode="numeric" | "decimal"` 且 `maxlength` 在 6–8 之间（绕开 CVV 的 3–4）。
- **为什么有时候还是填不上**：
  - 页面上的输入框是 React 受控 input 但对 `input` / `beforeinput` / `change` 都不响应——这是个别第三方 SDK 的锅，目前我们能做的已经做了（同时派发 beforeinput + input + change + 对分格派发 keydown/keyup）。
  - 12 秒内 3DS iframe 仍未挂载——剪贴板里已有码，手动粘贴。

---

## 关于"深度清理站点"

**这是本地清理，不是服务器登出。**

点击后会：

1. 在**当前 frame** 清 `localStorage` / `sessionStorage` / Cache Storage / IndexedDB / Service Workers。
2. 调 `chrome.browsingData.remove()` 清对应 origin 的 Cookies / 缓存 / cacheStorage / fileSystems / indexedDB / localStorage / serviceWorkers / webSQL。
3. 刷新当前标签页。

但：

- 如果你在 `app.kiro.dev` 用 Google 登录，清掉 `accounts.google.com` 的 cookie 不会让 Google 服务器端登出。
- 下次打开页面，浏览器和 Google 的 SSO 仍然可能自动把你登回去。

真要"退出所有会话"，去 [Google 账户 → 您的设备](https://myaccount.google.com/device-activity) 手动登出。

---

## 保存到本地文件夹（可选）

默认数据只在 `chrome.storage.local`，就是浏览器自己的存储。如果想备份成人类可读的 JSON：

```bat
cd D:\杂\gmail-2fa-api\自动填-上传文件
node local-save-server.js
```

或者双击 `start-local-save.bat`。然后点弹窗里的 **保存到文件夹**，数据写到：

```text
自动填-上传文件/data/batches/<批次名_短id>/
├── batch.json
├── gmail-accounts.json
├── github-accounts.json
├── billing-cards.json
└── combined.json
```

`data/` 已在 `.gitignore` 里，卡号 / 密码是**明文 JSON**。

---

## 安全边界与威胁模型

**不适用于**：

- 共享电脑 / 多人账号的 Windows。
- 把扩展推到 Chrome Web Store 或安装给别人用。
- 存放真实长期账户 / 信用卡。

**我们怎么存的**：

- `chrome.storage.local` 中的 `gba_plain_vault` 键，**明文 JSON**。
  Chrome 的 storage 在磁盘上有一点混淆但不是加密，任何本机其他软件可读。
- 没有主密码，没有锁定机制，没有云同步。
- 代码里曾有一套 PBKDF2-SHA-256 + AES-GCM 的加密 vault 路径，但从未接入 UI，**已删除**（见 shared.js 的注释）。重新实现的话需要同时加：启动时解锁密码、session 期间内存缓存、设定自动锁定时间。

**我们怎么做最小权限**：

- `host_permissions` 只声明 Google / GitHub / Kiro / Stripe 域 + 本机 `127.0.0.1:37621`，不用 `<all_urls>`。
- `content_scripts` 只挂上述站点。
- 没申请 `scripting` / `cookies` / `webRequest` 等高风险权限。
- 网络请求仅两处：接码 API（你自己填的 URL）和本机 `local-save-server.js`。

**你的责任**：

- 用完记得在弹窗里**删记录**或清空 `chrome.storage.local`（`chrome://extensions` → 详情 → "检查视图" → Console → `chrome.storage.local.clear()`）。
- 不要把 `data/batches/` 纳入 Git。

---

## 目标站点

内容脚本 `content_scripts.matches`：

- `https://accounts.google.com/*`
- `https://github.com/*`
- `https://kiro.dev/*`, `https://*.kiro.dev/*`
- `https://*.stripe.com/*`, `https://*.stripe.network/*`

Host permissions 另外允许：

- `https://*.google.com/*` / `https://*.github.com/*`（跳转 SSO 子域时清理用）
- `http://127.0.0.1:37621/*` / `http://localhost:37621/*`（本机保存服务）

---

## 开发

文件布局：

```text
自动填-上传文件/
├── manifest.json
├── background.js         ← service worker：vault 快照、接码、browsingData、跨 frame 广播
├── content.js            ← 注入到各站点：dock / 字段识别 / 真正写入 input
├── content.css
├── popup.html / popup.js / popup.css
├── shared.js             ← 解析器 + 字段类型推断 + TOTP + vault 规范化
├── local-save-server.js  ← 可选的本机 HTTP 落盘服务
├── start-local-save.bat
└── tools/
    └── audit-extension.mjs  ← 冒烟测试（manifest / 解析器 / 字段推断 / content 消息协议 / background vault 优先级）
```

**自测**：

```bash
node tools/audit-extension.mjs
# AUDIT PASS
```

测试用 Node `vm` + `webcrypto` 建一个最小 DOM/Chrome 沙箱，跑 `shared.js` / `content.js` / `background.js` 的核心分支，不需要真浏览器。

---

## License

MIT；仅供自用 / 学习交流。别把它用于规避第三方服务 ToS 或批量注册伤害他人。
