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

## 双上限分批

Content Script `buildBatches` 与 Background `validateBatchLimits` 都校验。默认 `maxItemsPerRequest = 0`（不限制条目数），行为与签名 0.6.0 的「只按 8,000 字符分批」一致。已派发的超时批次不会自动拆小重发；新任务才用新上限。不按译文长度拆分。

设置页「单次请求条目数」：0 = 无条目上限。实验时再改成 20 或 30，并保存。

## Mock 结构指标（实测代码，不是真实模型耗时）

合成页：80 个短节点 + 20 个中等段落 + 8 个长段落 + 2 个超长节点。并发与超时未进入这次计算。数字是 `buildNetworkItems` + `buildBatches` + `maxPageRequests=100` 的结果。

| 配置 | 网络 item | fetch 批次数 | 单批 item | 单批字符 |
| --- | --- | --- | --- | --- |
| 当前 8,000 / 不限条目 | 110 | 5 | 1–97 | 5,879–7,819 |
| 2,000 / 最多 20 | 114 | 21 | 1–20 | 904–1,998 |
| 3,000 / 最多 30 | 112 | 16 | 1–30 | 1,374–2,999 |

当前配置可以把约 97 个短节点打进同一请求，整批 JSON 解析完才写回 DOM。这与「90/90、100/100 仍在等」相符（结构推断，不是真实耗时）。小批次会增加 fetch 次数和提示词开销，不能只凭首批更快就宣称整页更快。

Mock Relay 另有 `/fixture-mixed`（短导航 + 长段落 + 链接/粗体），可用假 Key 看分批，不用于真实模型对比。

## 请你做的一次 Firefox 真实对比

独立配置文件加载 `.output/firefox-mv2`。确认设置页有 `build batch-timing-v1` 和「单次请求条目数」。手动填写 Key，不要从日常配置迁移。

同一篇公开、不敏感长页面，清**开发环境**会话翻译缓存（设置页「清除会话缓存」），不要清 Key。并发保持 2，超时保持 25 秒。依次：

1. 8,000 字符，条目数 0  
2. 2,000 字符，条目数 20  
3. 3,000 字符，条目数 30  

记录：首次出现译文、整页完成、成功/unknown、实际 fetch（批次计时行数，或 `requestsUsed`）。抽查链接、粗体、长段落完整性，以及恢复原文。

第一轮不换模型、不延长超时、不提高单页预算。若仍不足，再讨论小规模模型对比。
