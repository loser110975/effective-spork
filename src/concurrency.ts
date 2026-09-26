// concurrency.ts — 极简并发原语（性能治理 P0-3）。
//
// 用途：把「纯等待型」任务（CDN 下载、云端 ASR/摘要推理、本地文件 IO）从串行排队改为有限并发，
// 同时严格卡住并发上限，避免把上游 API 打成 429、或把本地 CPU / 内存打满。
//
// 设计取舍：
// - 不引入 p-limit 等外部依赖：插件需保持零运行时依赖，只打包自身源码。
// - 列表分页这类受抖音风控约束、且依赖 cursor 顺序的请求仍保持串行；
//   只对 processItem 内彼此独立的条目处理放开并发。
// - 落盘（syncEngine.flushState）自带串行队列，无需在此叠加。

/** 信号量：限制同时进行的异步任务数，FIFO 排队（公平，不会饿死）。 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // 名额直接转交给下一个等待者，active 保持不变
      next();
      return;
    }
    this.active--;
  }

  /** 在信号量约束下执行 fn。 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * 并发映射：对 items 逐项执行 fn，最多 limit 个同时进行，结果按输入顺序返回。
 * 注意：fn 自行负责异常兜底（本函数不吞异常，避免掩盖真实失败）。
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const safeLimit = clampConcurrency(limit, 1, Math.max(1, items.length));
  const results = new Array<R>(items.length);
  const sem = new Semaphore(safeLimit);
  await Promise.all(
    items.map((item, i) =>
      sem.run(async () => {
        results[i] = await fn(item, i);
      }),
    ),
  );
  return results;
}

/**
 * 把并发上限收敛到安全区间 [1, max]。
 * 非法值（NaN / 0 / 负数 / 非数字）回退到 fallback，避免配置异常导致并发失控或完全停摆。
 */
export function clampConcurrency(value: unknown, fallback = 3, max = 6): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return Math.max(1, Math.min(fallback, max));
  return Math.min(n, max);
}
