# 项目工作规则

<!-- GLOBAL-PROJECT-LOG-RULES:START -->
- 每次进入项目先读取 `PROJECT_LOG.md`，再检查 Git 状态和当前任务涉及的源码。
- 完成、暂停或阻塞前，更新 `PROJECT_LOG.md` 的当前快照、验证结果和 Git 记录。
- `PROJECT_LOG.md` 是本项目唯一的跨会话当前状态入口；历史资料只能作为证据，不能覆盖现场验证。
<!-- GLOBAL-PROJECT-LOG-RULES:END -->

- 插件发布文件为 `main.js`、`manifest.json`、`styles.css` 和 `douyin-bridge.js`。
- 修改 TypeScript 后必须运行 `npm run build`，并验证本地桥接 `/ping` 与收藏接口响应。
- 不得把 Cookie、API Key、浏览器配置目录或运行日志提交到 Git。

