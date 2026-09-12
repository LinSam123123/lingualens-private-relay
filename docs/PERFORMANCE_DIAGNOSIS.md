# 页面翻译性能诊断（2026-09-12）

基于当前源码。不是 Chrome 手动矩阵复测。数字来自代码，不是推测。

## 进度数字（90/90、100/100、200+）

状态栏 `{{done}}/{{total}}` 是 **网络 item** 计数，不是 API 请求次数。

1. DOM 文本节点先被抽成页面 item。
2. 超长节点按原文边界切成 `*-part-N` 网络 item。
3. `total` = 已排进批次的网络 item 数。
4. `done` = 已按稳定 ID 写回译文的网络 item 数。
5. 百分比 = `(done + errors + unknown + cancelled) / total`。

因此 90/90 表示 90 个网络 item 完成，不是 90 次 fetch。一批可含多个 item。单页批次上限默认 100（`maxPageRequests`），所以 200 个 item 通常仍少于 200 次 fetch。

超时、502/503 等显示为 **unknown**；预算耗尽、缺 ID、JSON 不兼容显示为 **errors**。界面不会把后者标成“超时”。

## 当前默认限制（未改用户已保存设置）

| 项 | 默认 | 代码位置 |
| --- | --- | --- |
| 单批原文字符 | 8,000 | `maxCharsPerRequest` |
| 单批 item 数 | 无上限（仅受字符上限约束） | `buildBatches` |
| 并发 | 2（1–4） | `maxConcurrency` |
| 超时 | 25 秒 | `timeoutMs` |
| 单页字符预算 | 100,000 | `maxPageChars` |
| 单页 fetch 预算 | 100 | `maxPageRequests` |
| 协议 | 设置中的 Chat Completions 或 Responses | `protocol` |

模型名以设置页已保存的 `providers[0].model` 为准，不能从显示名“5.6luna”推断。本诊断不读取真实配置或 Key。

## 超时计时

超时在批次 **离开队列、记为 dispatched、扣预算之后** 才启动。排队时间不计入 25 秒。`fetch` 使用同一 AbortSignal，覆盖响应头等待和响应体读取。完整 JSON 解析完才写回该批 DOM。

已派发后超时 → `interrupted/unknown`，不自动拆小重发。

## 安装版与源码

已签名日常版是 0.6.0。本轮开发构建必须用 **独立 Firefox 配置文件** 加载 `.output/firefox-mv2`，不要覆盖签名 XPI 或日常 IndexedDB。

## 如何确认加载的是本轮开发构建

日常签名版仍是 0.6.0，不要覆盖。独立 Firefox 配置文件加载 `.output/firefox-mv2` 后，设置页应显示：

- 标题旁的 `v0.6.0`（package.json 尚未升版）
- 「启用批次计时」以及 `build batch-timing-v1`

没有这两项就还是签名版或旧构建。

实际 model ID 只看设置页已保存的 Model 字段。源码默认 `model` 为空。本轮不读取日常配置文件或 Key。显示名「5.6luna」不能当成 model ID。

## 批次计时（可关闭）

设置页开关，仅内存、最多 40 条、不写入 storage。字段：request ID、attempt、item 数、原文字符数、排队 ms、响应头 ms、读体 ms、解析 ms、总耗时、脱敏状态。

- 排队：进入调度队列到离开队列（派发前）。
- 响应头：`fetch()` 从派发到响应头可用。**不是**模型首 token 时间。
- 读体：读取响应体。
- 解析：外层 JSON + 翻译信封。
- 总耗时：该次尝试从派发（超时计时开始）到结束。覆盖响应头等待和读体。

状态码来自已知分类（如 `interrupted/unknown:REQUEST_TIMEOUT_UNKNOWN`、`failed:PAGE_BUDGET_EXCEEDED`）。界面仍把预算耗尽、缺 ID、JSON 不兼容显示为 **errors**，超时显示为 **unknown**。

GET/SET/CLEAR 批次计时仅设置页可调用。

## 本轮改动方向

1. 可关闭的批次计时（已接入）。
2. 每批 item 上限，与字符上限一起分批。
3. 实验候选（不预设最优）：当前 8,000/无有效 item 上限；2,000/20；3,000/30。并发先保持 2。
