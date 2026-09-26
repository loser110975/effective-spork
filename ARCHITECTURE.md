# douyin-sync 架构说明

> 面向维护者的实现文档。面向使用者的功能与配置见 `README.md`，跨会话状态见 `PROJECT_LOG.md`。
> 基于源码 1.0.1（2026-09-11）逐文件核对得出。

---

## 一、一句话总览

一个 Obsidian 桌面插件，把抖音收藏/点赞/作品抓成 Markdown 笔记。**难点不在抓取，在反爬**：抖音 Argus 风控会拦掉一切非浏览器指纹的请求，所以整个架构围绕「怎么让请求看起来像浏览器」展开——答案是**把请求交给一个真实 Chromium 页面去发**，这个页面由一个**插件拉起的独立 Node 进程**维护。

进程拓扑：

```
Obsidian (Electron renderer)                独立 Node 进程                云端
┌──────────────────────────┐   HTTP    ┌──────────────────────┐
│ main.js (插件)            │ ───────▶ │ douyin-bridge.js      │ ──▶ 抖音 API
│  ├ SyncEngine            │  8765    │  └ Chromium 常驻页面   │     (Argus 放行)
│  ├ DouyinClient          │          │     (playwright-core)  │
│  ├ MediaStore / AiClient │          └──────────────────────┘
│  └ ASR providers         │ ────────────────────────────────▶ 百炼/火山/腾讯 (转写)
└──────────────────────────┘                                    百炼 compatible-mode (分类/OCR)
```

两个进程的分工是刻意的：

| | 插件进程 | 桥接进程 |
|---|---|---|
| 生命周期 | 随 Obsidian 启停 | **detached 常驻**，Obsidian 退出也不死 |
| 职责 | 业务编排、写笔记、调云端 API | 维持一个已登录的浏览器上下文，代发抖音请求 |
| 为什么 | 写文件、UI、轮询都在这 | 抖音只认浏览器指纹；页面挂了能在进程内自愈 |

---

## 二、模块清单与职责

`main.js` 由 esbuild 打包（CJS / target es2022 / minify），**唯一 external 是 `obsidian` 与 Node 内建模块**——也就是说没有任何第三方运行时依赖被打进包里，全部手写。

| 文件 | 体积 | 职责 | 关键点 |
|---|---|---|---|
| `src/main.ts` | 6.8K | 插件入口：加载配置/状态、注册命令与状态栏、定时器、**拉起桥接**、持久化 | 见 §3.1、§3.2 |
| `src/syncEngine.ts` | 19K | **总编排**：分页扫描、单条处理、断点重试、旧视频批量补跑、状态落盘 | 见 §3.3–§3.6、§3.11 |
| `src/douyinClient.ts` | 12.5K | 抖音 API 客户端：通道选择、6 个端点、响应归一化 | 见 §3.2、§3.9 |
| `src/itemType.ts` | 0.8K | 视频/图文类型判定纯函数（`is_note` / `aweme_type` / 有图回退三重信号） | 见 §3.9 |
| `src/videoMedia.ts` | 8K | ffmpeg 编排：直链单次拉取双输出（转录用音频 + 关键帧）、检测、缓存、清理 | 见 §3.11 |
| `src/videoSummaryService.ts` | 5K | 视频多模态总结：转录 + 关键帧 → 百炼视觉模型 → 带配图摘要写入 | 见 §3.11 |
| `src/types.ts` | 5.2K | 全部类型 + `DEFAULT_SETTINGS` + `SOURCE_LABEL` | — |
| `src/settings.ts` | 11.7K | 设置页 UI，全部 onChange 直接写回 | 见 §4.1 |
| `src/noteBuilder.ts` | 5.2K | 纯函数：路径规划 + 笔记内容渲染（YAML + callout） | 见 §3.8 |
| `src/media.ts` | 2.4K | 封面/图片下载、base64 兜底、递归建目录 | 见 §3.7 |
| `src/ai.ts` | 3.1K | OpenAI 兼容客户端：分类 + 图片 OCR + 多图视觉（`chatVision`） | 见 §3.7 |
| `src/bases.ts` | 2.7K | 生成 4 个 `.base` 画廊文件 | 见 §3.10 |
| `src/asr/index.ts` | 1.2K | **工厂** `createAsrProvider()`：按设置实例化服务商（可注入音频解析钩子） | — |
| `src/asr/siliconflow.ts` | 4K | 硅基流动 SenseVoice（本机 ffmpeg 抽音频 → multipart 上传） | 见 §3.11 |
| `src/asr/dashscope.ts` | 14.8K | 百炼 Paraformer（异步任务 + 双通道 + 跨模型兜底）、qwen3-asr-flash | 见 §3.5 |
| `src/asr/volcengine.ts` | 3.7K | 火山引擎 AUC（submit/query，Bearer 认证） | — |
| `src/asr/tencent.ts` | 5.1K | 腾讯云录音文件识别（**TC3-HMAC-SHA256 手写签名**） | — |
| `src/statusCore.ts` | 8K | 纯函数层：二维状态机 + 笔记文本手术（摘要块/配图标记渲染） | — |
| `src/util.ts` | 2.5K | 纯工具函数（sleep、文件名清洗、YAML 标量、时间格式化） | — |
| `douyin-bridge.js` | 9.4K | **进程外**桥接服务（不参与打包，随插件目录分发） | 见 §3.2 |
| `bridge-common.js` | 4.0K | 桥接与登录脚本共用的内核探测 + 登录态目录解析 | — |

**为什么 `isDesktopOnly: true`：** 代码直接用了 Node 内建模块——`crypto`（腾讯云签名）、`path`、以及通过 `window.require("child_process")` 拉子进程。这些只在桌面版 Electron 里可用。

---

## 三、关键执行流程

### 3.1 启动与配置加载（`main.onload`）

调用顺序：

```
onload()
 ├─ loadSettings()        读 data.json → Object.assign({}, DEFAULT_SETTINGS, data.settings ?? data)
 ├─ addIcon / new SyncEngine(cookie, bridgeUrl, spawnBridge)
 ├─ engine.loadState(data.state)      state 与 settings 存在同一个 data.json
 ├─ addStatusBarItem + onClickEvent   状态栏可点击触发同步
 ├─ addRibbonIcon + 4 个命令
 ├─ addSettingTab → restartInterval() 按分钟数建 setInterval
 └─ 首次同步判定：从未同步 && 已填 Cookie && interval>0
        → setTimeout 30 秒后自动跑一次全量
```

三个值得注意的设计：

1. **配置与状态同文件。** `saveSettings()` 写的是 `{ settings, state }`。好处是一次保存原子覆盖；代价是 state 会随同步记录膨胀（568 条约 200KB），每次保存都整份重写。
2. **设置对象是原地改的。** `SyncEngine` 持有 `settings` 的**引用**，设置页的 onChange 直接 `s.cookie = v` 改同一个对象，所以引擎立刻可见，无需通知。也正因为对象从不被整体替换，这里不需要 `setSettings()` 之类的重建钩子（2026-09-11 清理时移除了那个从未被调用的旧钩子）。
3. **`DouyinClient` 是懒加载的。** `testDouyinConnection()` 里 `await import("./douyinClient")`，注释写明「仅在用户测试时加载请求客户端」——避免启动时就拉起请求栈。

### 3.2 桥接：拉起、保活、通道选择

**拉起（`main.spawnBridge`）**：先 `GET /ping` 探测，已在跑就直接返回；否则

```
window.require("child_process").spawn(bridgeNodePath, [manifest.dir + "/douyin-bridge.js", port], {
  detached: true, stdio: "ignore", windowsHide: true,
  env: { ...process.env, NODE_PATH: bridgeNodeModules },   // ← playwright-core 靠它解析
  cwd: manifest.dir,
})
```

然后 30 次 × 500ms 轮询 `/ping`，15 秒超时报错。`bridgeNodePath` 为空时回退 `"node"`（走 PATH），`bridgeNodeModules` 为空则**不写 NODE_PATH** 让 Node 自己解析。

**桥接进程内部（`douyin-bridge.js`）**：

- `launchPersistentContext(PROFILE, { executablePath, headless })` 起一个**持久化** Chromium —— 登录态就在这个 profile 目录里。
- `findChrome()` 回退链：`%LOCALAPPDATA%\ms-playwright\chromium-*` → 系统 Chrome → 系统 Edge（`bridge-common.js`）。
- 启动后立即做一次**真实自检**：发一页收藏请求，打印 HTTP 状态。
- 所有请求走 `page.evaluate(async (rel) => fetch(rel, …))` —— **在页面上下文里发 fetch**，浏览器自动带上 HttpOnly Cookie 与完整指纹，Argus 放行。
- **串行队列** `enqueue()`：`chain = p.catch(()=>{})` 把所有 evaluate 串成一条链，避免并发 evaluate 竞态。
- **自愈三连**：
  1. 请求前 `ensurePageAlive()`：`page.evaluate("1+1")` 探活，失败则重载页面，再失败则重建整个浏览器上下文；
  2. 页面内 fetch 抛错（status -1）→ 重载后**重试一次**；
  3. headless 收到 403 → 关掉上下文，**换 headed 窗口重试**（Argus 有时专杀 headless），headed 窗口用 `--window-position=-32000,-32000` 挪到屏幕外。
- **端口占用即退出**：`server.on("error", () => process.exit(0))` —— 第二个实例启动时发现 8765 被占就静默退场，把端口让给已在跑的那个。

**插件侧通道选择（`douyinClient.req`）**：

```
req(opts, extra)
 ├─ bridgeUrl 存在 → reqViaBridge()      ← 默认路径
 └─ 否则 → 直连，且按 3 档请求头降级重试：
      0 全套头（含 sec-ch-ua 裸引号值）
      1 无指纹头
      2 最小头（仅 UA + Cookie）
      成功后记住 this.variant，本次会话后续请求直接用该档
```

三档降级的原因写死在注释里：**Obsidian 的 `requestUrl` 对请求头校验比标准浏览器严**，`sec-ch-ua: "Chromium";v="130"` 里的裸引号值会触发 `net::ERR_INVALID_ARGUMENT`，所以必须能降到不带这些头的档位。

**一个关键事实：桥接模式不传 Cookie。** `reqViaBridge` 的 payload 只含 `url/method/body/contentType`，`headerVariants()` 里那套 Cookie 头**只用于直连模式**。桥接的登录态来自浏览器 profile；插件设置里的 Cookie 字段在桥接模式下只起 `assertCookie()` 的前置校验作用（必须含 `sessionid` 才放行）。这就是为什么**扫码登录和填 Cookie 两件事都得做**。

### 3.3 一次完整同步的调用顺序（`SyncEngine.syncAll`）

```
syncAll()                                          running=true，弹 Notice
 │
 ├─ 1. retryPendingAsr(budget)                     ← 重试队列先吃预算
 │
 ├─ 2. 收藏（若 syncCollection）
 │     ├─ useFolderMode → listFolders()
 │     │     ├─ whitelist 非空 → filter 按名字
 │     │     └─ 逐个收藏夹 syncCollectionFolder()
 │     └─ (folderOk=false 或 未开 folder 模式 或 白名单为空)
 │           → syncFlat("未分类")                   ← 扁平兜底
 │
 ├─ 3. 喜欢/作品（若开启）→ getSelfSecUid() → syncPaged(listLikes / listPosts)
 │
 ├─ 4. generateBases()（若开启，已存在的不覆盖）
 │
 ├─ 5. 写 lastSyncAt / lastSyncSummary → saveState()
 └─ 返回 summary，finally running=false
```

三个分页函数（`syncCollectionFolder` / `syncFlat` / `syncPaged`）是**同一个循环骨架的三份实例**：

```
for (page = 0; page < 上限; page++)        收藏夹 200 页，扁平/喜欢/作品 500 页
  res = fetcher(cursor, 20)
  for (item of res.items)
    normalize() → 无效直接跳过
    if (state.processed[id])  → skipped++，processedStreak++
    else                      → processedStreak = 0，processItem()，sleep(300)
  if (processedStreak >= scanStopAfterProcessed) break     ← 连续 N 条已同步就收工
  if (!res.hasMore || 空) break
  cursor 推进；sleep(600)
```

**增量语义**就藏在 `processedStreak` 里：从第一页往后扫，**连续**遇到 N 条（默认 100）已同步的就提前停。只要中间出现一条新的，计数就归零继续扫——所以新收藏插在旧收藏中间也能被扫到，代价是可能多翻几页。

**⚠️ 一个真实存在的低效点**：开着「按收藏夹建子目录」且**白名单为空**时，`folderOk` 为 true，但兜底条件 `!folderOk || !useFolderMode || whitelist.length===0` 的第三项仍为真 → **扁平扫描也会跑一遍**。因为 `state.processed` 已去重，不会产生重复笔记，但会把整个收藏列表重新翻一遍（最多 500 页）。这是「宁可多扫、不漏收藏夹外条目」的取舍，不是 bug，但数据量大时明显拖慢。

### 3.4 单条处理（`processItem`）——所有功能的汇合点

顺序固定，每一步失败都不中断整体：

```
processItem(item, folder, overwritePath?, asrOverride?)
  1. 封面下载          media.saveImage(coverUrl, "cover/<id>")        → coverPath
  1.5 视频素材拉取     仅 type==="video"：videoMedia.pullAssets(item)
                       （SenseVoice+Key 需音频，或多模态总结开启需关键帧）
                       ffmpeg 直链一次拉取双输出；失败记入 summary.errors，不中断
  2. 图文图片下载      最多 maxImages(≤10) 张，逐张 sleep(200)        ← 图文类专属
  3. 图片文字识别      仅 type==="note"：逐张 ocrImage(url) 失败 → toDataUrl 后 base64 重试
  4. ASR 逐字稿        仅 type==="video" 且 provider≠none 且有 playUrl
                       （asrOverride 非 undefined 时直接复用调用方结果，不二次转写；
                        也不为音频重新拉素材）
                       结束后 videoMedia.cleanup(id) 清理临时音频
  5. AI 分类           ai.categorize(分类列表, 标题, 描述, 逐字稿摘录)
  6. 写笔记            planNotePath → buildNote(含关键帧折叠块) → writeNoteFile
  6.5 视频多模态总结   仅 type==="video" 且 videoSummaryEnabled 且有 AI Key：
                       generateAndWriteVideoSummary（转录+关键帧 → 摘要块含配图）
  7. 记状态            state.processed[id] = {path, syncedAt, folder, asrStatus}
                       asr.status==="success" 时从 pendingAsr 移除
  8. saveState()       ← 每条都落盘
```

**第 8 步是断点续传的根基**：每处理完一条立即持久化，进程被杀最多丢「正在处理的那一条」，下次同步从 `state.processed` 继续。

### 3.5 ASR 的三级容错（`asr/dashscope.ts`，最复杂的模块）

Paraformer 是异步任务模型，调用链是「提交 → 轮询 → 取结果 → 拉转写 JSON」，中间套了三层容错：

```
transcribe(url, videoId)
 └─ transcribeWithModel(主模型)
     ├─ 通道 A：submitAndPoll([url])                 服务端直接拉抖音直链
     │    ├─ ok → collectResult()
     │    ├─ permanent（无语音/文件无效）→ unavailable，不再重试
     │    ├─ 错误匹配 NEED_FALLBACK_RE (FILE_403_FORBIDDEN|FILE_DOWNLOAD)
     │    │      → 进通道 B
     │    └─ 其他错误 → 返回 failed，并打 serverError 标记
     │                （SERVER_ERROR|InternalError → 换模型；AllocationQuota → 换模型）
     │
     └─ 通道 B：本地下载 → 临时 OSS → oss:// 重提
          fetchVideoBytes()   下载字节；4xx 时经桥接 getAwemeDetail 刷新播放地址再试
                              200MB 上限；<1KB 视为异常
          getUploadPolicy()   GET /uploads?action=getPolicy&model=<模型>   ← 少参数就 404
          uploadToOss()       手工拼 multipart（见下）
          submitAndPoll(["oss://<key>"], {ossResolve:true})
                              ← 必须带 X-DashScope-OssResourceResolve: enable
 └─ 若失败且 serverError 且有互备模型 → transcribeWithModel(备模型) 完整再来一遍
```

**错误分类是靠正则匹配错误码做的**，四个正则各自决定一条不同的路：

| 正则 | 匹配内容 | 后果 |
|---|---|---|
| `NEED_FALLBACK_RE` | `FILE_403_FORBIDDEN` / `FILE_DOWNLOAD` | 走上传通道 B |
| `SERVER_ERROR_RE` | `SERVER_ERROR` / `InternalError` | 标记 serverError → 跨模型重试 |
| `QUOTA_RE` | `AllocationQuota` / `Free quota exhausted` | 同上（各模型免费额度独立） |
| `NO_SPEECH_RE` | `SUCCESS_WITH_NO_VALID_FRAGMENT` / `ASR_RESPONSE_HAVE_NO_WORDS` / `INVALID_FILE`… | **permanent** → `unavailable`，移出重试队列，永不重试 |

**`unavailable` 与 `failed` 的语义分界是整个重试机制的核心**：`unavailable` 表示「这条视频本来就没有可转写的东西」（纯音乐、无对白、无播放地址、转写结果为空），重试永远无意义，移出队列；`failed` 表示「这次没成功但下次可能行」，留在 `pendingAsr` 里吃下次的预算。混掉这两个概念，要么死循环重试，要么漏转。

**跨模型兜底**（`pickFallback`）：`fun-asr*` ↔ `paraformer-v2` 互为备份——两者对个别音频流的兼容性互补，一个模型报 `SERVER_ERROR` 时换另一个往往能过。主模型额度耗尽也走这条路。

**手工构造 multipart**（`uploadToOss`）是个不得不做的脏活：Obsidian 的 `requestUrl` 不支持 `FormData`，所以用 `TextEncoder` 把「表单字段 + 文件字节」手工拼成一个 `Uint8Array`。两个细节是 OSS 签名规范的硬要求：

- 字段顺序：`OSSAccessKeyId / Signature / policy / x-oss-object-acl / x-oss-forbid-overwrite / key / success_action_status`，**`file` 必须最后**；
- `key` 的值是 `${policy.upload_dir}/${videoId}.mp4`，必须与 policy 签名一致。

另外 `obsidian@1.8.7` 的 `RequestUrlParam` **没有 `timeout` 字段**，不能加——这是踩过的坑，注释里没写但参数里确实没有。

qwen3-asr-flash 是另一条完全不同的路：多模态生成接口，**同步返回**，没有轮询、没有上传通道（`messages[1].content = [{audio: url}]`）。适合短视频，但同样受 CDN 直连限制，也没有兜底。

### 3.6 断点重试（`retryPendingAsr`）

每次同步开头先花预算清队列，这条链路里有两个精心设计的点：

```
retryPendingAsr(budget)
 for (id of pendingAsr.slice(0, budget))
   ├─ findNotePath(id)                 按 `[<id>].md` 后缀全 Vault 扫描定位
   │    └─ 命中多份时优先取非「未分类」目录的副本
   ├─ getAwemeDetail(id) → normalize → provider.transcribe()   拿最新播放地址
   ├─ success     → processItem(..., overwritePath=currentPath, asrOverride=asr)
   │                从 pendingAsr 移除
   ├─ unavailable → 同上（全量重写笔记），移出队列
   └─ failed      → writeAsrErrorNote(currentPath, 错误原文)    ← 只改错误块
```

**为什么要 `findNotePath`**：`state.processed[id].path` 是**快照**。用户手动移动笔记、或跑过 `代码\backfill-categories.js` 这类分类回填脚本后，真实路径已经变了。如果直接用旧路径，`writeNoteFile` 会在旧位置**重建出一份重复笔记**。所以重试时按 `[<id>].md` 现场扫一遍 Vault，多份时优先取已分类的那份。

**为什么失败时不重写整篇**：`processItem` 是全量重建（会重新下载封面、重新 OCR、重新分类）。转写失败时如果走全量重建，会把用户对笔记的其他改动冲掉。所以单独写了 `writeAsrErrorNote()` 做**字符串手术**：定位 `> [!warning]- 逐字稿` 这一行的位置，截到下一个空行或 `---`，只替换这一小段。函数开头还有个保护——**找不到该区块就直接返回**，避免把一篇已有成功逐字稿的笔记改坏。

### 3.7 媒体与视觉（`media.ts` / `ai.ts`）

- **图片下载不走桥接**，直接 `requestUrl` + `Referer: douyin.com` + 浏览器 UA。抖音图片 CDN 只校验 Referer，不像视频 CDN 那样查指纹。
- `saveImage` 幂等：`getAbstractFileByPath` 命中就直接返回路径，不重复下载。扩展名从 URL 正则里抠，抠不到默认 `jpg`。
- **视觉 OCR 的双通道**：模型先直连图片 URL，抖音 CDN 拒绝数据中心 IP 时 → `toDataUrl()` 本地下载转 base64 再发。这和 ASR 的双通道是同一个思想：**能用 URL 就用 URL（省流量），被拒就本机中转**。
- 视觉失败**不入队重试**——图文 OCR 失败是「当次放弃」，下次同步也不会补，与 ASR 的断点续传行为不一致。（早期版本留过一个从未写入的 `state.pendingVision` 字段，2026-09-11 清理时已随类型一起移除。）
- 分类 prompt 要求「只输出分类名称本身」，返回值用正则剥掉引号/空白后在列表里做 `includes` 匹配，匹配不到就**兜底取第一个分类**——保证 category 字段永远合法。

### 3.8 笔记落盘（`noteBuilder.ts` / `syncEngine.writeNoteFile`）

- **路径规划** `planNotePath`：`抖音/收藏/<收藏夹名>/YYYY-MM-DD 标题 [aweme_id].md`；点赞/作品进 `抖音/点赞|作品/`。日期取 `createTime`，取不到就用当天。
- **文件名清洗** `sanitizeFilename`：正则干掉 `[\\/:*?"<>|#^[\]%\u0000-\u001f]`（含 Obsidian 的 `#`、`^`、`|`、`[]` 这些 wiki 语法敏感字符），压空白、截断 60 字；空标题兜底 `抖音_<id>`。
- **YAML 转义** `yamlStr` 直接用 `JSON.stringify(String(v))` —— 抖音标题里的引号、反斜杠、emoji 都能安全进双引号标量。这是个聪明取巧：YAML 双引号标量的转义规则与 JSON 兼容。
- **Callout 转义**：正文里若出现行首 `>` 会把折叠块打断，所以 `callout()` 把行首的 `>` 替换成全角 `＞`。
- **长文本分段的两种来源**：有 `segments` 就按句加 `mmss` 时间戳；没有就按 800 字符切段，避免 callout 单行过长渲染卡顿。
- **写入策略** `writeNoteFile`：先 `ensureParent` 递归建目录（逐级 `getAbstractFileByPath` 判断，失败容忍并发）；文件已存在走 `vault.process`（Obsidian 原子改写），不存在走 `vault.create`。

### 3.9 抖音 API 客户端（`douyinClient.ts`）

6 个端点，全部**不带 `a_bogus` 签名**——这是刻意沿用了旧工具验证过的形态：收藏/喜欢列表端点目前不强校验签名，只靠 Cookie + UA + Referer。注释明确写了：一旦抖音强制签名，请求会返回非 0 的 `status_code`，`testConnection` 会把服务器原始响应展示出来便于诊断。

`normalize()` 是「外部脏数据 → 内部干净模型」的唯一入口：

- `aweme_id` 必须匹配 `^\d{6,30}$`，不匹配直接返回 `null`（过滤广告位、空壳条目）；
- `images` 与 `image_infos.images` 两个来源合并，`url_list` **取最后一个**（抖音列表最后一个通常是最高清的）；
- 类型判定（`itemType.classifyItemType`，三重信号明确区分视频/图文）：`is_note===true` 或 `aweme_type∈{2,68,71}` 显式判图文；否则回退「有图即图文」（经真实数据验证：`aweme_type=0` 均为视频、`68` 均为图文）；
- 封面三级回退：`video.cover` → `video.origin_cover` → 第一张图；
- `noWatermark()`：播放地址把 `playwm` 换成 `play` 去水印。

`getSelfSecUid()` 依赖 scraping：请求自己的个人页 HTML，用两个正则抠 `sec_user_id`。**登录失效时这里会先挂**，所以喜欢/作品同步被 try/catch 单独包住，失败只记 error 不影响收藏。

### 3.10 Bases 画廊（`bases.ts`）

四个 `.base` 文件用**模板字符串硬编码**，没有用 Obsidian 的 Bases API（当前版本也没有稳定的公开 API）。选择器统一是 `file.hasProperty("douyin_id")`——只认本插件产出的笔记，不会误伤库里的其他文件。

**不覆盖**：`generateBases` 对已存在的文件直接 `continue`。理由写在注释里：用户可能已经自定义过视图。副作用是**版本升级改了模板也不会生效**，得手动删旧的。

四个视图刻意只用最基础的 Bases 能力（cards/table + property filter/sort/groupBy），唯一有版本风险的是 `最近7天.base` 里的 `file.mtime >= now() - 7d`——这个函数在部分 Obsidian 版本会报错，README 里给了「打开 .base 手工微调」的出路。

### 3.11 视频素材与多模态总结（`videoMedia.ts` / `asr/siliconflow.ts` / `videoSummaryService.ts`）

**视频/图文分流的处理管线**（2026-09 分类优化）：视频类走「ffmpeg 拉素材 → SenseVoice 转录 → 多模态总结」；图文类完全不触碰这三步。

**ffmpeg 单次拉取双输出**（`videoMedia.pullAssets`）——一条命令、一次网络请求，同时产出转录用音频与关键帧：

```
ffmpeg -nostdin -y -user_agent <UA> -headers "Referer: …" -rw_timeout 60s
       -reconnect 1 -reconnect_streamed 1
       -i <播放直链> -t 600
       -map 0:a:0? -vn -ac 1 -ar 16000 -b:a 64k  audio.mp3      ← 输出1：SenseVoice 用
       -map 0:v:0 -an -vf fps=1/<间隔>,scale='min(720,iw)':-2
       -frames:v 100 -q:v 3  frame_%02d.jpg                      ← 输出2：多模态参考用
```

- **按时间间隔自适应抽帧**（`fps=1/<间隔秒>`，默认 10s，设置 1~60）：23 秒视频约 3 帧、10 分钟约 60 帧，`-frames:v 100` 与 `-t 600` 双重封顶——固定张数会把 23 秒短视频也塞满 100 张（踩过的坑）。**短视频保底**：`rate = max(1/间隔, 4/时长)`，帧是多模态模型的画面上下文，23s 视频至少给 4 帧覆盖全片；
- **主路径失败即回退**：直链拉取非零退出且无产物 → `requestUrl` 下载字节（4xx 经桥接刷新播放地址，与 dashscope `fetchVideoBytes` 同款）→ 本地文件再跑同一命令；
- **坑**：无 shell 的 spawn 下，`\,` 转义会被 filtergraph 解析器吃掉导致 `scale=min(720,iw)` 被按逗号拆成两个过滤器——必须用单引号形式 `scale='min(720,iw)':-2`；
- `ingestFrames` 入库时**同步清理旧网格**：vault 中不在本次产物里的 `frame_*.jpg` 一并删除（间隔调大后帧数变少，避免旧帧残留）；
- 帧图复制入库 `Media/frames/<id>/`；音频留在 OS 临时目录，**ASR 结束即 `cleanup(id)` 整目录删除**；
- 按 `item.id` 缓存素材，同一视频在一次会话内不重复下载；`ffmpeg -version` 探测可用性（设置页有「检测」按钮）。

**SenseVoice 转录**（`SiliconflowSenseVoice`）：经工厂注入的 `resolveAudio` 钩子取本地音频 → 手工拼 multipart（字段 `model` / `language` / `response_format`，`file` 最后）上传 `api.siliconflow.cn/v1/audio/transcriptions` → 解析 `{"text"}`。**无时间戳**，noteBuilder 走 800 字分段渲染。空文本 → `unavailable`（纯音乐语义，沿用「移出重试队列」约定）；取不到音频 → `failed`（ffmpeg 缺失等），入 `pendingAsr`。

**多模态总结**（`generateAndWriteVideoSummary`）：帧图转 base64 data URL（累计 14MiB 截断，防百炼 16MiB 请求体红线 413）+ 转录文字（≤8000 字符）经 `AiClient.chatVision` 发给百炼视觉模型（默认 `qwen3-vl-plus`，设置可换）。提示词要求输出**结构化笔记体**：`简介：`一行 + 1~2 段概述 + `🎯 N. 小标题` 分节列表（3~8 节，**加粗**划重点）+ `🌟 小总结`——**摘要不含照片**（关键帧统一在笔记的「关键帧」折叠块），`statusCore.stripFrameMarkers` 兜底剔除模型偶发的 `【配图N】` 标记。写入：frontmatter `summary` + `summary_v: 2`（格式版本号）+ `upsertAbstractBlock`（零覆盖约束不变）。

**批量补跑**（`SyncEngine.backfillVideos`）：遍历 `state.processed`，读现场定位的笔记，frontmatter `type: "视频"` 且满足任一条件的条目 → `getAwemeDetail` → 走完整 `processItem` overwrite 路径：缺 `transcript_status: success`、缺摘要块、`frame_interval` 与当前设置不一致（含从未抽出帧）、`summary_v != 2`（摘要格式升级）。已有成功转录复用笔记逐字稿（构造 `asrOverride`，不重复计费 ASR）；预算复用 `maxTranscribePerSync`。图文笔记一律跳过。

---

## 四、状态与持久化

`data.json` 的完整形状：

```jsonc
{
  "settings": { /* 39 个字段，见 types.ts DEFAULT_SETTINGS */ },
  "state": {
    "processed": { "<aweme_id>": { "path", "syncedAt", "folder", "asrStatus" } },  // 去重与定位
    "pendingAsr":   ["<aweme_id>"],   // 转写失败待重试，吃下次预算
    "lastSyncAt": "...", "lastSyncSummary": "新增 0 / 转写 0 / 视频摘要 0 / 失败 0"
  }
}
```

读取时的兼容处理：`Object.assign({}, DEFAULT_SETTINGS, data.settings ?? data)`——`?? data` 是为了兼容**早期扁平格式**（settings 直接平铺在顶层）的旧 data.json。

「重置同步状态」命令把 `state` 清成空对象，**不删任何笔记**——下次同步会重新全量扫描，但因为笔记已存在且 `state` 为空，会**再生成一遍**（`writeNoteFile` 走 `vault.process` 覆盖同路径）。所以重置的真实语义是「重建笔记内容」，不是「清空重来」。

---

## 五、关键逻辑与边界情况（速查）

| # | 场景 | 机制 |
|---|---|---|
| 1 | 抖音 Argus 拦非浏览器请求 | 独立进程 + Chromium 持久化页面 + `page.evaluate(fetch)` |
| 2 | headless 被风控 | 自动换 headed 窗口重试（窗口挪到屏幕外） |
| 3 | 页面长时间驻留挂死 | 请求前 `evaluate("1+1")` 探活 → 重载 → 重建上下文，三级自愈 |
| 4 | 两个桥接实例抢端口 | `server.on("error")` 里 `process.exit(0)`，后者静默让位 |
| 5 | Obsidian 拒绝 `sec-ch-ua` 裸引号 | 直连模式 3 档请求头降级，成功档位记进会话 |
| 6 | 桥接模式登录态 | 来自浏览器 profile，**不传 Cookie**；插件 Cookie 字段只是前置校验 |
| 7 | 抖音 CDN 拒云端拉取（转写） | 通道 A 失败 → 本地下载 → 临时 OSS → `oss://` 重提 |
| 8 | 播放地址带签名会过期 | 下载 4xx 时经桥接 `getAwemeDetail` 刷新后重试 |
| 9 | 模型对特定音频流报错 / 额度耗尽 | `pickFallback` 跨模型完整重试（fun-asr ↔ paraformer） |
| 10 | 视频本来就没有语音 | `NO_SPEECH_RE` → `unavailable`，移出队列**永不重试** |
| 11 | 视频太大 | 桥接 `/download` 与上传通道都是 **200MB 上限** |
| 12 | requestUrl 不支持 FormData | 手工拼 multipart，`file` 字段必须在最后（OSS 签名要求） |
| 13 | 视觉模型拉不到图 | URL 失败 → 本地下载转 base64 |
| 14 | 用户移动过笔记 / 跑过分类回填 | 重试时按 `[<id>].md` 现场定位，多份时优先非「未分类」 |
| 15 | 转写失败不想冲掉用户改动 | `writeAsrErrorNote` 只做字符串手术，且找不到目标区块就放弃 |
| 16 | 标题含 wiki 敏感字符 / emoji | `sanitizeFilename` 正则清洗；YAML 用 `JSON.stringify` 转义 |
| 17 | callout 正文出现行首 `>` | 替换成全角 `＞` 防止打断折叠块 |
| 18 | 重复下载封面/图片 | `saveImage` 先查存在性，命中即返回，幂等 |
| 19 | 用户自定义过 .base 视图 | `generateBases` 对已存在文件直接跳过，不覆盖 |
| 20 | 频繁请求触发风控 | 条间 300ms、页间 600ms、重试间 1s 的固定 sleep |
| 21 | 进程被杀丢进度 | 每处理完一条立即 `saveState`，最多丢正在处理的一条 |
| 22 | 旧版扁平格式的 data.json | `data.settings ?? data` 兼容读取 |

---

## 六、已知局限

> 2026-09-11 做过一轮死代码清理：移除了 `SyncState.pendingVision` / `fullSyncedAt`（声明后从未被写入）、`SyncEngine.setSettings()` 与 `Main.loadEngineState()`（零调用方）、`util.clampInt` / `truncate`（零调用方）、`NoteContentInput.imagePathPrefix`（从未被读取）、`DouyinPage.statusCode` / `raw`（从未被写入）以及若干未使用导入与参数。清理后 `tsc --noUnusedLocals --noUnusedParameters` 零告警，非压缩产物 diff 仅含上述删除行。

| 项 | 说明 | 影响 |
|---|---|---|
| 收藏夹模式 + 空白名单 | 会**额外跑一遍扁平扫描**（见 §3.3） | 数据量大时同步明显变慢，但不产生重复笔记 |
| `UA` 不一致 | `douyinClient`/`bridge` 用 Chrome/130，`media.ts` 用 Chrome/140 | 目前无碍（图片 CDN 只查 Referer），但改 UA 时容易漏一处 |
| `summary.errors` 双重职责 | 既装错误也装「已生成 N 个 Bases」这类信息 | 会出现在「注意：」提示里，观感像报错 |
| 桥接日志落点 | 写在 `__dirname/bridge.log`，插件拉起的实例就写在**插件目录里** | `.gitignore` 已排除；但 Vault 里会多一个日志文件 |
| ASR 无签名 | 收藏/喜欢端点目前不强校验 `a_bogus`，一旦强校验整体失效 | 已在注释中写明诊断路径 |
| 图文 OCR 无断点续传 | 视觉失败即当次放弃，不重试 | 与 ASR 行为不一致，见 §3.7 |
