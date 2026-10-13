// procParse.ts — Windows 进程探测辅助的纯解析部分（M1 ProcessManager）。
// 不依赖 obsidian，可在 Node 中独立单元验证（见 tests/）。

// ---------- 进程探测辅助（M1 ProcessManager 的纯解析部分） ----------

/** 从 `netstat -ano` 输出中解析出监听指定端口的 PID 集合（去重、只保留 LISTENING）。 */
export function parsePidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(`:${port} `)) continue;
    if (!/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/(\d+)\s*$/);
    if (m) {
      const pid = Number(m[1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

/** 校验字符串是否为纯数字（防命令注入：taskkill 参数必须为纯数字 PID）。 */
export function isNumericPid(v: string): boolean {
  return /^\d{1,10}$/.test(v.trim());
}
