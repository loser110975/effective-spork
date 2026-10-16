// semanticSearchModal.ts — 语义搜索弹窗（批次三，2026-10-16）。
// 自由文本输入 → 引擎向量检索 → 结果列表（相似度 + 标题 + 分类）→ 点击跳转笔记。
// 为什么不用 FuzzySuggestModal：模糊搜索模态的输入框语义是「过滤已知条目名」，与
// 「自然语言描述找内容」的语义检索心智不符；自定义 Modal 输入框不预填、回车即搜。
import { App, Modal, Notice } from "obsidian";

export interface SemanticSearchHit {
  path: string;
  title: string;
  category: string;
  score: number;
}

export class SemanticSearchModal extends Modal {
  private inputEl!: HTMLInputElement;
  private resultEl!: HTMLElement;
  private debounceTimer: number | null = null;
  /** 过期响应守卫：慢请求返回时用户已改输入，旧结果不得覆盖新状态。 */
  private queryToken = 0;
  private running = false;
  private lastQuery = "";

  constructor(
    app: App,
    private readonly search: (query: string) => Promise<SemanticSearchHit[] | null>,
    private readonly noIndexHint: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.addClass("douyin-sync-semantic-search");

    const box = this.contentEl.createDiv();
    box.style.display = "flex";
    box.style.gap = "8px";
    box.style.alignItems = "center";
    this.inputEl = box.createEl("input", { type: "text" });
    this.inputEl.placeholder = "用一句话描述想找的内容，如：讲确定性失败重试的笔记";
    this.inputEl.style.flex = "1";
    const goBtn = box.createEl("button", { text: "搜索" });

    this.resultEl = this.contentEl.createDiv();
    this.resultEl.style.marginTop = "10px";
    this.resultEl.createDiv({ text: this.noIndexHint });

    const run = () => void this.run(this.inputEl.value);
    this.inputEl.addEventListener("input", () => this.schedule());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });
    goBtn.addEventListener("click", run);
    setTimeout(() => this.inputEl.focus(), 50);
  }

  onClose(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
  }

  /** 输入防抖 400ms：连续打字只在停顿后搜一次（每次搜索都是一次付费 embedding 调用）。 */
  private schedule(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.run(this.inputEl.value), 400);
  }

  private async run(query: string): Promise<void> {
    const q = query.trim();
    if (!q || this.running) return;
    const token = ++this.queryToken;
    this.running = true;
    this.renderStatus(`搜索中…`);
    try {
      const res = await this.search(q);
      if (token !== this.queryToken) return; // 过期响应
      if (res === null) {
        this.renderStatus(this.noIndexHint);
        return;
      }
      if (res.length === 0) {
        this.renderStatus("没有语义沾边的命中（可换个说法，或先「构建语义索引」刷新）");
        return;
      }
      this.renderHits(res);
    } catch (e: any) {
      if (token !== this.queryToken) return;
      new Notice(`语义搜索失败：${String(e?.message ?? e).slice(0, 120)}`, 8000);
      this.renderStatus("搜索失败，请重试");
    } finally {
      if (token === this.queryToken) this.running = false;
    }
  }

  private renderStatus(text: string): void {
    this.resultEl.empty();
    const el = this.resultEl.createDiv({ text });
    el.style.color = "var(--text-muted)";
    el.style.padding = "6px 2px";
  }

  private renderHits(hits: SemanticSearchHit[]): void {
    this.resultEl.empty();
    for (const h of hits) {
      const row = this.resultEl.createDiv();
      row.style.padding = "6px 8px";
      row.style.borderRadius = "6px";
      row.style.cursor = "pointer";
      row.style.display = "flex";
      row.style.flexDirection = "column";
      row.style.gap = "2px";
      const title = row.createDiv();
      title.style.fontWeight = "600";
      title.setText(`${Math.round(h.score * 100)}% · ${h.title}`);
      const meta = row.createDiv();
      meta.style.color = "var(--text-muted)";
      meta.style.fontSize = "0.85em";
      meta.setText(h.category || h.path);
      row.addEventListener("mouseenter", () => (row.style.background = "var(--background-modifier-hover)"));
      row.addEventListener("mouseleave", () => (row.style.background = ""));
      row.addEventListener("click", () => {
        this.close();
        void this.app.workspace.openLinkText(h.path, "", false);
      });
    }
  }
}
