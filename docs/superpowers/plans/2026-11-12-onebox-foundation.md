# onebox 基础架构（第一阶段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Tauri v2 + SolidJS 桌面端 Markdown 编辑器骨架，打通「磁盘 GFM → ProseMirror 单文档 → 视口按需渲染 → 写回磁盘」全链路。

**Architecture:** 单个 Tiptap Editor 持有完整 ProseMirror 文档。每个顶层块注册 nodeView：可见时交出 `contentDOM` 让 ProseMirror 原生渲染并接管输入，不可见时只返回带缓存高度的占位 div。可见性由 PM plugin 的装饰驱动，装饰翻转使 `spec.update` 返回 false，从而触发 PM 销毁重建 nodeView。全项目只有一个编辑器实例，零同步层。

**Tech Stack:** SolidJS 1.9.19 · TypeScript 5.9.3 · Vite 8.3.8 · Tiptap 3.33.1 · prosemirror-markdown 1.13.9 · Tauri v2 · Rust · vitest 5.1.0

**Spec:** [docs/superpowers/specs/2026-11-12-onebox-foundation-design.md](../specs/2026-11-12-onebox-foundation-design.md)

## Global Constraints

每个任务的要求都隐含包含本节。

- **精确版本，无 `^` / `~`**：solid-js `1.9.19`、vite `8.3.8`、vite-plugin-solid `2.11.16`、typescript `5.9.3`、vitest `5.1.0`、happy-dom `21.0.4`、@tiptap/core `3.33.1`、@tiptap/pm `3.33.1`、@tiptap/starter-kit `3.33.1`、prosemirror-markdown `1.13.9`、markdown-it `14.3.3`、@types/markdown-it `14.2.0`、@tauri-apps/api `2.12.4`、@tauri-apps/cli `2.12.4`、@tauri-apps/plugin-dialog `2.8.4`。Rust crate 用大版本约束，由 `Cargo.lock` 锁定。
- **markdown-it 必须锁 14.3.3，不可用 15.x**：prosemirror-markdown 依赖 `markdown-it ^14.0.0`，装 15 会产生两份实例。
- **提交授权（用户已明确批准）**：本次执行中每个任务完成后自动 commit 到 `feat/foundation` 分支。**不 push、不合入 main、不动远程。** 用户仍在真机验收后才决定合入。每个任务最后一步是 commit + 简短报告，然后继续下一个任务，不要停下等确认。
- **`node_modules/` 从 Task 1 起就必须被忽略**：Task 1 创建 `.gitignore` 时即写入 `node_modules/`、`dist/`、`.DS_Store`，不要等到 Task 8。任何任务都不得 `git add -A` / `git add .`，只按文件名加。
- **节点名用 Tiptap 实际注册名（camelCase）**：`paragraph`、`heading`、`blockquote`、`codeBlock`、`bulletList`、`orderedList`、`horizontalRule`、`listItem`、`hardBreak`。spec 中出现的 snake_case 是 ProseMirror 原生名，不适用于本项目。
- **属性名用 Tiptap 的**：`heading.level`、`codeBlock.language`、`orderedList.start`、`link.href`。prosemirror-markdown 默认用 `params` / `order`，必须覆写。
- **禁止私有 Markdown 语法**：不注册非 GFM 节点。**必须禁用 StarterKit 的 `underline`**（`<u>` 非 GFM）。不往正文写 HTML 注释、块 ID、自定义容器。
- **`src/core/` 不得 import `solid-js` 或任何 `@tauri-apps/*`**：内核保持框架无关、可独立单测。前端与桌面底座的唯一耦合点是 `src/io/types.ts`。
- **界面极简**：无 Tooltip、无弹窗、无 toast、无解释文案。状态信息只在状态栏以极短标记呈现。
- **按需最小验证**：只跑当前任务相关的测试文件（`pnpm vitest run tests/<file>.test.ts`），不要每个任务都重跑全量。全量只在 Task 10 收尾跑一次。
- **测试只用临时文件**，绝不读写用户真实文档。
- **每个任务的「提交并报告」步骤统一含义**：`git add <本任务涉及的具体文件>` → `git commit`（消息用 `feat:` / `test:` / `chore:` 前缀，简述该任务交付物）→ 返回状态、commit 短 hash、一行测试结论、疑虑。**不要 push，不要停下等用户确认，继续下一个任务。**
- **安装系统依赖前必须先向用户确认命令**（Task 8 的 rustup）。
- **第一阶段不做**：表格、任务列表、脚注、图片、内嵌 HTML、pulldown-cmark 分片解析、块拖拽、悬浮菜单、斜杠命令、Mermaid/KaTeX、`.editor-meta.json`、Kobalte、TanStack Virtual、打包图标与分发。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `package.json` / `vite.config.ts` / `tsconfig.json` / `index.html` | 构建与测试配置 |
| `src/index.tsx` | Solid 挂载入口 |
| `src/App.tsx` | 装配 io + editor + shell，持有文件状态 |
| `src/core/schema.ts` | 扩展清单 → Schema；顶层块类型清单 |
| `src/core/markdown.ts` | GFM 双向转换 + 不支持语法检测 |
| `src/core/editor.ts` | 创建单个 Editor，接线 viewport 三件套 |
| `src/core/metrics.ts` | dev 模式性能读数 |
| `src/core/viewport/heights.ts` | 块高缓存（WeakMap）+ 高度估算 |
| `src/core/viewport/visibility.ts` | 可见性 plugin、装饰、强制可见规则 |
| `src/core/viewport/blockNodeView.ts` | 占位 ↔ 内容 nodeView |
| `src/core/viewport/observer.ts` | IntersectionObserver → 可见集合 → dispatch |
| `src/io/types.ts` | FileSystem 接口 |
| `src/io/tauri.ts` | Tauri invoke 实现 |
| `src/ui/EditorShell.tsx` | 滚动容器 + 编辑器挂载点 |
| `src/styles/editor.css` | 块与占位样式 |
| `src-tauri/src/fs.rs` | 异步 read_text / write_text + Rust 单测 |
| `src-tauri/src/lib.rs` / `main.rs` | Builder 与命令注册 |
| `tests/*.test.ts` | 内核单测 |

依赖方向：`ui → core → (pm, markdown-it)`；`io → @tauri-apps/api`；`App → ui + core + io`。`core` 不反向依赖任何上层。

---

## Task 1: 前端骨架与测试环境

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/index.tsx`, `src/App.tsx`
- Modify: `.gitignore`（已存在，含 `.DS_Store`）
- Test: `tests/harness.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 可用的 `pnpm dev` / `pnpm test` / `pnpm typecheck`；happy-dom DOM 环境（Task 6 依赖）

- [ ] **Step 1: 写失败测试**

创建 `tests/harness.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('provides a DOM environment', () => {
    const el = document.createElement('div')
    el.textContent = 'onebox'
    expect(el.textContent).toBe('onebox')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL — `pnpm: command not found` 之外的情形应为 `vitest: not found`（依赖尚未安装）

- [ ] **Step 3: 创建配置文件**

`.gitignore` 全量替换为（`node_modules/` 必须从本任务起就被忽略，否则 Task 1-7 有把它提交进去的风险）：

```
.DS_Store
node_modules/
dist/
```

`package.json`：

```json
{
  "name": "onebox",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "2.12.4",
    "@tauri-apps/plugin-dialog": "2.8.4",
    "@tiptap/core": "3.33.1",
    "@tiptap/pm": "3.33.1",
    "@tiptap/starter-kit": "3.33.1",
    "markdown-it": "14.3.3",
    "prosemirror-markdown": "1.13.9",
    "solid-js": "1.9.19"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.12.4",
    "@types/markdown-it": "14.2.0",
    "happy-dom": "21.0.4",
    "typescript": "5.9.3",
    "vite": "8.3.8",
    "vite-plugin-solid": "2.11.16",
    "vitest": "5.1.0"
  }
}
```

`vite.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'esnext' },
  test: { environment: 'happy-dom', globals: false, include: ['tests/**/*.test.ts'] },
})
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>onebox</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
```

`src/App.tsx`：

```tsx
export default function App() {
  return <main class="app">onebox</main>
}
```

`src/index.tsx`：

```tsx
import { render } from 'solid-js/web'
import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
render(() => <App />, root)
```

- [ ] **Step 4: 安装依赖**

Run: `pnpm install`
Expected: 成功，生成 `pnpm-lock.yaml`，无 peer 冲突警告

若出现 `prosemirror-model` 多实例警告，运行 `pnpm why prosemirror-model` 确认只有一份；有多份则在 `package.json` 加 `pnpm.overrides` 将其钉到 `1.25.13`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm vitest run tests/harness.test.ts`
Expected: PASS（1 passed）

- [ ] **Step 6: 类型检查**

Run: `pnpm typecheck`
Expected: 无输出，退出码 0

- [ ] **Step 7: 浏览器确认骨架可运行**

Run: `pnpm dev`（后台运行）

用 chrome-devtools MCP 打开 `http://localhost:1420`，`evaluate_script` 执行：

```js
() => document.querySelector('main.app')?.textContent
```

Expected: `"onebox"`

- [ ] **Step 8: 提交并报告**

报告：骨架可运行、测试与类型检查通过。按 Global Constraints 的「提交并报告」含义提交，包含 `.gitignore` 与 `pnpm-lock.yaml`。

---

## Task 2: GFM Schema

**Files:**
- Create: `src/core/schema.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: Task 1 的依赖与测试环境
- Produces:
  - `extensions: Extensions` — 已禁用 underline 的扩展清单
  - `schema: Schema` — `getSchema(extensions)` 结果
  - `TOP_LEVEL_BLOCK_TYPES: readonly string[]` — `['paragraph','heading','blockquote','codeBlock','bulletList','orderedList','horizontalRule']`

- [ ] **Step 1: 写失败测试**

`tests/schema.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { TOP_LEVEL_BLOCK_TYPES, schema } from '../src/core/schema'

describe('GFM schema', () => {
  it('does not register underline (not GFM)', () => {
    expect(schema.marks.underline).toBeUndefined()
  })

  it('registers GFM marks', () => {
    for (const name of ['strong', 'em', 'code', 'strike', 'link']) {
      expect(schema.marks[name], name).toBeDefined()
    }
  })

  it('registers every top-level block type', () => {
    for (const name of TOP_LEVEL_BLOCK_TYPES) {
      expect(schema.nodes[name], name).toBeDefined()
    }
  })

  it('does not register types deferred to later phases', () => {
    for (const name of ['table', 'taskList', 'taskItem', 'image']) {
      expect(schema.nodes[name], name).toBeUndefined()
    }
  })

  it('uses Tiptap attribute names', () => {
    expect(schema.nodes.heading.spec.attrs?.level).toBeDefined()
    expect(schema.nodes.codeBlock.spec.attrs?.language).toBeDefined()
    expect(schema.nodes.orderedList.spec.attrs?.start).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/schema.test.ts`
Expected: FAIL — 无法解析 `../src/core/schema`

- [ ] **Step 3: 实现**

`src/core/schema.ts`：

```ts
import { getSchema, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { Schema } from '@tiptap/pm/model'

export const extensions: Extensions = [StarterKit.configure({ underline: false })]

export const schema: Schema = getSchema(extensions)

export const TOP_LEVEL_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'horizontalRule',
] as const
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/schema.test.ts`
Expected: PASS（5 passed）

若 `registers GFM marks` 中 `strike` 失败，说明 StarterKit 未启用 strikethrough，检查 `@tiptap/extension-strike` 是否在 StarterKit 依赖中（已核实在）。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

---

## Task 3: Markdown 双向转换与不支持语法检测

**Files:**
- Create: `src/core/markdown.ts`
- Test: `tests/markdown.test.ts`

**Interfaces:**
- Consumes: `schema` from `src/core/schema.ts`
- Produces:
  - `type UnsupportedKind = 'table' | 'taskList' | 'footnote' | 'html' | 'image'`
  - `parseMarkdown(text: string, schema: Schema): Node`
  - `serializeMarkdown(doc: Node): string`
  - `detectUnsupported(text: string): UnsupportedKind[]`

- [ ] **Step 1: 写失败测试**

`tests/markdown.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { detectUnsupported, parseMarkdown, serializeMarkdown } from '../src/core/markdown'
import { schema } from '../src/core/schema'

const roundTrip = (md: string) => serializeMarkdown(parseMarkdown(md, schema))

describe('markdown round trip', () => {
  it('is idempotent at doc level', () => {
    const md = [
      '# 标题',
      '',
      '段落 with **bold**, *em*, ~~strike~~, `code` and [link](https://example.com).',
      '',
      '> 引用',
      '',
      '- 甲',
      '- 乙',
      '',
      '1. 一',
      '2. 二',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      '---',
      '',
    ].join('\n')
    const once = parseMarkdown(md, schema)
    const twice = parseMarkdown(serializeMarkdown(once), schema)
    expect(twice.eq(once)).toBe(true)
  })

  it('preserves soft line breaks inside a paragraph', () => {
    const out = roundTrip('第一行\n第二行\n')
    expect(out).toContain('第一行\n第二行')
    expect(out).not.toContain('\\')
  })

  it('keeps code block language', () => {
    expect(roundTrip('```rust\nfn main() {}\n```\n')).toContain('```rust')
  })

  it('keeps ordered list start', () => {
    expect(roundTrip('3. 三\n4. 四\n')).toContain('3. 三')
  })

  it('keeps heading level', () => {
    expect(roundTrip('### 三级\n')).toContain('### 三级')
  })

  it('never emits underline markup', () => {
    const out = roundTrip('普通文本\n')
    expect(out).not.toContain('<u>')
  })
})

describe('detectUnsupported', () => {
  it('returns empty for supported markdown', () => {
    expect(detectUnsupported('# 标题\n\n段落 **粗体**\n\n- 列表\n')).toEqual([])
  })

  it('detects tables', () => {
    expect(detectUnsupported('| a | b |\n| --- | --- |\n| 1 | 2 |\n')).toContain('table')
  })

  it('detects task lists', () => {
    expect(detectUnsupported('- [x] 完成\n- [ ] 未完成\n')).toContain('taskList')
  })

  it('detects footnotes', () => {
    expect(detectUnsupported('正文[^1]\n\n[^1]: 注释\n')).toContain('footnote')
  })

  it('detects inline html', () => {
    expect(detectUnsupported('正文 <div>x</div>\n')).toContain('html')
  })

  it('detects images', () => {
    expect(detectUnsupported('![alt](./a.png)\n')).toContain('image')
  })

  it('ignores syntax inside fenced code blocks', () => {
    const md = '```md\n| a | b |\n| --- | --- |\n![x](y)\n<div>\n- [ ] t\n```\n'
    expect(detectUnsupported(md)).toEqual([])
  })

  it('does not mistake a horizontal rule for a table', () => {
    expect(detectUnsupported('上文\n\n---\n\n下文\n')).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/markdown.test.ts`
Expected: FAIL — 无法解析 `../src/core/markdown`

- [ ] **Step 3: 实现**

`src/core/markdown.ts`：

```ts
import MarkdownIt from 'markdown-it'
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import type { Node, Schema } from '@tiptap/pm/model'

export type UnsupportedKind = 'table' | 'taskList' | 'footnote' | 'html' | 'image'

const tokenizer = MarkdownIt('commonmark', { html: false, linkify: false, typographer: false })
tokenizer.enable('strikethrough')

// commonmark 预设把段内单换行输出为 softbreak token。转成字面 '\n' 文本，
// 使往返保持原样，而不是被规范化成 GFM 硬换行（反斜杠或双空格）。
tokenizer.core.ruler.push('onebox_softbreak_to_text', (state) => {
  for (const block of state.tokens) {
    if (!block.children) continue
    block.children = block.children.map((tok) => {
      if (tok.type !== 'softbreak') return tok
      const text = new state.Token('text', '', 0)
      text.content = '\n'
      return text
    })
  }
})

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1 }),
    },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: {
      block: 'codeBlock',
      getAttrs: (tok) => ({ language: tok.info || null }),
      noCloseToken: true,
    },
    hr: { node: 'horizontalRule' },
    hardbreak: { node: 'hardBreak' },
    text: { node: 'text' },
    em: { mark: 'em' },
    strong: { mark: 'strong' },
    s: { mark: 'strike' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href') }) },
  })
}

const base = defaultMarkdownSerializer.nodes

const serializer = new MarkdownSerializer(
  {
    paragraph: base.paragraph,
    blockquote: base.blockquote,
    heading: base.heading,
    horizontalRule: base.horizontal_rule,
    hardBreak: base.hard_break,
    text: base.text,
    bulletList: base.bullet_list,
    listItem: base.list_item,
    // Tiptap 用 language / start，prosemirror-markdown 默认用 params / order
    codeBlock(state, node) {
      state.write('```' + ((node.attrs.language as string | null) || '') + '\n')
      state.text(node.textContent, false)
      state.ensureNewLine()
      state.write('```')
      state.closeBlock(node)
    },
    orderedList(state, node) {
      const start = (node.attrs.start as number) ?? 1
      const maxW = String(start + node.childCount - 1).length
      const space = ' '.repeat(maxW + 2)
      state.renderList(node, space, (i) => {
        const n = String(start + i)
        return ' '.repeat(maxW - n.length) + n + '. '
      })
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  },
)

export function parseMarkdown(text: string, schema: Schema): Node {
  return buildParser(schema).parse(text) ?? schema.node('doc', null, [schema.node('paragraph')])
}

export function serializeMarkdown(doc: Node): string {
  return serializer.serialize(doc)
}

function isTableDelimiter(line: string, prev: string): boolean {
  if (!line.includes('|') || !line.includes('-') || !prev.includes('|')) return false
  return /^[\s|:-]+$/.test(line)
}

export function detectUnsupported(text: string): UnsupportedKind[] {
  const found = new Set<UnsupportedKind>()
  let inFence = false
  let prev = ''
  for (const line of text.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      prev = line
      continue
    }
    if (!inFence) {
      if (isTableDelimiter(line, prev)) found.add('table')
      if (/^\s{0,3}[-*+]\s+\[[ xX]\]\s/.test(line)) found.add('taskList')
      if (/\[\^[^\]]+\]/.test(line)) found.add('footnote')
      if (/<\/?[a-zA-Z][^>]*>/.test(line)) found.add('html')
      if (/!\[[^\]]*\]\([^)]*\)/.test(line)) found.add('image')
    }
    prev = line
  }
  return [...found]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/markdown.test.ts`
Expected: PASS（14 passed）

若 `is idempotent at doc level` 失败，先打印 `serializeMarkdown(once)` 与原文对比定位差异节点，不要直接放宽断言。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

---

## Task 4: 块高缓存

**Files:**
- Create: `src/core/viewport/heights.ts`
- Test: `tests/heights.test.ts`

**Interfaces:**
- Consumes: `schema` from `src/core/schema.ts`（仅测试用）
- Produces:
  - `class HeightCache { get(block: Node): number | undefined; set(block: Node, height: number): void }`
  - `estimateHeight(block: Node): number`

- [ ] **Step 1: 写失败测试**

`tests/heights.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { HeightCache, estimateHeight } from '../src/core/viewport/heights'
import { schema } from '../src/core/schema'

const para = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : [])

describe('HeightCache', () => {
  it('returns undefined for an unmeasured block', () => {
    expect(new HeightCache().get(para('x'))).toBeUndefined()
  })

  it('hits on the same node object', () => {
    const cache = new HeightCache()
    const block = para('x')
    cache.set(block, 120)
    expect(cache.get(block)).toBe(120)
  })

  it('misses on a different node object with identical content', () => {
    const cache = new HeightCache()
    cache.set(para('x'), 120)
    expect(cache.get(para('x'))).toBeUndefined()
  })

  it('overwrites a previous measurement', () => {
    const cache = new HeightCache()
    const block = para('x')
    cache.set(block, 100)
    cache.set(block, 200)
    expect(cache.get(block)).toBe(200)
  })
})

describe('estimateHeight', () => {
  it('applies the floor to an empty block', () => {
    expect(estimateHeight(para(''))).toBe(28)
  })

  it('applies the floor to a short block', () => {
    expect(estimateHeight(para('短'))).toBe(28)
  })

  it('scales with line count', () => {
    expect(estimateHeight(para('x'.repeat(160)))).toBe(48)
    expect(estimateHeight(para('x'.repeat(161)))).toBe(72)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/heights.test.ts`
Expected: FAIL — 无法解析 `../src/core/viewport/heights`

- [ ] **Step 3: 实现**

`src/core/viewport/heights.ts`：

```ts
import type { Node } from '@tiptap/pm/model'

const LINE_HEIGHT = 24
const CHARS_PER_LINE = 80
const MIN_HEIGHT = 28

export function estimateHeight(block: Node): number {
  const lines = Math.ceil(block.textContent.length / CHARS_PER_LINE)
  return Math.max(MIN_HEIGHT, lines * LINE_HEIGHT)
}

// 以块节点对象为键：PM 节点不可变，未修改的块跨 transaction 仍是同一引用（命中），
// 被编辑的块产生新对象（自然失效）。因此不需要块 ID，也不会污染 Markdown。
export class HeightCache {
  private map = new WeakMap<Node, number>()

  get(block: Node): number | undefined {
    return this.map.get(block)
  }

  set(block: Node, height: number): void {
    this.map.set(block, height)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/heights.test.ts`
Expected: PASS（7 passed）

- [ ] **Step 5: 提交并报告**

---

## Task 5: 可见性 Plugin

**Files:**
- Create: `src/core/viewport/visibility.ts`
- Test: `tests/visibility.test.ts`

**Interfaces:**
- Consumes: `schema`（仅测试用）
- Produces:
  - `interface VisibilityState { visible: ReadonlySet<number> }`
  - `visibilityKey: PluginKey<VisibilityState>`
  - `createVisibilityPlugin(): Plugin<VisibilityState>`
  - `forcedVisiblePositions(state: EditorState): Set<number>`
  - `isBlockVisible(state: EditorState, pos: number): boolean` — **nodeView 必须用这个，不能直接读 `state.visible`**，否则选区强制可见的块会被误渲染成占位

- [ ] **Step 1: 写失败测试**

`tests/visibility.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import {
  createVisibilityPlugin,
  forcedVisiblePositions,
  isBlockVisible,
  visibilityKey,
} from '../src/core/viewport/visibility'

// doc: 两个段落 "aaa" / "bbb"。block1 pos=0（nodeSize 5），block2 pos=5。
function makeState(selectionPos = 6) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('aaa')]),
    schema.node('paragraph', null, [schema.text('bbb')]),
  ])
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, selectionPos),
    plugins: [createVisibilityPlugin()],
  })
}

const setVisible = (state: EditorState, visible: number[]) =>
  state.apply(state.tr.setMeta(visibilityKey, { visible: new Set(visible) }))

describe('visibility plugin', () => {
  it('starts with an empty visible set', () => {
    expect(visibilityKey.getState(makeState())?.visible.size).toBe(0)
  })

  it('applies meta updates', () => {
    const next = setVisible(makeState(), [0])
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('keeps the visible set across unrelated transactions', () => {
    const state = setVisible(makeState(), [0])
    const next = state.apply(state.tr.insertText('x', 1))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('forces the selection block visible even when not in the set', () => {
    const state = makeState(6)
    expect([...forcedVisiblePositions(state)]).toEqual([5])
    expect(isBlockVisible(state, 5)).toBe(true)
    expect(isBlockVisible(state, 0)).toBe(false)
  })

  it('marks decorations with data-visible', () => {
    const state = setVisible(makeState(6), [])
    const decos = visibilityKey.get(state).props.decorations!(state) as DecorationSet
    const found = decos.find()
    expect(found.length).toBe(2)
    expect(found.map((d) => d.spec.visible)).toEqual([false, true])
  })

  it('memoizes decorations when nothing changed', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)
    const a = plugin.props.decorations!(state)
    const b = plugin.props.decorations!(state)
    expect(a).toBe(b)
  })

  it('rebuilds decorations when the doc changes', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)
    const a = plugin.props.decorations!(state)
    const next = state.apply(state.tr.insertText('x', 1))
    const b = plugin.props.decorations!(next)
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/visibility.test.ts`
Expected: FAIL — 无法解析 `../src/core/viewport/visibility`

- [ ] **Step 3: 实现**

`src/core/viewport/visibility.ts`：

```ts
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

export interface VisibilityState {
  visible: ReadonlySet<number>
}

export const visibilityKey = new PluginKey<VisibilityState>('onebox-visibility')

export function forcedVisiblePositions(state: EditorState): Set<number> {
  const forced = new Set<number>()
  for (const pos of [state.selection.from, state.selection.to]) {
    const $pos = state.doc.resolve(pos)
    forced.add($pos.depth === 0 ? pos : $pos.before(1))
  }
  return forced
}

export function isBlockVisible(state: EditorState, pos: number): boolean {
  if (visibilityKey.getState(state)?.visible.has(pos)) return true
  return forcedVisiblePositions(state).has(pos)
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export function createVisibilityPlugin(): Plugin<VisibilityState> {
  let cache: {
    doc: Node
    visible: ReadonlySet<number>
    forced: ReadonlySet<number>
    deco: DecorationSet
  } | null = null

  return new Plugin<VisibilityState>({
    key: visibilityKey,
    state: {
      init: () => ({ visible: new Set<number>() }),
      apply(tr, value) {
        const meta = tr.getMeta(visibilityKey) as { visible: ReadonlySet<number> } | undefined
        return meta ? { visible: meta.visible } : value
      },
    },
    props: {
      decorations(state) {
        const visible = visibilityKey.getState(state)!.visible
        const forced = forcedVisiblePositions(state)
        if (
          cache &&
          cache.doc === state.doc &&
          sameSet(cache.visible, visible) &&
          sameSet(cache.forced, forced)
        ) {
          return cache.deco
        }
        const decos: Decoration[] = []
        state.doc.forEach((node, pos) => {
          const on = visible.has(pos) || forced.has(pos)
          // 第 4 个参数才是 Decoration.spec 的返回值；attrs 无法从公开 API 读回
          decos.push(
            Decoration.node(
              pos,
              pos + node.nodeSize,
              { 'data-visible': on ? 'true' : 'false' },
              { visible: on },
            ),
          )
        })
        const deco = DecorationSet.create(state.doc, decos)
        cache = { doc: state.doc, visible, forced, deco }
        return deco
      },
    },
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/visibility.test.ts`
Expected: PASS（7 passed）

若 `forces the selection block visible` 得到 `[0]` 而非 `[5]`，说明测试里 `selectionPos` 落在了 block1；确认 doc 位置计算（paragraph nodeSize = 1 + 文本长度 + 1）。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

---

## Task 6: 块 nodeView（占位 ↔ 内容）

**Files:**
- Create: `src/core/viewport/blockNodeView.ts`
- Test: `tests/blockNodeView.test.ts`

**Interfaces:**
- Consumes: `HeightCache` / `estimateHeight`（Task 4）、`isBlockVisible`（Task 5）、`TOP_LEVEL_BLOCK_TYPES`（Task 2）
- Produces:
  - `interface ViewportObserver { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void }` — **在此文件定义并导出**，Task 7 实现它
  - `createBlockNodeView(node, view, getPos, heights, getObserver): NodeView`
  - `blockNodeViews(heights: HeightCache, getObserver: () => ViewportObserver | null): Record<string, (node: Node, view: EditorView, getPos: () => number | undefined) => NodeView>`

- [ ] **Step 1: 写失败测试**

`tests/blockNodeView.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { HeightCache } from '../src/core/viewport/heights'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { blockNodeViews, createBlockNodeView } from '../src/core/viewport/blockNodeView'

// block1 pos=0, block2 pos=5；选区放在 block2，使 block1 可被隐藏
function makeView(visible: number[]) {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('aaa')]),
    schema.node('paragraph', null, [schema.text('bbb')]),
  ])
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 6),
    plugins: [createVisibilityPlugin()],
  })
  state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set(visible) }))
  return { state } as unknown as EditorView
}

describe('createBlockNodeView', () => {
  it('renders contentDOM when visible', () => {
    const heights = new HeightCache()
    const view = makeView([0])
    const nv = createBlockNodeView(view.state.doc.child(0), view, () => 0, heights, () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.dataset.visible).toBe('true')
    expect(nv.dom.contains(nv.contentDOM!)).toBe(true)
  })

  it('renders a height-sized placeholder when hidden', () => {
    const heights = new HeightCache()
    const view = makeView([])
    const block = view.state.doc.child(0)
    heights.set(block, 123)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.contentDOM).toBeUndefined()
    expect(nv.dom.dataset.visible).toBe('false')
    expect(nv.dom.style.height).toBe('123px')
  })

  it('falls back to estimateHeight when unmeasured', () => {
    const view = makeView([])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.style.height).toBe('28px')
  })

  it('returns false from update when visibility flips', () => {
    const heights = new HeightCache()
    const view = makeView([0])
    const nv = createBlockNodeView(view.state.doc.child(0), view, () => 0, heights, () => null)
    view.state = view.state.apply(
      view.state.tr.setMeta(visibilityKey, { visible: new Set<number>() }),
    )
    expect(nv.update!(view.state.doc.child(0), [], undefined as never)).toBe(false)
  })

  it('returns true from update when visibility is unchanged', () => {
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.update!(view.state.doc.child(0), [], undefined as never)).toBe(true)
  })

  it('registers and unregisters with the observer', () => {
    const seen: string[] = []
    const observer = {
      observe: () => seen.push('observe'),
      unobserve: () => seen.push('unobserve'),
      disconnect: () => {},
    }
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => observer,
    )
    expect(seen).toEqual(['observe'])
    nv.destroy!()
    expect(seen).toEqual(['observe', 'unobserve'])
  })

  it('ignores mutations outside contentDOM', () => {
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.ignoreMutation!({ target: nv.dom } as never)).toBe(true)
    expect(nv.ignoreMutation!({ target: nv.contentDOM } as never)).toBe(false)
  })
})

describe('blockNodeViews', () => {
  it('registers every top-level type but not listItem', () => {
    const views = blockNodeViews(new HeightCache(), () => null)
    expect(Object.keys(views).sort()).toEqual(
      ['blockquote', 'bulletList', 'codeBlock', 'heading', 'horizontalRule', 'orderedList', 'paragraph'],
    )
    expect(views.listItem).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/blockNodeView.test.ts`
Expected: FAIL — 无法解析 `../src/core/viewport/blockNodeView`

- [ ] **Step 3: 实现**

`src/core/viewport/blockNodeView.ts`：

```ts
import type { Node } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { TOP_LEVEL_BLOCK_TYPES } from '../schema'
import { estimateHeight, type HeightCache } from './heights'
import { isBlockVisible } from './visibility'

export interface ViewportObserver {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}

export function createBlockNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): NodeView {
  let current = node
  const pos = getPos()
  const visible = pos !== undefined && isBlockVisible(view.state, pos)

  const dom = document.createElement('div')
  dom.className = 'onebox-block'
  dom.dataset.visible = visible ? 'true' : 'false'

  let contentDOM: HTMLElement | undefined
  let resizeObserver: ResizeObserver | undefined

  if (visible) {
    contentDOM = document.createElement('div')
    contentDOM.className = 'onebox-block-content'
    dom.appendChild(contentDOM)
    resizeObserver = new ResizeObserver(() => {
      heights.set(current, dom.offsetHeight)
    })
    resizeObserver.observe(dom)
  } else {
    dom.style.height = `${heights.get(current) ?? estimateHeight(current)}px`
  }

  getObserver()?.observe(dom)

  return {
    dom,
    contentDOM,
    update(nextNode) {
      const p = getPos()
      const nextVisible = p !== undefined && isBlockVisible(view.state, p)
      if (nextVisible !== visible) return false
      current = nextNode
      return true
    },
    destroy() {
      resizeObserver?.disconnect()
      getObserver()?.unobserve(dom)
    },
    ignoreMutation(mutation) {
      return !contentDOM || !contentDOM.contains(mutation.target)
    },
  }
}

export function blockNodeViews(
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): Record<string, (node: Node, view: EditorView, getPos: () => number | undefined) => NodeView> {
  const out: Record<
    string,
    (node: Node, view: EditorView, getPos: () => number | undefined) => NodeView
  > = {}
  for (const name of TOP_LEVEL_BLOCK_TYPES) {
    out[name] = (node, view, getPos) => createBlockNodeView(node, view, getPos, heights, getObserver)
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/blockNodeView.test.ts`
Expected: PASS（8 passed）

若 happy-dom 未实现 `ResizeObserver` 导致 ReferenceError，在 `vite.config.ts` 的 `test` 段加 `setupFiles: ['tests/setup.ts']`，并在 `tests/setup.ts` 写入最小 stub：

```ts
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
```

真实测高行为在 Task 10 的 Chrome 验证中确认，stub 只用于单测环境。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

---

## Task 7: 视口 Observer

**Files:**
- Create: `src/core/viewport/observer.ts`
- Test: `tests/observer.test.ts`

**Interfaces:**
- Consumes: `ViewportObserver`（Task 6 定义）、`visibilityKey`（Task 5）
- Produces:
  - `nextVisibleSet(prev: ReadonlySet<number>, next: ReadonlySet<number>): ReadonlySet<number> | null` — 集合未变返回 `null`
  - `blockPosOf(view: EditorView, el: Element): number`
  - `createViewportObserver(view: EditorView, root: HTMLElement, rootMargin?: string): ViewportObserver`

- [ ] **Step 1: 写失败测试**

`tests/observer.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { nextVisibleSet } from '../src/core/viewport/observer'

describe('nextVisibleSet', () => {
  it('returns null for identical sets', () => {
    expect(nextVisibleSet(new Set([0, 5]), new Set([5, 0]))).toBeNull()
  })

  it('returns null for two empty sets', () => {
    expect(nextVisibleSet(new Set(), new Set())).toBeNull()
  })

  it('returns the new set when a block enters', () => {
    const next = new Set([0, 5, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when a block leaves', () => {
    const next = new Set([0])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })

  it('returns the new set when size matches but members differ', () => {
    const next = new Set([0, 10])
    expect(nextVisibleSet(new Set([0, 5]), next)).toBe(next)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/observer.test.ts`
Expected: FAIL — 无法解析 `../src/core/viewport/observer`

- [ ] **Step 3: 实现**

`src/core/viewport/observer.ts`：

```ts
import type { EditorView } from '@tiptap/pm/view'
import type { ViewportObserver } from './blockNodeView'
import { visibilityKey } from './visibility'

export function nextVisibleSet(
  prev: ReadonlySet<number>,
  next: ReadonlySet<number>,
): ReadonlySet<number> | null {
  if (prev.size === next.size) {
    let same = true
    for (const v of next) {
      if (!prev.has(v)) {
        same = false
        break
      }
    }
    if (same) return null
  }
  return next
}

export function blockPosOf(view: EditorView, el: Element): number {
  const pos = view.posAtDOM(el, 0)
  const $pos = view.state.doc.resolve(pos)
  return $pos.depth === 0 ? pos : $pos.before(1)
}

export function createViewportObserver(
  view: EditorView,
  root: HTMLElement,
  rootMargin = '200px',
): ViewportObserver {
  const states = new Map<Element, boolean>()
  let prev: ReadonlySet<number> = new Set()
  let raf = 0

  const flush = () => {
    raf = 0
    // IME 组合中销毁块会丢字：推迟到 composition 结束
    if (view.composing) {
      raf = requestAnimationFrame(flush)
      return
    }
    const next = new Set<number>()
    for (const [el, intersecting] of states) {
      if (!intersecting || !el.isConnected) continue
      next.add(blockPosOf(view, el))
    }
    const changed = nextVisibleSet(prev, next)
    if (!changed) return
    prev = changed
    view.dispatch(view.state.tr.setMeta(visibilityKey, { visible: changed }))
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) states.set(entry.target, entry.isIntersecting)
      if (!raf) raf = requestAnimationFrame(flush)
    },
    { root, rootMargin },
  )

  return {
    observe(el) {
      states.set(el, false)
      io.observe(el)
    },
    unobserve(el) {
      states.delete(el)
      io.unobserve(el)
    },
    disconnect() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      io.disconnect()
      states.clear()
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/observer.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

报告时说明：IntersectionObserver 与 `blockPosOf` 的真实行为无法在 happy-dom 验证，留待 Task 10 的 Chrome 验证。若 2 万块量级下 IO 成为瓶颈，备选方案是「按 `getBoundingClientRect().top` 对 `view.dom.children` 二分查找可见区间」，本阶段不实现。

---

## Task 8: Rust 工具链、Tauri 外壳与文件 IO

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/fs.rs`, `src/io/types.ts`, `src/io/tauri.ts`
- Modify: `.gitignore`
- Test: `src-tauri/src/fs.rs` 内 `#[cfg(test)]` 模块

**Interfaces:**
- Consumes: Task 1 的 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/cli`
- Produces:
  - `interface FileSystem { readText(path: string): Promise<string>; writeText(path: string, content: string): Promise<void> }`
  - `tauriFileSystem: FileSystem`
  - Rust 命令 `read_text(path: String) -> Result<String, String>`、`write_text(path: String, content: String) -> Result<(), String>`

- [ ] **Step 1: 向用户确认安装 Rust（系统依赖，必须先问）**

本机 `rustc` / `cargo` 均不存在。向用户展示将执行的命令并取得明确同意后才运行：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

Expected: 安装完成后 `source "$HOME/.cargo/env"`，`rustc --version` 与 `cargo --version` 有输出。

用户不同意则停下，报告 Task 8 及之后被阻塞，不要绕过。

- [ ] **Step 2: 写失败的 Rust 测试**

`src-tauri/src/fs.rs`（先只写测试与函数签名，函数体用 `todo!()`）：

```rust
use std::path::PathBuf;

#[tauri::command]
pub async fn read_text(path: String) -> Result<String, String> {
    let _ = PathBuf::from(&path);
    todo!()
}

#[tauri::command]
pub async fn write_text(path: String, content: String) -> Result<(), String> {
    let _ = PathBuf::from(&path);
    let _ = content;
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("onebox-test-{}", std::process::id()))
    }

    #[tokio::test]
    async fn round_trips_text() {
        let dir = temp_dir();
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("sample.md");
        let p = path.to_str().unwrap().to_string();
        write_text(p.clone(), "# 标题\n".into()).await.unwrap();
        assert_eq!(read_text(p).await.unwrap(), "# 标题\n");
        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }

    #[tokio::test]
    async fn missing_file_errors() {
        let path = temp_dir().join("definitely-missing.md");
        let result = read_text(path.to_str().unwrap().to_string()).await;
        assert!(result.is_err());
    }
}
```

- [ ] **Step 3: 创建 Tauri 工程文件**

`src-tauri/Cargo.toml`：

```toml
[package]
name = "onebox"
version = "0.1.0"
description = "onebox markdown editor"
edition = "2021"

[lib]
name = "onebox_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["fs", "io-util", "rt", "macros"] }
```

`src-tauri/build.rs`：

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/main.rs`：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    onebox_lib::run()
}
```

`src-tauri/src/lib.rs`：

```rust
mod fs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![fs::read_text, fs::write_text])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/tauri.conf.json`（第一阶段只做 `tauri dev`，不做分发打包，故 `bundle.active` 为 false、不需要图标）：

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "onebox",
  "version": "0.1.0",
  "identifier": "com.onebox.editor",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "label": "main", "title": "onebox", "width": 1100, "height": 760 }],
    "security": { "csp": null }
  },
  "bundle": { "active": false, "targets": "all", "icon": [] }
}
```

`src-tauri/capabilities/default.json`：

```json
{
  "identifier": "default",
  "description": "main window permissions",
  "windows": ["main"],
  "permissions": ["core:default", "dialog:allow-open", "dialog:allow-save"]
}
```

`.gitignore` 追加（`node_modules/`、`dist/`、`.DS_Store` 已由 Task 1 写入，不要重复）：

```
src-tauri/target/
src-tauri/gen/schemas/
```

- [ ] **Step 4: 运行 Rust 测试确认失败**

Run: `cd src-tauri && cargo test`
Expected: FAIL — 两个测试 panic 于 `todo!()`（首次会先下载并编译依赖，耗时数分钟）

- [ ] **Step 5: 实现 Rust 命令**

把 `src-tauri/src/fs.rs` 的两个函数体替换为：

```rust
#[tauri::command]
pub async fn read_text(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(PathBuf::from(&path))
        .await
        .map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub async fn write_text(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(PathBuf::from(&path), content)
        .await
        .map_err(|e| format!("write failed: {e}"))
}
```

保留 `use std::path::PathBuf;` 与 `#[cfg(test)] mod tests` 不变。

- [ ] **Step 6: 运行 Rust 测试确认通过**

Run: `cd src-tauri && cargo test`
Expected: PASS（2 passed）

- [ ] **Step 7: 实现前端 IO 层**

`src/io/types.ts`：

```ts
export interface FileSystem {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
}
```

`src/io/tauri.ts`：

```ts
import { invoke } from '@tauri-apps/api/core'
import type { FileSystem } from './types'

export const tauriFileSystem: FileSystem = {
  readText: (path) => invoke<string>('read_text', { path }),
  writeText: (path, content) => invoke<void>('write_text', { path, content }),
}
```

- [ ] **Step 8: 类型检查与桌面启动**

Run: `pnpm typecheck`
Expected: 退出码 0

Run: `pnpm tauri dev`（后台运行，首次编译耗时数分钟）
Expected: 弹出标题为 onebox 的桌面窗口，内容为 Task 1 的 `onebox` 文本

- [ ] **Step 9: 提交并报告**

提交 `src-tauri/`（含 `Cargo.lock`）、`src/io/`、`.gitignore`。**`Cargo.lock` 必须提交**，它是 Rust 侧的版本锁定依据。`src-tauri/target/` 已被忽略，不要加。

---

## Task 9: Editor 装配与 Solid 外壳

**Files:**
- Create: `src/core/editor.ts`, `src/ui/EditorShell.tsx`, `src/styles/editor.css`
- Modify: `src/App.tsx`（替换 Task 1 的占位实现）, `src/index.tsx`（引入样式）
- Test: `tests/editor.test.ts`

**Interfaces:**
- Consumes: `extensions` / `schema`（Task 2）、`parseMarkdown` / `serializeMarkdown`（Task 3）、`HeightCache`（Task 4）、`createVisibilityPlugin`（Task 5）、`blockNodeViews` / `ViewportObserver`（Task 6）、`createViewportObserver`（Task 7）
- Produces:
  - `interface EditorHandle { editor: Editor; loadMarkdown(text: string): void; toMarkdown(): string; destroy(): void }`
  - `createEditor(opts: { element: HTMLElement; scrollRoot: HTMLElement; markdown: string; onUpdate: (doc: Node) => void }): EditorHandle`
  - `EditorShell` props: `{ markdown: string; onReady: (h: EditorHandle) => void; onUpdate: (doc: Node) => void }`

- [ ] **Step 1: 写失败测试**

`tests/editor.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createEditor } from '../src/core/editor'

const SAMPLE = '# 标题\n\n段落 **粗体**\n\n- 甲\n- 乙\n'

function mount() {
  const scrollRoot = document.createElement('div')
  const element = document.createElement('div')
  scrollRoot.appendChild(element)
  document.body.appendChild(scrollRoot)
  return { scrollRoot, element }
}

describe('createEditor', () => {
  it('loads markdown and serializes it back', () => {
    const { scrollRoot, element } = mount()
    const handle = createEditor({ element, scrollRoot, markdown: SAMPLE, onUpdate: () => {} })
    expect(handle.toMarkdown()).toContain('# 标题')
    expect(handle.toMarkdown()).toContain('**粗体**')
    handle.destroy()
    scrollRoot.remove()
  })

  it('loadMarkdown replaces the document', () => {
    const { scrollRoot, element } = mount()
    const handle = createEditor({ element, scrollRoot, markdown: SAMPLE, onUpdate: () => {} })
    handle.loadMarkdown('## 换掉了\n')
    expect(handle.toMarkdown()).toContain('## 换掉了')
    expect(handle.toMarkdown()).not.toContain('粗体')
    handle.destroy()
    scrollRoot.remove()
  })

  it('renders one wrapper per top-level block', () => {
    const { scrollRoot, element } = mount()
    const handle = createEditor({ element, scrollRoot, markdown: SAMPLE, onUpdate: () => {} })
    expect(element.querySelectorAll('.onebox-block').length).toBe(3)
    handle.destroy()
    scrollRoot.remove()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/editor.test.ts`
Expected: FAIL — 无法解析 `../src/core/editor`

- [ ] **Step 3: 实现 editor 装配**

`src/core/editor.ts`：

```ts
import { Editor, Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { extensions, schema } from './schema'
import { parseMarkdown, serializeMarkdown } from './markdown'
import { HeightCache } from './viewport/heights'
import { createVisibilityPlugin } from './viewport/visibility'
import { blockNodeViews, type ViewportObserver } from './viewport/blockNodeView'
import { createViewportObserver } from './viewport/observer'

export interface EditorHandle {
  editor: Editor
  loadMarkdown: (text: string) => void
  toMarkdown: () => string
  destroy: () => void
}

const visibilityExtension = Extension.create({
  name: 'oneboxVisibility',
  addProseMirrorPlugins: () => [createVisibilityPlugin()],
})

export function createEditor(opts: {
  element: HTMLElement
  scrollRoot: HTMLElement
  markdown: string
  onUpdate: (doc: Node) => void
}): EditorHandle {
  const heights = new HeightCache()
  let observer: ViewportObserver | null = null

  const editor = new Editor({
    element: opts.element,
    extensions: [...extensions, visibilityExtension],
    content: parseMarkdown(opts.markdown, schema).toJSON(),
    editorProps: { nodeViews: blockNodeViews(heights, () => observer) },
    onUpdate: ({ editor }) => opts.onUpdate(editor.state.doc),
  })

  observer = createViewportObserver(editor.view, opts.scrollRoot)
  // 首批 nodeView 构造时 observer 尚未存在，需补挂
  for (const child of Array.from(editor.view.dom.children)) observer.observe(child)

  return {
    editor,
    loadMarkdown(text: string) {
      const doc = parseMarkdown(text, schema)
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content)
      editor.view.dispatch(tr)
    },
    toMarkdown: () => serializeMarkdown(editor.state.doc),
    destroy() {
      observer?.disconnect()
      observer = null
      editor.destroy()
    },
  }
}
```

`visibilityExtension` 独立于 `src/core/schema.ts` 的 `extensions`，因为 `getSchema` 只应吃产生节点的扩展。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/editor.test.ts`
Expected: PASS（3 passed）

happy-dom 无真实布局，`IntersectionObserver` 不会触发回调；本任务只验证装配、加载与序列化，占位/内容切换的真实行为在 Task 10 Step 7-8 的 Chrome 验证中确认。

若报 `IntersectionObserver is not defined`，创建 `tests/setup.ts`：

```ts
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  } as unknown as typeof IntersectionObserver
}
```

并在 `vite.config.ts` 的 `test` 段加 `setupFiles: ['tests/setup.ts']`。

若 Tiptap 的 `EditorView` 在 happy-dom 下构造即抛错（缺 Selection / Range 等 API），不要给 happy-dom 打补丁：删除 `tests/editor.test.ts`，把这三条断言原样搬到 Task 10 Step 7 的 `evaluate_script` 中在真 Chrome 执行，并在报告里说明该任务的测试改由浏览器承担。

- [ ] **Step 5: 实现 Solid 外壳与样式**

`src/ui/EditorShell.tsx`：

```tsx
import { onCleanup, onMount } from 'solid-js'
import type { Node } from '@tiptap/pm/model'
import { createEditor, type EditorHandle } from '../core/editor'

export default function EditorShell(props: {
  markdown: string
  onReady: (handle: EditorHandle) => void
  onUpdate: (doc: Node) => void
}) {
  let scrollRoot!: HTMLDivElement
  let element!: HTMLDivElement
  let handle: EditorHandle | undefined

  onMount(() => {
    handle = createEditor({
      element,
      scrollRoot,
      markdown: props.markdown,
      onUpdate: props.onUpdate,
    })
    props.onReady(handle)
  })

  onCleanup(() => handle?.destroy())

  return (
    <div class="editor-scroll" ref={scrollRoot}>
      <div class="editor-mount" ref={element} />
    </div>
  )
}
```

`src/styles/editor.css`：

```css
:root {
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

body {
  margin: 0;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.editor-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.editor-mount {
  max-width: 760px;
  margin: 0 auto;
  outline: none;
}

.onebox-block {
  position: relative;
}

.onebox-block[data-visible='false'] {
  overflow: hidden;
}

.onebox-block-content {
  min-height: 1.5em;
}
```

- [ ] **Step 6: 接线 App**

`src/App.tsx` 全量替换为：

```tsx
import EditorShell from './ui/EditorShell'
import type { EditorHandle } from './core/editor'
import './styles/editor.css'

const SAMPLE = [
  '# onebox',
  '',
  '第一阶段骨架。',
  '',
  '- 支持列表',
  '- 支持 **粗体**、*斜体*、~~删除线~~、`代码`',
  '',
  '> 引用块',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '---',
  '',
].join('\n')

export default function App() {
  let handle: EditorHandle | undefined
  return (
    <main class="app">
      <EditorShell markdown={SAMPLE} onReady={(h) => (handle = h)} onUpdate={() => {}} />
    </main>
  )
}
```

`handle` 在本任务只赋值不读取，Task 10 会用它做文件加载与保存。`tsconfig.json` 未开启 `noUnusedLocals`，因此不会报未使用错误——不要为此加 `_` 前缀或 `void` 语句。

- [ ] **Step 7: 类型检查与浏览器确认**

Run: `pnpm typecheck`
Expected: 退出码 0

Run: `pnpm dev`，用 chrome-devtools MCP 打开 `http://localhost:1420`，`evaluate_script`：

```js
() => ({
  blocks: document.querySelectorAll('.onebox-block').length,
  withContent: document.querySelectorAll('.onebox-block-content').length,
  text: document.querySelector('.editor-mount')?.textContent?.slice(0, 40),
})
```

Expected: `blocks` ≥ 6，`withContent` ≥ 1，`text` 含 `onebox`

- [ ] **Step 8: 提交并报告**

---

## Task 10: 文件读写、只读保护、性能读数与端到端验收

**Files:**
- Create: `src/core/metrics.ts`
- Modify: `src/App.tsx`（文件打开/保存、状态栏、只读保护、dev 读数）, `src/styles/editor.css`（状态栏样式）
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `FileSystem` / `tauriFileSystem`（Task 8）、`EditorHandle`（Task 9）、`detectUnsupported` / `serializeMarkdown`（Task 3）、`visibilityKey`（Task 5）
- Produces:
  - `interface Metrics { domNodes: number; totalBlocks: number; visibleBlocks: number }`
  - `collectMetrics(view: EditorView): Metrics`

- [ ] **Step 1: 写失败测试**

`tests/metrics.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { collectMetrics } from '../src/core/metrics'

describe('collectMetrics', () => {
  it('counts total and visible blocks', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('paragraph', null, [schema.text('b')]),
      schema.node('paragraph', null, [schema.text('c')]),
    ])
    let state = EditorState.create({ doc, plugins: [createVisibilityPlugin()] })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state, dom: document.createElement('div') } as unknown as EditorView
    const m = collectMetrics(view)
    expect(m.totalBlocks).toBe(3)
    expect(m.visibleBlocks).toBe(1)
    expect(typeof m.domNodes).toBe('number')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/metrics.test.ts`
Expected: FAIL — 无法解析 `../src/core/metrics`

- [ ] **Step 3: 实现 metrics**

`src/core/metrics.ts`：

```ts
import type { EditorView } from '@tiptap/pm/view'
import { visibilityKey } from './viewport/visibility'

export interface Metrics {
  domNodes: number
  totalBlocks: number
  visibleBlocks: number
}

export function collectMetrics(view: EditorView): Metrics {
  const visible = visibilityKey.getState(view.state)?.visible ?? new Set<number>()
  return {
    domNodes: view.dom.querySelectorAll('*').length,
    totalBlocks: view.state.doc.childCount,
    visibleBlocks: visible.size,
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/metrics.test.ts`
Expected: PASS（1 passed）

- [ ] **Step 5: 接线文件读写与只读保护**

`src/App.tsx` 全量替换为：

```tsx
import { createSignal, onCleanup } from 'solid-js'
import { open, save } from '@tauri-apps/plugin-dialog'
import EditorShell from './ui/EditorShell'
import type { EditorHandle } from './core/editor'
import { detectUnsupported, serializeMarkdown } from './core/markdown'
import { collectMetrics } from './core/metrics'
import { tauriFileSystem } from './io/tauri'
import './styles/editor.css'

const SAMPLE = '# onebox\n\n打开一个 .md 文件开始。\n'
const SAVE_DEBOUNCE_MS = 800

export default function App() {
  let handle: EditorHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false

  const [path, setPath] = createSignal<string | null>(null)
  const [readonly, setReadonly] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  const flush = async () => {
    if (!handle || !path() || readonly() || !pending) return
    pending = false
    try {
      await tauriFileSystem.writeText(path()!, handle.toMarkdown())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  const onUpdate = () => {
    if (!path() || readonly()) return
    pending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  const openFile = async () => {
    const picked = await open({ multiple: false, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (typeof picked !== 'string') return
    await flush()
    try {
      const text = await tauriFileSystem.readText(picked)
      const unsupported = detectUnsupported(text)
      handle?.loadMarkdown(text)
      handle?.editor.setEditable(unsupported.length === 0)
      setReadonly(unsupported.length > 0)
      setPath(picked)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  const saveAs = async () => {
    if (!handle) return
    const picked = await save({ filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (typeof picked !== 'string') return
    try {
      await tauriFileSystem.writeText(picked, serializeMarkdown(handle.editor.state.doc))
      setPath(picked)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  const onKeydown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'o') {
      e.preventDefault()
      void openFile()
    } else if (e.key === 's') {
      e.preventDefault()
      if (e.shiftKey) void saveAs()
      else void flush()
    }
  }

  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', () => void flush())

  let metricsTimer: ReturnType<typeof setInterval> | undefined
  if (import.meta.env.DEV) {
    metricsTimer = setInterval(() => {
      if (handle) console.debug('[onebox metrics]', collectMetrics(handle.editor.view))
    }, 2000)
  }

  onCleanup(() => {
    window.removeEventListener('keydown', onKeydown)
    if (timer) clearTimeout(timer)
    if (metricsTimer) clearInterval(metricsTimer)
    void flush()
  })

  return (
    <main class="app">
      <EditorShell
        markdown={SAMPLE}
        onReady={(h) => {
          handle = h
          if (import.meta.env.DEV) {
            ;(window as unknown as { __oneboxLoad: (md: string) => void }).__oneboxLoad = (md) =>
              h.loadMarkdown(md)
          }
        }}
        onUpdate={onUpdate}
      />
      <footer class="statusbar">
        <span>{path() ?? '未打开'}</span>
        <span>{readonly() ? '只读' : ''}</span>
        <span>{failed() ? '保存失败' : ''}</span>
      </footer>
    </main>
  )
}
```

`src/styles/editor.css` 追加：

```css
.statusbar {
  display: flex;
  gap: 16px;
  padding: 4px 12px;
  font-size: 12px;
  opacity: 0.6;
  border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
}

.statusbar span:first-child {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6: 类型检查与全量测试**

Run: `pnpm typecheck`
Expected: 退出码 0

Run: `pnpm test`
Expected: 全部 PASS，共 51 项（harness 1 + schema 5 + markdown 14 + heights 7 + visibility 7 + blockNodeView 8 + observer 5 + editor 3 + metrics 1）。若 Task 9 Step 4 走了浏览器 fallback 删除了 `tests/editor.test.ts`，则为 48 项，且那 3 条断言必须已在 Step 7 的 Chrome 验证中执行并通过。

Run: `cd src-tauri && cargo test`
Expected: PASS（2 passed）

- [ ] **Step 7: Chrome 端到端验证（真浏览器，不可用单测替代）**

Run: `pnpm dev`

用 chrome-devtools MCP 打开 `http://localhost:1420`。为验证大文档虚拟化，先 `evaluate_script` 注入 3000 块文档：

```js
() => {
  const md = Array.from({ length: 3000 }, (_, i) => `第 ${i} 段：${'内容'.repeat(20)}`).join('\n\n')
  window.__oneboxLoad(md)
  return md.length
}
```

`__oneboxLoad` 已由 Step 5 的 `App.tsx` 在 dev 模式暴露。注入后 `evaluate_script` 断言占位机制：

```js
() => {
  const blocks = [...document.querySelectorAll('.onebox-block')]
  return {
    total: blocks.length,
    visible: blocks.filter((b) => b.dataset.visible === 'true').length,
    placeholders: blocks.filter((b) => b.dataset.visible === 'false').length,
    contentDOMs: document.querySelectorAll('.onebox-block-content').length,
    domNodes: document.querySelectorAll('*').length,
  }
}
```

Expected: `total` = 3000；`visible` 为几十量级；`placeholders` ≈ 3000 − visible；`contentDOMs` == `visible`；`domNodes` 远小于全量渲染（全量约 3000 × 每块十余节点）

滚动到底部后重复上面脚本，Expected：`visible` 集合改变、原顶部块转为占位、`contentDOMs` 仍为几十量级。

- [ ] **Step 8: Chrome 交互验证**

逐项在真浏览器操作并记录结果：

1. 点击某段输入中文（连续 IME 输入 10 字以上）→ 无丢字
2. 在段落末尾按 Enter → 新块出现且可输入
3. 在块首按 Backspace → 与上一块合并
4. 鼠标跨块拖选 3 个块 → 选区连续、Ctrl/Cmd+C 后粘贴到文本编辑器得到正确 Markdown
5. Cmd/Ctrl+Z 多次 → 全局撤销跨块生效
6. 滚出视口再滚回 → 内容完整恢复，光标可用
7. 打开含表格的 `.md`（用临时文件）→ 状态栏显示「只读」，编辑被禁用，文件内容未被改写

- [ ] **Step 9: 桌面端验证**

Run: `pnpm tauri dev`

在桌面窗口内重复 Step 8 的第 1、6、7 项，并验证 Cmd+O 打开临时 `.md`、编辑后自动保存、Cmd+Shift+S 另存为。用第三方编辑器（Typora / Obsidian / VSCode）打开保存结果，确认无格式错乱、无 HTML 注释、无块 ID。

- [ ] **Step 10: 记录性能读数并给出 A→B 判断**

在 1 万 / 10 万 / 100 万字符三档语料下记录 `collectMetrics` 输出与滚动帧率（chrome-devtools performance trace）。

判断规则（spec §9）：**若 10 万字符档即出现明显掉帧或 DOM 数不可接受，直接升级方案 B，不等到第四阶段。** 把读数与结论写进报告。

- [ ] **Step 11: 提交并报告**

报告内容：51 项前端单测 + 2 项 Rust 单测结果、Chrome 与桌面端逐项验证结果、三档性能读数、A 是否需升级 B 的结论。

按 Global Constraints 的「提交并报告」含义提交本任务文件。**不 push、不合入 main** —— 合入由用户真机验收后决定。

---

## 附：spec 覆盖对照

| spec 章节 | 对应任务 |
|---|---|
| §5.1 io 文件读写 | Task 8 |
| §5.2 GFM 双向 + 不支持检测 + 禁 underline | Task 2、Task 3 |
| §5.3 editor 装配 + 800ms 防抖 + flush | Task 9、Task 10 |
| §5.4 高度缓存 WeakMap + estimateHeight | Task 4 |
| §5.5 可见性 plugin + memoize + 强制可见 | Task 5 |
| §5.6 blockNodeView + 重建机制 | Task 6 |
| §5.7 IntersectionObserver + rAF 合并 + IME 推迟 | Task 7 |
| §5.8 Solid 外壳 + 极简界面 | Task 9、Task 10 |
| §7 错误处理（只读保护、失败标记） | Task 3、Task 10 |
| §8 测试策略（单测 + 真浏览器） | 各任务 Step 1-4、Task 10 Step 7-9 |
| §9 性能测量点 + A→B 判断 | Task 10 Step 10 |
| §10 版本锁定 | Task 1、Task 8 |
| §12 回写技术方案文档 | **未覆盖，见下** |

**§12 回写技术方案文档不在本计划内。** 它是文档工作而非可测试的软件交付，应在 Task 10 验收通过、确认 A 方案成立后单独执行，避免把待验证的结论写进「最终定稿」。执行时机由用户决定。