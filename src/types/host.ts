// types/host.ts —— 宿主窄接口与通知回调（2026-10 类型域拆分轮新增，消除两个 type-only 源级环）：
// ① PluginHost：设置页（settings.ts）对插件宿主的窄视图。此前 settings.ts 直接
//    `import type DouyinSyncPlugin from "./main"`，而 main → settings 是值级 import，
//    构成 main ⇄ settings 的 type-only 环；改为设置页只依赖本窄接口，main 传 this 实现
//    （结构化类型天然满足，无需 main 反向依赖本模块之外的东西）。
// ② NotifyFn：进程通知回调（原 processManager.ts 导出）。statusHub 只需要这个函数类型，
//    从 processManager import 会构成 statusHub → processManager 的 type-only 环；
//    移入类型模块后，processManager 与 statusHub 均改为从这里 import。
import type { Plugin } from "obsidian";
import type { DouyinSyncSettings } from "./settings";

/** 进程通知回调：level 为处置优先级（P0 最紧急），code 为结构化错误码，msg 为用户可读文案。 */
export type NotifyFn = (level: "P0" | "P1" | "P2" | "P3", code: string, msg: string) => void;

/** 设置页消费的状态中心窄视图（结构化匹配 StatusHub 的 getStatus/subscribe/restart）。 */
export interface PluginHostStatusHub {
  getStatus(): { processState: any; connectionState: any };
  subscribe(cb: (s: { processState: any; connectionState: any }) => void): () => void;
  restart(): void;
}

/** 设置页消费的引擎窄视图（结构化匹配 SyncEngine 的 running/checkFfmpeg/resetState）。 */
export interface PluginHostEngine {
  running: boolean;
  checkFfmpeg(force?: boolean): Promise<string | null>;
  resetState(): void;
}

/**
 * 插件宿主窄接口：设置页只认这些成员。继承 obsidian 的 Plugin 是因为
 * PluginSettingTab 构造器第二参要求 Plugin 实例——main 的 DouyinSyncPlugin
 * extends Plugin 且实现全部成员，传 this 即满足，无需设置页依赖 main。
 */
export interface PluginHost extends Plugin {
  settings: DouyinSyncSettings;
  engine: PluginHostEngine;
  statusHub: PluginHostStatusHub;
  saveSettings(): Promise<void>;
  testDouyinConnection(): Promise<void>;
  restartInterval(): void;
  openOcr(): Promise<void>;
  summarizeActive(): Promise<void>;
  rebuildRelatedNotes(): Promise<void>;
  backfillVideos(): Promise<void>;
  showResult(msg: string, isError?: boolean): void;
}
