import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DouyinSyncPlugin from "./main";
import { ASR_PROVIDER_LABELS } from "./asr";
import { AsrProviderKind, DEFAULT_SETTINGS } from "./types";
import { statusVisual } from "./statusCore";

export class DouyinSyncSettingTab extends PluginSettingTab {
  plugin: DouyinSyncPlugin;
  /** 实时状态行订阅（display() 重建时清理，防泄漏） */
  private statusUnsubs: (() => void)[] = [];

  constructor(app: App, plugin: DouyinSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
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
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("连接").setHeading();
    new Setting(containerEl)
      .setName("抖音 Cookie")
      .setDesc(
        "浏览器打开 douyin.com 并登录 → F12 开发者工具 → Network → 随便点一个 douyin.com 的请求 → 复制 Request Headers 里完整的 Cookie 值粘贴到这里（必须包含 sessionid，document.cookie 拿不到 HttpOnly 字段）。Cookie 过期后重新复制即可。" +
          "⚠️ 安全提示：Cookie 以明文存放在本机 data.json 中；若 Vault 使用 iCloud / Git / 云盘同步，请把 data.json 排除在同步范围外，避免凭据随 Vault 外传。",
      )
      .addText((t) =>
        t
          .setPlaceholder("sessionid=…; ttwid=…; …")
          .setValue(s.cookie)
          .onChange(async (v) => {
            s.cookie = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("按当前请求通道调一次收藏接口，验证登录态、桥接与接口可用性")
      .addButton((b) =>
        b.setButtonText("测试").onClick(() => void this.plugin.testDouyinConnection()),
      );

    new Setting(containerEl).setName("同步范围").setHeading();
    new Setting(containerEl).setName("同步收藏").addToggle((t) => t.setValue(s.syncCollection).onChange(async (v) => { s.syncCollection = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("按收藏夹建子目录")
      .setDesc("开启后收藏按收藏夹生成子目录")
      .addToggle((t) => t.setValue(s.useFolderMode).onChange(async (v) => { s.useFolderMode = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("收藏夹白名单")
      .setDesc("逗号分隔的收藏夹名称；留空=同步全部收藏夹")
      .addText((t) => t.setValue(s.folderWhitelist).onChange(async (v) => { s.folderWhitelist = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("同步喜欢（点赞）").addToggle((t) => t.setValue(s.syncLike).onChange(async (v) => { s.syncLike = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("同步作品").addToggle((t) => t.setValue(s.syncPost).onChange(async (v) => { s.syncPost = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("定时同步间隔（分钟）")
      .setDesc("0 = 关闭定时，仅手动同步；建议 60")
      .addText((t) =>
        t.setValue(String(s.syncIntervalMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.syncIntervalMinutes = Number.isFinite(n) && n >= 0 ? n : 60;
          await this.plugin.saveSettings();
          this.plugin.restartInterval();
        }),
      );
    new Setting(containerEl)
      .setName("每次同步最多转写条数")
      .setDesc("控制 ASR 费用；未转写的进入队列，下次同步自动续传。建议 ≤ 30：单条视频（下载+抽帧+转写+摘要）约需 1~3 分钟，额度设过大会让单次同步长时间占用不结束")
      .addText((t) => t.setValue(String(s.maxTranscribePerSync)).onChange(async (v) => { const n = parseInt(v, 10); s.maxTranscribePerSync = Number.isFinite(n) && n >= 0 ? n : 20; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("增量扫描提前停止阈值")
      .setDesc("连续遇到 N 条已同步的笔记就停止翻页；首次全量同步不受影响")
      .addText((t) => t.setValue(String(s.scanStopAfterProcessed)).onChange(async (v) => { const n = parseInt(v, 10); s.scanStopAfterProcessed = Number.isFinite(n) && n >= 20 ? n : 100; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("同步并发条数")
      .setDesc("同时处理的条目数（1 = 完全串行）。单条耗时几乎都在等待下载与云端推理，建议 3；调高可提升整体吞吐，但会加大抖音与 AI 接口压力。列表翻页始终串行")
      .addText((t) => t.setValue(String(s.syncConcurrency)).onChange(async (v) => {
        const n = parseInt(v, 10);
        s.syncConcurrency = Number.isFinite(n) && n >= 1 ? Math.min(n, 6) : 3;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName("路径").setHeading();
    new Setting(containerEl).setName("笔记根目录").addText((t) => t.setValue(s.rootFolder).onChange(async (v) => { s.rootFolder = v.trim() || "抖音"; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("媒体目录")
      .setDesc("封面与图片存放位置（兼容 Obsidian Sync / iCloud / Git）")
      .addText((t) => t.setValue(s.mediaFolder).onChange(async (v) => { s.mediaFolder = v.trim() || "抖音/Media"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Bases 目录").addText((t) => t.setValue(s.basesFolder).onChange(async (v) => { s.basesFolder = v.trim() || "抖音/Bases"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("同步后生成 Bases 画廊").setDesc("封面墙 / 分类画廊 / 爆款排行 / 最近7天（需 Obsidian 1.9+，已存在的不覆盖）").addToggle((t) => t.setValue(s.generateBases).onChange(async (v) => { s.generateBases = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("下载封面").addToggle((t) => t.setValue(s.downloadCover).onChange(async (v) => { s.downloadCover = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("下载图文图片").addToggle((t) => t.setValue(s.downloadImages).onChange(async (v) => { s.downloadImages = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("请求通道（本地桥接）").setHeading();
    new Setting(containerEl)
      .setName("经本地桥接请求抖音")
      .setDesc("推荐开启：抖音 Argus 风控会拦截 Obsidian 直连请求；桥接用真实浏览器上下文代发，仅监听本机 127.0.0.1")
      .addToggle((t) => t.setValue(s.bridgeEnabled).onChange(async (v) => { s.bridgeEnabled = v; await this.plugin.saveSettings(); this.display(); }));
    if (s.bridgeEnabled) {
      new Setting(containerEl).setName("桥接地址").addText((t) => t.setValue(s.bridgeUrl).onChange(async (v) => { s.bridgeUrl = v.trim() || DEFAULT_SETTINGS.bridgeUrl; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("Node 可执行文件路径").setDesc("桥接进程未运行时用于自动拉起；留空则用 PATH 里的 node（如 C:\\Program Files\\nodejs\\node.exe）").addText((t) => t.setValue(s.bridgeNodePath).onChange(async (v) => { s.bridgeNodePath = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("playwright-core 所在 node_modules").setDesc("含 playwright-core 的 node_modules 目录，作为桥接进程的 NODE_PATH；留空则按常规 node 解析规则查找").addText((t) => t.setValue(s.bridgeNodeModules).onChange(async (v) => { s.bridgeNodeModules = v.trim(); await this.plugin.saveSettings(); }));
    }

    // ---------- 组件独立开关（四项新功能）：各组件开关与故障互不影响 ----------
    new Setting(containerEl).setName("桥接进程管控（组件开关）").setHeading();
    const pmToggle = new Setting(containerEl)
      .setName("启用桥接进程管控面板")
      .setDesc("插件内启动 / 停止 / 重启桥接，并实时显示「运行中 / 已停止 / 连接是否正常」二维状态")
      .addToggle((t) => t.setValue(s.bridgeProcessEnabled).onChange(async (v) => { s.bridgeProcessEnabled = v; await this.plugin.saveSettings(); }));
    this.attachLiveStatus(pmToggle.controlEl);
    new Setting(containerEl)
      .setName("Obsidian 启动时自动拉起桥接")
      .setDesc("默认关闭（你需要手动通过面板或控制台启动）")
      .addToggle((t) => t.setValue(s.processAutoStart).onChange(async (v) => { s.processAutoStart = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("状态刷新间隔（毫秒）")
      .setDesc("二维状态轮询间隔，上限 5000ms")
      .addText((t) => t.setValue(String(s.processRefreshMs)).onChange(async (v) => { const n = parseInt(v, 10); s.processRefreshMs = Number.isFinite(n) ? Math.max(1000, Math.min(5000, n)) : 5000; await this.plugin.saveSettings(); this.display(); }));

    new Setting(containerEl).setName("图片 OCR（组件开关）").setHeading();
    const ocrToggle = new Setting(containerEl)
      .setName("启用图片 OCR 独立入口")
      .setDesc("选择或拖拽本地图片，调用视觉模型识别图中文字，可复制或导出到当前笔记")
      .addToggle((t) => t.setValue(s.ocrPanelEnabled).onChange(async (v) => { s.ocrPanelEnabled = v; await this.plugin.saveSettings(); this.display(); }));
    this.attachLiveStatus(ocrToggle.controlEl);
    if (s.ocrPanelEnabled) {
      new Setting(containerEl)
        .setName("打开图片识别")
        .setDesc("选择本地图片并识别（也可用命令「图片文字识别」）")
        .addButton((b) => b.setButtonText("选择图片").onClick(() => void this.plugin.openOcr()));
      new Setting(containerEl).setName("主通道 Base URL（Agnes）").setDesc("如 https://api.agnes-ai.cn/v1 或 https://apihub.agnes-ai.com/v1").addText((t) => t.setValue(s.ocrBaseUrl).onChange(async (v) => { s.ocrBaseUrl = v.trim() || DEFAULT_SETTINGS.ocrBaseUrl; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("主通道 API Key（Agnes）").setDesc("留空则复用下方 AI Key").addText((t) => t.setValue(s.ocrApiKey).onChange(async (v) => { s.ocrApiKey = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("主通道模型").addText((t) => t.setValue(s.ocrModelPrimary).onChange(async (v) => { s.ocrModelPrimary = v.trim() || DEFAULT_SETTINGS.ocrModelPrimary; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("兜底模型").setDesc("主通道失败并经你确认后才调用（付费）").addText((t) => t.setValue(s.ocrModelFallback).onChange(async (v) => { s.ocrModelFallback = v.trim() || DEFAULT_SETTINGS.ocrModelFallback; await this.plugin.saveSettings(); }));
      new Setting(containerEl)
        .setName("允许付费兜底通道")
        .setDesc("开启后主通道失败会弹窗询问「是否改用付费通道重试」；关闭则完全不使用付费通道。任何兜底调用都必须经你确认，绝不自动回退")
        .addToggle((t) => t.setValue(s.ocrFallbackEnabled).onChange(async (v) => { s.ocrFallbackEnabled = v; await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName("AI 总结（组件开关）").setHeading();
    const sumToggle = new Setting(containerEl)
      .setName("启用 AI 摘要")
      .setDesc("对笔记中的逐字稿与图片文字生成摘要，写入 frontmatter summary 属性与正文摘要折叠块；原文逐字保留，绝不覆盖")
      .addToggle((t) => t.setValue(s.summaryEnabled).onChange(async (v) => { s.summaryEnabled = v; await this.plugin.saveSettings(); }));
    this.attachLiveStatus(sumToggle.controlEl);
    if (s.summaryEnabled) {
      new Setting(containerEl)
        .setName("为当前笔记生成摘要")
        .setDesc("也可用命令「为当前笔记生成 AI 摘要」")
        .addButton((b) => b.setButtonText("生成摘要").onClick(() => void this.plugin.summarizeActive()));
      new Setting(containerEl).setName("摘要长度上限（tokens）").addText((t) => t.setValue(String(s.summaryMaxTokens)).onChange(async (v) => { const n = parseInt(v, 10); s.summaryMaxTokens = Number.isFinite(n) ? Math.max(200, Math.min(4000, n)) : 500; await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName("视频多模态总结（视频类收藏专用）").setHeading();
    new Setting(containerEl)
      .setName("同步时自动生成视频摘要")
      .setDesc("新视频完成转录+抽帧后，自动把转录文字与关键帧图片一并交给百炼多模态模型，生成带配图的摘要；图文类收藏不受影响")
      .addToggle((t) => t.setValue(s.videoSummaryEnabled).onChange(async (v) => { s.videoSummaryEnabled = v; await this.plugin.saveSettings(); this.display(); }));
    if (s.videoSummaryEnabled) {
      new Setting(containerEl)
        .setName("多模态总结模型")
        .setDesc("视觉理解模型名；智谱 GLM-4.6V-Flash 完全免费（配合下方专用 Base URL/Key），百炼可选 qwen3-vl-plus / qwen-vl-plus 等")
        .addText((t) => t.setValue(s.videoSummaryModel).onChange(async (v) => { s.videoSummaryModel = v.trim() || "qwen3-vl-plus"; await this.plugin.saveSettings(); }));
      new Setting(containerEl)
        .setName("多模态 Base URL（可选）")
        .setDesc("留空复用上方 AI Base URL；接入智谱填 https://open.bigmodel.cn/api/paas/v4")
        .addText((t) => t.setValue(s.videoSummaryBaseUrl).onChange(async (v) => { s.videoSummaryBaseUrl = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl)
        .setName("多模态 API Key（可选）")
        .setDesc("留空复用上方 AI Key；接入智谱等独立服务时填对应 Key")
        .addText((t) => t.setValue(s.videoSummaryApiKey).onChange(async (v) => { s.videoSummaryApiKey = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl)
        .setName("抽帧间隔（秒）")
        .setDesc("每隔 N 秒抽一帧、按视频时长自适应：23 秒视频约 3 帧，10 分钟约 60 帧（上限 100 张）；帧图存于媒体目录 frames/<视频ID>/，改小不影响已抽取的帧")
        .addText((t) => { t.setValue(String(s.keyframeIntervalSec)).onChange(async (v) => { const n = parseInt(v, 10); s.keyframeIntervalSec = Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : 10; await this.plugin.saveSettings(); }); });
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
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    if (s.asrProvider === "siliconflow_sensevoice") {
      new Setting(containerEl)
        .setName("硅基流动 API Key")
        .setDesc("cloud.siliconflow.cn 创建；模型固定为 FunAudioLLM/SenseVoiceSmall（视频语音转录）")
        .addText((t) => t.setValue(s.siliconflowKey).onChange(async (v) => { s.siliconflowKey = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl)
        .setName("ffmpeg 路径")
        .setDesc('抽帧与音频抽取依赖；默认用 PATH 中的 ffmpeg（安装：winget install "FFmpeg (Gyan.FFmpeg)"）')
        .addText((t) => t.setValue(s.ffmpegPath).onChange(async (v) => { s.ffmpegPath = v.trim() || "ffmpeg"; await this.plugin.saveSettings(); }))
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
      new Setting(containerEl).setName("百炼 DashScope API Key").setDesc("bailian.console.aliyun.com 开通模型服务后创建").addText((t) => t.setValue(s.dashscopeKey).onChange(async (v) => { s.dashscopeKey = v.trim(); await this.plugin.saveSettings(); }));
      if (s.asrProvider === "dashscope_paraformer") {
        new Setting(containerEl)
          .setName("转写模型名")
          .setDesc("paraformer-v2（默认）｜fun-asr-mtl / fun-asr（独立 10 小时免费额度，31 语种）")
          .addText((t) => t.setValue(s.dashscopeModel).onChange(async (v) => { s.dashscopeModel = v.trim() || "paraformer-v2"; await this.plugin.saveSettings(); }));
      }
    }
    if (s.asrProvider === "volcengine") {
      new Setting(containerEl).setName("火山引擎 AppID").setDesc("控制台 - 语音技术 - 应用管理").addText((t) => t.setValue(s.volcAppId).onChange(async (v) => { s.volcAppId = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("火山引擎 Access Token").addText((t) => t.setValue(s.volcToken).onChange(async (v) => { s.volcToken = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("Cluster").addText((t) => t.setValue(s.volcCluster).onChange(async (v) => { s.volcCluster = v.trim() || "volcengine_auc_common"; await this.plugin.saveSettings(); }));
    }
    if (s.asrProvider === "tencent") {
      new Setting(containerEl).setName("腾讯云 SecretId").setDesc("控制台 - 访问管理 - API 密钥").addText((t) => t.setValue(s.tencentSecretId).onChange(async (v) => { s.tencentSecretId = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("腾讯云 SecretKey").addText((t) => t.setValue(s.tencentSecretKey).onChange(async (v) => { s.tencentSecretKey = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName("AI（分类 / 图片文字识别，OpenAI 兼容接口）").setHeading();
    new Setting(containerEl).setName("API Base URL").addText((t) => t.setValue(s.aiBaseUrl).onChange(async (v) => { s.aiBaseUrl = v.trim() || DEFAULT_SETTINGS.aiBaseUrl; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("API Key").setDesc("留空则自动复用上方百炼 DashScope Key（推荐）").addText((t) => t.setValue(s.aiKey).onChange(async (v) => { s.aiKey = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("文本模型（自动分类）").addText((t) => t.setValue(s.aiModel).onChange(async (v) => { s.aiModel = v.trim() || "qwen-plus"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("启用 AI 自动分类").addToggle((t) => t.setValue(s.enableCategory).onChange(async (v) => { s.enableCategory = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("分类列表")
      .setDesc("每行一个；AI 只会从中选择")
      .addTextArea((t) => {
        t.setValue(s.aiCategories).onChange(async (v) => { s.aiCategories = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
      });
    new Setting(containerEl).setName("启用图片文字识别").setDesc("图文笔记逐张交给视觉模型，写入「图片文字」折叠块").addToggle((t) => t.setValue(s.enableVision).onChange(async (v) => { s.enableVision = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("视觉模型").addText((t) => t.setValue(s.visionModel).onChange(async (v) => { s.visionModel = v.trim() || "qwen-vl-plus"; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("OCR 独立通道（基址）")
      .setDesc("留空则复用上面的 AI 基址。实测硅基流动的视觉模型高峰期会返回 503（System is too busy），把它切到百炼 compatible-mode 可显著改善")
      .addText((t) => t.setValue(s.visionBaseUrl).onChange(async (v) => { s.visionBaseUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("OCR 独立通道（Key）")
      .setDesc("留空则复用 AI Key / 百炼 Key")
      .addText((t) => { t.setValue(s.visionApiKey).onChange(async (v) => { s.visionApiKey = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.type = "password"; });
    new Setting(containerEl)
      .setName("OCR 全局并发")
      .setDesc("跨条目统一的 OCR 请求上限，建议 2~3。条目级并发 × 图片级并发会把请求数放大，反而让对方过载、单张更慢")
      .addText((t) => t.setValue(String(s.visionConcurrency)).onChange(async (v) => {
        const n = parseInt(v, 10);
        s.visionConcurrency = Number.isFinite(n) && n >= 1 ? Math.min(n, 6) : 3;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("每篇最多识别图片数").setDesc("上限 10").addText((t) => { t.setValue(String(s.maxImages)).onChange(async (v) => { const n = parseInt(v, 10); s.maxImages = Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 10; await this.plugin.saveSettings(); }); });

    new Setting(containerEl).setName("维护").setHeading();
    new Setting(containerEl)
      .setName("重置同步状态")
      .setDesc("清空已同步记录与待重试队列（不删除已有笔记）；下次同步将重新全量扫描")
      .addButton((b) =>
        b.setButtonText("重置").onClick(async () => {
          this.plugin.engine.resetState();
          await this.plugin.saveSettings();
          this.plugin.showResult("同步状态已重置");
        }),
      );
  }
}
