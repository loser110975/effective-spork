// 测试入口：聚合可在 Node 中独立验证的模块（obsidian 经 alias 指向 obsidian-stub.ts）。
// 2026-09-27：加入 SyncEngine / MediaStore / settings 默认值 / obsidian 替身本体，
// 支持引擎级集成测试（MiniVault + 协作者注入，全程不触网）。
import * as statusCore from "../src/statusCore";
import * as itemType from "../src/itemType";
import * as util from "../src/util";
import * as perfMod from "../src/perf";
import * as concurrency from "../src/concurrency";
import * as noteBuilder from "../src/noteBuilder";
import * as douyinClient from "../src/douyinClient";
import * as typesMod from "../src/types/domain";
import * as typesSettingsMod from "../src/types/settings";
import * as aiConfigMod from "../src/aiConfig";
import * as videoSummaryServiceMod from "../src/videoSummaryService";
import * as summaryServiceMod from "../src/summaryService";
import * as relatedNotesMod from "../src/relatedNotes";
import * as embeddingServiceMod from "../src/embeddingService";
import { sanitizeNumericSettings, needsBackupRescue, pickSettingsSource, fallbackMatchesDefaults, payloadNeedsRescue, SUMMARY_MAX_TOKENS_LEGACY_DEFAULT, SUMMARY_MAX_TOKENS_DEFAULT } from "../src/settingsSanitize";
import { AiClient, OUTPUT_TRUNCATED_HINT } from "../src/ai";
import { PluginFileStore, SETTINGS_FILE, STATE_FILE } from "../src/pluginStorage";
import { SyncEngine } from "../src/syncEngine";
import { MediaStore } from "../src/media";
import { VideoMediaStore, isDeterministicMediaError } from "../src/videoMedia";
import { ProcessManager } from "../src/processManager";
import * as obsidianStub from "./obsidian-stub";

export const m = {
  ...statusCore,
  ...itemType,
  ...util,
  ...perfMod,
  ...concurrency,
  ...noteBuilder,
  ...douyinClient,
  ...typesMod,
  ...typesSettingsMod,
  ...aiConfigMod,
  ...videoSummaryServiceMod,
  ...summaryServiceMod,
  ...relatedNotesMod,
  ...embeddingServiceMod,
  SyncEngine,
  MediaStore,
  VideoMediaStore,
  ProcessManager,
  isDeterministicMediaError,
  sanitizeNumericSettings,
  needsBackupRescue,
  pickSettingsSource,
  fallbackMatchesDefaults,
  payloadNeedsRescue,
  SUMMARY_MAX_TOKENS_LEGACY_DEFAULT,
  SUMMARY_MAX_TOKENS_DEFAULT,
  AiClient,
  OUTPUT_TRUNCATED_HINT,
  PluginFileStore,
  SETTINGS_FILE,
  STATE_FILE,
  TFile: obsidianStub.TFile,
  TFolder: obsidianStub.TFolder,
  Notice: obsidianStub.Notice,
  normalizePathStub: obsidianStub.normalizePath,
  setRequestUrlMock: obsidianStub.setRequestUrlMock,
};
