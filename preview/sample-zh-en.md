# onebox 样式样张 · Style Specimen

这是一份用于校对 **中英文混排** 的样张文档，覆盖编辑器支持的全部块级语法。目标是与 Notion 的默认排版保持一致：正文 16px、行高 1.5、标题字重 600/700、内联代码使用红色 `#EB5757`。

This specimen checks **mixed Chinese & English** typography against Notion's defaults: 16px body text, 1.5 line height, semibold headings, and the signature red inline `code` style.

## 一、文本与行内样式

中文段落：清晨的光线穿过窗帘，落在键盘上。编辑器应当像纸一样安静，像工具一样可靠。The quick brown fox jumps over the lazy dog. 混排时数字 2026 与单位 16px 不应破坏节奏，标点「」与引号 "" 也要自然。

行内样式：**加粗 Bold**、*斜体 Italic*、***加粗斜体***、~~删除线 Strikethrough~~、`inline code`、[外部链接 Link](https://example.com) 与脚注引用[^note]。

> 引用块：好的排版是看不见的。Good typography is invisible.
> 它让读者只注意到内容本身，而不是容器。

### 1.1 列表

- 无序列表项一：支持嵌套
  - 嵌套子项 A
  - 嵌套子项 B
- 无序列表项二：中英文混排 Chinese & English
- 无序列表项三

1. 有序列表第一步
2. 有序列表第二步
   1. 子步骤 2.1
   2. 子步骤 2.2
3. 有序列表第三步

### 1.2 任务列表

- [x] 已完成：解析 GFM 表格与脚注
- [x] Done: ship the Notion-style typography
- [ ] 待办：百万字符桌面端压测
- [ ] Todo: manual fine-tuning of spacing

## 二、代码与表格

```ts
// 序列化在 Worker 中执行，不阻塞主线程
export function serialize(doc: Node): string {
  const chunks: string[] = []
  for (const block of doc.children) {
    chunks.push(render(block)) // 中文注释对齐测试
  }
  return chunks.join('\n\n')
}
```

| 阶段 Phase | 核心任务 Focus | 状态 Status | 字符数 Chars |
|:---|:---|:---:|---:|
| 第一阶段 | 脚手架与虚拟滚动 | 已完成 | 100,000 |
| 第二阶段 | Markdown 双向链路 | 已完成 | 1,000,000 |
| 第三阶段 | 块交互体系 | 进行中 | — |

---

### 2.1 图片与脚注

![山雾 · Mountain mist](mountain-mist.jpg)

脚注定义位于文档末尾，引用标记应小巧而不喧宾夺主。Footnotes sit at the end of the document[^note].

[^note]: 这是脚注内容。This is the footnote body, rendered slightly smaller than the main text.