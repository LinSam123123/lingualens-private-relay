# Firefox 流式开发版

## 构建和边界

在项目根目录运行 `npm run verify:firefox`。它执行全部测试、类型检查、Firefox production 构建和 Firefox 产物审计。Chrome 回归运行 `npm run verify`。

临时加载文件：
`<home>\Documents\浏览器翻译插件\.output\firefox-mv2\manifest.json`

设置页识别标记为 `spa-dock-v2`。版本仍为 0.6.0；这不是已签名更新。默认非流式、并发 2、超时 25 秒，支持并发 1–10、字符和条目双上限及分开的计时。不会覆盖已保存的设置。

最新开发构建同时包含自动增量翻译，状态栏可显示“监听新增内容”和“补译新增内容”；同标签页同 origin 的导航可延续。专项验收及预算语义见 [DYNAMIC_TRANSLATION.md](DYNAMIC_TRANSLATION.md)。

扩展 ID 仍为 `lingualens-private-relay@local`，凭据数据库仍为 `lingualens-private-credentials`，版本 1、对象仓库 `secrets`、记录 ID `relayApiKey`。只由 Background 操作；持久存储失败不回退到 storage.local。本轮未修改凭据代码或签名包。

## 最小独立验收

不要在日常签名版所在配置文件加载同 ID 开发版。用 Firefox 配置文件管理器创建独立开发配置，不复制日常数据。打开 `about:debugging#/runtime/this-firefox`，临时加载上面的 Manifest。

1. 项目根目录运行 `npm run mock-relay`，只填写假 Key，例如 `mock-firefox-key`；Base URL 为 `http://127.0.0.1:17891/slow/v1`，模型 `mock-model`。保存并授权的浏览器权限提示由用户确认。
2. 开启流式、计时，并发 4，单批 500 字符、最多 5 条；使用 `/fixture-long` 页面，确保有多于四批。分别检查 Chat Completions 和 Responses。
3. 观察任务结束前译文逐条出现。测试暂停后活动批次可完成、继续只派发排队批次、取消保留已成功译文；恢复原文后再开一轮，旧任务不应影响新任务。检查链接、粗体和输入框。
4. 用 Mock 的 `/disconnect/v1` 检查异常结果和成功译文保留，不自动重发；用户明确重试 unknown 应提示重复调用风险。Port 断开、终止事件后的槽位释放和回写确认需单独核对，不能仅凭普通翻译成功判定。
5. 在独立配置中选择扩展隔离的持久存储、保存假 Key；在 about:debugging 点重新加载后应仍显示脱敏状态，输入框不出现明文。检查 Popup、设置页和 Firefox 侧栏入口。

临时附加组件完全退出后不保证保留安装或凭据。跨浏览器重启的持久性验收必须使用后续签名安装版，不作为临时加载测试通过项。

## 验证记录（2026-10-02）

- 全部自动测试、TypeScript、Firefox production 构建与 Firefox 产物审计通过。
- Chrome 回归 `npm run verify` 通过，包括全部测试、TypeScript、Chrome production 构建及产物审计。
- 自动用例覆盖 SSE 分片、完整条目、取消、终止释放槽位、异常批次、旧任务隔离、重试回写确认和凭据策略；这些是 Node / 模拟 DOM 证据。
- 真实 Firefox 逐条显示、并发 4、暂停/取消/恢复、Port 断连、重新加载后的 IndexedDB、Popup 和侧栏：未验收。
- 未读取真实 Key、未调用真实中转站、未操作日常浏览器配置、未制作或上传签名包。

签名更新只在开发版浏览器验收通过后单独进行，保持扩展 ID 和凭据结构，使用更高版本号。
