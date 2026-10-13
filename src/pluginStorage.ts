// pluginStorage.ts — 插件双文件持久化（2026-10 存储拆分轮）：
// 把单一 data.json {settings, state} 拆为 <pluginDir>/settings.json 与 <pluginDir>/state.json。
//
// 目标布局与写入口径（系统设计存储拆分轮）：
// - settings.json 载荷 = settings 对象本体；state.json 载荷 = state 对象本体；
// - 写入一律 .tmp 临时文件 + rename 原子替换，且各自维护 .bak 备份链（仿 data.json.bak 的
//   tmp→rename 两步备份，防「唯一好备份」被半截覆盖）；
// - 旧 data.json 只读不写，作为迁移回滚锚点原样保留。
//
// 读路径（load）：
// ① 双新文件齐全 → 读新（任一损坏先试各自 .bak / .bak.tmp 抢救，再回退旧 data.json + 警告）；
// ② 否则若旧 data.json 存在 → 自动迁移：按键域拆分（settings 域 / state 域）写双新文件，
//    data.json 原样保留，返回 migrated=true 供调用方 Notice 告知；
// ③ 都没有 → 全新安装（null/null）。
//
// 本模块只依赖窄适配器接口 KvAdapter（与 Obsidian DataAdapter 的文本方法子集结构兼容，
// Node 单测可注入内存实现）；settings/state 键域判定复用 settingsSanitize 的既有口径。
import { normalizePath } from "obsidian";
import { needsBackupRescue, payloadNeedsRescue, pickSettingsSource } from "./settingsSanitize";

/** 存储适配器窄接口（Obsidian DataAdapter 的文本方法子集；测试注入内存实现）。 */
export interface KvAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const SETTINGS_FILE = "settings.json";
export const STATE_FILE = "state.json";
export const LEGACY_FILE = "data.json";

/** 备份链最小间隔（毫秒）：与旧 maybeBackupData 同口径，落后主文件 ≤10 分钟可接受。 */
export const BAK_INTERVAL_MS = 10 * 60_000;

/** 单文件 JSON 读取结果：missing=文件不存在；ok=解析成功；corrupt=存在但不是合法 JSON。 */
export type FileReadResult =
  | { status: "missing" }
  | { status: "ok"; value: unknown }
  | { status: "corrupt" };

/** load() 的返回：settings/state 载荷（可能为 null=全新安装）、迁移标记与用户提示。 */
export interface SplitLoadResult {
  settings: unknown;
  state: unknown;
  /** 本次读取是否执行了「data.json → 双新文件」迁移 */
  migrated: boolean;
  /** 需要以 Notice 呈现给用户的提示（迁移完成 / 损坏回退警告） */
  notices: string[];
}

/** 单文件载荷损坏判定：直接复用 settingsSanitize.payloadNeedsRescue（口径同 isObjectLike，逐文件抢救链）。 */
const payloadInvalid = payloadNeedsRescue;

/** 从文件路径读 JSON；文件不存在返回 missing，JSON.parse 失败返回 corrupt。 */
async function readJsonFile(adapter: KvAdapter, path: string): Promise<FileReadResult> {
  if (!(await adapter.exists(path))) return { status: "missing" };
  try {
    return { status: "ok", value: JSON.parse(await adapter.read(path)) };
  } catch {
    return { status: "corrupt" };
  }
}

/**
 * 插件双文件存储。所有方法幂等且可重入（写路径由调用方串行化到 saveChain）。
 */
export class PluginFileStore {
  /** 各文件上次备份时间（文件名 → epoch ms），实现 10 分钟节流。 */
  private lastBakAt = new Map<string, number>();

  constructor(
    private adapter: KvAdapter,
    private dir: string,
    /** 备份节流间隔；测试传 0 让每次写都落 .bak，便于断言 */
    private bakIntervalMs: number = BAK_INTERVAL_MS,
  ) {}

  private path(name: string): string {
    return normalizePath(`${this.dir}/${name}`);
  }

  /**
   * 原子写一个 JSON 文件：write(.tmp) → [到期则备份旧文件] → rename(.tmp → 正式)。
   * rename 若因目标已存在失败（个别实现不允许覆盖），remove 后重试一次——
   * 此时旧内容已进 .bak（或首个写场景本无旧内容），抢救链路完整。
   */
  async writeJson(name: string, value: unknown): Promise<void> {
    const p = this.path(name);
    const tmp = `${p}.tmp`;
    await this.adapter.write(tmp, JSON.stringify(value ?? null, null, 2));
    if (this.bakIntervalMs >= 0) await this.maybeBackup(name);
    try {
      await this.adapter.rename(tmp, p);
    } catch {
      if (await this.adapter.exists(p)) await this.adapter.remove(p);
      await this.adapter.rename(tmp, p);
    }
  }

  /**
   * 备份链（仿旧 maybeBackupData 两步加固）：正式文件 → 复制到 .bak.tmp → rename 成 .bak。
   * copy 直接覆盖旧备份的话，copy 中段被杀会把唯一好备份变成半截文件；同目录 rename 是
   * 元数据操作，.bak 永远要么旧完整要么新完整。节流期内跳过（lastBakAt 成功后才记账）。
   */
  private async maybeBackup(name: string): Promise<void> {
    const now = Date.now();
    if (now - (this.lastBakAt.get(name) ?? 0) < this.bakIntervalMs) return;
    const p = this.path(name);
    if (!(await this.adapter.exists(p))) return;
    const bakTmp = `${p}.bak.tmp`;
    const bak = `${p}.bak`;
    try {
      const content = await this.adapter.read(p);
      await this.adapter.write(bakTmp, content);
      try {
        if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      } catch {
        /* remove 失败让下一步 rename 失败，下轮重试 */
      }
      await this.adapter.rename(bakTmp, bak);
      this.lastBakAt.set(name, now);
    } catch {
      /* 备份失败不影响主流程（正式文件仍是权威数据）；lastBakAt 未置位，下次落盘即重试 */
    }
  }

  /**
   * 读单个新布局文件；载荷损坏时按「.bak → .bak.tmp」链抢救，再损坏返回 null。
   * state.json 缺失不算损坏（返回 null，调用方按空台账处理）。
   */
  private async loadFileWithRescue(name: string, notices: string[], label: string): Promise<unknown> {
    const p = this.path(name);
    const primary = await readJsonFile(this.adapter, p);
    // JSON.parse 得到 null 字面量（文件内容 "null"）也按损坏处理（payloadInvalid 覆盖）
    if (primary.status === "ok" && !payloadInvalid(primary.value)) return primary.value;
    // 主文件损坏（corrupt / 非对象载荷）→ 依次探 .bak、.bak.tmp
    for (const cand of [`${p}.bak`, `${p}.bak.tmp`]) {
      const r = await readJsonFile(this.adapter, cand);
      if (r.status === "ok" && !payloadInvalid(r.value)) {
        notices.push(`抖音同步：${name} 损坏，已从备份 ${name}.bak 恢复（${label}）`);
        return r.value;
      }
    }
    notices.push(`抖音同步：${name} 损坏且无可用备份（${label}），对应数据将按默认值重建`);
    return null;
  }

  /** 读旧 data.json（含 F4 同款 .bak / .bak.tmp 抢救，needsBackupRescue 判定口径不变）。 */
  private async loadLegacyComposite(): Promise<unknown> {
    const primary = await readJsonFile(this.adapter, this.path(LEGACY_FILE));
    let data: unknown = primary.status === "ok" ? primary.value : null;
    if (needsBackupRescue(data)) {
      for (const cand of [`${this.path(LEGACY_FILE)}.bak`, `${this.path(LEGACY_FILE)}.bak.tmp`]) {
        const r = await readJsonFile(this.adapter, cand);
        if (r.status !== "ok") continue;
        const parsed = r.value;
        if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
          const box = parsed as Record<string, unknown>;
          if (box.settings || box.state) {
            data = parsed;
            break;
          }
        }
      }
    }
    return data;
  }

  /** 把 settings/state 载荷分别原子写入双新文件（迁移与首次落盘共用）。 */
  async writeSplit(settings: unknown, state: unknown): Promise<void> {
    await this.writeJson(SETTINGS_FILE, settings ?? {});
    await this.writeJson(STATE_FILE, state ?? {});
  }

  /**
   * 读路径总入口：见模块头注释三段逻辑。返回载荷 + 迁移标记 + 用户提示。
   * 注意：本方法不抛错——任何损坏都降级为 notices + 默认值，绝不让插件加载失败。
   */
  async load(): Promise<SplitLoadResult> {
    const notices: string[] = [];
    const settingsExists = await this.adapter.exists(this.path(SETTINGS_FILE));
    const stateExists = await this.adapter.exists(this.path(STATE_FILE));
    const legacyExists = await this.adapter.exists(this.path(LEGACY_FILE));

    // ① 任一新文件存在 → 读新（损坏走各文件自己的抢救链；双双失效再回退旧 data.json）。
    // 注意用「或」而非「且」：迁移双写之间崩溃（settings.json 已落、state.json 未落）时，
    // 已存在的那半要照常读取，缺失的一半按 null 处理——不能整体当全新安装。
    if (settingsExists || stateExists) {
      const settings = settingsExists ? await this.loadFileWithRescue(SETTINGS_FILE, notices, "设置") : null;
      const state = stateExists ? await this.loadFileWithRescue(STATE_FILE, notices, "同步台账") : null;
      if (payloadInvalid(settings) || payloadInvalid(state)) {
        // 双文件抢救都失败 → 回退旧 data.json（回滚锚点仍有价值）
        const legacy = await this.loadLegacyComposite();
        if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
          const box = legacy as Record<string, unknown>;
          notices.push("抖音同步：新布局文件损坏，已回退读取旧 data.json（下次保存将重建新文件）");
          return {
            settings: payloadInvalid(settings) ? box.settings ?? null : settings,
            state: payloadInvalid(state) ? box.state ?? null : state,
            migrated: false,
            notices,
          };
        }
      }
      return { settings, state, migrated: false, notices };
    }

    // ② 旧 data.json 存在 → 自动迁移（按键域拆分写双新文件；data.json 原样保留作回滚锚点）
    if (legacyExists) {
      const legacy = await this.loadLegacyComposite();
      const composite = legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)
        ? (legacy as Record<string, unknown>)
        : null;
      // settings 域：pickSettingsSource 与旧 loadSettings 完全同口径（含旧版扁平 data.json 兼容）
      const settings = composite ? pickSettingsSource(composite) : {};
      // state 域：旧结构里 state 键直接取（与旧 `this._stateRaw = data?.state` 同口径）
      const state = composite ? composite.state ?? null : null;
      try {
        await this.writeSplit(settings, state);
        notices.push("抖音同步：已把 data.json 迁移为 settings.json + state.json 双文件（旧 data.json 原样保留作回滚锚点）");
      } catch (e: any) {
        // 迁移写失败不致命：下次加载重试（data.json 仍在）；本次用内存里的旧数据继续
        notices.push(`抖音同步：双文件迁移写入失败（${String(e?.message ?? e).slice(0, 80)}），本次沿用旧 data.json 数据`);
      }
      return { settings, state, migrated: true, notices };
    }

    // ③ 全新安装
    return { settings: null, state: null, migrated: false, notices };
  }
}
