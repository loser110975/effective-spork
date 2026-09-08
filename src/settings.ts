import { App, PluginSettingTab, Setting } from "obsidian";
import type DouyinSyncPlugin from "./main";
import { ASR_PROVIDER_LABELS } from "./asr";
import { AsrProviderKind, DEFAULT_SETTINGS } from "./types";

export class DouyinSyncSettingTab extends PluginSettingTab {
  plugin: DouyinSyncPlugin;

  constructor(app: App, plugin: DouyinSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("连接").setHeading();
    new Setting(containerEl)
      .setName("抖音 Cookie")
      .setDesc(
        "浏览器打开 douyin.com 并登录 → F12 开发者工具 → Network → 随便点一个 douyin.com 的请求 → 复制 Request Headers 里完整的 Cookie 值粘贴到这里（必须包含 sessionid，document.cookie 拿不到 HttpOnly 字段）。Cookie 过期后重新复制即可。",
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
      .setDesc("控制 ASR 费用；未转写的进入队列，下次同步自动续传")
      .addText((t) => t.setValue(String(s.maxTranscribePerSync)).onChange(async (v) => { const n = parseInt(v, 10); s.maxTranscribePerSync = Number.isFinite(n) && n >= 0 ? n : 20; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("增量扫描提前停止阈值")
      .setDesc("连续遇到 N 条已同步的笔记就停止翻页；首次全量同步不受影响")
      .addText((t) => t.setValue(String(s.scanStopAfterProcessed)).onChange(async (v) => { const n = parseInt(v, 10); s.scanStopAfterProcessed = Number.isFinite(n) && n >= 20 ? n : 100; await this.plugin.saveSettings(); }));

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
      new Setting(containerEl).setName("Node 可执行文件路径").setDesc("桥接进程未运行时用于自动拉起").addText((t) => t.setValue(s.bridgeNodePath).onChange(async (v) => { s.bridgeNodePath = v.trim(); await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("playwright-core 所在 node_modules").setDesc("桥接进程的 NODE_PATH").addText((t) => t.setValue(s.bridgeNodeModules).onChange(async (v) => { s.bridgeNodeModules = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(containerEl).setName("语音转写（云端 URL 直传，本地不下载不上传）").setHeading();
    new Setting(containerEl)
      .setName("ASR 服务商")
      .setDesc("视频链接直接交给云端服务拉取转写，本机不经手音视频文件")
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
    if (s.asrProvider === "dashscope_paraformer" || s.asrProvider === "dashscope_qwen3") {
      new Setting(containerEl).setName("百炼 DashScope API Key").setDesc("bailian.console.aliyun.com 开通模型服务后创建").addText((t) => t.setValue(s.dashscopeKey).onChange(async (v) => { s.dashscopeKey = v.trim(); await this.plugin.saveSettings(); }));
      if (s.asrProvider === "dashscope_paraformer") {
        new Setting(containerEl).setName("Paraformer 模型名").addText((t) => t.setValue(s.dashscopeModel).onChange(async (v) => { s.dashscopeModel = v.trim() || "paraformer-v2"; await this.plugin.saveSettings(); }));
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
