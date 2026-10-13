# PROJECT_LOG

## 验证与运维记录（2026-10-01：分叉核对 + 桥接重启上线 + 文档对齐）

> **背景**：本会话（第四轮施工会话）上次收尾后，其他并发会话已推进第七~十二轮（processItem 拆分、相关笔记互链、摘要风格预设、三视角深审、配置数据完整性、纯度收口）。本次开工按惯例先核对分叉：main.js ×3 `e64dfc92…`、douyin-bridge.js ×5 `bcbf5623…`，与第十二轮记录**完全一致，无分叉**。

### 本轮动作（只读核验 + 运维 + 文档，未改任何源码）

1. **基线复验**：`tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误；`npm test` **448/448**；全部测试套件的 `runTests` 返回均为 getter 形态——第四轮修复的「异步断言计数丢失」未被后续新增套件回退（grep -L 全量核查）。
2. **第四轮修复存活核查**：`audioPullKind`/`mediaPullError`（素材错误分类）、`spawnErr`（spawn error 监听）、`probeSucceeded`/`probeInFlight`（档位试探单飞）、`modifyBinary`（0 字节残档覆盖写）、`cachedSatisfies`（pullAssets 按需缓存）、`scheduleReload`（桥接 reload 竞速）全部在位；consumePage 重复 id 防线被第九轮 A3 的 **in-flight Set 强版取代**（连并发启动竞态也防），属正常演进。曾计划的 backfill framesOk 收紧经重新评估**不再需要**：现行 `storedInterval>0` 豁免保护的正是 agent 巡检补记 interval 的 308 篇无帧存量笔记，收紧会造成它们每次补跑空转。
3. **桥接重启**：发现在线桥已退出（连接拒绝）。自 Vault 插件目录 detached 拉起 → 1s 就绪，`/ping` **带 `rss` 字段**——第十/十一轮的桥接加固（内存自保 / parked 恢复校验 / send 收口）首次真正在线。冒烟 5/5：真实 `/req`（listcollection）HTTP 200；带 Origin 403；伪造 Host 403；`/form-upload` 404（第四轮删除仍生效）；2MB 超限体 413。
4. **延后大手术前置复核**：`asrProvider` 仍为 `siliconflow_sensevoice`（未切回百炼）→ ASR 两阶段流水线维持延后；bridge.log 中 /req 均为零散请求（分钟级间隔、无排队证据）→ 桥接 page 池维持延后。
5. **ARCHITECTURE.md 对齐**（滞后第七~十二轮）：§四 state 形状重写（补 asrRetry / transcriptCache / backfillFails / metrics / processManager / vision / summary，settings 39→64 字段，pickSettingsSource 与 .bak 抢救链）；§3.11 摘要描述更新（v3 层级笔记体 + summary_style 三风格 + shouldDropToNextStep 降档；补跑 summary_v!=3 与 reextractFrames 意图）；新增「七之二」第七~十二轮架构级速览（含替代关系声明）。
6. **data.json 只读观测**（未触碰）：`asrProvider=siliconflow_sensevoice`、`videoSummaryModel=qwen3.8-flash`（GLM 通道）；`state.metrics` 100 条样本在、`lastPerfSummary` 空。

### 验证（2026-10-01 本轮）

- `npm test` 448/448；tsc 0 错误（未重新构建——源码零改动，部署态即第十二轮构建）。
- md5：main.js `e64dfc92…` ×3（仓库/Vault/dist plugin）、douyin-bridge.js `bcbf5623…` ×5（仓库/Vault/~/bin/dist bridge/dist plugin）全部一致。
- 桥接 `/ping`：`{"ok":true,"ready":true,"headed":false,"kernel":"playwright","rss":106553344,…}`；负向三项（Origin/Host/超限）+ /form-upload 404 全部符合预期。
- data.json 未触碰；Git 改动仍未提交（历轮累计）。
- **待用户验收**（历轮合并）：Obsidian 重载插件后生效。插件侧功能（互链/风格预设/消毒/撞库保护）需重载；桥接侧加固**已在线**（本次重启）。

## 改进落地记录（2026-10-01 第十三轮：真实运行数据驱动的审计 + 两项改进）

> **方法转型**：第九~十一轮已把代码审查视角反复扫过（建议清单多次清零），本轮改用**真实数据驱动**审计——只读观测 data.json 运行态（1110 条台账 / 100 条性能埋点 / 50 条摘要记录）、抽样 Vault 笔记（1110 篇）、研判 bridge.log，再用桥接对抖音端点做只读探测。开工前核验：无并发会话（09-29 后零文件变动）、`npm test` 448/448、严格 tsc 0 错误。

### 审计发现（全部只读取得）

1. **第 4~12 轮成果从未在真实同步中运行**：台账 lastSyncAt 停在 09-14、processed 1110 条全部无 `source` 字段、互链块与 summary_style 在 1116 篇笔记中零落地——用户尚未重载插件验收（运维项，非代码项）。
2. **收藏夹 API 已被抖音整体下线**（桥接实测 2026-10-01）：`/aweme/v1/web/collection/*` 子树对 GET/POST 一律 404 "Unsupported path(Janus)"（list / item/list / album/list / folder/list 等 8 个变体全灭）；`listcollection` / `favorite` / `post` 正常。生产日志佐证：09-26 起 `collection/list` 每次同步 404，收藏夹模式靠扁平兜底存活，但每轮同步都产出一条「收藏夹模式失败」error 纯噪音。
3. **摘要通道配额耗尽零熔断**（09-21 真实数据）：一次补跑 50 连发相同「Free quota exhausted」403——每条视频白打一次调用 + 逐条刷 error；更贵的是 needFrames 恒真，62 条视频为「无人消费的帧」白付全片下载 + ffmpeg（该批 metrics：ffmpeg p50 37.8s / p95 480s）。
4. 点赞同步端点已修好（当前 `aweme/favorite/?` 实测 200；09-26 日志的 404 是旧路径）；防护日志 REJECTED（evil host/origin）确认桥接加固在真实环境生效；v3 层级摘要笔记结构抽样完好；Media 1.4GB / 帧 15104 个 / Bases 4 个均健康。

### 改进（2 项，均数据驱动）

1. **收藏夹 API 下线优雅降级**：`douyinClient` 新增导出纯函数 `isFolderApiUnavailableError(msg)`（HTTP 404 / Unsupported path 判定）；syncAll 的收藏夹 catch 据此把 404 类失败从 `summary.errors` 降级为 `summary.notices`（文案注明「抖音 API 变更，已按扁平模式同步」）；网络/5xx 类失败维持 error 观感。设置页「按收藏夹建子目录」描述同步。**不改请求行为**——listFolders 照常先试，未来抖音恢复端点即自动回归文件夹模式。
2. **视频摘要配额熔断（会话级）**：`aiConfig` 新增导出纯函数 `isQuotaExhaustedError(msg)`（Free quota / AllocationQuota / FreeTierOnly / 欠费 / Arrears）；syncEngine 新增 `videoSummaryQuotaFails / videoSummaryQuotaDead` 两个会话级字段——连续 3 次配额类失败即熔断：`runVideoSummary` 入口直接跳过（不再逐条 403 + 刷 error），`resolveVideoAssets` 的 needFrames 一并抑制（帧没有消费方，不再为它付全片下载 + ffmpeg，与第十轮 summaryProtected 同型组合、复用逻辑兼容）；每次 syncAll / backfillVideos 开始时复位重新探测（配额可能已恢复，每轮最多付 3 次轻量 403 的探明成本）；成功即清零计数。

### 验证（第十三轮）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误；`npm run build` 0 错误。
- `npm test` **466/466**（448 → +18：`tests/round13-data.test.mjs`——两个判定函数各 10/8 断言，正样本全部取自真实错误文本、负样本覆盖 5xx/风控 403/网络超时/空值）。
- **部署**：main.js `8033d3b7…` ×3（仓库/Vault/dist plugin，176,930 B）；douyin-bridge.js 本轮未动，5 副本 `bcbf5623…` 一致、在线（/ping ready、rss 125MB 健康）；data.json 全程未触碰（md5 `ab9fda09…` 与第十二轮记录一致）。
- **待用户验收**（与 4~12 轮验收点合并）：重载插件后生效。验收观察点：① 同步完成提示中收藏夹 404 变为说明性 notice；② 若多模态配额仍耗尽，第 3 条视频后摘要/抽帧自动停止并出现熔断 notice。
- **端点考古记录**（供后续接手）：uifid 是客户端指纹 JS 生成（SSR HTML 无、固定 evaluate 模板读不到 localStorage），`/aweme/listcollection/folder/` 等新路径存在但被 Argus 以「Uifid Not Found」拦截——不走 Argus 签名攻防是本项目既定边界，收藏夹功能按 API 下线处理。

## 重构记录（2026-09-28 第十二轮：第十一轮产出的纯度与边界收口，行为契约不变）

> **范围**：仅第十一轮产出的代码——`src/settingsSanitize.ts`（主对象）、`src/main.ts` loadSettings 接线、`tests/round11-config.test.mjs`。statusCore `formatRss`（3 行、边界完备）与桥接 send 兜底（3 行，5 副本同步成本 > 收益）审阅后**刻意不动**；settings.ts 打码 8 处为单行赋值无可优化。用户约束：对外接口/错误码不变、零新依赖、不碰无关模块。

### 增补（同日 20:40，用户「继续」确认后实施上一轮建议项 1/2）

1. **删除死导出 `NUMERIC_RULE_FALLBACKS`**：全仓零引用（测试实际用的是 `fallbackMatchesDefaults`），删除后 main.js 175,601 → 175,563 B。
2. **数组收紧**：`isObjectLike` 加 `!Array.isArray(v)` 排除——数组（无论作为 data 整体还是 settings 值）一律按损坏处理：`needsBackupRescue({settings:[…]})` 由「不抢救」改判「抢救」；`pickSettingsSource` 对数组返回空来源，索引键不再可能混入合并结果。新增 4 断言锁定。

### 改动（3 文件 + 测试）

1. **settingsSanitize.ts 内部重构（导出签名全部不变）**：删除 `fieldOf` 闭包工厂（每次消毒为 10 字段创建 30 个函数对象，其存在理由「tsc 拒绝直转」实际一次 `as unknown as Record` 即可）→ 循环外单次收窄、直接 `box[key]` 读写；抽取 `coerceInt`（字符串只做一次 Number 解析，原判定+取整各一次）与 `clamp`（先下限后上限，与原逐分支语义逐字节等价）；`needsBackupRescue` 双重否定 `!(A&&B&&C)` 化为单条件 `!isObjectLike(settings)`（`s!==undefined` 分支被 typeof 检查覆盖，属冗余）；头注释补「对外契约」速查段。
2. **main.ts 合并来源守卫（新导出 `pickSettingsSource`）**：原 `data?.settings ?? data` 回退链在「settings 键损坏且 .bak 抢救也失败」时把整个 data 合并进 settings——`{settings:null,state:{…}}` 会把 state 整块、data 为截断字符串时把逐字符索引键混入 settings，并随下次 saveSettings 固化进 data.json。守卫规则：settings 是对象→用之；损坏→空来源（只用默认值）；无 settings 键（旧版扁平 data.json）→顶层即 settings（兼容保留）；data 非对象→空来源。**行为变化仅限上述异常路径**，正常/旧版扁平路径逐字节等价。
3. **测试**：`round11-config.test.mjs` 新增 pickSettingsSource 8 断言（同一引用/空来源三形态/旧版扁平兼容/端到端合并无混入键）。

### 验证（第十二轮，含增补后复跑）

- `tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误。
- `npm test` **448/448**（436 → +8 pickSettingsSource → +4 数组收紧）。
- `npm run build` 0 错误，main.js **175,563 B**；部署 ×3 md5 一致 `e64dfc92…`（仓库 / dist plugin / Vault plugin）。
- douyin-bridge.js 未动（`bcbf5623…`，与第十一轮一致）。
- **data.json 观测**：md5 由第十一轮记录的 `6c322858…` 变为 `ab9fda09…`——本会话全程只读未写；变化来自插件重载后 saveSettings 落盘（消毒结果固化的预期行为）或正常同步写台账，属运行期漂移非事故。

## 改进落地记录（2026-09-27 第十一轮：全新视角深审——配置数据完整性 / 声明与实现一致性）

> **范围**：第十轮复审批后建议清单再度清零，本轮换前十一轮未系统覆盖的视角：**data.json 异常数值与 UI 声明对齐**（历轮集中在故障恢复 / 测试盲区 / 资源泄漏）。开工前按并发纪律监控到第十轮复审批会话收敛（12:43 PROJECT_LOG 落笔），独立核验其基线：405/405、main.js `55c7f640…` ×3、桥 `a70952de…` ×5、data.json `6c322858…` 未动，全部吻合后开工。本轮审阅覆盖全部 24 个 src 模块 + 桥接 + 测试设施（只读通读）。

### 深审发现与修复（3 类共 5 项）

1. **C1（P2）数值设置零消毒**：设置页 onChange 只消毒键盘输入；data.json 手改 / 外部工具写入的非法数值原样进入运行时。危害链以 `maxTranscribePerSync=NaN` 最重——syncAll 里 `asrBudgetLeft = Math.max(0, NaN) = NaN`，transcribeVideo 的 `NaN <= 0` 恒 false → **转写预算（计费保护）静默失效**（首次全量同步可一次性烧几百条转写费）；retryPendingAsr 的 `slice(0, NaN)` 返回空数组 → **重试队列被静默清空**；backfillVideos 的 budget=NaN 使「预算 0 语义」与 REUSE_ONLY_CAP 双双失效。**修复**：新增 `src/settingsSanitize.ts`（纯函数 Node 可测）——`sanitizeNumericSettings` 就地消毒 10 个数值字段（syncIntervalMinutes / maxTranscribePerSync / scanStopAfterProcessed / syncConcurrency / keyframeIntervalSec / maxImages / visionConcurrency / relatedNotesMax / summaryMaxTokens / processRefreshMs），口径与设置页各 onChange 逐项一致；判定必须是「值本身是数字/数字字符串」而非直接 `Number(raw)`（Number(null)/Number(false)/Number("") 都得 0，会把字段缺失变成合法的 0——如 keyframeIntervalSec=null → 1s 逐秒抽帧、预算 null → 恒禁用）。接线在 loadSettings 读取入口。
2. **C2（P3）备份抢救条件漏半损坏形态**：原 `!data || (!data.settings && !data.state)` ——「state 完整但 settings 键丢失/为 null/为字符串」时不触发 .bak 抢救，Cookie 与全部 Key 静默回默认（等于配置归零），而 bak 里明明有完整 settings。**修复**：`needsBackupRescue`（同模块纯函数）改为「settings 不是非空对象即抢救」；settings={} 视为存在。
3. **C3（P3）面板 /ping 行未显示 rss**：第十轮 P2-1 给 /ping 加了 rss 字节并声明「管理面板可直接观察」，但 panelView.refreshPingDetail 只显示 kernel/ready/headed——声明未落地。**修复**：statusCore 新增 `formatRss` 纯函数（字节 → MB 一位小数，非法/缺失返回 "—"，旧桥兼容），/ping 行补 `rss=…` 段。
4. **C4（P3）敏感输入明文显示**：8 个凭据输入框中仅 visionApiKey 打了 password（历史先例），Cookie / siliconflowKey / dashscopeKey / aiKey / videoSummaryApiKey / ocrApiKey / volcToken / tencentSecretKey 均明文——共享屏幕 / 录屏即泄露。**修复**：8 处统一 `inputEl.type = "password"`（粘贴不受影响）。
5. **C5（P3）桥接 send 无统一异常兜底**：客户端在响应窗口断开时 writeHead/end 可能同步抛（ERR_HTTP_HEADERS_SENT / ERR_STREAM_DESTROYED）——调用点只有部分包了 try（/download 错误路径有、/req 成功路径与 /ping 没有），异常会以 uncaught exception 崩掉常驻桥进程（同步全停）。**修复**：douyin-bridge.js 的 send 收口内部 try（一处覆盖全部调用点）。

### 审阅确认健壮（本轮新覆盖面的一句话核实）

- main.ts runSync 无 try/catch 不成立为缺陷：syncAll 主体 catch-all 返回 summary 并落盘，唯一可抛点（running 短路）已有前置守卫；onunload 时序（flushNow → dispose）与三类防抖收口完整。
- 桥接 a70952de 的 parked 恢复（复审批 1）推演自洽：恢复失败保持 pageParked=true 且本次 500，下轮重新导航；launchBrowser 统一复位覆盖全部重建路径。
- 各 ASR provider 顶层异常兜底、轮询网络容忍计数、TC3 签名动态 Host、OSS multipart 上传、qwen3 显式 300s 超时——均无发现。
- noteBuilder/statusCore 的 BOM/畸形 frontmatter/callout 所有权/calloutLine 转义四件套——无发现。

### 验证（第十一轮）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误；`node --check douyin-bridge.js` 通过。
- `npm test` **436/436**（405 → +31：`tests/round11-config.test.mjs`——消毒 16 断言含 Number(null/false/"") 三陷阱与「就地修改/合法保留/fallback 与 DEFAULT_SETTINGS 同步」契约，抢救判定 10 断言含 settings=null/字符串/{}/仅 state 四形态，formatRss 5 断言）。
- `npm run build` 0 错误，main.js 174,195 → **175,568 B**。
- **部署**：main.js `fe4d33a2…` ×3（仓库/Vault/dist plugin）、douyin-bridge.js `bcbf5623…` ×5（仓库/Vault/~/bin/dist bridge/dist plugin）全部一致；data.json 全程未触碰（md5 `6c322858…`）。
- **待用户验收**（与第十轮/复审批验收点合并）：重载插件 + 重启桥接后生效。本轮桥接改动仅 send 兜底（无行为变化）；面板 rss 行与设置页打码重载即可见；消毒对正常 data.json 无感（合法值原样保留）。
- **说明**：C1 消毒在 loadSettings 入口执行但**不回写 data.json**——下次 saveSettings 全量落盘时自然固化；不引入启动期写入（遵守「data.json 一律不碰」的外部写纪律，此处为插件自身行为）。

## 改进落地记录（2026-09-27 第十轮复审批：并发会话监督 + 独立复核 + 4 项加固）

> **背景**：本会话按第九轮复审批记忆开工，核对 md5 全一致（main.js `891657af…` ×3、桥 `cd5a604a…` ×5、data.json `6c322858…`），但 11:25 发现 `tests/round10-adversarial.test.mjs` 等新文件——**又一并发会话正在实时施工第十轮**（11:23–12:15 编辑 src 8 文件 + 测试两文件 + 桥接，期间测试基线从 318 → 381 → 394 漂移）。本会话全程未并行编辑，监控至其收敛（源码停手 + main.js 重建 + PROJECT_LOG 第十轮章节落笔 12:15）后开始只读复核。

### 独立复核结论（第十轮 F1-F7 / 74 断言 / 桥接内存自保 逐站点推演）

- **高风险站点核实无误**：F1 撞库逐字稿回收（提取口径与 extractSummarySources 一致、fmVal 引号无关、asrOverride 不再进暂存污染 provider——transcribeVideo 对 override 提前返回）、F2 首门位置（runVideoSummary 最前，不浪费调用）、F3 内存合并一次落盘、F5 魔数校验+写后核对（stat.size 即便延迟也只多一次幂等覆盖）、F6 running 置位 finally 复位、P3-3 reqViaBridge 180s 超时、桥接巡检（判定在 enqueue 外、动手在 enqueue 内，与请求串行不互踩；RSS 重建走 waitLaunchSettled+close+launchOnce 与 C1 一致）、`/ping` rss 字段。部署声明独立验证属实（394/394、md5 ×3/×5、data.json 未动）。
- **对抗测试质量抽查**：PM C5 双拉起（败者 PID 4242 不盖台账 / 监听者 999 胜者语义）与 dispose 身份校验（PID 复用防误杀）用例构造真实，变异声明可信。

### 复审批加固（4 项，`tests/round10-review.test.mjs` +11 断言）

1. **桥接 parked 恢复死循环**（douyin-bridge.js ensurePageAlive，「复审批 1」）：原实现 `pageParked=false` 先行置位、恢复 goto 失败被 `.catch(()=>{})` 吞掉——此后 about:blank 上的探活（`1+1` 纯 JS）永远通过而页面内 fetch 相对 URL 永远失败（-1 → 重试再 -1），**桥对后续所有请求持续失败直到重启**。修复：goto 后校验 `page.url()` 仍在 douyin 域，失败保持 `pageParked=true` 并抛错（本次请求 500，下轮请求重新尝试导航）；配套 launchBrowser 末尾统一复位 pageParked（原仅 RSS 巡检分支手动置回，探活失败/403 重试两条重建路径漏复位）。
2. **F7 击穿 B3 暂存保护**（syncEngine peekStashedTranscript，「复审批 2」）：paraformer 通道成功结果的 provider 是子模型名（`paraformer-v2` / 兜底链 `fun-asr-mtl`，dashscope.ts collectResult 的 `provider: model ?? this.name`），与 `want="dashscope_paraformer"` 严格不等且无前缀规则——F7 把该通道所有暂存条目判不匹配删除、下轮重新计费，恰是 B3 要防的对侧（F7 之前暂存有效）。修复：`want === "dashscope_paraformer"` 时加 `/^(paraformer|fun-asr)/i` 前缀识别（对侧锁：want=siliconflow 时 paraformer 子名仍不命中）。
3. **F4 备份非原子 + 失败冻结**（main.ts maybeBackupData/loadSettings，「复审批 3」）：`adapter.copy` 直接覆盖旧备份——copy 中段被杀（与主文件写坏是独立事件，可叠加）会把**唯一的好备份**变半截，抢救通道整体失效。修复：copy 先落 `data.json.bak.tmp` 再 remove+rename（同目录元数据操作）；`lastBakAt` 改成功后记账（原 copy 前置位，失败后 10 分钟不重试）；loadSettings 抢救候选加 `.bak.tmp` 兜底（换名窗口被杀的中间态，半截 tmp 由 JSON.parse 自然拦下）。
4. **撞库恢复帧白抽 + 保护面漏暂存路**（syncEngine processItem/resolveVideoAssets，「复审批 4」）：① keepExistingSummary=true 时摘要被阶段 9 跳过，但阶段 3 的 needFrames 恒真——无帧笔记（403 条撞库恢复里的多数）仍白跑一次全片下载 + ffmpeg 抽帧，成果又被跳过丢掉；② B3 暂存命中 + 撞库到已有 v3 摘要的完整笔记（转写成功→写笔记失败→暂存→重置台账→撞库）不在保护面——摘要被现生成版本覆盖。修复：`transcriptFromNote` 泛化为 `asrReused`（笔记旧稿 ‖ 暂存命中两路复用统一计数）并作为 keepExistingSummary 唯一转录来源条件；keepExistingSummary 透传 resolveVideoAssets 新参 `summaryProtected` 抑制 needFrames（摘要不重出时帧无消费方；reused 帧回填不受影响，帧块仍原样写回）。

### 验证（第十轮复审批）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误；`node --check douyin-bridge.js` 通过。
- `npm test` **405/405**（394 → +11：`tests/round10-review.test.mjs`——F7 前缀 5 断言含对侧、needFrames 抑制 3 断言含对侧（v2 重出时帧路照常拉）、暂存命中撞库 3 断言）。
- `npm run build` 0 错误，main.js 173,879 → **174,195 B**。
- **部署**：main.js `55c7f640…` ×3（仓库/Vault/dist plugin）、douyin-bridge.js `a70952de…` ×5（仓库/Vault/~/bin/dist bridge/dist plugin）全部一致；data.json 全程未触碰（md5 `6c322858…`）。
- **待用户验收**（与第十轮验收点合并）：重载插件 + 重启桥接后生效。本轮桥接改动在 parked 恢复与重建复位，挂机过夜场景重启桥接后自保链路才完整生效。

## 改进落地记录（2026-09-27 第十轮：全新三视角深审——故障恢复一致性 / 对抗测试盲区 / 资源泄漏性能）

> **范围**：第九轮后建议清单再度清零，本轮换三个前九轮未覆盖的视角并行深审（A 故障恢复与数据一致性 / B 测试盲区对抗分析 / C 资源泄漏与性能）。开工前核对 md5 与第九轮复审批记录一致（main.js `891657af…` ×3、桥 `cd5a604a…` ×5、data.json `6c322858…`），基线 318/318。**插曲**：深审 C 代理违反只读指令执行了 build+部署（main.js 变为 `891657af`——内容为当时 F1-F7 修复后的代码，tsc/测试均过，data.json 与桥未触碰）；随后被本轮正式构建覆盖，无实际损害。

### 深审 A（故障恢复与数据一致性）：修复 2 P1 + 2 P2 + 3 P3

1. **F1（P1）撞库恢复不复用笔记既有逐字稿**：「重置同步状态→立即同步」这条普通维护链会把约 400 条视频全部当 fresh——预算内条目（每轮 20 条）重新下载全片+重复计费 ASR，预算外条目被 asr=null 的 buildNote **降级重写**（逐字稿块删除、transcript_status 退回 not_requested）。第九轮 B3 暂存只覆盖「转写成功但写笔记失败」的崩溃窗口（成功落账即清），对早已成功同步的笔记必然为空。**修复**：collectExistingAssets 增加 transcript/transcript_provider/transcript_status 提取（复用 extractSummarySources 口径）；processItem 的撞库分支（collided 标记）在暂存未命中且笔记 transcript_status=success 且逐字稿非空时构造 asrOverride——与 backfillVideos 同口径，needAudio 随之为 false。只对撞库路径生效，backfill 的显式重出自愈意图（A8）不被劫持。
2. **F2（P1）撞库路径无条件重出摘要**：阶段 9 无「已有摘要」门，台账丢失重同步会把 328 篇 Agent 亲写层级摘要整批替换成现生成版本（付费+质量不可控，预算外条目还被纯帧摘要覆盖）。**修复**：processItem 增加 keepExistingSummary（transcript 来自笔记旧稿 && reused.summaryText 非空 && summaryV==SUMMARY_V）——runVideoSummary 首门跳过；SUMMARY_V 从 videoSummaryService 导出。旧格式（v<3）摘要不被保护，仍按补跑口径升级重出。
3. **F3（P2）writeItemNote 两段写非原子**：覆盖写（无摘要）与摘要回填之间崩溃，磁盘旧摘要被抹掉仅存内存——视频可靠补跑自愈，图文摘要永久丢失。**修复**：applySummaryToNote 在写盘前对 buildNote 内容字符串直接变换，一次 vault 调用落盘（回填失败仍不影响主流程，保持原容错语义）。
4. **F4（P2）data.json 全量非原子写**：断电/强杀落在写入窗口（30s 节流 ×700KB）可截断台账文件——历史事故前科。**修复**：saveSettings 成功后 ≥10 分钟把 data.json 复制为同目录 data.json.bak（adapter.copy）；loadSettings 主文件损坏/为空时从 .bak 抢救并 Notice 提示。main.js 代码自身行为，不涉及外部写 data.json。
5. **F5（P3）saveImage 幂等判据漏非 0 截断残档**：写入中段崩溃留下的截断 JPEG 通过 size>0 检查永久定格为坏图。**修复**：命中已存在文件时增加头部魔数校验（jpg/png/webp/gif，失配即重下）；写盘后回读 stat.size 与期望字节比对，不符覆盖重写一次。帧路的字节数比对做法对齐（videoMedia.ts ingestFrames）。
6. **F6（P3）refreshAllRelatedNotes 不置 running**：可双击并发跑两轮全库写盘、也可与随后的 syncAll/backfill 交错。**修复**：进入置位 + try/finally 复位（与 backfillVideos 同款）。
7. **F7（P3）transcriptCache 不校验供应商变更**：切换 ASR 供应商后旧供应商暂存抢先落账，该条目永不按新供应商重转（连 resetState 都绕不开）。**修复**：peekStashedTranscript 校验 e.provider 与 settings.asrProvider 一致（dashscope_qwen3 按子模型名前缀 qwen3* 识别），不一致即删除暂存宁可重付一次。round9 的 B3 用例 provider 字段（"SenseVoice"）同步改为真实 provider 名，并新增 F7 锁定用例。

深审 A 确认健壮的链路：写点原子性（vault.process/createBinary）、台账-笔记双向漂移三入口不复活、桥接死亡恢复与 statusHub 终态收敛、syncAll/backfill 重入保护与 running 复位、flushState 串行化与失败重标脏、设置中途变更语义（AI 通道下轮生效 / ASR 逐条实时）——均在报告中一句话核实，无发现。

### 深审 B（测试盲区对抗分析）：18 缺口 → 74 断言落地

- **方法**：对照 307→318 基线测试与源码，产出 18 个「关键分支零覆盖/弱覆盖」清单；草稿在临时目录验证（63/63 断言过 + **7 项源码变异全部被捕获**——逐项回退被守护的修复确认测试能红），随后落地为 `tests/round10-adversarial.test.mjs`（+ `tests/entry.ts` 导出 ProcessManager——项目内首个 PM 用例）。
- **覆盖的缺口**：backfillVideos A11 预算 0 语义 + REUSE_ONLY_CAP 50 上限、A8 空逐字稿不盖章、loadState asrRetry 形状消毒（第六轮历史真实 bug 回归锁）、B1 降档端到端消费链（含 summary_style 落盘）、stripBom 四件套、转写暂存 FIFO 20 淘汰、network 类素材失败入重试队列（确定性失败的对侧）、assertCookie 桥接跳过（C3）、listFolders 循环翻页聚合 + 双键回退 + 50 页上限、OCR 通道集成（enableVision）、收藏夹模式 syncAll（白名单 + folderOk 语义）、writeAsrErrorNote A7 多行压行 + 块尾边界、buildNote 特殊字符标题 YAML 注入往返、**processManager C5 双拉起败者 PID 校验 + dispose 身份校验（防 Windows PID 复用误杀无关进程树——全仓最危险的强杀路径首次有测试）**。
- 另有 3 个缺口经评估不落草稿（douyinClient 档位单飞的模块级状态需进程隔离、retryPendingAsr B3 暂存命中路径、collectExistingAssets 行首图片回收面——属产品决策），记录在案。

### 深审 C（资源泄漏与性能）：修复 1 P2 + 3 P3（全部发现均实测验证）

1. **P2-1 桥接 Chromium 页面无内存自保**：重 SPA 页面堆随挂机时长增长（数日可达 GB 级），此前只在出错时重建。**修复**（douyin-bridge.js）：① `/ping` 附带 rss（管理面板可直接观察）；② 空闲自保——60s 巡检，空闲 ≥10 分钟把页面导航到 about:blank 释放站点堆（pageParked 标记，ensurePageAlive 先恢复导航再请求，两道均经 enqueue 串行与请求互斥）；③ RSS ≥800MB 走 waitLaunchSettled+ctx.close+launchOnce 整重建。与「page 池延后立项」不冲突。
2. **P3-2 临时目录懒清理无兜底**（实测 %TEMP%\douyin-sync 残留 15 目录/14MB/14 天）：清理触发点从「首次素材拉取」提前到插件 onload（videoMedia.clearTempRoot 公开 + engine.cleanupTempRoot 薄封装 + main.ts onload 调用；tmpDir 保留幂等兜底）。
3. **P3-3 /req 插件端无显式超时**（默认 ~30s vs 桥端最坏 ~160s 恢复周期，先超时会触发无谓 spawnBridge 探测+同 URL 重复入队）：reqViaBridge 显式 timeout 180s（类型断言同 ai.ts 先例）。
4. **P3-4 /download 页面内单字符串累积 base64**（大文件使 page 堆瞬时 GB 级）：上限 200MB 收紧为 64MB（端点本为诊断保留，C13 口径不变，64MB 对诊断足够、堆峰值约 200MB 可承受）。
5. 深审 C 确认健壮：事件/定时器生命周期全链路（onunload 清理齐备）、state 全部增长结构封顶生效（实测 data.json 347KB/processed 1110 条）、单次 syncAll 内存峰值有 14MB 帧上限封顶、onload 无重活、ffmpeg 超时 kill + finally 清理、桥接日志轮转——无发现。

### 验证（第十轮）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误。
- `npm test` **394/394**（318 → +76：round10-adversarial 74 断言 + round9 B3 用例修正/新增 F7 对侧 2 断言）。
- `npm run build` 0 错误，main.js 171,580 → **173,879 B**。
- **部署**：main.js `269bae0b…` ×3（仓库/Vault/dist plugin）、douyin-bridge.js `fc67b6ff…` ×5（仓库/Vault/~/bin/dist bridge/dist plugin）全部一致；data.json 全程未触碰（md5 `6c322858…`）。
- **待用户重载插件 + 重启桥接验收**：本轮动了桥接（内存自保 + 413/下载上限），在线桥仍是旧代码；F1/F2 的实际收益在「重置同步状态」场景验收时可见（重置后重同步：已同步笔记应原样跳过重建消耗，逐字稿/摘要保留）。
- **修正第九轮复审批声明**：「resetState 保留 transcriptCache——重置台账后重同步不再对已付费转录重复计费」仅在崩溃窗口内未落账的暂存上成立；已落账条目（暂存早清、逐字稿在笔记里）此前会被重复计费/降级重写，第十轮 F1 才补全该链路。


## 改进落地记录（2026-09-27 第九轮复审批：并发会话监督 + 独立复核 + 2 项加固）

> **背景**：本会话开工时按第八轮记忆核对 md5 全一致，但测试基线异常（sync-engine processItem 段失败）——排查发现**另一并发会话正在实时施工第九轮**（09:38–10:15 编辑 src 7 文件 + 新增 `tests/round9-fixes.test.mjs`，期间出现过 `budget` 重复声明的瞬时编译错误）。本会话全程**未与其并行编辑**：监控至其收敛（源码停手 5 分钟 + PROJECT_LOG 第九轮章节落笔）后，才做只读复核与小幅加固。

### 独立复核结论（第九轮 3 P1 + 12 P2 + 16 P3 逐站点审查）

- **高风险站点全部核实无误**：A1（frame_interval 真实间隔 + reextract 重抽意图，六种 needAudio/needFrames/hint/reextract 组合矩阵推演自洽）、A2（撞库回收与台账/在飞/inflight 三重判重交互）、A3（in-flight Set 登记先于 await、页间串行无跨页竞态）、B3（转写暂存：命中不扣预算/不重复计费、finalize 清除、resetState 保留——「重置台账后重同步」不再对已付费转录重复计费）、A5（有头无尾保守识别，代价已文档化）、A6（删除尊重 + douyin_id 兜底；noteIndex 只建台账索引，每条新条目的兜底扫描为内存操作，600 篇库量级可接受）、B1（shouldDropToNextStep 边界正确）、C1/C12（桥接：串行队列下无并发 403 竞态；finish 后再断不丢 413）、C15（三态探测只杀自己的子进程，60s 硬上限）、C5（败者不再污染台账 PID）。
- **部署独立验证**：main.js ×3、桥接 ×5、data.json `6c322858…` 未动、`npm test` 307/307——与第九轮记录完全一致。

### 复审批加固（2 项）

1. **transcriptCache 条目形状消毒**（syncEngine loadState，「复审批 1」）：第九轮 B3 新增的转写暂存只有顶层 `isPlainObject` 校验，手改 data.json 出的条目级脏值（transcript 非字符串）会穿过 `peekStashedTranscript` 的真值检查流进 asrOverride → buildNote 渲染出非文本内容。与 asrRetry（第六轮）同口径逐条消毒：transcript 非非空字符串的条目直接丢弃（宁可下轮重新计费，不把脏值当已付费转录复用）；provider 非字符串归一空串、at 不可解析归一 epoch（FIFO 排序仍确定）。新增 `tests/round9-review.test.mjs` 11 用例（有效保留/七类脏值/顶层错位/缺省字段）。
2. **桥接启动超时文案报实际等待时长**（main.ts，「复审批 2」）：C15 三态探测下慢启动会等满 60s，原文案写死「15s」误导排查。改为 `等了 Ns`（实际秒数），上限说明保留。

### 验证（第九轮复审批）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误。
- `npm test` **318/318**（307 → +11：`tests/round9-review.test.mjs`）。
- `npm run build` 0 错误，main.js 171,123 → **171,580 B**（+457 B）。
- **部署**：main.js `891657af…` ×3（仓库/Vault/dist plugin）一致；桥接未改动，5 副本 `cd5a604a…` 一致；data.json 全程未触碰（md5 `6c322858…`）。
- 待用户重载插件验收（与第九轮验收点合并：重启桥接后 C1/C12 生效）。

## 改进落地记录（2026-09-27 第九轮：三路独立深审 3 P1 + 12 P2 + 16 P3——后续建议清单清零后的全新深审）

> **范围**：第八轮后建议清单已清零，本轮从零发起新一轮三路并行深审（syncEngine 正确性 / 媒体 ASR AI 管线 / 基础设施与 UI，三个独立代理逐行精读 28 个源文件），共产出 40+ 条发现，去重核实后全部亲自复核源码确认。修复 3 P1 + 12 P2 + 16 P3，明确不做 9 项（理由见文末）。开工前核对：main.js ×3 `d623b2fc…`、桥接 ×5 `5021d399…`、data.json `6c322858…`，与第八轮记录全一致，无并发分叉。

### P1（3 项）

1. **frame_interval 盖章 + 补跑重抽意图被劫持**（A1，syncEngine）：改抽帧间隔后，transcriptOk 的笔记在补跑里被 `reused.framePaths` 无条件劫持——旧帧原样复用、一次 ffmpeg 都不跑，且 `frame_interval` 被**盖章成当前设置**而非帧的真实间隔 → 下一轮 `framesOk` 恒真、永久 skipped，「补帧/改间隔」对其主要目标群体静默失效。修复三件套：① `resolveVideoAssets` 随返回值携带**本次帧的真实间隔**（backfill frameHint = 当前设置；reused 帧 = 笔记 frontmatter 记录值 `ReusedNoteAssets.frameInterval`——该字段第八轮就已收集但从未被消费），`writeItemNote` 用它写 `frame_interval`；② `processItem`/`BackfillJob` 新增 **reextractFrames 显式重抽意图**，framesOk=false 的补跑候选传 true，禁止 reused 帧劫持（needAudio/needFrames 全 false 时仍回退复用，保住笔记里的帧块不被清空）；③ 无帧不盖章语义不变。
2. **帧数降档循环对「短视频 × 低图片上限模型」完全失效**（B1，videoSummaryService）：break 条件 `framePaths.length <= n` 在总帧数 ≤ 首档 8 时第一步就命中——6 帧视频 × glm-4v-flash（上限恰 5 张）摘要永久失败（每轮 301002）。新导出纯函数 `shouldDropToNextStep(总帧数, 当前档, 下一档)`：仅当「下一档真的能减少送出图数」才继续，5/2/1 档可达。
3. **桥接 403→headed 重试被单飞吞掉 + 整桥 exit(1)**（C1，douyin-bridge.js）：启动窗口内（listen 已就绪、初始 headless launch 在飞）首个 /req 拿到 403 时，`launchOnce(true)` 命中单飞返回的仍是 headless 的在飞 promise，而上方 `ctx.close()` 会让它中途 reject——拒绝沿启动 IIFE 扩散成 `process.exit(1)`，插件侧表现为间歇性「15s 启动超时」。新增 `waitLaunchSettled()`（等在飞单飞落定再关旧上下文），apiFetch 403 分支与 ensurePageAlive 重建分支两处接线。

### P2（12 项）

- **A2 全新撞库覆盖丢资产**（syncEngine）：节流落盘窗口内崩溃 / 重置台账后重同步时，全新路径撞上已存在笔记会 buildNote 全量覆盖——用户编辑与已付费摘要一并丢失。修复：processItem 开头 `findNotePath(id)` 现场定位（台账丢失时按文件名后缀命中），命中即与重试路径共用同一套资产回收（`collectReusedAssets` 门控放宽为只看 overwritePath）：封面/图片/OCR/分类/帧/摘要回填全部复用。
- **A3 同页重复 id 并发双跑**（syncEngine）：并发 ≥2 时「先到者写台账」的时序保证不成立 → 双重 ASR 计费。consumePage 改 in-flight Set：入队即登记、结束解除，检查改为「台账 ‖ 在飞」。
- **B3 转写成功但写笔记失败 = 白花一次 ASR 钱**（syncEngine/types）：失败路径已付费转录只存在内存，下轮全新重跑重新计费；重试路径更糟——同一份转录反复重试到 dead-letter。新增 `state.transcriptCache`（FIFO ≤20 条，loadState 形状消毒、resetState 保留、finalizeProcessed 清除）：转写成功即暂存，processItem/retryPendingAsr 命中暂存直接当 asrOverride 用（needAudio 随之为 false，连音频拉取都省掉）。
- **B4 ingestFrames adapter 直写绕过 Vault 封装**（videoMedia）：改 `vault.modifyBinary`，TFile.stat.size 不再失真。
- **C2 statusHub 不感知 bridgeEnabled + 每次启动必弹 E1**：直连模式 probe() 早退（不再 ping 桥接端口、不再产生异常提示）；E1 降噪——进程态非 running 时「桥接进程未运行」是预期状态不弹窗（默认配置 autoStart=false 每次启动弹 10s P0 的老毛病根治），仅「先前在跑、探测发现没了」或端口被占（E2）才提示。
- **C3 assertCookie 与设置页文案打架**（douyinClient）：桥接模式下 `/req` 由浏览器上下文自带登录态，插件 Cookie 不参与；照设置页说明（桥接模式不填 Cookie）操作的用户会被硬报缺 sessionid。`assertCookie` 桥接模式直接跳过，报错文案同步。
- **C4 引擎路径 spawn 诊断黑洞**（main.ts）：`stdio:"ignore"` + 无 exit 监听，缺脚本/缺依赖时空等 15s 后给通用报错。照 PM 路径同款：stderr 管道收尾巴 + exit 监听提前止损，报错带 stderr 尾巴与脚本路径。
- **C5 双拉起台账写死 PID**（processManager）：与引擎路径并发双拉起时败者 EADDRINUSE 秒退、胜者 /ping ready 让两条路径都判成功，PM 会把自己已退出的子进程 PID 盖进台账。startInner 写台账前 `findPidsByPort()` 校验 childPid 仍是端口监听者。
- **C6 scanStopAfterProcessed 钳制与 0=禁用语义冲突**（settings）：UI 钳 `n>=20` 且手改 0 后敲任何字符被静默改回 100。改 `n>=0`，描述注明「0 = 禁用提前停止」。
- **C15 引擎路径 15s 超时杀健康慢启动桥**（main.ts）：原二值化 ready 判定下，慢机器 Chromium 启动超 15s 的桥会被 taskkill（PM 路径有 45s 原地等待、引擎路径没有）。改三态探测（ready/starting/down）：starting 延长等待（硬上限 60s，与 PM 对齐）而非计失败并杀桥。
- **C12 readBody 413 吞响应**（douyin-bridge.js）：send 与 req.destroy 共享同一 socket，立即 destroy 可能抢在 413 flush 前。改 pause + `res.on("finish")` 后再断。
- **B10 手改 data.json 非数字 summaryMaxTokens 产生 max_tokens:null**（videoSummaryService）：设置页只在 UI onChange 消毒，消费端 `Number.isFinite` 兜底（回退 500）。

### P3（16 项）

- **A4** 同步路径 `writeRelatedBlock` 无变化不写盘（与 refresh 同口径——内容不变时 vault.process 也重写文件，mtime 每轮跳动污染「最近7天」视图与同步/备份变更检测）。
- **A5** `applyRelatedToNote`「有头无尾」从清到 EOF 改为**按块形态保守识别**（标记行 + `## 相关笔记` + 连续 `- [[…]]` 列表行），遇到第一个非块形态内容即止——全仓唯一会吞用户正文的路径消除；块形态残留仍正常重建。round8 对应用例同步改写（「残留内容」保留断言 + 新增块形态残留/幂等两用例）。
- **A6** 重试路径不再复活用户已删除的笔记：findNotePath 扑空且旧路径文件不存在 → 结清重试队列（保留 processed 台账防下轮重建）。**配套**：findNotePath 新增 ③ douyin_id frontmatter 兜底（用户改名笔记仍能定位，不误判删除）；retryPendingAsr 相关旧测试补建真实笔记文件。
- **A7+B8** `writeAsrErrorNote`：错误文本压成一行（多行错误破 callout 结构）+ read→modify 改 `vault.process` 原子写（与全仓写点口径一致）。
- **A8** backfill 对「transcript_status: success 但逐字稿为空」的笔记不再盖章 success（frontmatter success + 正文空块的自相矛盾会让补跑终态判定恒真、永久化），回退 undefined 走正常转写自愈。
- **A9** statusCore 全部 7 处 frontmatter 闭合围栏判定从 `trim()==="---"` 改为**列 0 行首** `/^---\s*$/`（YAML 口径；多行块标量值里手改出的缩进 `  ---` 不再误判闭合、summary 不再插进 YAML 中段）。新增 `isFenceClose` 内部辅助。
- **A11** backfill 预算 0 语义与同步路径对齐：0 = 不再转写，只补「可复用已有转录」的免费候选（上限 50 条）；budget>0 时行为不变（总候选 ≤ budget）。
- **A12** `refreshAllRelatedNotes` 加互链开关守卫 + running 互斥；命令入口对关闭状态给明确提示。
- **B6** `saveImage` 429 并入重试（原只重试 5xx；瞬时限流会定格为永久缺图）。
- **B7** needAudio 时不再丢弃完好帧网格：pullAssets 的帧路按需裁剪（wantFrames:false），帧从 hint 回填——「转录缺失但帧完好」的补跑免一次全片解码 + JPEG 编码。
- **B5** dashscope OSS 上传注释如实描述（原「峰值减半」与代码不符；真正减半需分片流式上传，requestUrl 不支持，维持现状）。
- **C10** 管理面板「端口」行改「桥接地址」（原显示完整 URL 名不副实）；操作成功后清掉上一次残留的错误内联文案。
- **C11** 设置页「定时同步间隔」与「状态刷新间隔」的 restart 副作用进 600ms 防抖（后者原每键烧一次 /ping）；hide() 收口立即应用、onunload 丢弃（新增 `cancelPendingEffect`）。

### 明确不做（含理由）

- **A10**（重建计入 summary.created 口径）**A13**（并发互链短暂单向，refresh 命令自愈）：影响仅展示/瞬时，改动引入的复杂度不值。
- **B9**（火山引擎 token 走查询串）：需对照官方文档确认 header 鉴权可行性，动 ASR 通道风险大于收益，留待下次接触火山通道时一并处理。
- **C7**（stop 在 spawn 窗口内的孤儿窗口）：与 C5 同根，C5 修复 + taskkill 指纹兜底已覆盖现实路径。
- **C8**（onunload 异步清理链在整体退出时可能截断）：已知结构性限制，优雅退出 POST /shutdown 已排最前。
- **C9**（桥 ready 判据过早）：刻意权衡——ready 提前翻转让插件能等慢启动桥（本轮 C15 进一步强化），改为 goto 后置位会引入「能用的桥被判启动失败」的新问题。
- **C13**（/download 端点仓库内无调用方）：保留（外部手工调用可能存在），1MB 限入 + C12 修复已覆盖。
- **C14**（PowerShell CIM 指纹查询 8s 超时缓存）：窄场景，宁可放过设计已声明。
- **C16**（aweme_type=150 未收录进 IMAGE_AWEME_TYPES）：注释自述与实现不一致，但需抓一条 150 的真实响应验证 images 字段形态，留待下次抓包顺带核实。

### 验证（第九轮）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误。
- `npm test` **307/307**（270 → +37：`tests/round9-fixes.test.mjs` 新套件——shouldDropToNextStep 七断言、A9 围栏三态、引擎级 A1 三路径（重抽意图不复用旧帧/复用帧真实间隔 30/B7 帧路裁剪回填）、writeItemNote 间隔落盘两态、A2 撞库摘要+分类回收、B3 暂存复用与清除、A3 同页重复 id 单跑、A6 已删笔记结清且不重建、findNotePath douyin_id 兜底（改名找回/删除为 null）、A4 二次写入 0 落盘、A12 双守卫）；round8「有头无尾」用例按 A5 新行为改写（+2 用例）；sync-engine 的 retryPendingAsr 组按 A6 补建真实笔记文件（4 处）。
- `npm run build` 0 错误，main.js 166,990 → **171,123 B**（+4,133 B）。
- **部署**：main.js `3e67404d…` ×3（仓库/Vault/dist plugin）一致；douyin-bridge.js `cd5a604a…` ×5（仓库/Vault/~/bin/dist bridge/dist plugin）一致（**本轮动了桥接**，在线桥仍是旧代码，重启桥接/重载插件后生效）；data.json 全程未触碰（md5 `6c322858…` 与第八轮一致）。
- 新桥 `node --check` 语法通过。
- 待用户在 Obsidian 重载插件并重启桥接后验收：①桥接启动期不再偶发「15s 启动超时」；②启动时不再弹「桥接进程未运行」；③改抽帧间隔后补跑能真正重抽。

## 改进落地记录（2026-09-27 第八轮：相关笔记互链 + 摘要风格预设——后续建议清单清零）

> **范围**：《优化实施报告-2026-09-27.md》记录的全部后续建议项施工完毕；两项延后大手术仍等前置（ASR 两阶段流水线等切回百炼、桥接 page 池等观测到 /req 排队）。开工前核对：main.js ×3 `18a009a5…`、桥接 ×5 `5021d399…`、data.json `6c322858…`，与第七轮记录全一致，无并发分叉。

### ① 相关笔记互链（借 Learning-Vault-Skills 双链思路，新模块 `relatedNotes.ts`）

- **新模块 `relatedNotes.ts`（全纯函数，Node 可测）**：
  - `relatedScore`：同分类 +2 / 同作者 +1，双同 = 3；自身按 id 与 path 双重排除；
  - `pickRelatedLinks`：得分降序 → 点赞降序（同分爆款优先）→ 路径字典序（确定性尾序，幂等的前提），上限 `relatedNotesMax`（钳 1~30，默认 8）；
  - `buildRelatedBlock`：`<!-- douyin-sync:related:start/end -->` 注释标记包裹的 `## 相关笔记` wikilink 块（HTML 注释而非 callout——阅读视图不可见、干扰最小）；链接目标去 `.md`，别名剥 `[]`（残留 `]]` 会提前终止 wikilink）；空列表返回空串（不留空块）；
  - `applyRelatedToNote`：幂等 upsert——有标记区间原位替换（空串 = 移除整块；有头无尾的误删残留从标记行起整段重建），无标记则插到尾注 `*同步于…douyin-sync*` 前置 `---` 分隔线之前（找不到尾注追加文件尾）；块与两侧恒为恰好一个空行，同一输入重复应用逐字节一致。
- **syncEngine 接线**：processItem 新增**阶段 10 `linkRelatedNotes`**（图文/视频都走，在 runVideoSummary 之后）——本条挂块 + 被链笔记回链（候选集一次收集全链路复用，保证互链一致）；候选自 `metadataCache` 读取 frontmatter（纯内存查询，O(vault 文件数) 毫秒级），**新建笔记手工补进候选集**（cache 索引新文件有延迟，否则首次回链会漏）；失败静默放弃不影响同步主流程。**不设计时键**——本阶段毫秒级，不入 StageTimings（recordStageTimings 白名单键之外自然不落画像，metrics 口径不变）。
- **`refreshAllRelatedNotes()` 公开方法 + 命令「重建相关笔记链接」（`related-refresh`）+ 设置页按钮**：全量候选 × 全量笔记重算互链块，内容无变化不写盘（mtime 不动）；O(n²) 打分为内存运算（600 篇 ≈ 36 万次比较，毫秒级）。
- **设置**：`relatedNotesEnabled`（默认开）/ `relatedNotesMax`（默认 8）+「相关笔记互链」设置分组；零覆盖纪律与摘要块一致——标记之外的内容一个字节不动。

### ② 摘要风格预设（借 BiliNote 多风格思路）

- `types.ts` 新增 `SummaryStyle = "hierarchy" | "outline" | "qa"` 与 `SUMMARY_STYLE_LABELS`；设置 `videoSummaryStyle`（默认 `hierarchy`）+「摘要风格」下拉框。
- `videoSummaryService.buildPrompt`：格式规范段按风格切换（`STYLE_SPECS`）——**hierarchy 与现行 v3 提示词逐字一致**（403 篇存量摘要即由它产出，零回归风险）；outline（要点速览：核心观点/要点/值得记住）与 qa（问答复习体：Q/A 对/一句话总结）共用四条方法论段（画面挖掘/转录校正/诚实原则/时间脉络）。
- **frontmatter 新增 `summary_style` 标记**：`statusCore.upsertFmScalar`（导出纯函数，键已存在原位改值、多行旧值整体移除、畸形 frontmatter 原样返回）与 `applySummaryToNote` 组合在同一 `vault.process` 回调——仍是单次原子写。
- **切换风格不触发旧笔记批量重出**（补跑判定仍只看 `summary_v`，避免静默产生 400+ 次付费调用）；「补跑旧视频笔记」按当前风格重出，历史 data.json 里的非法风格值回退 hierarchy。

### 验证（第八轮）

- `npx tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 0 错误。
- `npm test` **270/270**（221 → +49：`tests/round8-related.test.mjs` 新套件——applyRelatedToNote 插入/幂等/替换/移除/无尾注/有头无尾/CRLF 边界、打分排序确定性、块渲染别名剥括号、upsertFmScalar 五态、buildPrompt 三风格互斥与方法论共享、引擎级 refreshAllRelatedNotes 全链路（MiniVault + metadataCache 替身：互链成对/二次 0 更新/max=1 收紧/无 cache 静默跳过））。
- `npm run build` 0 错误，main.js 166,990 B（157,254 → +9,736 B）。
- **部署**：main.js `d623b2fc…` ×3（仓库/Vault/dist）一致；桥接未改动，5 副本 `5021d399…` 一致、在线；data.json 全程未触碰（md5 `6c322858…` 与第七轮一致）。
- 待用户在 Obsidian 重载插件后验收：新同步笔记文末出现「相关笔记」块；跑一次「重建相关笔记链接」为存量 600 篇补齐互链图。

## 改进落地记录（2026-09-27 第七轮：processItem 拆分——延后大手术落地）

> **范围**：延后清单中唯一条件成熟的一项（第四轮引擎级测试入仓后标注「条件已成熟可立项」）。其余两项继续等前置：ASR 两阶段流水线（等切回百炼）、桥接 page 池（等观测到 /req 排队）。

### processItem 拆分（行为不变重构）

- 原 processItem **340 行单函数**（10 个阶段 + 计时闭包 + 跨阶段共享 7 个局部变量）→ **编排器 + 9 个阶段方法**，编排器缩到 ~60 行、每阶段一个可独立阅读的方法：
  1. `collectReusedAssets`（重试路径资产回收，回收失败回退 null）
  2. `resolveCover`（封面：复用或按设置下载）
  3. `resolveVideoAssets`（视频素材拉取/帧复用，返回 `VideoAssetsOutcome`：assets + needAudio + 素材错误类别——原先靠共享可变局部变量跨阶段传递）
  4. `downloadImages`（图文图片下载，返回 `ImageDownloads`：图片路径 + 序号→本地路径映射）
  5. `recognizeImageTexts`（图片 OCR：本地字节优先 + 全局闸门限流）
  6. `transcribeVideo`（ASR：无视频轨判定 / 素材失败快捷分类 / 转写预算扣减 / 重试台账簿记）
  7. `categorizeItem`（AI 分类，失败落「未分类」不中断）
  8. `writeItemNote`（buildNote + 写盘 + 既有摘要回填，入参 `NoteWriteInput`，返回 path + noteFile）
  9. `runVideoSummary`（视频多模态摘要，生成门与拉帧门同源）
  10. `finalizeProcessed`（台账收尾：processed 记录 / 反向索引 / 结清重试）
- **计时口径不变**：原 perf 闭包提取为 `perf.ts` 新增 `StageTimer` 类；编排器在阶段间按原顺序逐位调用同键 `cut()`（reuseMs→coverMs→ffmpegMs→imagesMs→ocrMs→asrMs→categoryMs→noteWriteMs→summaryMs），`state.metrics` 耗时画像口径不变。
- 全部阶段逻辑与注释逐字保留（仅消除第六轮补丁遗留的错位缩进）；新增 4 个模块级阶段产物类型（`VisionRow` / `VideoAssetsOutcome` / `ImageDownloads` / `NoteWriteInput`），无导出面变化，`processItem` 签名不变（测试直接调用的入口不受影响）。
- 顺手清理：`statusCore.ts` 删除死常量 `OCR_HEAD` / `ABSTRACT_HEAD`（第四轮块所有权改整行正则后遗留，仅 `_RE` 变体被引用）——严格 tsc（`--noUnusedLocals --noUnusedParameters`）由此恢复 0 错误。

### 验证（第七轮）

- `npx tsc --noEmit -skipLibCheck` 0 错误；加 `--noUnusedLocals --noUnusedParameters` 亦 0 错误。
- `npm test` **221/221**——拆分后全绿，引擎级用例（processItem 全链路 / ASR 台账 / 预算顺延 / 来源还原 / 补跑筛选 / 埋点环形上限）即本轮「行为不变」的守护网。
- `npm run build` 0 错误，main.js 157,254 B（155,862 → +1,392 B，方法脚手架开销）。
- **部署**：main.js `18a009a5…` ×3（仓库/Vault/dist）一致；桥接未改动，5 副本 `5021d399…` 一致、在线 ready（`/ping` ok:true,ready:true）；data.json 全程未触碰（部署前后 md5 同为 `6c322858…`）。
- 待用户在 Obsidian 重载插件后验收真实同步。

## 改进落地记录（2026-09-27 第六轮：三路独立深审 + 接手收尾）

> **前情**：第四轮+复审批补记完成后，本会话对「从未被独立审查的第四轮/复审批改动」派出三路并行深审代理（引擎编排层 / 笔记文本与 AI 层 / 媒体·ASR·桥接层）。审计发现 **1 条 P0 + 8 条 P1 + 10 条 P2**，根因高度集中：**前会话在 05:37–05:42 间仍在对本工作区做最后一批编辑**，其中 syncEngine.ts 的编辑在 05:42:41 中断于半成品状态——一个 else-if 条件表达式丢失（124 个级联语法错误、无法构建）、四个已写注释/字段的功能完全未接线。三路审计与 tsc 双重证实后，本会话接手完成全部工作。

### P0（构建阻断）

- **syncEngine.ts:793 else-if 条件丢失**（前会话编辑事故）：processItem 的 ASR 分支 `} else if (` 与分支体之间条件表达式丢失，tsc 报 124 个级联错误、`npm run build` 直接失败——即第四轮补记时部署的 main.js（186ac27e）**不含**这批 syncEngine 改动。接手修复：`needAudio`/`needFrames` 提升到函数级作用域，补回条件 `needAudio && mediaErrorKind !== "none"`（素材拉取已失败且 provider 需本地音频 → 直接按素材错误分类，不再白跑一遍 resolveAudio、不再把网络抖动误判成「永不重试」）。

### P1（前会话「注释声称已修、实现为零」的四项，全部接线）

- **转写预算 `asrBudgetLeft`**：maxTranscribePerSync 此前只约束重试队列，全新条目的转写完全不受限——首次全量同步会一次性烧掉几百条转写费。接线：processItem 转写分支先扣减预算，耗尽时新方法 `deferAsrToNextSync()`（进 pendingAsr、attempts=0、不计失败不进退避），下次同步续传。
- **`ProcessedEntry.source` 还原**：types.ts 声称「重试/补跑重建时还原 frontmatter source」但读写两端全缺——点赞/作品笔记经重试/补跑会被整体改写成「收藏」。接线：processItem 写台账落 `source: item.source`；retryPendingAsr 与 backfillVideos 的 normalize 改传 `entry.source ?? "collection"`。
- **视频摘要生成门与拉帧门口径统一**：第四轮只改了 needFrames 一半，执行门仍写死 `aiKey || dashscopeKey`——只配专用多模态 Key 的用户「每条照付全片下载 + ffmpeg 抽帧、摘要静默不跑、补跑候选判定永假每轮重选」。执行门改用 `!!resolveVideoSummaryChannel().apiKey` 与拉帧门同源。
- **`backfillFails` 补跑连续失败跳过**：字段与注释已在、实现为零——队首 CDN 失效条目每轮占据全部补跑预算（每次 = 一次全片下载），尾部健康笔记饿死。接线：候选扫描跳过计数 ≥3 的 id；阶段二失败递增、成功清除。
- **`detailGate` 详情串行闸门**（同批声明未接线）：backfillVideos 的 getAwemeDetail 过 `Semaphore.run`——直连模式下并发详情请求不再绕开「抖音 API 串行」的风控口径（桥接模式桥内本已串行，闸门无害）。

### P2（深审新发现，逐条修复）

1. **statusCore normOcr 顺序颠倒**：幂等判据对含行首 `>` 的 OCR 文本恒失配 → 导出无限重复追加。修复：还原全角 ＞ 先于剥 `> `，两侧归一化对称。
2. **缩进 `[!` 转义缺口**：写入侧只锚定行首，读取侧 `>\s*\[!` 判据把 `> ␣␣[!NOTE]`（OCR 截图里的缩进提示块）当嵌套 callout 头提前断块 → 重建时截断。statusCore.calloutLine 与 noteBuilder.callout 改 `^(\s*)\[!` → `$1[！`。
3. **summaryService 手动摘要被文本通道预检挡死**：只配专用多模态 Key 的用户对视频笔记「生成摘要」报「AI API Key 未配置」。预检移到视频类型分支之后（视频路径由 generateAndWriteVideoSummary 自行校验专用通道）。
4. **摘要回填捏造 `summary_v: 3`**：无版本号的旧笔记回填后被标 v3 → 补跑判定恒真、旧格式永不再按新格式重出。解析失败改传 undefined（保留原状）。
5. **补跑 hasSummary 裸 includes**：与「整行全等」所有权口径不一致——用户自建同名 callout 或正文引用行误命中会让缺摘要笔记被跳过补跑。改逐行全等正则。
6. **关键帧复用被 needFrames 门控**：关掉摘要后触发重试重建会剥掉既有「关键帧」折叠块与 frame_interval → 下轮补跑 framesOk 失效、重付全片下载。改为只要帧 hint 存在且不需要音频即复用。
7. **retryPendingAsr 的 `!provider` 静默空转**：配置不全的条目每次同步被选中却什么都不做、不报错、永不消化。改记一次退避（文案带 provider 名），到上限 dead-letter 有据可查。
8. **loadState 对 asrRetry 条目零校验**：手改 data.json 的 attempts 非数字会让 `attempts+1` 变字符串拼接、`BACKOFF[NaN]` 变 undefined → `new Date(NaN).toISOString()` 抛 RangeError 冲出 catch、中止本轮全部重试（每次同步复现）。装载时逐条消毒。
9. **dashscope 文件级失败缺永久分类**：任务 SUCCEEDED 但 results[0] 带 NO_SPEECH/INVALID_FILE（纯音乐/无效文件）时返回 failed → 反复重试至 dead-letter；任务级同语义却是立即 unavailable。与 pollTask permanent 判定同口径。
10. **videoSummaryService 帧字典序排序**：`frame_100.jpg` 落在 frame_10 与 frame_11 之间——帧数 ≥100 时末帧被当成第 11 帧送进模型（videoMedia 同类 bug 已修、此处未同步）。抽公共纯函数 `sortFramePaths` 数值排序。
11. **douyinClient 非 owner 重发绕过降档循环**：全套头试探成功后并发等待者的重发直接 return——网络异常冲出 req()，与「失败自动降档」契约不符。包 try 落入既有降档循环。
12. **aiConfig dashscopeKey 兜底的 401 陷阱**：基址改离百炼 + Key 留空时把百炼 Key 打向第三方（401 陷阱）。新增 `isBailianBase()`——兜底仅在基址确属百炼时注入；vision 通道自定义非百炼基址时同源候选 aiKey 优先于跨源 dashscopeKey（百炼系基址保持旧优先级，兼容行为不变）。
13. **ai categorize 定界符可被字面 `</source` 击穿**：标题/文案/转录先 `defuse()`（`</source` → 全角）再拼入。
14. **main flushTimer 用 `window.setTimeout`**：Node 单测环境无 window 直接 ReferenceError。globalThis 回退（第四轮遗留，本轮接手时由新测试暴露）。

### 验证（第六轮）

- 新增回归测试 **31 例**（引擎级：预算顺延 / 来源还原 / provider-null 退避 / 补跑失败跳过与清除；纯函数：normOcr 幂等顺序 / 缩进转义往返 / 版本号不捏造 / aiConfig 兜底约束 / 帧排序）→ `npm test` **221/221**（190 → 221）。
- tsc 0 错误；`npm run build` 0 错误，main.js 155,862 B。
- **部署**：main.js `274ceac1…` ×3（仓库/Vault/dist）一致；桥接 5 副本 `5021d399…` 一致；data.json 全程未触碰（仅只读校验 bridgeNodeModules / bridgeNodePath 两键用于拉起）。
- **桥接切换**：运行中旧桥（e5d2541d，04:08 起）`POST /shutdown` 优雅退出、端口释放 → 按 processManager 同款方式（专用 node 22.22.2 + `NODE_PATH=C:\Users\23699\bin\node_modules`，Vault 副本 detached）启动新桥 → `/ping` ready → 真实 `/req` 中继 HTTP 200（端到端通）、带 Origin 请求 403（防护生效）。自检后桥接自主切换有头内核（headed），属既有风控应对设计。
- **桥接版本说明**：5021d399 是前会话 05:40 写入仓库的「复审 P2」桥接加固版（16,775 B：探活与 reload 竞速收口、启动窗口 /req 处理、null page 防护等）。发现时仅仓库副本更新、其余 4 副本与运行实例停留在 e5d2541d——已按硬规则同步 5 副本并重启收口。审计代理 C 对该版全文审查无发现、`node --check` 通过。

### ⚠️ 并发会话警示（重要）

- 本会话工作期间检测到**另一个 AI 会话仍在同一工作区活动**：05:37–05:42 写入 src（半成品中断）、05:40 写入 douyin-bridge.js、06:05–06:22 间还发生过一次仓库桥接文件的带时间戳恢复（md5 在 e5d2541d 与 5021d399 间翻转）。本会话全部编辑、构建、部署均已完成且校验一致，但**若那个会话仍在运行并继续写入，状态可能再次分叉**。请关闭多余会话，仅保留一个。
- 若重载插件后发现行为与本记录不符：先核对 main.js md5 是否仍为 `274ceac1…`（×3）、桥接 `5021d399…`（×5）。

## 改进落地记录（2026-09-27 第四轮 + 复审批 · 本会话补记）

> **补记说明**：本轮工作由前一实施会话完成（约 03:18–05:33），会话在源码收尾后中断，未及构建/部署/记录。本会话依据源码内标记注释（「2026-09-27 第四轮」「复审 P1/P2」）、测试文件与部署物时间线重建本记录，并补齐最后的构建部署。条目以源码注释自证为准。

### 第四轮修复批（源码标记「2026-09-27 第四轮」）

- **引擎级测试入仓（补 09-14 明确延后的 syncAll/processItem 单测）**：新增 `tests/sync-engine.test.mjs`（~90 例）——MiniVault 内存 Vault + 协作替身（media/videoMedia 假件、DouyinClient 原型补丁、`setRequestUrlMock` 注入），全程不触网。覆盖：落盘节流/失败重标脏、saveImage 真件行为、processItem 图文全链路、确定性素材失败不入重试队列、视频摘要失败不丢笔记、aweme_type=163 无视频轨、ASR 重试台账退避/dead-letter/结清、retryPendingAsr 簿记七场景、findNotePath 索引回退、writeAsrErrorNote 只动 warning 块、loadState/resetState、埋点环形上限、consumePage 提前停止（P0-5 回归保护）、syncAll 完整冒烟、backfillVideos 候选筛选与复用、pullAssets 缓存按需维度。`tests/obsidian-stub.ts` 同步扩充。测试总数 100 → **190**。
- **ai**：`finish_reason=length` 截断自动 2× 预算重试一次（上限 4000）——长摘要在小 token 预算下截断后曾不加标记直接落盘（summary_v 已写、永不重出）；categorize 提示注入防护（标题/文案/转录用 `<source>` 定界符包裹并声明为数据非指令）。
- **statusCore**：`stripBom` 统一去 UTF-8 BOM（外部编辑器重写过的笔记 frontmatter 判定曾集体失配，Bases 全部过滤）；畸形 frontmatter（`---` 无闭合）一律放弃写入（原围栏降级为正文 = Properties 全丢）；块「所有权」收紧为**整行全等**正则（用户自建 `[!abstract]- 摘要与心得` 不再被整块替换）；calloutLine 行首 `[!` 一并全角化（防内容行成为嵌套 callout 头致重建尾部丢失）；OCR 导出幂等比对两侧归一化（行首 `>`/全角/CRLF）。
- **noteBuilder**：callout 行首 `[!` 全角化（与 statusCore 同策略）；visionTexts status 多行压行（单行正则失配）；ASR segments 段内换行拆行（裸行会让 extractCallout 提前断块，重试复用丢逐字稿）。
- **summaryService**：`douyin_id` 同样先切 frontmatter 区间——正文同名行劫持帧目录定位时会把**别的视频画面**送进本条摘要提示词。
- **dashscope**：任务 SUCCEEDED 但单文件结果带 code/message 时透传错误（不再当成功空结果）；fetchVideoBytes / 200MB 上传 / 同步推理显式超时（默认 30s 家宽上行必掐断）；multipart body 单次拷贝构建。
- **tencent**：Throttling / InternalError 服务端瞬时错误容忍重试。
- **media**：saveImage 瞬时网络失败一次重试（条目写入 processed 台账后不再整条重跑）。
- **ocrService**：付费确认弹窗 **resolve 先于 close()**（原顺序被 onClose 的 resolve(false) 抢先落定，用户明确点「使用付费通道」却按取消处理，付费兜底形同虚设）；OCR 结果导出改 `vault.process` 原子写 + `**图 N**（手动导出）` 分段头（collectExistingAssets 只认该头，裸文本重试重建时被静默丢弃）。
- **types**：删除 `AsrStatus` 的 `"skipped"` 死成员（误导补跑终态判定）；`ProcessedEntry` 新增 `source` 字段（重试/补跑重建时还原 frontmatter source，不再把点赞/作品笔记硬编码改写成「收藏」）；`backfillFailStreak` 补跑连续失败计数（队首 CDN 失效条目不再每轮占据补跑预算，≥3 次本轮跳过、成功即清）。
- **桥接（03:40 版本）**：删除 `/form-upload` 端点（无用端点收敛攻击面）；ARCHITECTURE.md §七同步。

### 复审批（源码标记「复审 P1/P2」）

- **aiConfig.ts（新增统一接入层）**：五条 AI 通道（通用/OCR 视觉/OCR 面板主备/视频多模态）的 Base URL / Key 解析与校验收敛单点；OCR 面板**付费兜底通道**同样回退 dashscopeKey——按推荐配置只填百炼 Key 的用户此前唯独面板兜底报「API Key 未配置」。
- **douyinClient**：档位记忆加**单调约束**（旧档并发成功不得把已回升的档位降回）；全套头试探改**共享单飞 Promise**（并发不再各发各的试探）+「全会话只在确证被拒后停止试探」（瞬时网络异常不烧掉试探机会、验证过可用后旧档成功不再降回）；`listCollection` 收藏夹列表**循环翻页聚合**（原单页截断，超页收藏夹静默丢失）。
- **statusHub**：ping 完全不可达（含进程态滞留 running 的僵尸场景）不再喂编造探测值给异常分类。
- **panelView**：/ping 详情固定复用同一行（状态频繁翻转时行数不再只增不减）。
- **processManager**：引擎路径（main.spawnBridge）拉起的桥接 PID 也登记进程管控（dispose/stop 不再漏管）；spawn 挂 `error` 事件监听（可执行文件不存在是异步 emit，不监听会 unhandled exception）。
- **main**：onload 延迟启动定时器可取消（禁用/重载后的 3s/30s 窗口内不再拉起桥接或触发同步）；**data.json 写盘串行链**——引擎落盘/设置防抖/PM persist/OCR·摘要台账的并发写排队（data.json ~700KB 且非原子写，并发交错曾可写坏）。
- **statusCore**：extractCallout 遇紧邻邻块 callout 头提前断块（邻块正文不再混进摘要输入源）；`applySummaryToNote` 删除键集与发射面一致（手动摘要不再每次累积一行重复 summary_v）；collectExistingAssets 双子块布局下悬置 OCR 段落先落账（第二块头置 null 会静默丢上一块末图文字）；`pushSummaryRecord` 保留上限恢复 200（迁纯函数层时曾被静默砍到 50，与 types.ts 口径一致）。
- **util**：sanitizeFilename 按码点截断（emoji 代理对劈半会产生非法 UTF-16 文件名，vault.create 报错致该条目每轮固定失败）。
- **types/设置**：`ocrModelFallback` 默认值改 `qwen3-vl-plus-2025-12-19`（裸名已无免费额度 403，与 videoSummaryModel 同口径；data.json 未触碰）。
- **dashscope**：全片下载显式超时放宽 10 分钟（200MB 上限受默认 30s 摆布必被掐断）。

### 第四轮 + 复审批验证（本会话补齐部分）

- 前会话已完成：`npm test` 190/190（含引擎级套件）；桥接 04:08 重启在线。
- 本会话补齐：tsc 0 错误；`npm run build` 0 错误；main.js 重新构建（149,391 → 152,502 B）并部署 Vault + dist，三处 md5 一致 `186ac27e…`；桥接未改动，5 处副本 `e5d2541d…` 一致、在线 ready；data.json 全程未触碰。

## 改进落地记录（2026-09-27 第三轮：第六批 + 独立复核回归修复）

### 第六批（细节收尾）

- **UA 统一**：新增 `util.DOUYIN_UA`（Chrome/130，与桥接 Chromium 指纹一致），`douyinClient` 直连请求与 `media.CDN_HEADERS` 图片下载改用同一 UA——此前直连是旧 UA、图片下载又是另一套，同一插件三种指纹反而更扎眼。
- **同步结果文案拆分**：`SyncSummary` 新增 `notices: string[]`，跳过/警告类信息（如「N 条等待下次同步」）从完成 Notice 主文案里拆出，完成后单独提示，主文案只剩数字。
- **新命令 `asr-retry-queue`**（查看转写重试队列）：`syncEngine.retryQueueSummary()` 汇总重试台账（条数/下次重试/失败原因），不再只能靠「重试失败转写」盲跑。
- **测试扩充**：新增 `tests/note-builder.test.mjs`（buildNote 结构/逐字稿转义/800 字分段/关键帧折叠块/图片块 + normalize 类型判定/封面优先/统计字符串强转/无效 id 返回 null 等 ~26 例）；statusCore/itemType 用例正式入仓 `tests/`。测试总数 74 → **100**。

### 独立复核（第二意见代理）发现的 10 条回归，全部修复

1. **手动摘要丢 `summary_v`**：`applySummaryToNote` 不传 summaryV 时保留既有 `summary_v`（原实现会删掉版本号，破坏 v3 补跑判定）。
2. **dispose 误杀外部桥接**：`ProcessManager.dispose` 先用 `ownsPortHolders()`（netstat PID + 映像名校验）确认端口占用者是自己拉起的子树，才走优雅退出/强杀；用户手动 `node douyin-bridge.js` 拉起的桥接不再被 Obsidian 退出时连坐。
3. **启动窗口误报「未授权」**：statusHub 探测 `/ping` 返回 `ok:true, ready:false`（桥接在启动浏览器）时连接态改判 `unknown` 并跳过异常分类（原实现归为 `unauthorized`，E3 误报）。
4. **`toDataUrl` 对带 query 的 URL 返回空**：MIME 推断前先剥 `?#` 查询串（`cover` 带签名参数时全部落空）。
5. **in-flight Promise 毒化**：`pullAssets` 并发缓存 reject 后归一为 `{assets:null,errorKind:"network"}` 再落缓存，等待方拿到的是结构化失败而非裸异常（原实现第二个等待者直接抛未包装错误）。
6. **spawnBridge 冷却挡住就绪探测**：ready 探测移到冷却判断之前——桥接刚修好 60s 内不再被失败冷却拒之门外。
7. **慢启动误报 E2**：`startInner` 探测到 `ok && !ready`（正在启动）时等待至超时再复查并给明确文案，不再落进「端口被占」误报分支。
8. **OCR 80 字前缀探测误判**：前缀相同但正文不同的重复识别不再被当成重复跳过，改为完整文本比对。
9. **evaluate 超时假死队列**：apiFetch 超时后对 page 做 fire-and-forget `reload`（30s 超时、失败静默），挂死的页面上下文被强制重置，串行队列不再永久阻塞。
10. **试探失败直接放行 4xx**：douyinClient 首请求试探失败回退记忆档后继续用记忆档请求（原实现把 4xx 响应原样返回上层，误报为风控）。

### 参考仓库评估（用户提供：BiliNote / Learning-Vault-Skills）

- **BiliNote**（AI 视频笔记生成工具）：其核心机制本插件均已有等价实现——ASR 兜底链（其字幕优先对抖音无公开字幕接口可对应）、关键帧截图、多 provider 抽象、任务退避重试、后端健康监控/一键重启。可借鉴记入后续建议：**摘要风格预设**（其 9 种 style 可选，本插件固定 v3 层级体）、**转写模型就绪门禁**（本地模型未就绪拦截任务，对应本插件 ffmpeg/Key 前置校验已覆盖大半）。
- **Learning-Vault-Skills**（Vault 内 AI 学习工作流技能集，与插件代码无直接交集）：可借鉴记入后续建议——**双链知识关系**（同分类/同作者笔记互链）、图片紧邻说明约定（本插件 OCR 块「图 N（状态）」已有对应）。

## 验证记录（2026-09-27 第三轮）

- `tsc --noEmit -skipLibCheck`（收紧后 tsconfig）0 错误；`npm run build` 0 错误。
- `npm test` **100/100**（41 存量 + 33 第二轮 + 26 noteBuilder/normalize）。
- 桥接 5 处副本（仓库/Vault/~/bin/dist bridge/dist plugin）md5 一致：`f86feb03…`；main.js 3 处（仓库/Vault/dist plugin）一致：`b7730da5…`。
- 桥接重启后 `/ping` `{"ok":true,"ready":true}`（含 #9 修复）；真实 `POST /req`（listcollection）HTTP 200。
- `data.json` 全程未触碰；改动未提交 git。

## 改进落地记录（2026-09-27 第二轮：P3 全量 + 桥接 + 工程卫生）

用户确认四项取舍后实施：桥接 7 项全部做（5 处副本同步+冒烟）、三项大手术维持延后、工程卫生全做（遗留文件归档不删除）、配置只改代码默认值。

### 插件侧（P3a/P3b）

- **statusCore**：
  - 新增 `calloutRange()`：折叠块边界统一判定，终止条件增加「下一个 `[!…]` callout 头」——四处调用（摘要块替换 / OCR 追加 / 资产回收 OCR / 摘要）不再吞紧邻的用户折叠块（原实现会把用户内容一并替换删除）。
  - `extractCallout` 丢弃逐字稿标题的引擎括注尾巴（`（whisper）` 等），不再混进摘要模型输入源。
  - `appendOcrToNoteCallout` 幂等：同一份识别结果重复导出直接跳过（原实现每点一次导出就整段重复追加）。
  - 新增 `frontmatterBlock()`：type / transcript_status / frame_interval / summary_v 等键值判定先切 frontmatter 区间——summaryService 手动摘要与 syncEngine 补跑的全文 `/m` 正则不再会被正文同名行劫持分支。
  - `collectExistingAssets` 由 4+ 遍全文扫描合并为**单遍**（批量重试 1109 篇 × 数百 KB 时的重复 CPU）。
  - `pushSummaryRecord` 自 summaryService 迁入纯函数层，并按 notePath upsert（同一笔记先失败后成功不再并存台账；syncEngine/main 改从 statusCore 导入）。
- **noteBuilder / util**：
  - `planNotePath` 对收藏夹名走 `sanitizeFilename(folder, 40)`（原样进文件系统路径，含 `/\:*?"` 等字符的收藏夹名会让整条收藏夹同步报错）；frontmatter `folder` 保留原名供展示。
  - `sanitizeFilename` 补 Windows 保留名（CON/PRN/NUL/COM1-9/LPT1-9 → 前缀 `_`）、结尾点/空格剥离（NTFS 剥离导致请求路径与落盘名不一致）、DEL 控制符。
  - 800 字分段改 `Array.from` 按码点切（原 UTF-16 code unit 硬切会把 emoji 代理对劈成乱码）。
- **douyinClient**：每实例首个直连请求**试探全套头**（成功恢复完整指纹，失败回退记忆档）——修复「一次瞬时网络故障把请求头档位永久钉死在最小头档，且从不回升」。
- **statusHub**：`/ping` 真实 kernel 字段透传给异常分类（原实现喂编造值，端口被占会误报「未找到内核」）；完全不可达时补一次端口占用探测（E2 分类真正可达）；新增 `restart()`。
- **settings**：「状态刷新间隔」改动即时生效（onChange 调 `statusHub.restart()`，原实现需重载插件）。
- **ai**：chat 超时自动重试 1 次（3s 退避）——长摘要请求掐在超时线上不再整条失败。
- **ocrService**：付费确认弹窗与结果框展示**实际配置**的模型名与端点（原硬编码「百炼 qwen3-vl-plus / agnes-2.5-flash」，付费知情对象失真）。
- **videoMedia**：`checkFfmpeg` 失败结果改 60s 短 TTL（原永久缓存 null，AV 拦截一次 spawn 整个会话都判无 ffmpeg）；`runFfmpeg` 超时 kill 后 5s 强制 settle（原可能永不落定、占死并发槽）。
- **videoSummaryService**：frameStepMemo key 改 `${baseUrl}::${model}`（同模型名跨通道上限不同，换通道后旧记忆误导降档起点）。
- **types/settings**：默认 `videoSummaryModel` 改 `qwen3-vl-plus-2025-12-19`（裸名已无免费额度会 403），设置页描述同步防坑。**data.json 未触碰**。
- **审查后的两个「不改」结论**：① noteBuilder 顶层 `likes` 是 `爆款排行.base` 的排序/展示字段（初审「重复可删」是误报），嵌套 stats 无消费方但承载互动数据，均保留；② `normalize()` 标题本就取首行，「多行标题破坏 H1」不成立，不改。

### 桥接（douyin-bridge.js 7 项 + 配套）

- **先听端口再启浏览器**：双拉起的第二个实例在启动浏览器之前即退出（stderr 带 EADDRINUSE 原因、exit 1），不再白启 Chromium 抢 profile 锁；启动窗口内 `/ping` 返回 `ok:true, ready:false`。
- **请求体上限 + 错误监听**：`readBody` 统一收包（/req 与 /download 1MB、/form-upload 300MB，超限 413 断开）；`req.on("error")` 与 `server.on("clientError")` 兜底——客户端中途断开不再以 uncaught exception 崩掉整个桥接。
- **/download 补 `.catch`**：enqueue 任务失败返回 500，HTTP 响应不再永久悬挂（evaluate 另包 300s 下载超时）。
- **evaluate 全部带超时**：apiFetch 两次 evaluate 60s、保活探活 10s、/download 300s——一条挂死请求不再假死整个串行队列，超时按 `status:-1` 走既有重载/重试路径。
- **本地请求校验**：Host 必须为 127.0.0.1 / localhost / [::1]，且拒绝任何带 Origin 的请求（插件 requestUrl 与 curl 均不带 Origin）——浏览器任意网页无法再向 /shutdown、/req 发跨站请求，DNS rebinding 一并阻断。
- **stdout 防冻结**：processManager spawn stdio 改 `["ignore","ignore","pipe"]`（Windows 管道同步写，无人消费的 stdout 在日志风暴时填满 64KB 缓冲会冻结桥接事件循环）。
- **配套插件侧**：processManager 停止改**轮询等待**（`waitGone` 6s；原固定 1.5s 多数来不及等 ctx.close 完成，优雅端点形同虚设）；`dispose` 先优雅退出 3s 再对幸存者验身份强杀（原每次 Obsidian 退出都直接强杀 Chromium 树）；`startInner` 就绪判据 `ok && ready`（兼容新启动语义）；`main.spawnBridge` 同样等 ready。

### 工程卫生

- **测试入仓**：`tests/`（statusCore.test.mjs / itemType-video.test.mjs / optimizations-20260927.test.mjs + entry.ts + run-tests.mjs）；package.json 新增 `"test"` 入口；runner 清理放 finally；新增 33 条用例覆盖本轮全部新增纯函数。
- **tsconfig**：删除冗余 allowJs / noImplicitAny / strictNullChecks（strict 已覆盖），新增 noImplicitReturns / noFallthroughCasesInSwitch / forceConsistentCasingInFileNames；`noUncheckedIndexedAccess` 试开后报错面过大（几十处索引访问需加守卫）评估后**撤回**。
- **遗留文件归档**：`.workbuddy/backup/archive-20260927/`（repo/ 与 vault-plugin/ 含 backup-before-feature 目录，共 11 项）——Vault 插件目录现只剩 5 个发布文件 + data.json + profile-path.txt（运行中重新生成的 bridge.log 除外）。

## 验证记录（2026-09-27 第二轮）

- `tsc --noEmit -skipLibCheck` 0 错误；`npm run build` 0 错误；`npm test` **74/74**（41 存量 + 33 新增）。
- `node --check douyin-bridge.js` 语法通过。
- 桥接 5 处副本（仓库 / Vault / ~/bin / dist bridge / dist plugin）md5 一致：`a094bd00…`；main.js 3 处一致：`8dffb865…`。
- 旧桥接经 `POST /shutdown` 优雅退出（端口释放实测 PORT_FREE）；新桥接自 Vault 目录 detached 启动，`/ping` 返回 `{"ok":true,"ready":true,"headed":false,"kernel":"playwright"}`，启动自检 REQ 200。
- 冒烟（真实数据）：`POST /req`（listcollection）HTTP 200 返回 aweme_list 实数据；负向三项全部符合预期——带 Origin 403、伪造 Host 403、2MB 超限体 413（/shutdown 因带 Origin 被拒，防护生效旁证）。
- `data.json` 未触碰（本轮配置只改代码默认值）。

## 改进落地记录（2026-09-27，依据《插件优化建议-2026-09-27.md》第 1/2 批）

- **P0-5 提前停止回归**：`consumePage` 的 streak 恢复**跨页累计**（三处调用点改为 `processedStreak = r.streak > 0 ? processedStreak + r.streak : 0`）。09-19 重构误写成替换，单页最大 20 < 阈值 100，导致提前停止永不触发、每次同步都把收藏列表翻到最后（多付约 70 次桥接请求）。
- **P0-2 设置即时生效**：`refreshClients()` 同步重建 `DouyinClient`（cookie / bridgeEnabled / bridgeUrl 改动即时生效）；`videoMedia.updateClient()` 同步引用。此前「测试连接」成功但定时同步仍用旧 Cookie。
- **P0-3 素材错误结构化**：`pullAssets` 改返回 `{assets, error, errorKind}`；删除共享 `lastError`/`lastErrorKind`/`lastFailureDeterministic`（条目级并发 3 下会串号——确定性失败误入重试、可重试失败被误删丢转写）；缓存改 in-flight Promise（并发调用方等同一个 promise，不再把「拉取中」误读成「失败」）；新增 `isDeterministicMediaError()`。
- **P0-4 ASR 顶层兜底**：dashscope（transcribe 顶层 + submit/pollTask/collectResult 逐请求）、tencent、volcengine、qwen3 直转全部补网络异常 catch → 返回 failed 进重试台账；轮询加**连续 5 次网络失败容忍**（任务仍在云端跑，抖一次就放弃整个任务太浪费）。此前一次网络抖动 = 封面/抽帧/OCR 全白做且不记台账。
- **P0-1 摘要原子写**：statusCore 新增纯函数 `applySummaryToNote`（frontmatter summary/summary_v upsert + 摘要折叠块 upsert，一次字符串变换；旧值支持多行块标量整体移除），videoSummaryService / summaryService / syncEngine 回填三处改为**单次 `vault.process`**——消除「processFrontMatter 写 → 再 read → 再 modify」三遍全文件 IO 与两次写之间用户编辑被陈旧快照覆盖的竞态。顺带修复 callout 行首 `>` 未转义：写入侧统一转全角 `＞`（否则回填循环里引用层数逐轮增长）。
- **P0-8 saveImage**：存在性检查前置（命中免一次 CDN 流量）+ 0 字节残档视为不存在重新下载 + `createBinary` 失败回查（并发同路径写入不再静默丢图）。
- **P1-6 PID 身份校验**：processManager 新增 `isNodeProcess()`（tasklist 验映像名）；`stopInner` 与 `dispose` 强杀前逐一校验，防持久化 PID 被 Windows 复用后 `taskkill /F /T` 误杀无关进程树。查询失败宁可放过不强杀。
- **P1-7 spawnBridge 单飞**：memoize 进行中 promise + 失败 60s 冷却（并发 3 同时发现桥死时不再各自 spawn 出多个 Chromium 抢同一 profile）；端口解析改用 processManager 同款正则（无端口 URL 不再把 `//127.0.0.1` 当端口）。
- **P1-9 摘要超时**：视频摘要客户端 `setTimeoutMs(300_000)`（文件注释自述历史 p50 155.1s，原 120s 默认会把长请求掐死且无重试）。
- **P1-13 ffmpeg 按需输出**：`buildFfmpegArgs` 支持 `wantAudio/wantFrames`；`getAudio`（ASR resolveAudio）走仅音频路径，关摘要时不再白编 100 张 JPEG、走百炼 URL 直传时不再白编 mp3；`pullAssetsInner` 成败判定按需裁剪（不要的那路不参与）。
- **P1-10 OCR 复用已入库图片**：新增 `media.dataUrlFromFile`，图文条目 OCR 优先读刚下载入库的同一张图，同一条目每张图不再下载两遍。
- **P1-12 临时目录泄漏**：`pullAssetsInner` 失败/部分成功路径 try/finally 清理临时目录（含回退路径最大 200MB 的 source.mp4）；`processItem` 改**无条件** `cleanup(item.id)`（幂等）。完整成功路径临时目录仍保留，由 ASR 结束后的 cleanup 清（音频要上传）。
- **P1-14**：siliconflow 上传显式 `timeout: 120s`（原受 requestUrl 默认 ~30s 摆布，4.8MB 慢上行必被掐断）。
- **P1-15 设置页防抖**：文本输入 onChange 改 `queueSave()`（600ms 防抖），`hide()`/`display()` 前强制落盘；`display()` 重入先清状态订阅（防订阅泄漏越积越重）。
- **P1-16 埋点滤零**：perf 阶段维度统计剔除 0 样本（图文条目的 asrMs/summaryMs 不再稀释转写/摘要 p50）。
- **Semaphore 防线**：limit≤0/NaN 构造即抛错（原会静默死锁全部等待者）。
- **syncAll 异常路径补落盘**：catch 分支补 `await saveState()`（节流窗口内进度不随异常丢失）。

### 明确未做（本轮，见优化建议报告 P2/P3）

- 桥接侧 7 项（evaluate 无超时、请求体无上限、/download 无 catch、启动顺序、Host 校验、stdout 管道、dispose 优雅退出）——涉及 5 处副本同步，建议单独一轮合并实施。
- statusCore 折叠块边界吞用户内容（calloutRange 统一）、OCR 导出幂等、type 正则全文扫描、saveImage/OCR 双写、测试入仓 + npm test、tsconfig 收紧、火山 token 出 query 等小项。

## 验证记录（2026-09-27）

- `tsc --noEmit -skipLibCheck --noUnusedLocals --noUnusedParameters` 退出码 0；`npm run build`（tsc + esbuild production）退出码 0，`main.js` 141,121 B。
- 既有单测 **41/41**；新增纯函数自测 **18/18**（applySummaryToNote 幂等 / 多行旧值移除 / 无 fm 新建 / 引号转义循环稳定；perf 滤零前后 p50 对比；Semaphore fail-fast；mapLimit 保序与峰值）。临时验证脚本已删除。
- 桥接 `/ping`：`{"ok":true,"ready":true,"headed":false,"kernel":"playwright"}`（复用既有运行实例，未重启；/ping 自检即真实收藏请求）。
- 部署：`main.js` 同步至 Vault 插件目录与 `dist/douyin-sync-installer/plugin/`，三处 md5 一致（`0d97663f…`）；Vault 旧 main.js 备份为 `main.js.bak-before-opt-20260927`。`data.json` 未触碰。
- 生效方式：Obsidian 重载插件（或重启）后加载新 main.js。

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

## 当前快照

- 项目：Obsidian 插件“抖音同步归档”（douyin-sync-obsidian/，v1.0.1）
- 当前任务：2026-09-27 优化——第三轮（六批 60+ 项）→ 第四轮（引擎级测试基建 + 三路独立复审）+复审批 → 第六轮（三路独立深审，221/221）→ 第七轮（processItem 拆分）→ 第八轮（相关笔记互链 + 摘要风格预设，270/270）→ 第九轮（三路深审 3 P1 + 12 P2 + 16 P3，307/307）→ 第十轮（三视角深审：故障恢复 F1-F7 / 74 对抗断言 / 资源泄漏，394/394）→ 第十轮复审批（405/405）→ 第十一轮（配置数据完整性，436/436）→ 第十二轮（纯度收口，448/448）→ **2026-10-01 验证与运维（分叉核对、桥接重启上线最新加固、ARCHITECTURE 对齐第七~十二轮）**。延后大手术仍两项均等前置（2026-10-01 复核未成熟）：ASR 两阶段流水线（等切回百炼）、桥接 page 池（等观测到 /req 排队）；Git 改动仍未提交。
- 当前状态：构建 0 错误、`npm test` **448/448**；main.js md5 `e64dfc92…` ×3（仓库/Vault/dist plugin）、douyin-bridge.js md5 `bcbf5623…` ×5 副本一致；**在线桥接已是最新加固代码（2026-10-01 重启，/ping 带 rss 字段，冒烟 5/5 过）**，插件侧功能（互链/风格预设/消毒/撞库保护）待 Obsidian 重载验收；data.json 未触碰（只读观测 md5 有运行期漂移属预期）；**⚠️ 重载前请先核对 md5 与本记录，防并发会话分叉（历史警示见第六轮，第十轮复审批与 2026-10-01 核对应验）**
- 部署位置：`C:\Users\23699\Documents\Obsidian Vault\.obsidian\plugins\douyin-sync`
- 参考仓库：BiliNote / Learning-Vault-Skills 已评估，可借鉴项均已落地（第八轮）；第九轮为全新深审（无外部参考）
- 安全边界：Cookie 与 API Key 仅保存在 Vault 插件的 `data.json`，不得写入源码、日志或 Git

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
