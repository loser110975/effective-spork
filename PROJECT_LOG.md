# PROJECT_LOG

## 改进落地记录（2026-09-14，依据 CODE_ANALYSIS.md §五 优先级表）

- **P0 · 问题 8**：`syncEngine.findNotePath` 增加 `id → path` 反向索引（懒建 + TFile 存在性校验 + 未命中回扫回填），`processItem` 写台账时同步更新索引，`loadState`/`resetState` 时失效重建。
- **P0 · 问题 9**：`videoSummaryService.listVideoFramePaths` 由全 vault 扫描改为帧目录 `TFolder` 直读（O(目录文件数)）。
- **P1 · 问题 3**：`util.ts` 新增统一入口 `nodeRequireFn` / `nodeRequire` / `fsExists`（错误边界 + 类型收敛）；`main.ts`（2 处）、`processManager.ts`（2 处）、`videoMedia.ts`、`asr/siliconflow.ts` 全部改走统一入口，`(window as any).require` 在 src 下仅存于 util 单点实现。
- **P1 · 问题 6**：新增 `statusCore.collectExistingAssets`（纯函数，解析口径与 noteBuilder 产出一一对应）；`processItem` 在重试路径（`asrOverride` + `overwritePath`）回收既有 cover / category / 图片 / 逐图 OCR 文本 / 关键帧，跳过二次下载、重复 OCR 与重复分类；关键帧优先复用已入库帧网格，避免重试重拉视频跑 ffmpeg。
- **P2 · 问题 5**：`ai.ts` chat 显式 `timeout`（默认 120s，`setTimeoutMs` 可调），超时错误独立文案，不再与网络错误混同。
- **P3 · 问题 7**：`douyinClient` 的 `variant` 提升为模块级 `rememberedVariant`，跨实例保留生效档位，不再每次重建都从全套头重试降级。
- **P3 · 问题 12**：设置页 Cookie 项追加明文存储安全警示（CODE_ANALYSIS 给出的最小合规选项；AES-GCM 加密会破坏现有 data.json 兼容，未采用）。
- **P3 · 问题 11**：`douyin-bridge.js` 新增 `POST /shutdown` 端点与 `SIGTERM/SIGINT` 处理（先关 Chromium 上下文再退出，避免 profile 锁残留）；`processManager.stopInner` 改为「先优雅退出 → 失败再 `taskkill /F /T` 兜底」。桥接脚本已按 AGENTS.md 同步全部 5 处副本（仓库 / Vault / ~/bin / dist bridge / dist plugin），md5 一致。

## 明确延后（含理由）

- **P1 · 问题 1/2/6 的完整版**：`processItem` 约 170 行的完整原子化拆分（ItemProcessor 独立类）需要重组 `buildNote` 的入参装配链路，属一次性大手术；本次以「重试路径资产复用」实现其核心收益（重试不再触发全套副作用），完整拆分建议单独立项。
- **P2 · syncAll / processItem 单测**：需搭建 obsidian App/Vault mock 测试环境，建议与问题 6 的完整拆分一并实施。
- **问题 13 / 14**：不在 §五 优先级表内；且桥接串行队列是 Argus 风控下的刻意设计（有界并发会增加风控暴露），`createNormalized` 在当前 API 版本不存在，均未改动。

## 验证记录（2026-09-14）

- `tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 退出码 0；`esbuild production` 退出码 0，`main.js` 119703B。
- `statusCore` 单元测试 **25/25**（原 19 项 + 新增资产回收 6 项，含零覆盖组合断言）。
- M1 集成验证 **6/6**（spawn → netstat PID 一致 → /ping 就绪 → 整树终止 → 端口释放）。
- 桥接优雅退出冒烟 **5/5**（新脚本就绪 → `POST /shutdown` 200 → 进程自行退出 code=0，未用 taskkill → 端口释放）。
- 桥接脚本 5 处副本同步：仓库 / Vault / `~/bin` / dist bridge / dist plugin，md5 一致（`70fec1170d4c…`，10335B）。
- `main.js` 已部署 Vault（119703B，md5 一致）；`data.json` 未触碰。

## 当前快照（历史）

- 项目：Obsidian 插件“抖音同步归档”
- 当前任务：收藏分类优化（已完成）＋ 按 CODE_ANALYSIS.md 落地代码质量改进（本次：7 项已实现）
- 当前状态：CODE_ANALYSIS 改进项——P0 索引化（问题 8/9）✅、P1 require 统一（问题 3）✅、P1 重试资产复用（问题 6）✅、P2 AI 超时（问题 5）✅、P3 variant 记忆（问题 7）✅、P3 Cookie 警示（问题 12）✅、P3 桥接优雅退出（问题 11）✅；P1 processItem 完整原子化拆分与 P2 syncAll/processItem 单测**明确延后**（理由见验证记录）。构建 0 错误、单测 25/25、集成 6/6、优雅退出冒烟 5/5，已部署 Vault 并同步桥接脚本 5 处副本
- 部署位置：`C:\Users\23699\Documents\Obsidian Vault\.obsidian\plugins\douyin-sync`
- 安全边界：Cookie 与 API Key 仅保存在 Vault 插件的 `data.json`，不得写入源码、日志或 Git

## 关键文件索引

- `src/main.ts`：插件入口、命令面板和桥接进程启动
- `src/settings.ts`：设置页及“测试连接”按钮
- `src/douyinClient.ts`：抖音 API 请求与桥接路由
- `src/itemType.ts`：视频/图文类型判定纯函数（is_note / aweme_type / 有图回退三重信号）
- `src/videoMedia.ts`：ffmpeg 编排（直链单次拉取双输出：转录用音频 + 关键帧）
- `src/asr/siliconflow.ts`：硅基流动 SenseVoice 转写
- `src/videoSummaryService.ts`：视频多模态综合总结（转录 + 关键帧 → 百炼视觉模型 → 带配图摘要）
- `douyin-bridge.js`：真实 Chromium 页面上下文请求桥
- `README.md`：安装、配置和请求通道说明

## 验证记录

- 2026-09-08：部署文件与工作目录文件 SHA-256 一致；桥接 `/ping` 返回 ready。
- 2026-09-08：经桥接调用 `listcollection` 得到 HTTP 200、`status_code=0`、3 条数据。
- 2026-09-08：版本升级为 1.0.1；设置页与命令面板统一调用 `testDouyinConnection()`；`npm run build` 退出码为 0。
- 2026-09-08：用户明确改用 D 盘备份；旧部署已备份到 `D:\CodexBackups\ObsidianPlugins\20260908-233613\douyin-sync`，5 个文件逐一校验，SHA-256 差异数为 0。
- 2026-09-08：1.0.1 四个发布文件已部署，源文件与 Vault 文件 SHA-256 全部匹配，`data.json` 部署前后哈希一致。
- 2026-09-08：Obsidian 正常关闭并重启，打开正确 Vault；用户确认设置页测试成功，桥接日志于 23:39:10 记录 `listcollection -> 200`。
- 2026-09-11：死代码清理。`tsc -noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 退出码 0（清理前报 2 处未使用导入）；`esbuild production` 退出码 0，`main.js` 由 58756 B 降至 58252 B。
- 2026-09-11：以非压缩模式分别打包清理前后的源码并逐行 diff，差异仅含 16 行删除与 5 行改写，全部落在被移除符号上；ASR、OSS 上传、笔记渲染、设置页 UI、桥接拉起等业务逻辑行逐字节一致。验证用临时脚本已删除。
- 2026-09-11：源码备份于 `C:\Users\23699\Desktop\抖音收藏1\.workbuddy\backup\src-20260911-1636\`（含清理前 14 个 `.ts` 与 `main.js`）。
- 2026-09-12：四项新功能实施。`tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 退出码 0；`esbuild production` 退出码 0，`main.js` 58252B → 89903B。新增模块：`statusCore.ts`（纯函数层）、`processManager.ts`（M1）、`statusHub.ts`（M4）、`ocrService.ts`（M2）、`summaryService.ts`（M3）、`panelView.ts`（管理面板视图）；扩展 `types.ts` / `main.ts` / `settings.ts` / `syncEngine.ts` / `styles.css`。
- 2026-09-12：`statusCore` 单元测试 19/19（含★零覆盖断言：替换摘要块后逐字稿与图片文字逐字不变；重复生成不产生重复块）。
- 2026-09-12：M1 集成验证 6/6（spawn → `netstat -ano` 解析 PID 与子进程 PID 一致 → `/ping` 6.5s 就绪 → `taskkill /F /T` 整树终止 → 端口释放）。
- 2026-09-12：部署 5 文件到 Vault（原文件备份于 `backup-before-feature-20260912051018`），md5 全部一致；`data.json` 未触碰。
- 2026-09-13：收藏分类优化实施。`tsc -noEmit -skipLibCheck` 退出码 0；`esbuild production` 退出码 0，`main.js` 89903B → 110783B。新增模块：`itemType.ts`（类型判定纯函数）、`videoMedia.ts`（ffmpeg 直链单次拉取双输出）、`asr/siliconflow.ts`（SenseVoice multipart 上传）、`videoSummaryService.ts`（多模态总结）；扩展 `types.ts` / `douyinClient.ts` / `statusCore.ts`（`renderVideoSummary`）/ `ai.ts`（`chatVision`）/ `noteBuilder.ts`（关键帧折叠块）/ `summaryService.ts`（视频走多模态）/ `syncEngine.ts`（视频分支 + `backfillVideos` 批量补跑）/ `main.ts` / `settings.ts`。
- 2026-09-13：单元测试 30/30（`statusCore` 19 + 新增 `itemType` 6 + `renderVideoSummary` 5，运行器重建于 `douyin-sync-obsidian/.tmp-tests.mjs`）。
- 2026-09-13：ffmpeg 实测——本机为 winget Gyan.FFmpeg 9.0.1（PATH 内）；本地样本双输出通过（15s 视频 → 3 帧 + 126KB mono mp3）；远程 https 双输出通过（`scale='min(720,iw)':-2` 单引号形式；发现无 shell spawn 下 `\,` 转义被 filtergraph 解析器吃掉的坑并修复）；验证脚本保留于 `代码\test-ffmpeg-pull.js`。
- 2026-09-13：真实数据类型判定验证——经桥接拉一页收藏（20 条），`aweme_type=0`×17 全判视频、`aweme_type=68`×3 全判图文，与三重信号逻辑完全吻合；`代码\test-aweme-type-distribution.js` 可复查。
- 2026-09-13：百炼多模态实测——`qwen3-vl-plus` compatible-mode 接收 base64 data URL 关键帧正常（338 tokens/次，单图约 288 image tokens）；SiliconFlow 转录端点路由确认（无效 Key 返回 401 而非 404）。
- 2026-09-13：`main.js` 已同步至 `dist\douyin-sync-installer\plugin\` 与 Vault 插件目录；`data.json` 未触碰（现有 `asrProvider=dashscope_paraformer` 需用户在设置页切到 SenseVoice 并填 Key）。
- 2026-09-13：用户实测反馈"关键帧少了"（设置钳制 1~10 导致填大值被静默钳回 10）。放宽 `keyframeCount` 上限至 30（videoMedia / videoSummaryService / settings 三处钳制同步），摘要配图引用上限 3→6；`backfillVideos` 新增**补帧**路径：关键帧数少于当前设置的视频也纳入补跑，已有成功转录从笔记逐字稿块复用（构造 `asrOverride`，不重复计费 ASR），仅重新抽帧 + 重出摘要。真实验收：用户切换 SenseVoice+填 Key 后自动同步 4 条视频全链路 4/4 成功、0 转写失败、临时音频按时清理。
- 2026-09-13：应用户要求关键帧上限 30→**100**（四处钳制同步：types 注释 / settings / videoMedia / videoSummaryService / syncEngine）。配套加 16MiB 红线保护：`framesToDataUrls` 累计 base64 超 14MiB 即截断（qwen3-vl 收 250 张 base64 图但请求体解码后 ≤16MiB，超限 HTTP 413），截断后序号仍与配图渲染一致。
- 2026-09-13：用户示例反馈三项整改（100 张上限导致 23 秒视频也抽 100 张）：① 抽帧改**按时间间隔自适应**——`keyframeCount` 设置废弃，新增 `keyframeIntervalSec`（默认 10s，1~60），`fps=1/<间隔>` 无需预知时长，`-frames:v 100`/`-t 600` 双封顶；`ingestFrames` 入库时清理旧网格多余帧；frontmatter `keyframes` 字段改 `frame_interval`。② **摘要不再嵌照片**——`statusCore.renderVideoSummary` 移除，改 `stripFrameMarkers` 兜底剔除偶发标记，关键帧统一放「关键帧」折叠块。③ 摘要改**结构化笔记体**（`简介：` + 概述段 + `🎯 N.` emoji 分节 + 加粗划重点 + `🌟 小总结`，对齐用户给出的 bilibili 笔记示例），frontmatter 新增 `summary_v: 2` 版本号。补跑条件同步升级：间隔不一致 / 无帧 / `summary_v != 2` 均纳入重跑。测试更新后 29/29，构建部署到 dist 与 Vault。
- 2026-09-13：用户明确抽帧定位——"目的是让 AI 结合转录文字更好总结视频"。两处强化：① `videoMedia` 短视频保底帧数 `rate=max(1/间隔, 4/时长)`（23s 视频从 2~3 帧提到 4 帧，实测 5s/23s/45s/80s/600s → 4/4/5/8/60 帧）；② 提示词向模型说明采样方式（每隔 N 秒从全片均匀抽取、对应开头/中段/结尾）与用法（转录=口播、帧=画面，两者互补，重点补充转录未提的视觉信息，按时间顺序理解推进脉络，不逐张描述）。
- 2026-09-13：用户给出第二个摘要示例（折射率实验笔记），摘要风格升级为**层级笔记体**并标 `summary_v: 3`：第一行「主题:副题」内容标题（不照抄视频标题）→ `## 引言`（含核心问题）→ 按内容逻辑 `## 分节`（可嵌 `### 子标题`，完整保留数据/数字/公式/名词，宁详勿略，不用 emoji 编号）→ `## 总结与意义` → `## AI 总结`（3~6 句整体概括）。补跑判定升为 `summary_v != 3` 重出，v2 笔记下轮补跑自动换新风格。构建 29/29 通过，已部署。
- 2026-09-13：诊断"补跑摘要全失败"——`qwen3-vl-plus` 免费额度耗尽（`AllocationQuota.FreeTierOnly`，百炼各模型额度独立；qwen-vl-plus/qwen-vl-ocr/qwen-plus 实测仍有额度）。用户指定改用 `qwen3.5-omni-plus-2026-03-15`（实测图像输入 200，单帧约 882 image token）。补跑新增 **frameHint 复用**：帧网格已符合当前设置（`frame_interval` 匹配）时跳过 ffmpeg 重新拉取，直接复用已入库帧重出摘要。
- 2026-09-13：**事故与恢复**——用 Python 写 data.json 换模型时，因文件中存在孤代理 emoji 转义（抖音标题脏数据）且 `ensure_ascii=False`，写入中途崩溃致文件截断（17.7KB/204KB，settings 完整、processed 截断），且 Obsidian 已关闭无法触发内存回写。恢复：`代码\restore-datajson.py` 用 `raw_decode` 抢救出完整 settings（52 字段含全部 Key），并从 vault 全量笔记重建 processed（589 条，与损坏前一致，dedupe 策略同 findNotePath）；pendingAsr 已知 1 条补回；`state.summary`（28 条历史）/`vision`/processManager PID 为保护性放弃（不影响补跑逻辑——补跑依据笔记内容而非历史记录）。改用 `ensure_ascii=True` 写入并复核通过；截断件存 `data.json.corrupt-20260913`。教训：**外部写 data.json 必须 `ensure_ascii=True`**。
- 2026-09-13：新模型实跑验收——补跑 40 条全部成功 0 失败（qwen3.5-omni-plus，约 38s/条，frameHint 复用生效）。发现并修复**引号匹配 bug**：processFrontMatter 写回 summary 后会把 YAML 引号剥掉（`type: "视频"` → `type: 视频`），而补跑/手动摘要的 `type` 与 `transcript_status` 正则要求带引号——导致被改写过的笔记（尤其摘要失败过的）永远无法再被补跑命中。三处正则改引号无关（syncEngine 补跑 type/transcript_status、summaryService 手动摘要 type）。修正后统计口径：视频笔记 403 条，v3 完成 40，待补 363。
- 2026-09-13：**Agent 接管完成全部剩余摘要**。用户要求由 AI 助手充当多模态模型完成剩余 328 条：扫描切分 28 批（`代码\agent-batches\batch-XX.txt`，每批 12 条），派子代理串行逐篇"读转录→抽样看帧→写 v3 层级摘要→`代码\agent-summary-write.py` 写回"（脚本新增 frame_interval 自动补记，防云端重复抽帧覆盖）。执行模式从单代理改为双代理并行后稳定（4 并行会触发 user concurrency limit）。全程 done 328 / failed 0；含 10 条**转录为空/无效**的云端盲区笔记（纯靠帧上字幕卡或视频文案重建，如实标注"信息有限、不做虚构"）；ASR 误写按上下文校正（道氏理论/兰小欢/长鑫存储等）。最终核验：**视频笔记 403/403 全部具备 summary_v: 3 层级笔记体摘要**（95 条有帧、308 条无帧——无帧者为云端抽帧失败的视频，摘要基于转录与文案）。`代码\agent-summary-write.py` 与批次文件保留，可用于后续增量或重写。
- 2026-09-13：**三层持续摘要架构落地**（用户选定）：① 主力模型切智谱 **GLM-4.6V-Flash**（完全免费视觉模型，BigModel OpenAI 兼容协议）——新增设置 `videoSummaryBaseUrl`/`videoSummaryApiKey` 隔离多模态通道（留空复用 aiBaseUrl/aiKey，分类通道不受影响），待用户注册 bigmodel.cn 填 Key 后生效；② **提示词固化**：buildPrompt 写入实战方法论（画面信息挖掘清单、ASR 同音错字校正规则、空转录重建规则、诚实标注原则），任何模型都产出接近手写的层级笔记体；③ **Agent 巡检兜底**：新增 `代码\agent-sweep.py`（扫描缺 summary_v 且同步超 10 分钟的视频笔记，按帧达标/转录空/常规排序，写 pending.txt 最多 12 条），CronCreate 每 30 分钟定时任务派**单个**子代理亲写（≤5 帧/篇），**每次运行追加 `代码\agent-sweep.log`**（时间+pending/done/skipped/failed）解决静默失效问题。首次手动 sweep 验证端到端：pending=10 全部完成（9 条由被取消的子代理完成+1 条人工补写，日志如实记录取消与续跑）。
- 2026-09-13：**GLM 通道实测接管生效**——用户填入智谱 Key 后实测 `glm-4.6v-flash` 图像输入 HTTP 200（燕麦视频第 30 帧信息图，准确读出总胆固醇↓8%/坏胆固醇↓10%/对照组无显著变化，1216 prompt tokens/帧）。自此三层架构全部上线：新收藏同步 → GLM 自动层级摘要；云端失败 → 30 分钟巡检由 AI 助手亲写兜底；`代码\agent-sweep.log` 提供运行反馈。

## 近期任务

- 2026-09-08：诊断发现 `src/settings.ts` 的测试按钮仅传 Cookie，新建的 `DouyinClient` 没有桥接地址；命令面板和同步引擎已经正确传入桥接配置。
- 2026-09-08：将测试流程集中到插件入口；设置按钮不再自行构造客户端，避免以后再次漏传请求通道。
- 2026-09-08：部署并验收完成；Argus 403 问题闭环。
- 2026-09-11：按 `ARCHITECTURE.md` §6 清单逐项核实并清理死代码，删除 `util.clampInt` / `util.truncate`（零调用方）、`SyncEngine.setSettings()` / `Main.loadEngineState()`（零调用方）、`SyncState.pendingVision` / `SyncState.fullSyncedAt`（从未写入）、`NoteContentInput.imagePathPrefix`（从未读取）、`DouyinPage.statusCode` / `DouyinPage.raw`（从未写入）、未使用导入 `WorkspaceLeaf` / `sanitizeFilename`、`syncFlat` 的 `_source` 参数，并合并 `noteBuilder.ts` 中三行重复的 `./types` 导入。
- 2026-09-11：清理 `setSettings()` 后暴露出 `SyncEngine` 构造器的 `private spawnBridge` 属性已无读取方，降级为普通参数（仍原样传给 `DouyinClient`），行为不变。
- 2026-09-11：`ARCHITECTURE.md` §3.1 / §3.7 / §4 / §6 中描述上述已删符号的段落同步更新，避免文档与源码不一致。
- 2026-09-11：待办——如需让 Vault 中运行的插件用上本次清理结果，需重新部署 `main.js` 并重载插件。
- 2026-09-12：实现 `M1 ProcessManager`（`start/stop/restart` + 命令去重 + PID 持久化 + `onunload` 整树终止）、`M4 StatusHub`（进程态 5 × 连接态 4 二维状态机，轮询 ≤5s，仅状态变更才提示）、`M2 OcrService`（Agnes 主通道 + 显式确认后的付费兜底，绝不自动回退）、`M3 SummaryService`（frontmatter `summary` 属性 + 正文摘要折叠块，原文零覆盖）、管理面板视图 `douyin-sync-panel`（Ribbon `server` 图标）。
- 2026-09-12：新增 6 条命令（open-panel / bridge-start / bridge-stop / bridge-restart / ocr-pick / summary-generate），原有 4 条命令保留；状态栏改为「抖音同步｜桥接状态｜同步进度」三段拼接。
- 2026-09-12：`data.json` 新增 `state.processManager` / `state.vision`（≤200 条）/ `state.summary`（≤200 条），沿用 `Object.assign` 兼容读取；「重置同步状态」不清空这三者（非同步数据）。
- 2026-09-12：新增设置项 `bridgeProcessEnabled` / `processAutoStart`（默认关）/ `processRefreshMs` / `ocrPanelEnabled` / `ocrBaseUrl` / `ocrApiKey` / `ocrModelPrimary` / `ocrModelFallback` / `ocrFallbackEnabled` / `summaryEnabled` / `summaryMaxTokens`；设置页新增「桥接进程管控 / 图片 OCR / AI 总结」三个分组，各组带实时二维状态行。
- 2026-09-12：待办——用户在 Obsidian 重载插件后验收；Agnes `data:base64` 支持性待真实 Key 实测（R-01）；Git 未提交改动需整理提交。

## Git 记录

- 第 1 次 git：`6c2da1db5e69a867d66fc37a6c837fadcf0c9457`，建立插件源码、构建产物和项目规则基线。
- 第 2 次 git：`5bc204042933a56417d53f7016016936a4e13a0b`，统一设置页与命令面板的桥接测试入口，升级至 1.0.1 并完成生产构建。
