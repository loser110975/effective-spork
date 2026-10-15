import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { PluginHost } from "./types/host";
import { ASR_PROVIDER_LABELS } from "./asr";
import { AsrProviderKind, DEFAULT_SETTINGS, SUMMARY_STYLE_LABELS, type SummaryStyle } from "./types/settings";
import { statusVisual } from "./statusCore";

export class DouyinSyncSettingTab extends PluginSettingTab {
  plugin: PluginHost;
  /** 实时状态行订阅（display() 重建时清理，防泄漏） */
  private statusUnsubs: (() => void)[] = [];
  /** 文本输入防抖落盘句柄（data.json 含完整 state，逐键全量序列化纯属浪费 IO） */
  private saveDebounce: number | null = null;
  /** 副作用防抖（第九轮 C11）：定时同步间隔 / 状态刷新间隔的 onChange 副作用逐键触发，
   *  后者每键立即烧一次 /ping。挂起的副作用在 hide() 时立即应用、onunload 时丢弃。 */
  private effectTimer: number | null = null;
  private effectFn: (() => void) | null = null;

  /** 副作用防抖：600ms 内的连续输入只执行最后一次的副作用。 */
  private queueEffect(fn: () => void): void {
    if (this.effectTimer !== null) window.clearTimeout(this.effectTimer);
    this.effectFn = fn;
    this.effectTimer = window.setTimeout(() => {
      this.effectTimer = null;
      const f = this.effectFn;
      this.effectFn = null;
      f?.();
    }, 600);
  }

  /** hide() 收口：立即应用挂起的副作用（否则关页后输入的间隔不生效）。 */
  private flushPendingEffect(): void {
    if (this.effectTimer !== null) {
      window.clearTimeout(this.effectTimer);
      this.effectTimer = null;
      const f = this.effectFn;
      this.effectFn = null;
      f?.();
    }
  }

  /** onunload 收口：丢弃挂起的副作用（重启定时器/轮询在卸载后执行会泄漏）。 */
  cancelPendingEffect(): void {
    if (this.effectTimer !== null) {
      window.clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    this.effectFn = null;
  }

  constructor(app: App, plugin: PluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** 文本类 onChange 的防抖落盘：600ms 内的连续输入只写一次 data.json。 */
  private queueSave(): void {
    if (this.saveDebounce !== null) window.clearTimeout(this.saveDebounce);
    this.saveDebounce = window.setTimeout(() => {
      this.saveDebounce = null;
      void this.plugin.saveSettings();
    }, 600);
  }

  /** 关闭设置页 / 重绘前把挂起的防抖保存立即落盘（onunload 也会调用）。 */
  flushPendingSave(): void {
    if (this.saveDebounce !== null) {
      window.clearTimeout(this.saveDebounce);
      this.saveDebounce = null;
      void this.plugin.saveSettings();
    }
  }

  hide(): void {
    this.flushPendingSave();
    this.flushPendingEffect();
    for (const u of this.statusUnsubs) u();
    this.statusUnsubs = [];
  }

  /** 在某个 Setting 的控件区追加实时二维状态行（颜色 + 文案 + 处置建议三重编码）。 */
  private attachLiveStatus(el: HTMLElement): void {
    const holder = el.createDiv({ cls: "douyin-sync-status-inline" });
    const render = (s: { processState: any; connectionState: any }) => {
      const v = statusVisual(s.processState, s.connectionState);
      holder.empty();
      const dot = holder.createSpan({ cls: "douyin-sync-dot" });
      dot.style.color = v.color;
      dot.setText(v.icon + " " + v.label);
      holder.createSpan({ cls: "douyin-sync-status-advice", text: v.advice ?? "" });
    };
    render(this.plugin.statusHub.getStatus());
    this.statusUnsubs.push(this.plugin.statusHub.subscribe(render));
  }

  display(): void {
    // display() 会被 onChange 重入（tab 未 hide → hide() 不触发清理）：先清旧订阅，防重复渲染历史 holder
    this.flushPendingSave();
    for (const u of this.statusUnsubs) u();
    this.statusUnsubs = [];
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("连接").setHeading();
    new Setting(containerEl)
      .setName("抖音 Cookie")
      .setDesc(
        "浏览器打开 douyin.com 并登录 → F12 开发者工具 → Network → 随便点一个 douyin.com 的请求 → 复制 Request Headers 里完整的 Cookie 值粘贴到这里（必须包含 sessionid，document.cookie 拿不到 HttpOnly 字段）。Cookie 过期后重新复制即可。桥接模式下请求头来自浏览器登录态，此项仅用于直连回退。" +
          "⚠️ 安全提示：Cookie 以明文存放在本机 data.json 中；若 Vault 使用 iCloud / Git / 云盘同步，请把 data.json 排除在同步范围外，避免凭据随 Vault 外传。",
      )
      .addText((t) => {
        t.setPlaceholder("sessionid=…; ttwid=…; …")
          .setValue(s.cookie)
          .onChange(async (v) => {
            s.cookie = v.trim();
            this.queueSave();
          });
        // 敏感输入打码（第十一轮）：Cookie 等同于账号凭据，明文显示在共享屏幕 / 录屏时会泄露。
        // 需要查看时用开发者工具或临时改本行——与 visionApiKey 的既有先例同口径。
        t.inputEl.type = "password";
      });
    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("按当前请求通道调一次收藏接口，验证登录态、桥接与接口可用性")
      .addButton((b) =>
        b.setButtonText("测试").onClick(() => void this.plugin.testDouyinConnection()),
      );

    new Setting(containerEl).setName("同步范围").setHeading();
    new Setting(containerEl).setName("同步收藏").addToggle((t) => t.setValue(s.syncCollection).onChange(async (v) => { s.syncCollection = v; this.queueSave(); }));
    new Setting(containerEl)
      .setName("按收藏夹建子目录")
      .setDesc("开启后收藏按收藏夹生成子目录；抖音侧收藏夹接口已下线（2026-10 实测 404）时自动回退扁平模式，完成提示中会说明")
      .addToggle((t) => t.setValue(s.useFolderMode).onChange(async (v) => { s.useFolderMode = v; this.queueSave(); }));
    new Setting(containerEl)
      .setName("收藏夹白名单")
      .setDesc("逗号分隔的收藏夹名称；留空=同步全部收藏夹")
      .addText((t) => t.setValue(s.folderWhitelist).onChange(async (v) => { s.folderWhitelist = v; this.queueSave(); }));
    new Setting(containerEl).setName("同步喜欢（点赞）").addToggle((t) => t.setValue(s.syncLike).onChange(async (v) => { s.syncLike = v; this.queueSave(); }));
    new Setting(containerEl).setName("同步作品").addToggle((t) => t.setValue(s.syncPost).onChange(async (v) => { s.syncPost = v; this.queueSave(); }));
    new Setting(containerEl)
      .setName("定时同步间隔（分钟）")
      .setDesc("0 = 关闭定时，仅手动同步；建议 60")
      .addText((t) =>
        t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.syncIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 60;
          this.queueSave();
          // 副作用防抖（第九轮 C11）：重启定时器逐键触发纯属浪费
          this.queueEffect(() => this.plugin.restartInterval());
        }),
      );
    new Setting(containerEl)
      .setName("每次同步最多转写条数")
      .setDesc("控制 ASR 费用；未转写的进入队列，下次同步自动续传。建议 ≤ 30：单条视频（下载+抽帧+转写+摘要）约需 1~3 分钟，额度设过大会让单次同步长时间占用不结束")
      .addText((t) => t.setValue(String(s.maxTranscribePerSync)).onChange(async (v) => { const n = parseInt(v, 10); s.maxTranscribePerSync = Number.isFinite(n) && n >= 0 ? n : 20; this.queueSave(); }));
    new Setting(containerEl)
      .setName("增量扫描提前停止阈值")
      .setDesc("连续遇到 N 条已同步的笔记就停止翻页；首次全量同步不受影响。0 = 禁用提前停止（每次翻完整列表）")
      .addText((t) => t.setValue(String(s.scanStopAfterProcessed)).onChange(async (v) => { const n = parseInt(v, 10); s.scanStopAfterProcessed = Number.isFinite(n) && n >= 0 ? n : 100; this.queueSave(); }));
    new Setting(containerEl)
      .setName("同步并发条数")
      .setDesc("同时处理的条目数（1 = 完全串行）。单条耗时几乎都在等待下载与云端推理，建议 3；调高可提升整体吞吐，但会加大抖音与 AI 接口压力。列表翻页始终串行")
      .addText((t) => t.setValue(String(s.syncConcurrency)).onChange(async (v) => {
        const n = parseInt(v, 10);
        s.syncConcurrency = Number.isFinite(n) && n >= 1 ? Math.min(n, 6) : 3;
        this.queueSave();
      }));

    new Setting(containerEl).setName("路径").setHeading();
    new Setting(containerEl).setName("笔记根目录").addText((t) => t.setValue(s.rootFolder).onChange(async (v) => { s.rootFolder = v.trim() || "抖音"; this.queueSave(); }));
    new Setting(containerEl)
      .setName("媒体目录")
      .setDesc("封面与图片存放位置（兼容 Obsidian Sync / iCloud / Git）")
      .addText((t) => t.setValue(s.mediaFolder).onChange(async (v) => { s.mediaFolder = v.trim() || "抖音/Media"; this.queueSave(); }));
    new Setting(containerEl).setName("Bases 目录").addText((t) => t.setValue(s.basesFolder).onChange(async (v) => { s.basesFolder = v.trim() || "抖音/Bases"; this.queueSave(); }));
    new Setting(containerEl).setName("同步后生成 Bases 画廊").setDesc("封面墙 / 分类画廊 / 爆款排行 / 最近7天（需 Obsidian 1.9+，已存在的不覆盖）").addToggle((t) => t.setValue(s.generateBases).onChange(async (v) => { s.generateBases = v; this.queueSave(); }));
    new Setting(containerEl).setName("下载封面").addToggle((t) => t.setValue(s.downloadCover).onChange(async (v) => { s.downloadCover = v; this.queueSave(); }));
    new Setting(containerEl).setName("下载图文图片").addToggle((t) => t.setValue(s.downloadImages).onChange(async (v) => { s.downloadImages = v; this.queueSave(); }));

    new Setting(containerEl).setName("请求通道（本地桥接）").setHeading();
    new Setting(containerEl)
      .setName("经本地桥接请求抖音")
      .setDesc("推荐开启：抖音 Argus 风控会拦截 Obsidian 直连请求；桥接用真实浏览器上下文代发，仅监听本机 127.0.0.1")
      .addToggle((t) => t.setValue(s.bridgeEnabled).onChange(async (v) => { s.bridgeEnabled = v; this.queueSave(); this.display(); }));
    if (s.bridgeEnabled) {
      new Setting(containerEl).setName("桥接地址").addText((t) => t.setValue(s.bridgeUrl).onChange(async (v) => { s.bridgeUrl = v.trim() || DEFAULT_SETTINGS.bridgeUrl; this.queueSave(); }));
      new Setting(containerEl).setName("Node 可执行文件路径").setDesc("桥接进程未运行时用于自动拉起；留空则用 PATH 里的 node（如 C:\\Program Files\\nodejs\\node.exe）；文件不存在时自动回退 PATH node 并警告").addText((t) => t.setValue(s.bridgeNodePath).onChange(async (v) => { s.bridgeNodePath = v.trim(); this.queueSave(); }));
      new Setting(containerEl).setName("playwright-core 所在 node_modules").setDesc("含 playwright-core 的 node_modules 目录，作为桥接进程的 NODE_PATH；留空则按常规 node 解析规则查找").addText((t) => t.setValue(s.bridgeNodeModules).onChange(async (v) => { s.bridgeNodeModules = v.trim(); this.queueSave(); }));
    }

    // ---------- 组件独立开关（四项新功能）：各组件开关与故障互不影响 ----------
    new Setting(containerEl).setName("桥接进程管控（组件开关）").setHeading();
    const pmToggle = new Setting(containerEl)
      .setName("启用桥接进程管控面板")
      .setDesc("插件内启动 / 停止 / 重启桥接，并实时显示「运行中 / 已停止 / 连接是否正常」二维状态")
      .addToggle((t) => t.setValue(s.bridgeProcessEnabled).onChange(async (v) => { s.bridgeProcessEnabled = v; this.queueSave(); }));
    this.attachLiveStatus(pmToggle.controlEl);
    new Setting(containerEl)
      .setName("Obsidian 启动时自动拉起桥接")
      .setDesc("默认关闭（你需要手动通过面板或控制台启动）")
      .addToggle((t) => t.setValue(s.processAutoStart).onChange(async (v) => { s.processAutoStart = v; this.queueSave(); }));
    new Setting(containerEl)
      .setName("状态刷新间隔（毫秒）")
      .setDesc("二维状态轮询间隔，上限 5000ms")
      // 不再 this.display()（2026-09-27 第四轮）：逐键重绘会让输入框敲第一个字符就失焦、
      // 半截输入被钳位覆盖；statusHub.restart() 已让间隔即时生效——但逐键 restart 仍会
      // 每键烧一次 /ping（第九轮 C11），同样进防抖
      .addText((t) => t.setValue(String(s.processRefreshMs)).onChange(async (v) => { const n = parseInt(v, 10); s.processRefreshMs = Number.isFinite(n) ? Math.max(1000, Math.min(5000, n)) : 5000; this.queueSave(); this.queueEffect(() => this.plugin.statusHub.restart()); }));

    new Setting(containerEl).setName("图片 OCR（组件开关）").setHeading();
    const ocrToggle = new Setting(containerEl)
      .setName("启用图片 OCR 独立入口")
      .setDesc("选择或拖拽本地图片，调用视觉模型识别图中文字，可复制或导出到当前笔记")
      .addToggle((t) => t.setValue(s.ocrPanelEnabled).onChange(async (v) => { s.ocrPanelEnabled = v; this.queueSave(); this.display(); }));
    this.attachLiveStatus(ocrToggle.controlEl);
    if (s.ocrPanelEnabled) {
      new Setting(containerEl)
        .setName("打开图片识别")
        .setDesc("选择本地图片并识别（也可用命令「图片文字识别」）")
        .addButton((b) => b.setButtonText("选择图片").onClick(() => void this.plugin.openOcr()));
      new Setting(containerEl).setName("Base URL").addText((t) => t.setValue(s.ocrBaseUrl).onChange(async (v) => { s.ocrBaseUrl = v.trim() || DEFAULT_SETTINGS.ocrBaseUrl; this.queueSave(); }));
      new Setting(containerEl).setName("API Key").addText((t) => { t.setValue(s.ocrApiKey).onChange(async (v) => { s.ocrApiKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl).setName("模型").addText((t) => t.setValue(s.ocrModelPrimary).onChange(async (v) => { s.ocrModelPrimary = v.trim() || DEFAULT_SETTINGS.ocrModelPrimary; this.queueSave(); }));
    }

    new Setting(containerEl).setName("AI 总结（组件开关）").setHeading();
    const sumToggle = new Setting(containerEl)
      .setName("启用 AI 摘要")
      .setDesc("对笔记中的逐字稿与图片文字生成摘要，写入 frontmatter summary 属性与正文摘要折叠块；原文逐字保留，绝不覆盖")
      .addToggle((t) => t.setValue(s.summaryEnabled).onChange(async (v) => { s.summaryEnabled = v; this.queueSave(); }));
    this.attachLiveStatus(sumToggle.controlEl);
    if (s.summaryEnabled) {
      new Setting(containerEl)
        .setName("为当前笔记生成摘要")
        .setDesc("也可用命令「为当前笔记生成 AI 摘要」")
        .addButton((b) => b.setButtonText("生成摘要").onClick(() => void this.plugin.summarizeActive()));
      // 非法回退 500→2000（第十四轮，与新默认同口径）
      new Setting(containerEl).setName("摘要长度上限（tokens）").addText((t) => t.setValue(String(s.summaryMaxTokens)).onChange(async (v) => { const n = parseInt(v, 10); s.summaryMaxTokens = Number.isFinite(n) ? Math.max(200, Math.min(4000, n)) : 2000; this.queueSave(); }));
    }

    new Setting(containerEl).setName("相关笔记互链").setHeading();
    new Setting(containerEl)
      .setName("同步时自动互链相关笔记")
      .setDesc("笔记文末维护「相关笔记」块：链接同分类/同作者的已同步笔记，被链接的笔记也会回链；历史笔记用「重建全部链接」一次性刷新。块由隐藏标记包裹、幂等更新，标记之外的内容绝不改动")
      .addToggle((t) => t.setValue(s.relatedNotesEnabled).onChange(async (v) => { s.relatedNotesEnabled = v; this.queueSave(); this.display(); }));
    if (s.relatedNotesEnabled) {
      new Setting(containerEl)
        .setName("每篇最多互链条数")
        .setDesc("同分类优先于同作者，同分时高赞优先（1~30，默认 8）")
        .addText((t) => { t.setValue(String(s.relatedNotesMax)).onChange(async (v) => { const n = parseInt(v, 10); s.relatedNotesMax = Number.isFinite(n) ? Math.max(1, Math.min(30, n)) : 8; this.queueSave(); }); });
      new Setting(containerEl)
        .setName("重建全部相关笔记链接")
        .setDesc("对全部已同步笔记重算互链块（无变化的笔记不写盘）；也可用命令「重建相关笔记链接」")
        .addButton((b) => b.setButtonText("开始重建").onClick(() => void this.plugin.rebuildRelatedNotes()));
    }

    new Setting(containerEl).setName("视频多模态总结（视频类收藏专用）").setHeading();
    new Setting(containerEl)
      .setName("同步时自动生成视频摘要")
      .addToggle((t) => t.setValue(s.videoSummaryEnabled).onChange(async (v) => { s.videoSummaryEnabled = v; this.queueSave(); this.display(); }));
    if (s.videoSummaryEnabled) {
      new Setting(containerEl)
        .setName("多模态总结模型")
        .setDesc("视觉理解模型名；智谱 GLM-4.6V-Flash 完全免费（配合下方专用 Base URL/Key）。走百炼必须填带版本号的模型（如 qwen3-vl-plus-2025-12-19）——裸名 qwen3-vl-plus 免费额度已耗尽会 403")
        .addText((t) => t.setValue(s.videoSummaryModel).onChange(async (v) => { s.videoSummaryModel = v.trim() || "qwen3-vl-plus-2025-12-19"; this.queueSave(); }));
      new Setting(containerEl)
        .setName("摘要风格")
        .setDesc("层级笔记体=主题标题+引言+分节+总结与意义（默认，存量摘要同款）；要点速览=核心观点+要点列表+金句；问答复习体=Q/A 问答对。切换只影响之后新生成的摘要，旧笔记用下方「补跑旧视频笔记」按新风格重出")
        .addDropdown((d) =>
          d
            .addOptions(SUMMARY_STYLE_LABELS)
            .setValue(s.videoSummaryStyle)
            .onChange(async (v) => {
              s.videoSummaryStyle = v as SummaryStyle;
              this.queueSave();
            }),
        );
      new Setting(containerEl)
        .setName("多模态 Base URL")
        .addText((t) => t.setValue(s.videoSummaryBaseUrl).onChange(async (v) => { s.videoSummaryBaseUrl = v.trim(); this.queueSave(); }));
      new Setting(containerEl)
        .setName("多模态 API Key")
        .addText((t) => { t.setValue(s.videoSummaryApiKey).onChange(async (v) => { s.videoSummaryApiKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl)
        .setName("抽帧间隔（秒）")
        .setDesc("每隔 N 秒抽一帧、按视频时长自适应：23 秒视频约 3 帧，10 分钟约 60 帧（上限 100 张）；帧图存于媒体目录 frames/<视频ID>/，改小不影响已抽取的帧")
        .addText((t) => { t.setValue(String(s.keyframeIntervalSec)).onChange(async (v) => { const n = parseInt(v, 10); s.keyframeIntervalSec = Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : 10; this.queueSave(); }); });
      new Setting(containerEl)
        .setName("补跑旧视频笔记")
        .setDesc("对已同步但缺转录/缺摘要/关键帧数少于当前设置的旧视频批量补跑（已有转录直接复用不重复计费；数量上限同「每次同步最多转写条数」）")
        .addButton((b) => b.setButtonText("开始补跑").onClick(() => void this.plugin.backfillVideos()));
    }

    new Setting(containerEl).setName("语音转写").setHeading();
    new Setting(containerEl)
      .setName("ASR 服务商")
      .setDesc("硅基流动 SenseVoice：本机 ffmpeg 抽取音频后上传（推荐，支持本地直链拉流）；其余为云端 URL 直传")
      .addDropdown((d) =>
        d
          .addOptions(ASR_PROVIDER_LABELS)
          .setValue(s.asrProvider)
          .onChange(async (v) => {
            s.asrProvider = v as AsrProviderKind;
            this.queueSave();
            this.display();
          }),
      );
    if (s.asrProvider === "siliconflow_sensevoice") {
      new Setting(containerEl)
        .setName("语音API Key")
        .setDesc("cloud.siliconflow.cn 创建；模型固定为 FunAudioLLM/SenseVoiceSmall（视频语音转录）")
        .addText((t) => { t.setValue(s.siliconflowKey).onChange(async (v) => { s.siliconflowKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl)
        .setName("语音Base URL")
        .setDesc("ASR 上传端点基址；默认 https://api.siliconflow.cn/v1，走中转代理时才需要改")
        .addText((t) => t.setValue(s.siliconflowBaseUrl).onChange(async (v) => { s.siliconflowBaseUrl = v.trim() || DEFAULT_SETTINGS.siliconflowBaseUrl; this.queueSave(); }));
      new Setting(containerEl)
        .setName("ffmpeg 路径")
        .setDesc('抽帧与音频抽取依赖；默认用 PATH 中的 ffmpeg（安装：winget install "FFmpeg (Gyan.FFmpeg)"）')
        .addText((t) => t.setValue(s.ffmpegPath).onChange(async (v) => { s.ffmpegPath = v.trim() || "ffmpeg"; this.queueSave(); }))
        .addButton((b) =>
          b.setButtonText("检测").onClick(async () => {
            new Notice("检测 ffmpeg 中…", 3000);
            const ver = await this.plugin.engine.checkFfmpeg(true); // force：设置页点「检测」必须重新探测（绕过缓存）
            new Notice(
              ver ? `ffmpeg 可用：${ver}` : `未检测到 ffmpeg。请安装：winget install "FFmpeg (Gyan.FFmpeg)"，或在上方填完整路径`,
              ver ? 5000 : 10000,
            );
          }),
        );
    }
    if (s.asrProvider === "dashscope_paraformer" || s.asrProvider === "dashscope_qwen3") {
      new Setting(containerEl).setName("百炼 DashScope API Key").setDesc("bailian.console.aliyun.com 开通模型服务后创建").addText((t) => { t.setValue(s.dashscopeKey).onChange(async (v) => { s.dashscopeKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl)
        .setName("百炼 DashScope Base URL")
        .setDesc("默认 https://dashscope.aliyuncs.com/api/v1；走中转代理时才需要改")
        .addText((t) => t.setValue(s.dashscopeBaseUrl).onChange(async (v) => { s.dashscopeBaseUrl = v.trim() || DEFAULT_SETTINGS.dashscopeBaseUrl; this.queueSave(); }));
      if (s.asrProvider === "dashscope_paraformer") {
        new Setting(containerEl)
          .setName("转写模型名")
          .setDesc("paraformer-v2（默认）｜fun-asr-mtl / fun-asr（独立 10 小时免费额度，31 语种）")
          .addText((t) => t.setValue(s.dashscopeModel).onChange(async (v) => { s.dashscopeModel = v.trim() || "paraformer-v2"; this.queueSave(); }));
      }
    }
    if (s.asrProvider === "volcengine") {
      new Setting(containerEl).setName("火山引擎 AppID").setDesc("控制台 - 语音技术 - 应用管理").addText((t) => t.setValue(s.volcAppId).onChange(async (v) => { s.volcAppId = v.trim(); this.queueSave(); }));
      new Setting(containerEl).setName("火山引擎 Access Token").addText((t) => { t.setValue(s.volcToken).onChange(async (v) => { s.volcToken = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl).setName("Cluster").addText((t) => t.setValue(s.volcCluster).onChange(async (v) => { s.volcCluster = v.trim() || "volcengine_auc_common"; this.queueSave(); }));
      new Setting(containerEl).setName("火山引擎 Base URL").setDesc("默认 https://openspeech.bytedance.com/api/v1").addText((t) => t.setValue(s.volcBaseUrl).onChange(async (v) => { s.volcBaseUrl = v.trim() || DEFAULT_SETTINGS.volcBaseUrl; this.queueSave(); }));
    }
    if (s.asrProvider === "tencent") {
      new Setting(containerEl).setName("腾讯云 SecretId").setDesc("控制台 - 访问管理 - API 密钥").addText((t) => t.setValue(s.tencentSecretId).onChange(async (v) => { s.tencentSecretId = v.trim(); this.queueSave(); }));
      new Setting(containerEl).setName("腾讯云 SecretKey").addText((t) => { t.setValue(s.tencentSecretKey).onChange(async (v) => { s.tencentSecretKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
      new Setting(containerEl).setName("腾讯云 ASR Base URL").setDesc("默认 https://asr.tencentcloudapi.com；TC3 签名 Host 随基址自动更新").addText((t) => t.setValue(s.tencentBaseUrl).onChange(async (v) => { s.tencentBaseUrl = v.trim() || DEFAULT_SETTINGS.tencentBaseUrl; this.queueSave(); }));
    }

    new Setting(containerEl).setName("AI（分类 / 图片文字识别，OpenAI 兼容接口）").setHeading();
    new Setting(containerEl).setName("API Base URL").addText((t) => t.setValue(s.aiBaseUrl).onChange(async (v) => { s.aiBaseUrl = v.trim() || DEFAULT_SETTINGS.aiBaseUrl; this.queueSave(); }));
    new Setting(containerEl).setName("API Key").addText((t) => { t.setValue(s.aiKey).onChange(async (v) => { s.aiKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
    new Setting(containerEl).setName("文本模型（自动分类）").addText((t) => t.setValue(s.aiModel).onChange(async (v) => { s.aiModel = v.trim() || "qwen-plus"; this.queueSave(); }));
    new Setting(containerEl).setName("启用 AI 自动分类").addToggle((t) => t.setValue(s.enableCategory).onChange(async (v) => { s.enableCategory = v; this.queueSave(); }));
    new Setting(containerEl)
      .setName("分类列表")
      .setDesc("每行一个；AI 只会从中选择")
      .addTextArea((t) => {
        t.setValue(s.aiCategories).onChange(async (v) => { s.aiCategories = v; this.queueSave(); });
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
      });
    new Setting(containerEl).setName("启用图片文字识别").setDesc("图文笔记逐张交给视觉模型，写入「图片文字」折叠块").addToggle((t) => t.setValue(s.enableVision).onChange(async (v) => { s.enableVision = v; this.queueSave(); }));
    new Setting(containerEl).setName("视觉模型").addText((t) => t.setValue(s.visionModel).onChange(async (v) => { s.visionModel = v.trim() || "qwen-vl-plus"; this.queueSave(); }));
    new Setting(containerEl)
      .setName("OCR 独立通道（基址）")
      .addText((t) => t.setValue(s.visionBaseUrl).onChange(async (v) => { s.visionBaseUrl = v.trim(); this.queueSave(); }));
    new Setting(containerEl)
      .setName("OCR 独立通道（Key）")
      .addText((t) => { t.setValue(s.visionApiKey).onChange(async (v) => { s.visionApiKey = v.trim(); this.queueSave(); }); t.inputEl.type = "password"; });
    new Setting(containerEl)
      .setName("OCR 全局并发")
      .setDesc("跨条目统一的 OCR 请求上限，建议 2~3。条目级并发 × 图片级并发会把请求数放大，反而让对方过载、单张更慢")
      .addText((t) => t.setValue(String(s.visionConcurrency)).onChange(async (v) => {
        const n = parseInt(v, 10);
        s.visionConcurrency = Number.isFinite(n) && n >= 1 ? Math.min(n, 6) : 3;
        this.queueSave();
      }));
    new Setting(containerEl).setName("每篇最多识别图片数").setDesc("上限 10").addText((t) => { t.setValue(String(s.maxImages)).onChange(async (v) => { const n = parseInt(v, 10); s.maxImages = Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 10; this.queueSave(); }); });

    new Setting(containerEl).setName("维护").setHeading();
    new Setting(containerEl)
      .setName("重置同步状态")
      .setDesc("清空已同步记录与待重试队列（不删除已有笔记）；下次同步将重新全量扫描")
      .addButton((b) =>
        b.setButtonText("重置").onClick(async () => {
          // 运行中守卫（2026-09-27 第四轮）：同步进行中重置会清掉刚写的台账，在途条目继续
          // 写入新台账 → 下轮对同批条目重复下载、重复 ASR 计费
          if (this.plugin.engine.running) {
            this.plugin.showResult("同步正在进行中，请等本轮结束后再重置", true);
            return;
          }
          this.plugin.engine.resetState();
          this.queueSave();
          this.plugin.showResult("同步状态已重置");
        }),
      );
  }
}
