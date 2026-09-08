# PROJECT_LOG

## 当前快照

- 项目：Obsidian 插件“抖音同步归档”
- 当前任务：修复设置页“测试连接”绕过本地桥接而触发 Argus HTTP 403
- 当前状态：已定位，尚未修改
- 部署位置：`C:\Users\23699\Documents\Obsidian Vault\.obsidian\plugins\douyin-sync`
- 安全边界：Cookie 与 API Key 仅保存在 Vault 插件的 `data.json`，不得写入源码、日志或 Git

## 关键文件索引

- `src/main.ts`：插件入口、命令面板和桥接进程启动
- `src/settings.ts`：设置页及“测试连接”按钮
- `src/douyinClient.ts`：抖音 API 请求与桥接路由
- `douyin-bridge.js`：真实 Chromium 页面上下文请求桥
- `README.md`：安装、配置和请求通道说明

## 验证记录

- 2026-09-08：部署文件与工作目录文件 SHA-256 一致；桥接 `/ping` 返回 ready。
- 2026-09-08：经桥接调用 `listcollection` 得到 HTTP 200、`status_code=0`、3 条数据。

## 近期任务

- 2026-09-08：诊断发现 `src/settings.ts` 的测试按钮仅传 Cookie，新建的 `DouyinClient` 没有桥接地址；命令面板和同步引擎已经正确传入桥接配置。

## Git 记录

- 待建立初始基线。

