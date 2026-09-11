# MVP 手动验收进度

最后更新：2026-09-11

分支：`codex/lingualens-private-translator`

构建产物：`.output/chrome-mv3`

## 当前结论

- Chrome/Edge MV3 第一阶段功能已实现。
- Chrome 核心手动矩阵已完成并通过。
- Edge 基础兼容冒烟已由用户报告通过：加载 `.output/chrome-mv3`、保存并授权 loopback、`/fixture` 整页翻译、恢复原文。这些是界面观察，没有 Mock Relay fetch 计数；未测 Responses 切换，也未重复 Chrome 异常矩阵。
- Firefox MV2 预览冒烟已由用户报告通过：保存并授权、整页翻译、恢复原文、Popup 打开侧边栏。这些是界面观察，没有 Mock Relay fetch 计数，也不是 Chrome 异常矩阵的复测。
- Firefox 仍未做：划词翻译、local Key 禁用项、安装提示中的 `websiteContent` 声明、429/超时/SW 等异常路径。
- Firefox 不支持 `storage.*.setAccessLevel`。自动测试覆盖：初始化不会因此失败；local Key 被拒绝；session Key 仍可用。
- Firefox Manifest 的 `data_collection_permissions.required` 为 `websiteContent`。不能因为没有遥测就写 `none`。该声明尚未在真实 Firefox 安装提示中目视确认。
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

## Firefox 预览冒烟

Mock Relay：`http://127.0.0.1:17891/ok/v1`，模型 `mock-model`。未重复 Chrome 异常矩阵。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 保存并授权 loopback | 通过（用户报告） | 不再报 `http://127.0.0.1:17891/*` 未声明；缺 fetch 计数 |
| Chat Completions 整页翻译 | 通过（用户报告） | `/fixture` 译文写回；缺批次/DOM 计数 |
| 恢复原文 | 通过（用户报告） | 界面观察已恢复；缺“无新增请求”计数 |
| Popup 打开侧边栏 | 通过（用户报告） | `sidebarAction.open` 打开侧栏；未测历史持久化 |
| 划词翻译（无 scripting） | 未测 | |
| 设置页禁用 local Key | 未测 | |
| `websiteContent` 安装提示 | 未测 | |

## Edge 基础兼容冒烟

与 Chrome 共用 `.output/chrome-mv3`。Mock Relay：`http://127.0.0.1:17891/ok/v1`，模型 `mock-model`。未重复 Chrome 异常矩阵。

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 加载解压产物 | 通过（用户报告） | `edge://extensions` 加载 `chrome-mv3` |
| 保存并授权 loopback | 通过（用户报告） | 设置页授权；缺权限 API 日志 |
| Chat Completions 整页翻译 | 通过（用户报告） | `/fixture` 译文写回；缺批次/DOM 计数 |
| 恢复原文 | 通过（用户报告） | 界面观察已恢复；缺“无新增请求”计数 |
| Responses 整页翻译 | 未测 | 本轮未要求切换协议 |

## 尚待完成

未阻塞个人私有使用。若继续预览：

1. Firefox 划词翻译（无 `scripting`）。
2. Firefox 设置页确认 local Key 已禁用。
3. Edge 切换 Responses 后再做一次整页翻译与恢复原文。

### 收尾

1. Edge 基础冒烟已记入本文件。
2. `npm run verify` 已于 2026-09-11 通过（测试、TypeScript、Chrome production build、产物审计）。
3. 工作区仅文档变更；`.output/` 不入库。产物：`.output/chrome-mv3`、`.output/firefox-mv2`。

## 继续工作时的起点

启动 Mock Relay：

```powershell
npm run mock-relay
```

Firefox 加载文件：

```text
<home>\Documents\浏览器翻译插件\.output\firefox-mv2\manifest.json
```

Edge 加载目录：

```text
<home>\Documents\浏览器翻译插件\.output\chrome-mv3
```

测试地址：

```text
http://127.0.0.1:17891/fixture
```
