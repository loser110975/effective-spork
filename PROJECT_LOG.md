# PROJECT_LOG

## 当前快照

- 项目：Obsidian 插件“抖音同步归档”
- 当前任务：修复设置页“测试连接”绕过本地桥接而触发 Argus HTTP 403
- 当前状态：源码已修复并构建通过；因本机 `E:` 盘不可用，尚未覆盖 Vault 中的旧部署
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
- 2026-09-08：版本升级为 1.0.1；设置页与命令面板统一调用 `testDouyinConnection()`；`npm run build` 退出码为 0。
- 2026-09-08：部署前检查发现 `E:` 盘不存在，按全局备份门槛停止覆盖，等待备份盘恢复后部署并做 Obsidian 原生复测。

## 近期任务

- 2026-09-08：诊断发现 `src/settings.ts` 的测试按钮仅传 Cookie，新建的 `DouyinClient` 没有桥接地址；命令面板和同步引擎已经正确传入桥接配置。
- 2026-09-08：将测试流程集中到插件入口；设置按钮不再自行构造客户端，避免以后再次漏传请求通道。

## Git 记录

- 第 1 次 git：`6c2da1db5e69a867d66fc37a6c837fadcf0c9457`，建立插件源码、构建产物和项目规则基线。
