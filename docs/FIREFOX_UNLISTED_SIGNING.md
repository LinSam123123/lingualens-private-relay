# Firefox Unlisted 签名（自行分发）

扩展 ID（稳定，不要改）：`lingualens-private-relay@local`  
版本：以 `package.json` 为准。  
数据声明：`websiteContent`（会把划词/页面正文发到你配置的 Relay）。  
不公开上架。不设置 `update_url`。不关闭 Firefox 签名校验。

## 为什么需要签名

临时载入（`about:debugging`）会在 Firefox 完全退出后被移除，IndexedDB 默认一并删除。这不是凭据库失败。Release 版 Firefox 只运行 Mozilla 签过名的扩展。Unlisted 签名后，你可以本地安装 XPI，重启后扩展仍在。

## 打包（本机，不含真实 Key）

```powershell
npm run pack:firefox-unlisted
```

生成（`dist/` 不入库）：

- `dist/firefox-unlisted/lingualens-private-<version>-firefox.zip` — 提交给 Hub 的扩展包
- `dist/firefox-unlisted/lingualens-private-<version>-firefox-source.zip` — 审核用源码（WXT/Vite 打包，必须附源码）

提交前请打开这两个 zip，确认没有真实 Key、私人 Relay 配置、日志或 AMO JWT。

## Developer Hub 最短步骤

不要把 JWT 写入 Git，也不要让自动化代传，除非你再次确认。

1. 用 Mozilla 账号登录 [Add-ons Developer Hub](https://addons.mozilla.org/developers/)。
2. **Submit a New Add-on**。
3. 分发方式选 **On your own**（自行分发 / Unlisted），不要选 On this site。
4. 上传 `lingualens-private-<version>-firefox.zip`。
5. 平台选 Firefox for Desktop。
6. 是否提供源码选 **Yes**，上传 `*-firefox-source.zip`。
7. 等待校验和签名邮件（Unlisted 多为自动校验）。
8. 在 My Add-ons → 该版本 → 下载签过名的 `.xpi`。
9. 先在 `about:debugging` **移除临时附加组件**（临时卸载会清掉该 origin 的 IndexedDB；签名安装后的重启测试才算数）。
10. `about:addons` → 齿轮 → **从文件安装附加组件** → 选签名 XPI。
11. 打开设置，把假 Key 存到「扩展隔离的持久存储」并保存。
12. **完全退出 Firefox 再打开**。扩展应仍在，设置页仍显示 hasKey / 脱敏 Key。

更新：提高 `package.json` 的 version，保持同一 gecko id，再打新包，在 Hub 上对该附加组件提交新版本（仍选 Unlisted）。继续不设自动更新服务器。

## 审核可能问到的要点

- 这是个人私有构建，只把文本发到用户自己填的 Relay。
- `websiteContent` 是因为会传输网页正文，不是因为有遥测。
- 构建：`npm ci` → `npm test` → `npm run build:firefox`。
- 没有账号系统，没有项目运营的翻译服务器。
