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
- **mark 名用 Tiptap 实际注册名**：`bold`、`italic`、`code`、`strike`、`link`。**不是** `strong` / `em` —— 那是 prosemirror-markdown 默认 schema 的名字。已实测确认：`getSchema([StarterKit.configure({underline:false})]).marks` 的键为 `link, bold, code, italic, strike`；`bold` 渲染 `<strong>`、`italic` 渲染 `<em>`，GFM 语义完整。markdown-it 的 token 名仍是 `strong` / `em` / `s`，映射时两侧名字不同，必须显式对应。
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
    for (const name of ['bold', 'italic', 'code', 'strike', 'link']) {
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

  it('emits no HTML for any supported mark', () => {
    const out = roundTrip('**b** *i* ~~s~~ `c` [l](https://e.com)\n')
    expect(out).not.toMatch(/<[a-zA-Z/]/)
  })

  it('sizes the fence to survive nested backtick runs', () => {
    const md = '````md\n```\nx\n```\n````\n'
    const once = parseMarkdown(md, schema)
    const out = serializeMarkdown(once)
    expect(out.startsWith('````')).toBe(true)
    expect(parseMarkdown(out, schema).eq(once)).toBe(true)
  })

  it('keeps tilde-fenced content containing backtick fences', () => {
    const md = '~~~\n```\nx\n```\n~~~\n'
    const once = parseMarkdown(md, schema)
    expect(parseMarkdown(serializeMarkdown(once), schema).eq(once)).toBe(true)
  })

  it('sizes the fence for an indented closing fence inside the content', () => {
    const md = '````\n   ```\nx\n````\n'
    const once = parseMarkdown(md, schema)
    expect(parseMarkdown(serializeMarkdown(once), schema).eq(once)).toBe(true)
  })

  it('still emits exactly three backticks for an ordinary code block', () => {
    expect(roundTrip('```ts\nconst x = 1\n```\n').startsWith('```ts\n')).toBe(true)
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

  it('detects reference-style images', () => {
    expect(detectUnsupported('![alt][r]\n\n[r]: ./a.png\n')).toContain('image')
  })

  it('detects collapsed and shortcut images', () => {
    expect(detectUnsupported('![alt][]\n\n[alt]: ./a.png\n')).toContain('image')
    expect(detectUnsupported('![alt]\n\n[alt]: ./a.png\n')).toContain('image')
  })

  it('detects images with nested brackets in alt', () => {
    expect(detectUnsupported('![a[b]](c)\n')).toContain('image')
  })

  it('detects task lists at any indentation', () => {
    expect(detectUnsupported('parent\n    - [x] nested done\n')).toContain('taskList')
  })

  it('detects empty-label task items', () => {
    expect(detectUnsupported('- [x]\n')).toContain('taskList')
  })
})

describe('parse tolerance', () => {
  it('never throws on any image form', () => {
    for (const md of [
      '![alt](./a.png)\n',
      '![alt][r]\n\n[r]: ./a.png\n',
      '![alt][]\n\n[alt]: ./a.png\n',
      '![alt]\n\n[alt]: ./a.png\n',
      '![a[b]](c)\n',
    ]) {
      expect(() => parseMarkdown(md, schema), md).not.toThrow()
    }
  })

  it('preserves single-line html comments', () => {
    const md = 'before\n\n<!-- hidden -->\n\nafter\n'
    const once = parseMarkdown(md, schema)
    const out = serializeMarkdown(once)
    expect(out).toContain('<!-- hidden -->')
    expect(parseMarkdown(out, schema).eq(once)).toBe(true)
  })
})

describe('detection regression cases', () => {
  it('detects ordered-list task items', () => {
    expect(detectUnsupported('1. [x] done\n2. [ ] todo\n')).toContain('taskList')
  })

  it('detects blockquoted task items', () => {
    expect(detectUnsupported('> - [x] done\n')).toContain('taskList')
  })

  it('detects multi-line html comments', () => {
    expect(detectUnsupported('before\n\n<!--\nhidden\n-->\n\nafter\n')).toContain('html')
  })

  it('does not flag a single-line html comment', () => {
    expect(detectUnsupported('a <!-- x --> b\n')).toEqual([])
  })

  it('pairs fences by char and length so a 4-backtick fence does not invert state', () => {
    // 内层围栏必须是奇数个：偶数个在朴素翻转实现下也会净归零，测不到缺陷
    const md = '````\n```\n````\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(detectUnsupported(md)).toContain('table')
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
    // 无 image 节点。忽略而非抛异常：不支持的文件走只读闸门，磁盘内容不受影响，
    // 但解析必须成功，否则文件根本打不开。
    // markdown-it 的 image 是单 token（无 _open/_close），必须显式 noCloseToken，
    // 否则 ignore 只注册 image_open/image_close，image 本身仍无 handler 而抛异常。
    image: { ignore: true, noCloseToken: true },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
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
      const text = node.textContent
      // 围栏必须长于内容中任何行首围栏串，否则内层围栏提前闭合、正文被截断改写。
      // 代码块是受支持语法，没有只读闸门兜底，所以这里必须自身正确。
      let longest = 0
      for (const line of text.split('\n')) {
        // CommonMark 允许闭合围栏缩进 ≤3 空格，扫描必须同样容忍，
        // 否则缩进的 ``` 不被计入、外层围栏取 3、内容被提前闭合截断
        const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (m) longest = Math.max(longest, m[1].length)
      }
      const fence = '`'.repeat(Math.max(3, longest + 1))
      state.write(fence + ((node.attrs.language as string | null) || '') + '\n')
      state.text(text, false)
      state.ensureNewLine()
      state.write(fence)
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
    // 默认 marks 的键是 em/strong，本项目 schema 的键是 italic/bold，必须逐个改名而非展开
    bold: defaultMarkdownSerializer.marks.strong,
    italic: defaultMarkdownSerializer.marks.em,
    code: defaultMarkdownSerializer.marks.code,
    link: defaultMarkdownSerializer.marks.link,
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

  // 图片用 tokenizer 自身的 token 流判定：markdown-it 能识别 inline / reference /
  // collapsed / shortcut 全部形式，正则穷尽不了。 fenced code 内的图片天然不产生
  // image token，无需另行跳过。
  for (const block of tokenizer.parse(text, {})) {
    for (const tok of block.children ?? []) {
      if (tok.type === 'image') found.add('image')
    }
  }

  let fenceChar = ''
  let fenceLen = 0
  let inHtmlComment = false
  let prev = ''
  for (const line of text.split('\n')) {
    // 围栏按字符与长度配对闭合：4 反引号围栏内的 ``` 行不应翻转状态
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) {
      if (!fenceChar) {
        fenceChar = f[1][0]
        fenceLen = f[1].length
      } else if (f[1][0] === fenceChar && f[1].length >= fenceLen) {
        fenceChar = ''
        fenceLen = 0
      }
      prev = line
      continue
    }
    if (!fenceChar) {
      if (isTableDelimiter(line, prev)) found.add('table')
      // 任意缩进、有序标记、引用前缀、空标签：漏检会让文件以可编辑打开，
      // 保存时任务列表标记被转义改写成字面文本
      if (/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\](\s|$)/.test(line)) found.add('taskList')
      if (/\[\^[^\]]+\]/.test(line)) found.add('footnote')
      if (/<\/?[a-zA-Z][^>]*>/.test(line)) found.add('html')
      // 多行 HTML 注释：起始行未同行闭合时进入注释态。单行注释逐字往返无损，
      // 不纳入检测；多行注释的结束符会被转义成 \-->，在第三方编辑器里永不闭合、
      // 吞掉后文。
      const open = line.indexOf('<!--')
      if (open >= 0 && !line.slice(open + 4).includes('-->')) inHtmlComment = true
      if (inHtmlComment) {
        found.add('html')
        if (line.includes('-->')) inHtmlComment = false
      }
    }
    prev = line
  }
  return [...found]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/markdown.test.ts`
Expected: PASS（30 passed）

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
import { EditorState } from '@tiptap/pm/state'
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

  it('counts explicit newlines, not just characters', () => {
    const code = schema.node('codeBlock', null, [schema.text('a\n'.repeat(9) + 'a')])
    expect(estimateHeight(code)).toBe(240)
  })

  it('counts nested textblocks so a multi-item list is not one line', () => {
    const list = schema.node(
      'bulletList',
      null,
      Array.from({ length: 5 }, () =>
        schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
      ),
    )
    expect(estimateHeight(list)).toBe(120)
  })

  it('counts paragraphs inside a blockquote', () => {
    const quote = schema.node(
      'blockquote',
      null,
      Array.from({ length: 3 }, () => schema.node('paragraph', null, [schema.text('q')])),
    )
    expect(estimateHeight(quote)).toBe(72)
  })
})

describe('node identity across transactions', () => {
  it('keeps an unmodified block reference so the cache still hits', () => {
    const doc = schema.node('doc', null, [para('aaa'), para('bbb')])
    const cache = new HeightCache()
    const second = doc.child(1)
    cache.set(second, 90)
    const next = EditorState.create({ doc }).tr.insertText('x', 1).doc
    expect(next.child(1)).toBe(second)
    expect(cache.get(next.child(1))).toBe(90)
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
  const text = block.textContent
  // 显式换行、自动折行、嵌套文本块数三者取最大：
  // 只看字符数会把 10 行短代码块估成 1 行；而 textContent 不在子块间插分隔符，
  // 5 项列表也只有 25 字符，同样被估成 1 行（实测 28px vs 约 120px）。
  const explicitLines = text.split('\n').length
  const wrappedLines = Math.ceil(text.length / CHARS_PER_LINE)
  let textblocks = 0
  block.descendants((node) => {
    if (node.isTextblock) textblocks++
  })
  const lines = Math.max(explicitLines, wrappedLines, textblocks)
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
Expected: PASS（11 passed）

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
  - `sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean` — **导出供 Task 7 复用**，避免 `nextVisibleSet` 再写一份同样的比较逻辑

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
    const plugin = visibilityKey.get(state)!
    const decos = plugin.props.decorations!.call(plugin, state) as DecorationSet
    const found = decos.find()
    expect(found.length).toBe(2)
    expect(found.map((d) => d.spec.visible)).toEqual([false, true])
    // attrs（第 3 参数）才是驱动 PM 销毁重建的那一半，必须单独断言：
    // 只测 spec 的话，删掉 attrs 参数仍然全绿，而整个架构会失效。
    // 公开 d.ts 只暴露 from/to/spec，attrs 在运行时挂在 type 上。
    expect(
      found.map(
        (d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-visible'],
      ),
    ).toEqual(['false', 'true'])
  })

  it('maps visible positions through document changes', () => {
    const state = setVisible(makeState(6), [5])
    const next = state.apply(state.tr.insertText('x', 1))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([6])
  })

  it('drops visible positions whose block was deleted', () => {
    const state = setVisible(makeState(6), [0, 5])
    const next = state.apply(state.tr.delete(0, 5))
    expect([...visibilityKey.getState(next)!.visible]).toEqual([0])
  })

  it('keeps a block visible when only its markup changes', () => {
    // setNodeMarkup 产生 ReplaceAroundStep，mapResult 会把块起点判为 deleted，
    // 导致改标题级别时该在屏块塌成占位
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('aaa')]),
      schema.node('paragraph', null, [schema.text('bbb')]),
    ])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 8),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0, 5]) }))
    const next = state.apply(state.tr.setNodeMarkup(0, undefined, { level: 3 }))
    expect([...visibilityKey.getState(next)!.visible].sort((a, b) => a - b)).toEqual([0, 5])
  })

  it('forces every block in a range selection visible', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('aaa')]),
      schema.node('paragraph', null, [schema.text('bbb')]),
      schema.node('paragraph', null, [schema.text('ccc')]),
    ])
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 12),
      plugins: [createVisibilityPlugin()],
    })
    expect([...forcedVisiblePositions(state)].sort((a, b) => a - b)).toEqual([0, 5, 10])
  })

  it('rebuilds decorations when the visible set changes', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const next = setVisible(state, [5])
    const b = plugin.props.decorations!.call(plugin, next)
    expect(a).not.toBe(b)
  })

  it('memoizes decorations when nothing changed', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const b = plugin.props.decorations!.call(plugin, state)
    expect(a).toBe(b)
  })

  it('rebuilds decorations when the doc changes', () => {
    const state = setVisible(makeState(6), [0])
    const plugin = visibilityKey.get(state)!
    const a = plugin.props.decorations!.call(plugin, state)
    const next = state.apply(state.tr.insertText('x', 1))
    const b = plugin.props.decorations!.call(plugin, next)
    expect(a).not.toBe(b)
  })
})
```

注：`PluginKey.get()` 返回 `Plugin | undefined`，且 `props.decorations` 的类型带 `this: P`（prosemirror-view 1.42.9 d.ts:838），所以测试里必须 `!` + `.call(plugin, state)`，否则 tsc 报错。**实现侧不得依赖 `this`** —— PM 自身是脱离插件对象调用该 prop 的，运行时 `this` 并不成立；本实现用闭包 `cache` 与 `visibilityKey.getState(state)`，不读 `this`。

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
  const { from, to } = state.selection
  // 范围选区必须覆盖途经的每一个顶层块，只取两端会漏掉中间块；
  // AllSelection（Cmd+A）的 from=0 / to=content.size 更是只命中首块。
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent === state.doc) forced.add(pos)
  })
  // 折叠选区或端点落在块边界时 nodesBetween 可能不回调，补上两端解析结果
  for (const pos of [from, to]) {
    const $pos = state.doc.resolve(pos)
    forced.add($pos.depth === 0 ? pos : $pos.before(1))
  }
  return forced
}

export function isBlockVisible(state: EditorState, pos: number): boolean {
  if (visibilityKey.getState(state)?.visible.has(pos)) return true
  const { from, to } = state.selection
  // 折叠选区是输入与滚动时的绝对多数情况，走无分配快路径：
  // 2 万块初次渲染会调用本函数 2 万次，每次都建 Set + 两次 resolve 开销显著
  if (from === to) {
    const $pos = state.doc.resolve(from)
    return pos === ($pos.depth === 0 ? from : $pos.before(1))
  }
  return forcedVisiblePositions(state).has(pos)
}

export function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
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
        if (meta) return { visible: meta.visible }
        if (!tr.docChanged) return value
        // 文档变更会移动其后所有顶层块的起始位置。不映射就会让下方每个块
        // 的可见性判定失效、被打成占位——每次敲键都触发一轮销毁重建。
        //
        // 不能用 mapResult 的 deleted 判断块是否消失：setNodeMarkup 产生
        // ReplaceAroundStep，assoc=1 时本块起点被判 deleted、assoc=-1 时下一块
        // 起点被判 deleted，两种都会误踢在屏块。deleted 表达的是位置映射语义，
        // 不是块的存在性。改为 map 取新位置，再按新文档真实的顶层块起点过滤。
        const mapped = new Set<number>()
        for (const pos of value.visible) mapped.add(tr.mapping.map(pos))
        const kept = new Set<number>()
        tr.doc.forEach((_node, pos) => {
          if (mapped.has(pos)) kept.add(pos)
        })
        return { visible: kept }
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
Expected: PASS（12 passed）

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
import type { Node } from '@tiptap/pm/model'
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

// 单块文档，选区落在块内 pos 1，可见集含 pos 0
function singleBlockView(block: Node) {
  const doc = schema.node('doc', null, [block])
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [createVisibilityPlugin()],
  })
  state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
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

  it('renders the selection-bearing block even when absent from the visible set', () => {
    // 这条专门咬住「必须用 isBlockVisible 而非直读 state.visible」：
    // 选区在 block2、可见集为空时，block2 仍须有 contentDOM
    const view = makeView([])
    const nv = createBlockNodeView(
      view.state.doc.child(1), view, () => 5, new HeightCache(), () => null,
    )
    expect(nv.dom.dataset.visible).toBe('true')
    expect(nv.contentDOM).toBeDefined()
  })

  it('falls back to the estimate when the cached height is zero', () => {
    const view = makeView([])
    const block = view.state.doc.child(0)
    const heights = new HeightCache()
    heights.set(block, 0)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.dom.style.height).toBe('28px')
  })

  it('preserves heading semantics', () => {
    const view = singleBlockView(schema.node('heading', { level: 2 }, [schema.text('h')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.querySelector('h2')).not.toBeNull()
    expect(nv.contentDOM?.tagName).toBe('H2')
  })

  it('preserves code block semantics and language class', () => {
    const view = singleBlockView(schema.node('codeBlock', { language: 'ts' }, [schema.text('x')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.dom.querySelector('pre > code.language-ts')).not.toBeNull()
    expect(nv.contentDOM?.tagName).toBe('CODE')
  })

  it('gives a leaf horizontalRule no contentDOM', () => {
    // 位置：paragraph('a') nodeSize=3 → hr 在 pos 3，doc content size=4
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('horizontalRule'),
    ])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([3]) }))
    const view = { state } as unknown as EditorView
    const nv = createBlockNodeView(state.doc.child(1), view, () => 3, new HeightCache(), () => null)
    expect(nv.dom.querySelector('hr')).not.toBeNull()
    expect(nv.contentDOM).toBeUndefined()
  })

  it('renders a paragraph nested in a list item normally, not as a placeholder', () => {
    // nodeViews 按类型名注册，对所有深度生效。嵌套段落 pos=2、depth>0，
    // 若走占位分支会把整个列表项的内容销毁（li.textContent 变成空）。
    const list = schema.node('bulletList', null, [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
    ])
    const doc = schema.node('doc', null, [list])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 2, new HeightCache(), () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.tagName).toBe('P')
    // 语义元素自身就是内容容器，PM 才会把文字渲染进 <p>；套一层 div 就不相等了
    expect(nv.contentDOM).toBe(nv.dom)
  })

  it('renders a paragraph nested in a blockquote normally', () => {
    const quote = schema.node('blockquote', null, [
      schema.node('paragraph', null, [schema.text('q')]),
    ])
    const doc = schema.node('doc', null, [quote])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 1, new HeightCache(), () => null)
    expect(nv.contentDOM).toBeDefined()
    expect(nv.dom.tagName).toBe('P')
  })

  it('recreates when heading level changes', () => {
    const view = singleBlockView(schema.node('heading', { level: 2 }, [schema.text('h')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    const next = schema.node('heading', { level: 3 }, [schema.text('h')])
    expect(nv.update!(next, [], undefined as never)).toBe(false)
  })

  it('recreates when code block language changes', () => {
    const view = singleBlockView(schema.node('codeBlock', { language: 'ts' }, [schema.text('x')]))
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    const next = schema.node('codeBlock', { language: 'js' }, [schema.text('x')])
    expect(nv.update!(next, [], undefined as never)).toBe(false)
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
    // PM 渲染进 contentDOM 的后代文本节点同样不能被忽略
    const text = document.createTextNode('aaa')
    nv.contentDOM!.appendChild(text)
    expect(nv.ignoreMutation!({ target: text } as never)).toBe(false)
  })

  it('never ignores selection mutations', () => {
    // PM 默认实现（view dist:1125）对 selection mutation 恒返回 false；
    // 吞掉它 PM 就不再从 DOM 回读选区。占位块（无 contentDOM）也一样。
    const view = makeView([0])
    const nv = createBlockNodeView(
      view.state.doc.child(0), view, () => 0, new HeightCache(), () => null,
    )
    expect(nv.ignoreMutation!({ type: 'selection', target: nv.dom } as never)).toBe(false)

    const hidden = makeView([])
    const placeholder = createBlockNodeView(
      hidden.state.doc.child(0), hidden, () => 0, new HeightCache(), () => null,
    )
    expect(placeholder.contentDOM).toBeUndefined()
    expect(
      placeholder.ignoreMutation!({ type: 'selection', target: placeholder.dom } as never),
    ).toBe(false)
  })

  it('does not register nested blocks with the observer', () => {
    // 嵌套段落若也进 observer，观测目标数会随文档嵌套深度成倍增长
    const seen: string[] = []
    const observer = {
      observe: () => seen.push('observe'),
      unobserve: () => seen.push('unobserve'),
      disconnect: () => {},
    }
    const list = schema.node('bulletList', null, [
      schema.node('listItem', null, [schema.node('paragraph', null, [schema.text('item')])]),
    ])
    const doc = schema.node('doc', null, [list])
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [createVisibilityPlugin()],
    })
    state = state.apply(state.tr.setMeta(visibilityKey, { visible: new Set([0]) }))
    const view = { state } as unknown as EditorView
    const nested = state.doc.child(0).child(0).child(0)
    const nv = createBlockNodeView(nested, view, () => 2, new HeightCache(), () => observer)
    expect(seen).toEqual([])
    // 嵌套块不注册观测，也没有需要清理的东西，故不提供 destroy
    expect(nv.destroy).toBeUndefined()
  })

  it('recomputes a hidden placeholder height when its content changes', () => {
    const view = makeView([])
    const block = view.state.doc.child(0)
    const heights = new HeightCache()
    heights.set(block, 123)
    const nv = createBlockNodeView(block, view, () => 0, heights, () => null)
    expect(nv.dom.style.height).toBe('123px')
    // 200 字符 → ceil(200/80)=3 行 → 72px；新节点无缓存，走 estimateHeight
    const taller = schema.node('paragraph', null, [schema.text('x'.repeat(200))])
    expect(nv.update!(taller, [], undefined as never)).toBe(true)
    expect(nv.dom.style.height).toBe('72px')
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
import { DOMSerializer } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { TOP_LEVEL_BLOCK_TYPES } from '../schema'
import { estimateHeight, type HeightCache } from './heights'
import { isBlockVisible } from './visibility'

export interface ViewportObserver {
  observe(el: Element): void
  unobserve(el: Element): void
  disconnect(): void
}

type BlockNodeViewFactory = (
  node: Node, view: EditorView, getPos: () => number | undefined,
) => NodeView

export function createBlockNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): NodeView {
  let current = node
  const pos = getPos()

  // PM 的 nodeViews 按【类型名】注册，对所有深度生效：listItem / blockquote 里的
  // 段落同样会进这个工厂。它们的 pos 不是顶层位置，isBlockVisible 必然 false，
  // 若走占位分支就会把列表项与引用的内容整段销毁。非顶层一律正常渲染、不参与虚拟化。
  const topLevel = pos !== undefined && view.state.doc.resolve(pos).depth === 0
  if (!topLevel) {
    const nested = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
    return {
      dom: nested.dom,
      contentDOM: nested.contentDOM ?? undefined,
      update(next) {
        if (!next.sameMarkup(current)) return false
        current = next
        return true
      },
    }
  }

  const visible = isBlockVisible(view.state, pos)
  const observer = getObserver()

  const dom = document.createElement('div')
  dom.className = 'onebox-block'
  dom.dataset.visible = visible ? 'true' : 'false'

  let contentDOM: HTMLElement | undefined
  let resizeObserver: ResizeObserver | undefined

  const placeholderHeight = (block: Node) => {
    const cached = heights.get(block)
    return cached && cached > 0 ? cached : estimateHeight(block)
  }

  if (visible) {
    // 用节点自身的 toDOM 渲染，保留 h1/pre>code/ul/ol/hr 语义。
    // 恒用 div 会丢掉标题与列表语义，而 nodeView 拥有 DOM，后续 CSS 无法补救。
    // NodeSpec.toDOM 在 d.ts 上是可选的（TS2722），但七个 TOP_LEVEL_BLOCK_TYPES 全都定义了它，
    // 且 renderSpec 对它们恒返回元素 dom、contentDOM 为元素或 undefined（已实测）。
    const rendered = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
    rendered.dom.classList.add('onebox-block-content')
    dom.appendChild(rendered.dom)
    // horizontalRule 是 leaf，renderSpec 不返回 contentDOM，这是正确行为
    contentDOM = rendered.contentDOM ?? undefined
    resizeObserver = new ResizeObserver(() => {
      // 外壳必须是 BFC（Task 9 的 display: flow-root）：否则子元素的 margin 折叠到
      // 外壳之外，offsetHeight 小于实际占据高度，每个占位块都系统性偏矮。
      const h = dom.offsetHeight
      // 挂载在 display:none 祖先下时 offsetHeight 为 0，缓存 0 会让占位塌成 0px
      if (h > 0) heights.set(current, h)
    })
    resizeObserver.observe(dom)
  } else {
    dom.style.height = `${placeholderHeight(current)}px`
  }

  observer?.observe(dom)

  return {
    dom,
    contentDOM,
    update(nextNode) {
      const p = getPos()
      const nextVisible = p !== undefined && isBlockVisible(view.state, p)
      if (nextVisible !== visible) return false
      // toDOM 的产物带 attrs（h2 的级别、code 的 language-*）。PM 不会重新应用
      // toDOM，markup 变了必须返回 false 让它重建，否则级别 2→3 仍留在 <h2>。
      if (!nextNode.sameMarkup(current)) return false
      current = nextNode
      // 隐藏块的内容也会被 transaction 改到（撤销、跨块替换），占位高度须跟着重算
      if (!visible) dom.style.height = `${placeholderHeight(current)}px`
      return true
    },
    destroy() {
      resizeObserver?.disconnect()
      observer?.unobserve(dom)
    },
    ignoreMutation(mutation) {
      // PM 自己的默认实现从不忽略 selection mutation（view dist:1125）。吞掉它
      // 会让 PM 不再从 DOM 回读选区。ViewMutationRecord 的联合类型里含 'selection'。
      return mutation.type !== 'selection' && (!contentDOM || !contentDOM.contains(mutation.target))
    },
  }
}

export function blockNodeViews(
  heights: HeightCache,
  getObserver: () => ViewportObserver | null,
): Record<string, BlockNodeViewFactory> {
  const out: Record<string, BlockNodeViewFactory> = {}
  for (const name of TOP_LEVEL_BLOCK_TYPES) {
    out[name] = (node, view, getPos) => createBlockNodeView(node, view, getPos, heights, getObserver)
  }
  return out
}
```

**本任务的测量不变量（Task 9 / Task 10 必须守住）：** `heights` 里缓存的是块外壳的 `offsetHeight`，占位块把它写进 `style.height`。两者相等的前提是**外壳为 BFC**——`.onebox-block { display: flow-root }`。`position: relative` 不建立 BFC，`p` / `h2` / `ul` / `pre` 的 UA margin 会折叠到外壳之外，于是可见块实际占据 `offsetHeight + margin`，占位块只占 `offsetHeight`，每块约 16px 系统性偏矮，3000 块累计数万像素滚动漂移。**不要改成测量 margin 来「修」它**：margin 折叠出去后外壳自身的 computed margin 仍是 0，加进去也补不回子元素的 margin，那是安慰剂。唯一正确的修法是让外壳成为 BFC（或清零内容 margin 并把间距放到外壳 padding 上）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/blockNodeView.test.ts`
Expected: PASS（20 passed）

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
- Consumes: `ViewportObserver`（Task 6 定义）、`visibilityKey` 与 `sameSet`（Task 5 导出，**复用而非重写集合比较**）
- Produces:
  - `nextVisibleSet(prev: ReadonlySet<number>, next: ReadonlySet<number>): ReadonlySet<number> | null` — 集合未变返回 `null`
  - `blockPosOf(view: EditorView, el: Element): number`
  - `createViewportObserver(view: EditorView, root: HTMLElement, rootMargin?: string): ViewportObserver`

**去重的比较基准是 plugin 的权威可见集**（`visibilityKey.getState(view.state).visible`），observer **不得自存 `prev` 副本**。理由与失败路径见 spec §5.7：plugin 每个 `docChanged` transaction 自行 map+filter，私有副本会漂移，一旦 DOM 算出的集合恰好等于过期副本就永远不再派发纠正事务，屏上块永久停在占位态。

- [ ] **Step 1: 写失败测试**

`tests/observer.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { schema } from '../src/core/schema'
import { HeightCache } from '../src/core/viewport/heights'
import { blockNodeViews, type ViewportObserver } from '../src/core/viewport/blockNodeView'
import { createVisibilityPlugin, visibilityKey } from '../src/core/viewport/visibility'
import { blockPosOf, createViewportObserver, nextVisibleSet } from '../src/core/viewport/observer'

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

// 编排层用【真实 EditorView + 真实 visibility plugin + 真实 nodeViews】，只替身
// IntersectionObserver 与 rAF（happy-dom 无布局，这两者无法真实运行）。posAtDOM、
// 装饰、nodeView 销毁重建全走真实实现，测的是行为而不是替身。

type Entry = { target: Element; isIntersecting: boolean }
let emit: (entries: Entry[]) => void = () => {}
let nextFrameId = 0
const frames = new Map<number, FrameRequestCallback>()

class StubIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    emit = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function runFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const cb of pending) cb(0)
}

const para = (text: string) => schema.node('paragraph', null, [schema.text(text)])

const mounted: { view: EditorView; root: HTMLElement; observer: ViewportObserver }[] = []

function mount(blocks: Node[]) {
  const root = document.createElement('div')
  const element = document.createElement('div')
  root.appendChild(element)
  document.body.appendChild(root)

  const heights = new HeightCache()
  let observer: ViewportObserver | null = null
  const view = new EditorView(element, {
    state: EditorState.create({
      doc: schema.node('doc', null, blocks),
      plugins: [createVisibilityPlugin()],
    }),
    nodeViews: blockNodeViews(heights, () => observer),
  })
  observer = createViewportObserver(view, root)
  // 首批 nodeView 构造时 observer 尚未存在，与 Task 9 的 createEditor 一样补挂
  for (const child of Array.from(view.dom.children)) observer.observe(child)

  const entry = { view, root, observer }
  mounted.push(entry)
  return {
    ...entry,
    wrappers: () => Array.from(view.dom.children) as HTMLElement[],
    visible: () => [...visibilityKey.getState(view.state)!.visible].sort((a, b) => a - b),
  }
}

beforeEach(() => {
  emit = () => {}
  nextFrameId = 0
  frames.clear()
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++nextFrameId
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  for (const m of mounted.splice(0)) {
    m.observer.disconnect()
    m.view.destroy()
    m.root.remove()
  }
  vi.unstubAllGlobals()
})

describe('createViewportObserver', () => {
  it('dispatches intersecting blocks as visibilityKey meta', () => {
    const { wrappers, visible } = mount([para('aaa'), para('bbb'), para('ccc')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 10])
  })

  it('does not dispatch again when the intersecting set is unchanged', () => {
    const { view, wrappers } = mount([para('aaa'), para('bbb')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    const settled = view.state
    // 翻转会重建 nodeView，旧外壳已脱离文档，必须重新取
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(view.state).toBe(settled)
  })

  it('resyncs from plugin state after a delete and equal-size reinsert in one frame', () => {
    // plugin 在每个 docChanged transaction 里自行 map+filter。删掉 [5,9) 再在 5
    // 插回等长块后，文档起点回到 [0,5,9]，但 plugin 的集合只剩 {0,9}（map(5) 被
    // 插入推到 9）。若 observer 拿私有 prev={0,5,9} 去比较，DOM 算出的 next 恰好
    // 等于它 → 永远不派发纠正事务 → 屏上的块永久停在占位态。
    const { view, wrappers, visible } = mount([para('aaa'), para('bb'), para('ccc')])
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 9])

    view.dispatch(view.state.tr.delete(5, 9))
    view.dispatch(view.state.tr.insert(5, para('bb')))
    expect(visible()).toEqual([0, 9])

    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([0, 5, 9])
  })

  it('defers flush while composing and dispatches after composition ends', () => {
    const { view, wrappers, visible } = mount([para('aaa'), para('bbb')])
    view.composing = true
    emit(wrappers().map((el) => ({ target: el, isIntersecting: true })))
    runFrames()
    expect(visible()).toEqual([])
    expect(frames.size).toBe(1)
    view.composing = false
    runFrames()
    expect(visible()).toEqual([0, 5])
  })

  it('skips detached elements instead of throwing', () => {
    const { wrappers, visible } = mount([para('aaa'), para('bbb')])
    const stranger = document.createElement('div')
    emit([
      { target: wrappers()[0], isIntersecting: true },
      { target: stranger, isIntersecting: true },
    ])
    runFrames()
    expect(visible()).toEqual([0])
  })
})

describe('blockPosOf', () => {
  it('maps a depth-1 position to its top-level block start', () => {
    const { view } = mount([para('aaa'), para('bbb')])
    const stub = { state: view.state, posAtDOM: () => 6 } as unknown as EditorView
    expect(blockPosOf(stub, document.createElement('div'))).toBe(5)
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
import { sameSet, visibilityKey } from './visibility'

export function nextVisibleSet(
  prev: ReadonlySet<number>,
  next: ReadonlySet<number>,
): ReadonlySet<number> | null {
  return sameSet(prev, next) ? null : next
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
    // 与 plugin 的【权威】可见集比较，不自存一份 prev。plugin 会在每个 docChanged
    // transaction 里自行 map+filter，私有副本必然与它漂移：一旦 DOM 算出的 next
    // 恰好等于过期副本，就永远不再派发纠正事务，屏上块永久停在占位态。
    // 读权威集同时省掉「位置平移后 plugin 已映射正确、却因 next != prev 再派发
    // 一次全量 updateState」的冗余开销。setMeta 事务的 apply 原样返回 meta.visible，
    // 故派发后 plugin 状态恒等于 next，不会自激循环。
    const current = visibilityKey.getState(view.state)?.visible ?? new Set<number>()
    const changed = nextVisibleSet(current, next)
    if (!changed) return
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
Expected: PASS（11 passed）

若 happy-dom 撑不住真实 EditorView（构造或 dispatch 抛错），**停下来报 NEEDS_CONTEXT 并附具体错误**，不要悄悄退化成全是替身的 fake view——那样测的就是替身而不是行为。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0

- [ ] **Step 6: 提交并报告**

报告时说明：IntersectionObserver 的真实相交判定与 `blockPosOf` 在真实布局下的结果仍无法在 happy-dom 验证，留待 Task 10 的 Chrome 验证。若 2 万块量级下 IO 成为瓶颈，备选方案是「按 `getBoundingClientRect().top` 对 `view.dom.children` 二分查找可见区间」，本阶段不实现。

另需记录两项已知风险（本阶段不修，Task 10 真机观察）：
1. `observe(el)` 以 `false` 起步，新建的可见块在 IO 首次上报前会被短暂漏掉；审查已确认该窗口**有界**（占位外壳自己会收到 IO 条目，下一帧补回，再下一帧 `next == current` 即停），不会自激振荡。
2. `view.composing` 期间每帧重排 flush，`disconnect()` 会取消。

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
  /* 必须是 BFC：否则 p/h2/ul/pre 的 UA margin 折叠到外壳之外，
     可见块 offsetHeight 小于实际占据高度，占位块每块系统性偏矮约 16px。
     position: relative 不建立 BFC，不能用它替代。 */
  display: flow-root;
}

.onebox-block[data-visible='false'] {
  overflow: hidden;
}

.onebox-block-content {
  min-height: 1.5em;
}
```

`display: flow-root` 的副作用：相邻块的外壳之间不再发生 margin 折叠，块间距是上下两块 content margin 之和（段落之间约 2em）。第一阶段接受这个偏松的节奏，不要为此再加 margin 清零或 padding 补偿——那会改变 `offsetHeight` 与 `style.height` 的相等关系。

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
Expected: 全部 PASS，共 94 项（harness 1 + schema 5 + markdown 30 + heights 11 + visibility 12 + blockNodeView 20 + observer 11 + editor 3 + metrics 1）。若 Task 9 Step 4 走了浏览器 fallback 删除了 `tests/editor.test.ts`，则为 91 项，且那 3 条断言必须已在 Step 7 的 Chrome 验证中执行并通过。

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

注：`.onebox-block-content` 类挂在节点自身 toDOM 渲染出的语义元素上（`p` / `h2` / `pre` / `ul` / `ol` / `hr`），每个可见块恰好一个，所以计数仍等于可见块数。`hr` 是 leaf，其 nodeView 的 `contentDOM` 为 undefined，但类仍在 `<hr>` 上。

滚动到底部后重复上面脚本，Expected：`visible` 集合改变、原顶部块转为占位、`contentDOMs` 仍为几十量级。

**占位高度必须等于可见时的实际占据高度**（Task 6 审查提出的漂移风险，单测无法验证，必须在这里量）。先回到顶部，取一个可见块量它的占据高度，再滚到底让它转占位，比较两者，最后滚回顶部确认内容恢复。

**关键一：可见性翻转会销毁并重建 nodeView，旧元素引用会脱离文档。** 每次滚动后必须按 `index` 重新查询元素，不能沿用滚动前抓到的引用——否则读到的是脱离文档的旧 div，`dataset.visible` 永远停在 `'true'`、`getBoundingClientRect().height` 恒为 0，断言必然假失败。

**关键二：不能选含选区的那个块。** `forcedVisiblePositions` 让选区所在块恒可见，它永远不会转占位。`loadMarkdown` 用 `replaceWith` 替换全文后选区通常落在第 0 块，所以「取第一个可见块」恰好选中唯一不可能翻转的块。下面用 `document.getSelection()` 排除它，再取最后一个符合条件的可见块。

```js
async () => {
  const scroller = document.querySelector('.editor-scroll')
  const at = (i) => document.querySelectorAll('.onebox-block')[i]
  const settle = async (i, want) => {
    for (let n = 0; n < 40 && at(i)?.dataset.visible !== want; n++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return at(i)
  }

  scroller.scrollTop = 0
  await new Promise((r) => setTimeout(r, 150))
  const blocks = [...document.querySelectorAll('.onebox-block')]
  const sel = document.getSelection()
  const holdsSelection = (el) => !!sel?.anchorNode && el.contains(sel.anchorNode)
  const index = blocks.reduce(
    (acc, b, i) => (b.dataset.visible === 'true' && !holdsSelection(b) ? i : acc),
    -1,
  )
  if (index < 0) return { error: 'no visible non-selection block', total: blocks.length }
  const before = at(index)
  const occupied = before.getBoundingClientRect().height
  const outer = getComputedStyle(before)

  scroller.scrollTop = scroller.scrollHeight
  const placeholder = await settle(index, 'false')
  const placeholderHeight = placeholder.getBoundingClientRect().height
  const contentGone = placeholder.querySelector('.onebox-block-content') === null
  const recreated = placeholder !== before

  scroller.scrollTop = 0
  const restored = await settle(index, 'true')

  return {
    index,
    total: document.querySelectorAll('.onebox-block').length,
    occupied,
    placeholderHeight,
    drift: placeholderHeight - occupied,
    display: outer.display,
    margins: [outer.marginTop, outer.marginBottom],
    becamePlaceholder: placeholder.dataset.visible === 'false',
    contentGone,
    recreated,
    contentRestored: restored.querySelector('.onebox-block-content') !== null,
  }
}
```

Expected:
- `total` = 3000、`index` ≥ 0（滚动不改变文档，块序号稳定）
- `becamePlaceholder` = true、`contentGone` = true、`recreated` = true、`contentRestored` = true —— 这四条一起证明**滚动真的触发了销毁重建**，而不是只改了 `data-visible`
- `display` = `flow-root`；`margins` = `['0px','0px']`
- **`drift` 绝对值 ≤ 1**（亚像素舍入）

若 `drift` 为负十几 px 且 `display` 不是 `flow-root`，就是 Task 9 的外壳没建立 BFC、子元素 margin 折叠出去了——回到 Task 9 Step 5 修 CSS，不要靠调 `estimateHeight` 掩盖。`ResizeObserver` 是异步的，若首次量到 `drift` 很大，先多等几帧再判失败。若 `recreated` 为 false 而 `becamePlaceholder` 为 true，说明 PM 没有重建 nodeView（`update` 误返回了 true），回到 Task 6 查可见性翻转分支。若 `becamePlaceholder` 为 false 且 `index` 为 0，先确认选区排除逻辑生效（选区块恒可见，不是 bug）。

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

报告内容：94 项前端单测 + 2 项 Rust 单测结果、Chrome 与桌面端逐项验证结果、三档性能读数、A 是否需升级 B 的结论。

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