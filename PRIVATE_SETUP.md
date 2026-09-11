# LinguaLens 私有中转站版使用说明

## 1. 构建与安装

```powershell
npm install
npm run verify
```

Chrome 和 Edge 的加载方法：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目的 `.output/chrome-mv3` 目录。

首次安装或更新扩展后，刷新需要翻译的网页。浏览器内部页、扩展商店页等受限页面不能注入 Content Script。

### Firefox 临时预览

Firefox 完整适配仍属于第二阶段，但可以临时加载当前预览构建：

```powershell
npm run build:firefox
```

1. 在 Firefox 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 `.output/firefox-mv2/manifest.json`。
4. 打开扩展设置，填写 Relay 后点击“保存并授权域名”。
5. Popup 的侧边栏按钮在 Firefox 中通过 `sidebarAction.open()` 打开；Chrome/Edge 仍使用 `sidePanel.open`。

临时附加组件会在 Firefox 完全退出后被移除，下次需要重新载入。Firefox 预览已做过保存授权、整页翻译、恢复原文和 Popup 侧边栏的冒烟（用户报告/界面观察）。全量异常矩阵、划词和无 `scripting` 的边界仍未测；遇到新的浏览器差异应记录，不要为跑通而降低 Key 隔离。

Firefox 140+ 可能显示数据收集说明。Manifest 声明 `websiteContent`，因为翻译会把网页正文发到你配置的 Relay，而不是因为项目有遥测。`required: ["none"]` 仅适用于完全不向扩展或本地浏览器之外传输数据的附加组件。

## 2. 中转站要求

Base URL 必须满足：

- 公网地址只允许 HTTPS。
- HTTP 只允许 `localhost` 或 `127.0.0.1`。
- 不允许用户名、密码、查询参数或 URL 片段。
- 必须填写不会重定向的最终地址。

扩展按设置的协议调用：

- `POST {baseUrl}/chat/completions`
- `POST {baseUrl}/responses`
- `GET {baseUrl}/models`

翻译请求携带 `X-Translation-Request-Id`。中转站应允许该 Header；若明确拒绝，扩展返回 `REQUEST_ID_HEADER_REJECTED`，不会移除 Header 后自动重试。

模型不需要支持 `response_format`、JSON Schema 或 Structured Outputs。扩展通过提示词要求 JSON，并接受纯 JSON 或 Markdown JSON 代码栏。输出格式为：

```json
{"items":[{"id":"原始ID","text":"译文"}]}
```

未知 ID 会被忽略；缺失 ID 只会在用户重试失败项时补发。扩展不会按译文长度切分并猜测节点归属。

## 3. 保存与授权

1. 打开扩展设置页。
2. 填写 Base URL、协议、模型和 API Key。
3. 选择 Key 存储方式。
4. 点击“保存并授权域名”。
5. 接受浏览器针对该主机权限的提示。

Chrome 申请的是精确 origin（非默认端口会写入口径）。Firefox 的 match pattern 不能带端口，因此申请 `scheme://hostname/*`，该权限覆盖此主机的所有端口。Background 的 fetch 仍只使用已保存并通过校验的精确 Base URL（含端口），不会改成任意端口或任意域名。`permissions.request`、`contains` 和 `remove` 使用同一套模式生成函数。

更换 Base URL 时，扩展先申请新权限；保存失败会移除刚申请的权限；保存成功后再移除旧权限。Firefox 上只改端口时新旧模式相同，不会移除该主机权限。模型刷新和连接测试只能针对已保存的配置运行，避免绕过用户授权手势。

Key 默认存入 `storage.session`，浏览器会话结束后可能丢失。选择本地模式后，Key 存入限制为 trusted extension contexts 的 `storage.local`。设置页只能读取 `hasKey` 和脱敏状态，不能读回明文 Key。

Firefox 目前不支持 `storage.local.setAccessLevel`（MDN：`version_added: false`，Bug 1724754）。`storage.session` 默认仅可信扩展上下文可访问，因此默认 session Key 仍保持隔离。受保护的 local Key 在无法限制内容脚本读取 `storage.local` 时会被拒绝，设置页会禁用该选项；不会为了兼容而把 Key 写入未隔离的 local。Content Script 也不再从网页上下文直接读取扩展 storage（界面语言只在扩展页使用 storage）。

## 4. 默认限制

- 超时：25 秒
- 并发：2，可设为 1 至 4
- 单页字符预算：100,000
- 单页实际 fetch 预算：100
- 单次请求字符数：8,000

预算在调用 fetch 前扣除。进入 `dispatched` 后，无论成功、HTTP 错误、超时、取消或状态未知，都不会返还。自动重试和手动重试都会继续消耗同一页面任务预算。`/models` 和连接测试不计入页面预算。

## 5. 重试与状态

- HTTP 429：遵守合法 `Retry-After`，否则有限指数退避；最多自动重试两次。
- HTTP 502/503：默认记为 `interrupted/unknown`，不自动重试。
- 只有确认中转站未执行请求，或已按 request ID 实现幂等时，才能开启 502/503 安全重试选项。
- 可明确识别的 DNS 或连接拒绝错误：最多自动重试两次。
- 普通浏览器 `TypeError`、模糊断开、25 秒超时、SW 中断：记为 `interrupted/unknown`，不自动重发。
- 用户取消产生的 `AbortError`：记为 `cancelled`，不自动重试。

“重试失败”只处理有明确失败结论的 item。“重试状态未知”必须由用户确认；中转站可能已经完成原请求，因此可能产生重复计费或重复调用。手动重试沿用原 request ID，并增加 attempt。

## 6. 页面操作语义

- 暂停：停止派发新批次；已派发请求可在 25 秒内完成。
- 继续：恢复 queued 批次；不会自动重试 failed 或 unknown。
- 取消：abort 活动请求，清空队列，保留已成功译文。
- 恢复原文：先取消，再恢复快照中的原始文本并移除扩展标记。
- 页面导航或关闭：按取消处理，不再访问已销毁 DOM。

第一阶段只翻译启动时的页面快照，不使用 `MutationObserver`。翻译开始后新增的动态内容不会自动处理。

## 7. Service Worker 恢复边界

`storage.session` 只保存 task、batch、item ID、request ID、attempt、状态、预算和更新时间，不保存网页原文。日志只在批次或任务状态变化时写入。

SW 实例重启后：

- 原 `dispatched` 批次转为 `interrupted/unknown`，预算不变，绝不自动重发。
- `queued` 批次可在 Content Script 恢复握手后继续。
- unknown 只能由用户重试、跳过或恢复原文。

这不保证浏览器完全退出、扩展重载、升级、禁用或页面重载后的恢复。页面重载、tab 消失或 session ID 不匹配时会清理旧日志。

## 8. 本地测试中转站

```powershell
npm run mock-relay
```

使用模型 `mock-model`，Base URL 可选：

- `http://127.0.0.1:17891/ok/v1`
- `http://127.0.0.1:17891/slow/v1`
- `http://127.0.0.1:17891/redirect/v1`
- `http://127.0.0.1:17891/rate-limit/v1`
- `http://127.0.0.1:17891/gateway/v1`
- `http://127.0.0.1:17891/header-rejected/v1`
- `http://127.0.0.1:17891/timeout/v1`
- `http://127.0.0.1:17891/disconnect/v1`

手动验收应覆盖 Chat Completions、Responses、重定向提示、429、502/503 两种策略、Header 拒绝、连接拒绝、模糊断开、25 秒超时、取消、预算、SW 重启和恢复原文。Chrome 与 Edge 需要分别加载产物验证。

普通 DOM fixture 位于 `http://127.0.0.1:17891/fixture`，多批次暂停/取消 fixture 位于 `http://127.0.0.1:17891/fixture-long`。当前手动验收状态见 [docs/MANUAL_VALIDATION.md](docs/MANUAL_VALIDATION.md)。

## 9. 数据清理

- 设置页“清除 Key”会同时删除 session/local 中的 Secret。
- 清理扩展缓存可删除 session 翻译缓存。
- Sidepanel 历史只存在 `storage.session`。
- 浏览器扩展管理页的“清除数据”或卸载扩展会删除该扩展的本地数据。
- 更换 Relay 后，建议在浏览器站点权限中确认旧 origin 已移除。

## 10. Git 与上游更新

```powershell
git status
git remote -v
git fetch upstream
git log --oneline upstream/main..HEAD
```

上游更新应在独立分支中合并或变基，并重新执行 `npm run verify` 与 Chrome/Edge 手动矩阵。不要在同一提交中同时升级 WXT/依赖和修改 Relay 业务逻辑。
