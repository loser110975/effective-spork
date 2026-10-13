// statusCore.ts — 兼容桶文件（P1-2 拆分）：历史 9 个依赖方继续从 "./statusCore" 导入，路径零改动。
// 实现按职责拆分至三个纯函数模块：
// - statusMachine.ts：二维状态机（statusVisual / classifyAnomaly / formatRss 等，M4 StatusHub）
// - noteText.ts：笔记文本手术（applySummaryToNote / upsertFmScalar / appendOcrToNoteCallout /
//   collectExistingAssets / pickEvenly 等，M3 SummaryService 的「原文零覆盖」保障）
// - procParse.ts：Windows 进程解析（parsePidsFromNetstat / isNumericPid，M1 ProcessManager）
// 三个模块都不依赖 obsidian，可在 Node 中独立单元验证（见 tests/）。
export * from "./statusMachine";
export * from "./noteText";
export * from "./procParse";
