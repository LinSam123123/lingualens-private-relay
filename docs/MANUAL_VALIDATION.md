# MVP 手动验收进度

最后更新：2026-08-29

分支：`codex/lingualens-private-translator`

构建产物：`.output/chrome-mv3`

## 当前结论

- Chrome/Edge MV3 第一阶段功能已实现。
- Chrome 核心手动矩阵已完成并通过。
- Edge 尚未开始手动兼容验收。
- Firefox MV2 预览构建已生成并完成 Manifest 检查，但尚未在真实 Firefox 中手动验证。
- Firefox 不支持 `storage.*.setAccessLevel`。自动测试覆盖：初始化不会因此失败；local Key 被拒绝；session Key 仍可用。真实浏览器中的设置页禁用项、划词（无 `scripting`）、Sidebar 和 `permissions.request` 仍缺实测证据。
- Firefox Manifest 的 `data_collection_permissions.required` 现为 `websiteContent`。Mozilla 将“向扩展或本地浏览器之外传输数据”视为 data transmission；向用户配置的 Relay 发送网页正文符合 `websiteContent`，不能因为没有遥测就写 `none`。该声明尚未在真实 Firefox 安装提示中目视确认。
- 最新完整自动验证已通过：测试、TypeScript、Chrome production build 和产物审计。
- 动态 DOM、多预设、持久缓存、Firefox 完整适配、旧 Provider 物理清理和依赖升级仍属于后续阶段。

## Chrome 已完成

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| Chat Completions 整页翻译 | 通过 | 9/9 完成，DOM 映射与结构保留 |
| Responses 整页翻译 | 通过 | 9/9 完成 |
| 恢复原文 | 通过 | 译文标记全部移除，无新增请求 |
| 429 自动重试 | 通过 | 两次 429 后成功，总计 3 次 fetch |
| 503 默认策略 | 通过 | 1 次 fetch，结果 unknown，不自动重试 |
| 503 安全重试选项 | 通过 | 开启后最多 3 次 fetch，最终仍为 unknown |
| Request ID Header 被拒绝 | 通过 | 1 次 fetch，明确失败，不误判为可重试网络错误 |
| 重定向连接测试 | 通过 | 明确提示填写不会重定向的最终 Base URL |
| 25 秒超时 | 通过 | 9 unknown，1 次 fetch，无自动重发 |
| 模糊网络断开 | 通过 | 9 unknown，1 次 fetch |
| 连接拒绝 | 通过 | Chrome 仅暴露模糊错误，保守归类 unknown |
| DNS 失败 | 通过 | `.invalid` 地址归类 unknown，不猜测为可重试错误 |
| 用户取消 | 通过 | 17 cancelled；并发 2 时仅活动的 2 批进入 fetch |
| 暂停 | 通过 | 停在 5/17；间隔 3 秒请求数保持 4 |
| 继续 | 通过 | 最终 17/17；总计 16 批，无已完成批次重放 |
| 请求预算 | 通过 | 预算 3；结果 2/4 + 2 errors；严格 3 次 fetch |
| 字符预算 | 通过 | 清缓存后 0/3 + 3 errors；严格 2 次 fetch |
| SW 中断活动批次 | 通过 | 9 unknown；请求数持续为 1，无自动重发 |
| SW 中断 queued 恢复 | 通过 | 16/17 + 1 unknown；总计 16 批，无第 17 次重复请求 |
| 会话缓存 | 通过 | 缓存命中不调用 fetch；配置或 Key 变化时清缓存 |

## 尚待完成

### Edge 基础兼容验收

1. 在 `edge://extensions` 加载 `.output/chrome-mv3`。
2. 使用 `http://127.0.0.1:17891/ok/v1`、模型 `mock-model` 验证 Chat Completions。
3. 切换 Responses，恢复原文并再次验证整页翻译。
4. 验证 Edge 中的设置保存、具体 origin 授权和恢复原文。

Edge 只做基础兼容验收，不重复 Chrome 的全部异常矩阵，除非发现浏览器差异。

### 收尾

1. 完成 Edge 后更新本文件。
2. 再运行一次 `npm run verify`。
3. 审查最终 Git 状态与构建产物。

## 继续工作时的起点

启动 Mock Relay：

```powershell
npm run mock-relay
```

Edge 加载目录：

```text
<home>\Documents\浏览器翻译插件\.output\chrome-mv3
```

测试地址：

```text
http://127.0.0.1:17891/fixture
```
