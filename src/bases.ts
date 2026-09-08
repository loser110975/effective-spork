import { Vault, normalizePath } from "obsidian";
import { ensureFolder } from "./media";

/**
 * Bases 画廊生成（需 Obsidian 1.9+）。
 * 四个视图：封面墙 / 分类画廊 / 爆款排行 / 最近7天。
 * 若某过滤函数在当前 Obsidian 版本报错，可在 Bases 编辑器里打开 .base 文件微调。
 */

const BASE_FILES: { name: string; content: string }[] = [
  {
    name: "封面墙.base",
    content: `filters:
  and:
    - file.hasProperty("douyin_id")
    - file.hasProperty("cover")
views:
  - type: cards
    name: 封面墙
    filters:
      and:
        - file.hasProperty("cover")
    order:
      - file.name
    sort:
      - property: file.mtime
        direction: DESC
    image: note.cover
    imageFit: cover
    cardSize: 200
`,
  },
  {
    name: "分类画廊.base",
    content: `filters:
  and:
    - file.hasProperty("douyin_id")
    - file.hasProperty("category")
views:
  - type: cards
    name: 分类画廊
    order:
      - note.category
      - file.name
    sort:
      - property: file.mtime
        direction: DESC
    groupBy: note.category
    image: note.cover
    imageFit: cover
    cardSize: 160
`,
  },
  {
    name: "爆款排行.base",
    content: `filters:
  and:
    - file.hasProperty("douyin_id")
views:
  - type: table
    name: 爆款排行（按点赞）
    order:
      - file.name
      - note.author
      - note.likes
      - note.category
      - note.url
    sort:
      - property: note.likes
        direction: DESC
    limit: 100
  - type: cards
    name: 爆款封面
    sort:
      - property: note.likes
        direction: DESC
    image: note.cover
    imageFit: cover
    cardSize: 220
    limit: 50
`,
  },
  {
    name: "最近7天.base",
    content: `filters:
  and:
    - file.hasProperty("douyin_id")
views:
  - type: cards
    name: 最近同步
    filters:
      and:
        - file.mtime >= now() - 7d
    sort:
      - property: file.mtime
        direction: DESC
    image: note.cover
    imageFit: cover
    cardSize: 200
  - type: table
    name: 最近同步（列表）
    filters:
      and:
        - file.mtime >= now() - 7d
    order:
      - file.name
      - note.author
      - note.category
    sort:
      - property: file.mtime
        direction: DESC
`,
  },
];

export async function generateBases(vault: Vault, basesFolder: string): Promise<number> {
  await ensureFolder(vault, basesFolder);
  let written = 0;
  for (const f of BASE_FILES) {
    const full = normalizePath(`${basesFolder}/${f.name}`);
    const existing = vault.getAbstractFileByPath(full);
    if (existing) continue; // 用户可能已自定义，不覆盖
    await vault.create(full, f.content);
    written++;
  }
  return written;
}
