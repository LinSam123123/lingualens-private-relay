# 自动增量翻译

## 开发版行为

Chrome / Firefox 共用引擎。首次点击“翻译此页面”保持整页快照；完成后监听新增内容，不必还原再翻译。新增、改写、隐藏转可见的正文稳定 500ms 后，只有接近视口上下 600px 才排程。后台标签页不派发新增工作。

同标签页、同 origin（协议、主机和端口一致）的导航及刷新继续自动翻译，新文档首次只处理视口附近。跨 origin、关闭标签页、“停止自动翻译”或“恢复原文”停止延续。没有永久网站规则；不保证浏览器完全退出、扩展重载、升级或禁用后的恢复。

网站内容变动会产生新 revision。旧回复不会覆盖新的正文或已删除节点；译文及双语标记不会成为新翻译输入。恢复只恢复扩展仍拥有的节点，不覆盖网站之后的改写。代码、输入框、密码框、可编辑区域、隐藏区域和扩展 UI 保持跳过。

动态批次沿用同一文档的 taskId、预算，使用唯一 batch/item ID 和 request ID。SPA URL 改变不重置预算；完整新文档获得新预算。默认仍为 100,000 字符 / 100 次实际 fetch，25 秒超时、并发 2；流式设置及用户保存的并发值不变。重试消耗预算，派发后不退还。预算耗尽停止自动新增，不自动重置。

## 操作和中断

- 暂停：停止新增派发，保留待办；活动请求允许完成。同站换页继承暂停。
- 继续：恢复未派发内容，不自动重试 failed / unknown。
- 补译新增内容：扫描当前文档中尚未处理且接近视口的内容，不重发相同 revision。
- 停止自动翻译：取消活动和排队工作，关闭观察器与标签页延续，保留已成功译文。
- 恢复原文：先停止，移除扩展标记，仅还原仍属于当前 revision 的节点。
- Port 断开：不自动重连重发；用户补译、继续或明确重试才重建通道。
- SW 重启：日志中的 dispatched 转 unknown，预算不变，绝不自动重发；队列恢复沿用原批次身份。
- 往返缓存：pagehide 暂停并中止活动工作；pageshow 重新握手，只处理新内容，不自动重放被中止的批次。保留暂停文档的预算日志，正常旧文档日志在新文档握手时清理，关闭标签页清理全部日志。

Background 的 storage.session 仅保存标签页 origin、文档 ID、语言、显示模式、暂停状态及原有无正文任务日志。Content Script 不读扩展 storage，也不能指定 Relay URL、Key 或连接配置。页面全文自动发往用户配置的中转站，因此开启后，同站新页面正文也可能被发送。

已扣费的任务日志若丢失，增量路径拒绝自动创建新预算，并显示中断状态。首批到达前的暂停或取消也会记录任务级状态，防止晚到批次绕过用户操作。

## 最小浏览器验收

### SPA navigation repair (2026-10-08)

- Background verifies a nonce-tagged top-frame document probe against the current tab URL and the engine's document session ID. Same-origin SPA path/query changes no longer depend on the sender URL staying current. Real document replacement and cross-origin messages still fail ownership checks.
- Loading fences new submissions but does not by itself cancel the document. Completion can clear the fence only after proving the same document. A verified document replacement cancels the previous task once, serialized with repeated handshakes.
- A batch rejected by the navigation guard before cache/scheduler/fetch returns `PAGE_DOCUMENT_NOT_READY`. The engine preserves its original IDs and waits for a bounded handshake, rather than creating unknown items or resetting the budget. Manual unknown retries are not automatically replayed.
- Reload the development extension AND refresh existing pages once after updating, so their content scripts implement the new probe. No cache or Key clearing is required.
- Verification: all Node tests, TypeScript, both production builds and both audits passed. A real Chromium DOM fixture using the shared engine and AutoPages with mock messaging survived four SPA switches (including a rapid pair), made four mock batch calls, and retained zero unknown/errors/cancellations. Restore preserved the latest website text. This fixture does not validate installed-extension transport, real GoDaddy, Firefox UI, or SW suspension.

使用独立 Chrome / Firefox 配置文件，不能与同 ID 日常签名版混装。开发目录分别为 `.output/chrome-mv3` 和 `.output/firefox-mv2`。

运行 `npm run mock-relay`；设置假 Key、`http://127.0.0.1:17891/ok/v1`、`mock-model`，打开流式。不要使用真实 Key。

1. 打开 `http://127.0.0.1:17891/fixture-dynamic`，点击一次翻译；观察延迟新增与隐藏正文自动翻译，向下滚动查看屏幕外段落。
2. 点击 Add paragraph、Replace source、Reuse virtual row 和 Next SPA chapter；确认只翻译变化正文，不出现译文嵌套，SPA 不重置预算。
   打开 Expandable article section、Toggle article drawer 和 Reveal sliding drawer；关闭后再打开，成功译文不应产生重复 fetch。请求期间关闭、结束后重新打开也应显示已收到的译文。
3. 暂停并新增正文，继续后应翻译；切到后台并新增，返回后应继续。恢复原文检查链接、粗体和网站最新正文。
4. 点击 Next document 或 Same-origin redirect：同站自动继续。点击 Different origin：停止自动翻译。后退测试往返缓存，观察预算和任务身份，不只看译文。协议、www/非 www、主机或端口变化都属于跨 origin，不会自动发送新站正文。
5. 降低开发配置的页面请求预算验证耗尽；模拟 SW / Port 中断核对 unknown 不重发及手动处理。不要清日常配置的缓存或 Key。

## 验证状态

自动用例使用 Node、模拟 DOM / Observer、真实页面引擎及调度器，覆盖 revision、去重、视口、暂停/后台、预算、恢复、往返缓存重绑和自动延续消息边界。它们不是浏览器验收。

2026-10-02：`npm run verify` 通过，包含 17 项新增增量/导航用例、全部既有测试、类型检查、Chrome production 构建与审计；Firefox production 构建及 `npm run audit:build:firefox` 也通过。`npm run verify:firefox` 可重复运行同一套检查。

初版没有操作日常浏览器配置、读取真实 Key、调用付费接口、升级依赖或制作签名包。真实 Chrome / Firefox 完整扩展的上述点击验收仍需完成。

## 展开补译修复（2026-10-02）

开发版识别标记为 `dynamic-reveal-v2`，扩展版本号不变。

- 监听 `open`、`aria-expanded`、`aria-controls`、`data-state` 和 `inert`；原生 toggle 及展开动画结束也会唤醒相关子树。通过 aria-controls 定位相邻正文，不因每次展开扫描整个页面。
- 关闭的原生 details 只翻译可见 summary；普通 dropdown/popover/popup 正文不再仅因 CSS 类名被当成菜单，tooltip 和真正的菜单角色仍跳过。
- 请求派发后临时隐藏的同一 revision 保留成功结果，重新可见时回写，不重发。迟到的页面回写确认仍属于真正写入节点的原 attempt。
- 自动延续先筛选视口，再截取字符上限，避免长页面屏幕外内容占满扫描上限。
- 加载事件暂时没有 URL 时保留但隔离原延续状态；不可确认的旧文档仍拒绝发送请求。等待中的握手会合并后续导航通知再检查一次，停止或销毁会清除待检查通知。

新增 8 个回归用例。全部自动测试、类型检查以及两端 production 构建和产物审计通过。

真实接口验证：仅使用用户明确提供的临时凭据及固定非敏感测试句子，共 8 次实际调用，使用 `gpt-5.6-luna`；Chat Completions / Responses 的 JSON 和 SSE 都正常。未刷新模型列表、未自动降级重发、未做六种模型的性能对比，不能据此得出长文章或高并发的性能结论。服务地址、Key 和原始 HTTP 错误体没有写入代码、文档、任务日志或构建。

真实 Chrome DOM 验证：临时本机测试页直接运行共享 PageTranslateEngine、实际调度器和 RelayAdapter，通过本机测试桥代替扩展消息传输。已观察逐条回写、原生折叠框、ARIA/CSS 抽屉、动画抽屉、新增/改写正文、Mock 暂停/继续、恢复网站最新原文，以及真实请求期间收起、结束后展开而不增加调用数。测试页和本机桥已关闭，凭据内存会话已清除。

这不是完整扩展安装验收：没有在真实浏览器里验证 tabs.onUpdated、完整导航/重定向、SW 重启、Firefox UI 或凭据重新加载。本轮没有改日常配置、IndexedDB 结构、扩展 ID、依赖或签名版。已签名的 Firefox 0.6.0 不会自动获得开发目录中的修复；须另行签名更新。临时 Key 已出现在会话中，测试后必须在中转后台撤销，而非只清空扩展输入框。
