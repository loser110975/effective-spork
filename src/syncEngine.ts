import { App, Notice, TFile, normalizePath } from "obsidian";
import { DouyinClient } from "./douyinClient";
import { createAsrProvider } from "./asr";
import { AiClient } from "./ai";
import { MediaStore } from "./media";
import { generateBases } from "./bases";
import { buildNote, planNotePath } from "./noteBuilder";
import {
  DouyinSyncSettings,
  SyncState,
  SyncItem,
  AsrResult,
  SOURCE_LABEL,
} from "./types";
import { nowIso, parseList, noteTitleFor, sleep, sanitizeFilename } from "./util";

export interface SyncSummary {
  total: number;
  created: number;
  skipped: number;
  transcribed: number;
  asrFailed: number;
  visionOk: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

export class SyncEngine {
  state: SyncState = { processed: {}, pendingAsr: [], pendingVision: [] };
  running = false;
  private client: DouyinClient;
  private media: MediaStore;
  private ai: AiClient | null = null;

  constructor(
    private app: App,
    private settings: DouyinSyncSettings,
    private onStateChange: () => Promise<void>,
    private onStatus: (text: string) => void,
    private spawnBridge?: () => Promise<void>,
  ) {
    this.client = new DouyinClient(
      settings.cookie,
      settings.bridgeEnabled ? settings.bridgeUrl : undefined,
      spawnBridge,
    );
    this.media = new MediaStore(app.vault, settings.mediaFolder);
    if (settings.aiKey || settings.dashscopeKey) {
      this.ai = new AiClient(settings.aiBaseUrl, settings.aiKey || settings.dashscopeKey, settings.aiModel);
      this.ai.setVisionModel(settings.visionModel);
    }
  }

  setSettings(s: DouyinSyncSettings) {
    this.settings = s;
    this.client = new DouyinClient(
      s.cookie,
      s.bridgeEnabled ? s.bridgeUrl : undefined,
      this.spawnBridge,
    );
    this.media = new MediaStore(this.app.vault, s.mediaFolder);
    this.ai = (s.aiKey || s.dashscopeKey) ? new AiClient(s.aiBaseUrl, s.aiKey || s.dashscopeKey, s.aiModel) : null;
    this.ai?.setVisionModel(s.visionModel);
  }

  async loadState(raw: unknown) {
    if (raw && typeof raw === "object") {
      const s = raw as Partial<SyncState>;
      this.state = {
        processed: s.processed ?? {},
        pendingAsr: s.pendingAsr ?? [],
        pendingVision: s.pendingVision ?? [],
        lastSyncAt: s.lastSyncAt,
        lastSyncSummary: s.lastSyncSummary,
        fullSyncedAt: s.fullSyncedAt,
      };
    }
  }

  resetState() {
    this.state = { processed: {}, pendingAsr: [], pendingVision: [] };
    void this.onStateChange();
  }

  private async saveState() {
    await this.onStateChange();
  }

  // ---------- 主入口 ----------

  async syncAll(): Promise<SyncSummary> {
    if (this.running) throw new Error("同步正在进行中");
    this.running = true;
    const summary: SyncSummary = {
      total: 0,
      created: 0,
      skipped: 0,
      transcribed: 0,
      asrFailed: 0,
      visionOk: 0,
      errors: [],
      startedAt: nowIso(),
      finishedAt: "",
    };
    const notice = new Notice("抖音同步：开始…", 0);
    try {
      let asrBudget = this.settings.maxTranscribePerSync;

      // 1) 重试上次失败的转写
      asrBudget = await this.retryPendingAsr(asrBudget, summary, notice);

      const whitelist = parseList(this.settings.folderWhitelist);

      // 2) 收藏（收藏夹模式）
      if (this.settings.syncCollection) {
        let folderOk = false;
        if (this.settings.useFolderMode) {
          try {
            const folders = await this.client.listFolders(0, 100);
            const targets = whitelist.length ? folders.filter((f) => whitelist.includes(f.name)) : folders;
            if (folders.length === 0) {
              summary.errors.push("收藏夹列表为空（可能无收藏夹或接口变更）");
            }
            for (const f of targets) {
              this.onStatus(`同步收藏夹：${f.name}`);
              const n = await this.syncCollectionFolder(f.id, f.name, summary, notice);
              notice.setMessage(`抖音同步：收藏夹「${f.name}」新增 ${n}`);
            }
            folderOk = targets.length > 0 || whitelist.length > 0;
          } catch (e: any) {
            summary.errors.push(`收藏夹模式失败：${e?.message ?? e}`);
          }
        }
        // 3) 扁平兜底（无白名单时；或收藏夹模式失败时）
        if (!folderOk || !this.settings.useFolderMode || whitelist.length === 0) {
          this.onStatus("同步收藏（扁平）");
          await this.syncFlat("collection", "未分类", summary, notice);
        }
      }

      // 4) 喜欢 / 作品
      if (this.settings.syncLike || this.settings.syncPost) {
        try {
          const secUid = await this.client.getSelfSecUid();
          if (this.settings.syncLike) {
            this.onStatus("同步喜欢列表");
            await this.syncPaged(
              (cursor, count) => this.client.listLikes(secUid, cursor, count),
              summary,
              notice,
              "like",
            );
          }
          if (this.settings.syncPost) {
            this.onStatus("同步作品列表");
            await this.syncPaged(
              (cursor, count) => this.client.listPosts(secUid, cursor, count),
              summary,
              notice,
              "post",
            );
          }
        } catch (e: any) {
          summary.errors.push(`喜欢/作品同步失败：${e?.message ?? e}`);
        }
      }

      // 5) Bases
      if (this.settings.generateBases) {
        try {
          const n = await generateBases(this.app.vault, this.settings.basesFolder);
          if (n > 0) summary.errors.push(`已生成 ${n} 个 Bases 文件`);
        } catch (e: any) {
          summary.errors.push(`Bases 生成失败：${e?.message ?? e}`);
        }
      }

      summary.finishedAt = nowIso();
      this.state.lastSyncAt = summary.finishedAt;
      this.state.lastSyncSummary = `新增 ${summary.created} / 转写 ${summary.transcribed} / 失败 ${summary.asrFailed}`;
      await this.saveState();

      const msg =
        `抖音同步完成：新增 ${summary.created}，跳过 ${summary.skipped}，` +
        `转写成功 ${summary.transcribed}，转写失败 ${summary.asrFailed}` +
        (summary.errors.length ? `。注意：${summary.errors[0]}` : "");
      notice.setMessage(msg);
      setTimeout(() => notice.hide(), 6000);
      this.onStatus(`上次同步 ${new Date().toLocaleTimeString("zh-CN")}`);
      return summary;
    } catch (e: any) {
      notice.setMessage(`抖音同步失败：${e?.message ?? e}`);
      setTimeout(() => notice.hide(), 8000);
      summary.errors.push(String(e?.message ?? e));
      summary.finishedAt = nowIso();
      return summary;
    } finally {
      this.running = false;
    }
  }

  // ---------- 分页 ----------

  private async syncCollectionFolder(
    folderId: string,
    folderName: string,
    summary: SyncSummary,
    notice: Notice,
  ): Promise<number> {
    let cursor = 0;
    let created = 0;
    let processedStreak = 0;
    for (let page = 0; page < 200; page++) {
      const res = await this.client.listFolderItems(folderId, cursor, 20);
      summary.total += res.items.length;
      for (const raw of res.items) {
        const item = DouyinClient.normalize(raw, "collection");
        if (!item) continue;
        if (this.state.processed[item.id]) {
          processedStreak++;
          summary.skipped++;
          continue;
        }
        processedStreak = 0;
        if (await this.processItem(item, folderName, summary, notice)) created++;
        await sleep(300);
      }
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
    return created;
  }

  private async syncFlat(
    _source: "collection",
    defaultFolder: string,
    summary: SyncSummary,
    notice: Notice,
  ): Promise<void> {
    let cursor = 0;
    let processedStreak = 0;
    for (let page = 0; page < 500; page++) {
      const res = await this.client.listCollection(cursor, 20);
      summary.total += res.items.length;
      for (const raw of res.items) {
        const item = DouyinClient.normalize(raw, "collection");
        if (!item) continue;
        if (this.state.processed[item.id]) {
          processedStreak++;
          summary.skipped++;
          continue;
        }
        processedStreak = 0;
        await this.processItem(item, defaultFolder, summary, notice);
        await sleep(300);
      }
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
  }

  private async syncPaged(
    fetcher: (cursor: number, count: number) => Promise<{ hasMore: boolean; cursor?: number; items: any[] }>,
    summary: SyncSummary,
    notice: Notice,
    source: SyncItem["source"],
  ): Promise<void> {
    let cursor = 0;
    let processedStreak = 0;
    for (let page = 0; page < 500; page++) {
      const res = await fetcher(cursor, 20);
      summary.total += res.items.length;
      for (const raw of res.items) {
        const item = DouyinClient.normalize(raw, source);
        if (!item) continue;
        if (this.state.processed[item.id]) {
          processedStreak++;
          summary.skipped++;
          continue;
        }
        processedStreak = 0;
        await this.processItem(item, "", summary, notice);
        await sleep(300);
      }
      if (processedStreak >= this.settings.scanStopAfterProcessed) break;
      if (!res.hasMore || res.items.length === 0) break;
      cursor = res.cursor ?? cursor + 20;
      await sleep(600);
    }
  }

  // ---------- 单条处理 ----------

  private async processItem(
    item: SyncItem,
    folder: string,
    summary: SyncSummary,
    notice: Notice,
    overwritePath?: string,
  ): Promise<boolean> {
    try {
      notice.setMessage(`抖音同步：处理 ${noteTitleFor(item.title, item.id).slice(0, 24)}`);

      // 封面
      let coverPath = "";
      if (this.settings.downloadCover && item.coverUrl) {
        coverPath = await this.media.saveImage(item.coverUrl, `cover/${item.id}`);
      }

      // 图文图片
      const imagesDownloaded: string[] = [];
      if (item.type === "note" && this.settings.downloadImages) {
        const n = Math.min(item.imageUrls.length, this.settings.maxImages);
        for (let i = 0; i < n; i++) {
          const p = await this.media.saveImage(item.imageUrls[i], `images/${item.id}/${i + 1}`);
          if (p) imagesDownloaded.push(p);
          await sleep(200);
        }
      }

      // 图片文字识别
      const visionTexts: { index: number; text: string; status: string }[] = [];
      if (item.type === "note" && this.settings.enableVision && this.ai && item.imageUrls.length > 0) {
        const n = Math.min(item.imageUrls.length, this.settings.maxImages);
        for (let i = 0; i < n; i++) {
          try {
            let text = "";
            try {
              text = await this.ai.ocrImage(item.imageUrls[i], item.title);
            } catch {
              // CDN 直连失败 → 下载转 base64 兜底
              const dataUrl = await this.media.toDataUrl(item.imageUrls[i]);
              if (dataUrl) text = await this.ai.ocrImage(dataUrl, item.title);
            }
            visionTexts.push({ index: i + 1, text, status: text ? "识别成功" : "未识别" });
            if (text) summary.visionOk++;
          } catch (e: any) {
            visionTexts.push({ index: i + 1, text: "", status: `识别失败：${String(e?.message ?? e).slice(0, 60)}` });
          }
          await sleep(300);
        }
      }

      // ASR 逐字稿
      let asr: AsrResult | null = null;
      if (item.type === "video" && this.settings.asrProvider !== "none") {
        const provider = createAsrProvider(this.settings);
        if (provider && item.playUrl) {
          asr = await provider.transcribe(item.playUrl);
          if (asr.status === "success") {
            summary.transcribed++;
          } else {
            summary.asrFailed++;
            if (!this.state.pendingAsr.includes(item.id)) this.state.pendingAsr.push(item.id);
          }
        } else if (!item.playUrl) {
          asr = { status: "unavailable", transcript: "", error: "无播放地址" };
        }
      }

      // AI 分类
      let category = "未分类";
      if (this.settings.enableCategory && this.ai) {
        const cats = parseList(this.settings.aiCategories);
        if (cats.length > 0) {
          try {
            category = await this.ai.categorize(cats, item.title, item.desc, asr?.transcript ?? "");
          } catch (e: any) {
            summary.errors.push(`分类失败：${String(e?.message ?? e).slice(0, 80)}`);
          }
        }
      }

      // 写笔记
      const title = noteTitleFor(item.title, item.id);
      const path = overwritePath ?? planNotePath(this.settings.rootFolder, item, folder, title);
      const content = buildNote({
        item,
        folder,
        category,
        coverPath,
        imagePathPrefix: "",
        imagesDownloaded,
        visionTexts,
        asr,
        syncedAt: nowIso(),
      });
      await this.writeNoteFile(path, content, overwritePath);

      this.state.processed[item.id] = {
        path,
        syncedAt: nowIso(),
        folder: folder || SOURCE_LABEL[item.source],
        asrStatus: asr?.status,
      };
      // 转写成功的从待重试队列移除
      if (asr?.status === "success") {
        this.state.pendingAsr = this.state.pendingAsr.filter((x) => x !== item.id);
      }
      await this.saveState();
      summary.created++;
      return true;
    } catch (e: any) {
      summary.errors.push(`[${item.id}] ${String(e?.message ?? e).slice(0, 100)}`);
      return false;
    }
  }

  private async writeNoteFile(path: string, content: string, overwrite?: string): Promise<void> {
    const normalized = normalizePath(path);
    if (overwrite) {
      const f = this.app.vault.getAbstractFileByPath(normalized);
      if (f instanceof TFile) {
        await this.app.vault.process(f, () => content);
        return;
      }
    }
    await this.ensureParent(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, () => content);
    } else {
      await this.app.vault.create(normalized, content);
    }
  }

  private async ensureParent(path: string) {
    const idx = path.lastIndexOf("/");
    if (idx > 0) {
      const { ensureFolder } = await import("./media");
      await ensureFolder(this.app.vault, path.slice(0, idx));
    }
  }

  // ---------- 重试转写 ----------

  private async retryPendingAsr(budget: number, summary: SyncSummary, notice: Notice): Promise<number> {
    if (this.state.pendingAsr.length === 0 || budget <= 0 || this.settings.asrProvider === "none") {
      return budget;
    }
    const ids = [...this.state.pendingAsr].slice(0, budget);
    for (const id of ids) {
      const entry = this.state.processed[id];
      if (!entry || !entry.path) continue;
      notice.setMessage(`抖音同步：重试转写 ${id}`);
      try {
        const raw = await this.client.getAwemeDetail(id);
        if (!raw) {
          summary.errors.push(`重试转写：无法获取详情 ${id}`);
          continue;
        }
        const item = DouyinClient.normalize(raw, "collection");
        if (!item || item.type !== "video") continue;
        const provider = createAsrProvider(this.settings);
        if (!provider) continue;
        const asr = await provider.transcribe(item.playUrl);
        if (asr.status === "success") {
          summary.transcribed++;
          // 重新生成笔记（保留路径）
          await this.processItem(item, entry.folder, summary, notice, entry.path);
          this.state.processed[id].asrStatus = "success";
          this.state.pendingAsr = this.state.pendingAsr.filter((x) => x !== id);
          await this.saveState();
        } else {
          summary.asrFailed++;
        }
        budget--;
        await sleep(1000);
      } catch (e: any) {
        summary.errors.push(`重试转写 ${id}：${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
    return budget;
  }
}
