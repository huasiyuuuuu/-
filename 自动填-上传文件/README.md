# 账号填充清洗助手

本地 Chrome/Edge 扩展。核心流程是：粘贴卡密或账单文本，自动识别字段，生成可点击复制的小标签，并在网页输入框旁提供填充按钮。

## 安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开“开发者模式”。
3. 点“加载已解压的扩展程序”。
4. 选择目录：`D:\杂\gmail-2fa-api`。

## 使用

打开扩展弹窗，把内容粘到输入框里，或者点“读取剪贴板并识别”。

支持 Gmail：

```text
email@gmail.com|password|recovery@example.com|BASE32TOTPSECRET|2023|Country
```

支持 GitHub：

```text
username----password----BASE32TOTPSECRET
```

支持账单页面文本：

```text
卡号 CARD NUMBER
4111111111111111 点击复制
有效期 EXPIRY
2030/3 点击复制
CVV
123 点击复制
接码 API
https://...
```

识别后会生成小标签，例如 `账号`、`密码`、`2FA验证码`、`卡号`、`CVV`。点对应标签即可复制完整值。

## 填表

在 Gmail、GitHub 或支付页面点输入框，会弹出小面板：

- 填 Gmail
- 填 GitHub
- 填账单
- 复制2FA
- 取短信码

弹窗里也有“按当前网站填”和“填账单”按钮。

## 保存到文件夹

默认会保存到浏览器本地。若要额外写入项目文件夹，先运行：

```bat
D:\杂\gmail-2fa-api\start-local-save.bat
```

然后点扩展里的“保存到文件夹”，数据会写到：

```text
D:\杂\gmail-2fa-api\data\batches\
```

`data/` 是明文 JSON，已经被 `.gitignore` 忽略。
