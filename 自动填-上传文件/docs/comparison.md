# 对比主流密码管理器 / 自动填项目

> 目的：把"账号填充清洗助手"放在成熟项目旁边比一比，挑出**真值得借鉴**的工程做法，并说明哪些**故意不抄**——因为它们是为另一种使用场景服务的。

对比对象：

- **Bitwarden**（[bitwarden/clients](https://github.com/bitwarden/clients) · MPL-2.0 · TypeScript / Angular / MV3 for the web extension）
- **1Password X / 1Password 8**（闭源扩展 + 官方开发者文档：[Design your website to work best with 1Password](https://developer.1password.com/docs/web/compatible-website-design/)、[About the security of 1Password Autofill in your browser](https://support.1password.com/browser-autofill-security/)）
- **Proton Pass**（[protonpass/proton-pass-common](https://github.com/protonpass/proton-pass-common) · Rust core + TS 扩展 · GPL-3.0）
- **KeePassXC-Browser**（[keepassxreboot/keepassxc-browser](https://github.com/keepassxreboot/keepassxc-browser) · GPL-3.0 · 原生消息协议 + 浏览器扩展）

以下所有第三方信息都来自公开文档 / 仓库 / 已披露的 CVE，措辞经过归纳复述。

---

## 1. 架构总览

| 维度 | Bitwarden 扩展 | 1Password X | Proton Pass | KeePassXC-Browser | **本项目** |
|---|---|---|---|---|---|
| 代码分层 | `autofill-init` → `CollectAutofillContentService` → `InsertAutofillContentService`，把 `collectPageDetails` 与 `fillScript` 解耦；参见 [Bitwarden contributing docs – Autofill](https://contributing.bitwarden.com/architecture/deep-dives/autofill/) | 通过页面 DOM + 启发式，并给网站提供 [合作指南](https://developer.1password.com/docs/web/compatible-website-design/) | Rust 核心发出 "fill plan"，JS 层只执行 | native-messaging 协议 + JSON-RPC | `content.js` 一个文件里混合了识别 / 写入 / dock UI / SPA 钩子 |
| 并发 frame | 全 frame 注入后统一收集 | 全 frame | 全 frame | 全 frame（仅主线文档和登录流） | `background.fillAllFrames` 通过 `chrome.webNavigation.getAllFrames` 广播到每个 frame |
| 数据模型 | `FieldView`（有分值、可信度、submit 方式） | 未披露，但文档里把 fields 归到 form `<form>` | 类似 Bitwarden | 由 KeePassXC 桌面端认可 | 只有 `{accounts, githubs, billings, settings}`，没有表单模型也没有 "trust score" |

**观察**：成熟项目都在"收集"与"填充"之间保留一个可序列化的中间层（Bitwarden 叫 `pageDetails`），利于：背景页做决策（根据 URL / 用户选的 item）、在 popup 里预览会改哪些 field。我的项目现在是"看到就填"，没有中间层，所以也就没"为什么这个字段被跳过"的解释能力。

**值得借鉴 →** 提出一个 `FieldPlan[]`：`{frameId, elementHint, kind, expectedFromVault, willWrite, reason}`。写入前 popup 能展示它。

---

## 2. 字段识别（field inference）

| 维度 | Bitwarden | 1Password | Proton Pass | 本项目 |
|---|---|---|---|---|
| 优先级 | `autocomplete` > `type` > `name/id` 正则 > 周围文案 > label `for=` | 同上；文档建议开发者写 `autocomplete` 和独立 `<form>` | 类似 Bitwarden，但把"卡号 / CVV / 到期"做成 Rust 端的强表 | `exactAutocomplete` > type > 正则 on name/id/placeholder/aria + label + closest `[class]` 的 innerText |
| 负面列表 | 有；会过滤 "search"、"quantity"、"phone_code"、"otp"-but-postal 等 | 未披露具体名单 | 有（开源） | **新增**：`code` 时排除 `zip / postal / promo / coupon / country / area / dial / product / voucher / gift / store / tracking / reference / invite` |
| OTP 识别 | `one-time-code` / `otp` / `totp` / `mfa` / `2fa` / `sms`；结合 `maxlength` | `autocomplete="one-time-code"` 优先；SMS OTP iOS 交给系统；参见 [WICG/sms-one-time-codes](https://github.com/WICG/sms-one-time-codes) | 同 Bitwarden | 上述 + `inputmode=numeric/decimal` 且 `maxlength ∈ [6,8]` 作为 fallback |
| 分格 OTP | 单独识别为 group，按字符逐位填（见 bitwarden issue 历史） | 同上 | 同上 | 本项目已支持：连续 `maxlength=1` 的 input 组 |

**观察**：我的负面列表 + inputmode fallback 已与 Bitwarden 大致对齐，对 3DS "code" 这种弱标签的页面反而比 Bitwarden 早几步放宽。但我缺 1Password 文档里强调的：
- **尊重显式 `autocomplete="off"`**（有些银行禁用浏览器自动填）——我现在不看这个属性。
- **识别 `<form>` 边界**：我用 `closest('form')` 兜底，但没像 Bitwarden 那样记录 "同一 form 内的关联字段"，这会导致同页多个登录块（比如一个改密码 + 一个创建新账号）被混填。

**值得借鉴 →**
1. 加一条规则：若 `autocomplete="off"` 且 `overwriteExisting !== true`，跳过。
2. 把同 form 内的 username / password 视为一组，避免跨 form 污染。

---

## 3. 已有值 / 覆盖策略

| 维度 | Bitwarden | 1Password | 本项目 |
|---|---|---|---|
| 默认策略 | **不覆盖**已有值；用户点 "自动填充" 会覆盖，但主动输入类只在字段空时触发 | 默认只填空字段；credit card 允许"强制更新" | Bug A 修复前：一旦非空就放弃 → 填不进去<br>Bug A 修复后：**空 OR 掩码** 视为空；新值比现值"更完整"（digit 数更多）允许覆盖；相同值不写；全覆盖需勾开关 |
| 掩码识别 | 未见明示 | 未见明示 | 有专门 `MASK_STRIP`：`• · ● ○ ◦ * x X _ - — –` 加空白 |
| "相同值不写" | 有 | 有 | 有 |

**观察**：在 Stripe Elements 那种 "•••• 4242" 残留阻塞的场景，我的实现比 Bitwarden 默认更宽容——这是针对"代付测试 / 批量改卡"的实际痛点做的决策，留着。

---

## 4. 写入字段（value setter）

| 维度 | Bitwarden / 成熟实践 | 本项目 |
|---|---|---|
| 设置值 | 走原生 `descriptor.set.call(el, val)`，绕过 React 控制 | 相同 |
| 派发事件 | `keydown`, `keypress`, `input`, `change`, `keyup`，有时配合 `focus/blur` | 新增：`beforeinput` + `input` + `change`；分格 OTP 加 `keydown` + `keyup` + focus/blur |
| `contenteditable` | 识别并特殊处理 | 相同 |
| `<select>` | 按 value / textContent / 含义匹配 | 相同（按 value/text/includes） |
| CSP / sandbox iframe | 踩过坑（[CVE-2025-65203](https://www.sentinelone.com/vulnerability-database/cve-2025-65203/) 就是 KeePassXC 在 sandbox iframe 里不该填却填了） | 目前没有检测 `iframe[sandbox]`，我们自己注入在 `all_frames=true` 下所有允许的 host，但**没有**显式跳过 CSP 限制的 frame |

**值得借鉴 →** 在 `fillOtpCode` / `fillAccount` / `fillBilling` 前加一条：
```js
if (window.self !== window.top && (document.defaultView?.frameElement?.sandbox?.length ?? 0) > 0) return 0;
```
即"若当前 frame 带 `sandbox=""` 又没给 `allow-same-origin`，不要动"。这是去年 KeePassXC 被扩展商店短暂下架的直接原因。

---

## 5. 数据存储与加密

| 维度 | Bitwarden | 1Password | Proton Pass | KeePassXC | **本项目** |
|---|---|---|---|---|---|
| 本地落盘形态 | **加密**：主密码 → PBKDF2-SHA-256（默认 600k 轮 ≥ 2023.x）→ 对称密钥 → 加密 vault blob | 加密：secret key + 主密码双因子 | 加密：PGP / OpenPGP.js + account key | 加密（KeePass .kdbx 文件） | **明文 JSON**（`chrome.storage.local.gba_plain_vault`） |
| 自动锁定 | `Vault timeout` 可配置；动作 `Lock` / `Log out`；参见 [App settings](https://bitwarden.com/help/app-settings/) | 10 分钟默认，可调 | 可调 | KeePassXC 桌面端控制 | 无 |
| 解锁 UX | 主密码输入 → 派生密钥 → 解密 → 内存持有 | 同上 | 同上 | native-messaging 让桌面端弹解锁 | 无 |
| 云同步 | 有 | 有 | 有 | 第三方（kdbx 文件自行同步） | 无 |
| 主密码本身存哪 | 不存，只存 argon2/pbkdf2 派生 | 不存 | 不存 | 不存 | — |

**现状**：我们在 README 里已经把这一点写得很清楚（"不是密码管理器，仅代付 / 开号场景"）。代码里曾经写过一套 PBKDF2 + AES-GCM，但从未接入 UI，已在本次清理中删除。

**如果要补**（未定排期）：
1. popup 启动要解锁密码；派生 AES-GCM key 存 `chrome.storage.session`。
2. `chrome.storage.local` 只放 ciphertext。
3. 加 "auto-lock after N minutes"（`chrome.alarms`）。
4. 明文 vault 导出按钮前加 reauth。
5. 参考 Bitwarden 的 "Master Password Re-Prompt"：即便 unlocked，查看特定高敏感项前再次输入。

---

## 6. 权限与攻击面

| 维度 | Bitwarden / 1Password / Proton / KeePassXC | 本项目 |
|---|---|---|
| `host_permissions` | `<all_urls>`——因为要自动填所有网站 | **枚举**：Google / GitHub / Kiro / Stripe / loopback（37621）|
| 内容脚本 | 所有 frame / 所有 URL | 只上述 4 个域 |
| `scripting` / `webRequest` / `cookies` | Bitwarden 申请 `tabs` / `clipboardWrite` / `nativeMessaging`；不申 `webRequest` | 只 `activeTab` / `browsingData` / `clipboardRead` / `clipboardWrite` / `storage` / `webNavigation` |
| 本次清理 | — | 去掉 `<all_urls>` 和未用的 `scripting` |

**胜出点**：我的攻击面比 Bitwarden 小得多——因为我不是通用密码管理器。

**留意点**：`browsingData` 是个强权限。README 已写"深清只能本地、不让 Google 服务器登出"；是否还要加一条 "调用前展示将被清理的 origin 列表并要求二次确认"—**已有**（`confirm()` 对话框列出完整 origins）。

---

## 7. 3DS / Stripe 体验

| 维度 | Bitwarden / 1Password | 本项目 |
|---|---|---|
| 是否填 3DS challenge 的 OTP 输入 | 通常不填（3DS iframe 在 `hooks.stripe.com` 或银行域，密码管理器用户也记不住一次性码） | 填：拉 `smsApi` → 12s 轮询 |
| SMS 拉取 | 手机操作系统的原生 `autocomplete="one-time-code"` + WebOTP API | 自己的 `fetchSmsCode` → 解析 JSON/文本中的 4–8 位数字码（正 / 反向关键字过滤） |
| 超时 | — | `AbortController` 10s + 上层 6 次每 2.5s 轮询 |

**观察**：这块是我的差异化，不存在"向成熟项目看齐"的目标。唯一可借鉴的是：

**值得借鉴 →** 关于 [WICG/sms-one-time-codes](https://github.com/WICG/sms-one-time-codes) 的格式——如果日后你的接码 API 返回的是原始短信全文（不是 JSON），按这个 WICG 的格式 `@host.example #123456` 可以让解析更可靠。我的 `parseSmsCode` 已经有上下文正则，但没有"该格式"的强识别，加上去一行即可。

---

## 8. SPA 导航检测

| 维度 | Bitwarden | 本项目 |
|---|---|---|
| 触发 | `webNavigation.onHistoryStateUpdated` + `onDOMContentLoaded` + 主动 `pageDetails` 轮询 | 本次重写：patch `history.pushState/replaceState` + `popstate` / `hashchange` / `pageshow` / `visibilitychange` + 单个 debounced `MutationObserver`（250 ms） |
| 旧做法 | — | 每秒 `setInterval(syncDock, 1000)`（已删） |

事件组合+ MutationObserver 的方式和 Bitwarden `webNavigation.onHistoryStateUpdated` 基本等效；他们能用 `webNavigation` 是因为 service worker 里有 `webNavigation` 权限，我们也已经声明了，但实际触发 dock 重绘仍放在内容脚本 — 在页面内 patch history 省一次跨上下文消息往返。**这块已到位，不用再改。**

---

## 9. 可测试性

| 维度 | Bitwarden | 本项目 |
|---|---|---|
| 单元测试 | Jest，跑 `autofill-init.spec.ts`、`collect-autofill-content.service.spec.ts` 等 | 本次之前只有一份冒烟 `audit-extension.mjs`（node `vm` + webcrypto 沙箱，模拟 chrome.* / document / crypto） |
| E2E | Playwright | 无 |
| 覆盖率追踪 | 有 | 无 |

**本次改进**：audit 扩容为 7 个 subcase：`runManifestAudit`, `runParsingAudit`, `runFieldInferenceAudit`（12 个 case，含 4 个负向）、`runContentAudit`、`runOverwritePolicyAudit`（3 个）、`runOtpFillAudit`（单框 / 分格 / 混合）、`runBackgroundVaultPrecedenceAudit`。

**值得借鉴 →** 后续可以加 Playwright + Bitwarden 式"用真实 Stripe test page（例如 `stripe.com/docs/testing#use-test-cards`）跑一次 fillBilling"。这一步涉及网络和 CI，暂不列入。

---

## 10. 总结：这轮能再改的 Top 5

按"投入产出"排，都是**从成熟项目里学到、但我们目前没有**的点：

1. **跳过 `iframe[sandbox]` 且无 `allow-same-origin` 的 frame**（防 CSP 绕过，~10 行）。
2. **识别并尊重 `autocomplete="off"`**（除非用户勾了 overwrite）。
3. **加 "FieldPlan preview"：** popup 在"一键填当前页"之前给 `dry-run` 预览，用户点确认再写入（约 80 行，UI+消息协议）。
4. **同 form 内字段关联：** 把 username / password 视作 pair 匹配，避免同页两个表单互串（Bitwarden 即使不指望我们做通用，但对 Google 登录第一步 email → 第二步 password 这种分段式页面就已经受益）。
5. **（可选的大件）加 vault 加密 + 主密码** — 见 §5 列的 5 步。属于"方向性决定"，想做就做，但做了就要接住 "忘记密码不可恢复" 这套用户教育。

---

## 免责 / 鸣谢

本文信息来自以下公开源，引用已在相应段落插入：

- Bitwarden contributing docs — Autofill deep-dive（`contributing.bitwarden.com/architecture/deep-dives/autofill/...`）
- Bitwarden Help — App settings / Master Password / URI match
- 1Password Developer — [Design your website](https://developer.1password.com/docs/web/compatible-website-design/)、[Browser autofill security](https://support.1password.com/browser-autofill-security/)
- Proton — [Open source audit blog](https://www.proton.me/blog/pass-open-source-security-audit)
- KeePassXC — [CVE-2025-65203 披露](https://www.sentinelone.com/vulnerability-database/cve-2025-65203/)
- W3C / WICG — [sms-one-time-codes](https://github.com/WICG/sms-one-time-codes)

上述段落为原作者观点的摘要与对比，非原文引用；为符合许可要求已重新表述。
