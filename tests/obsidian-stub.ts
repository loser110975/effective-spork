// 测试专用 obsidian 模块替身（esbuild alias 指向本文件）。
// 2026-09-27 扩展：TFile/TFolder/Notice/normalizePath + requestUrl 可编程 mock，
// 支持引擎级单测（SyncEngine + MiniVault 协作者注入）；纯函数单测不受影响
//（默认 requestUrl mock 会拒绝调用，防止用例意外触网）。
export class TAbstractFile {
  path: string = "";
  name: string = "";
}
export class TFile extends TAbstractFile {
  stat: { size: number; mtime: number } = { size: 0, mtime: 0 };
  basename: string = "";
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  constructor(public message?: string, public timeout?: number) {}
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
  hide(): void {}
}

/** 与 Obsidian 同语义的近似实现：反斜杠归一、折叠重复斜杠、去首尾斜杠。 */
export function normalizePath(p: string): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

type RequestUrlMock = (p: any) => Promise<any>;
let impl: RequestUrlMock = async () => {
  throw new Error("requestUrl 不应在单测中被调用（需先 setRequestUrlMock 注入行为）");
};
export function setRequestUrlMock(fn: RequestUrlMock): void {
  impl = fn;
}
export const requestUrl = (p: any): Promise<any> => impl(p);

export default { requestUrl, Notice, TFile, TFolder, TAbstractFile, normalizePath };
