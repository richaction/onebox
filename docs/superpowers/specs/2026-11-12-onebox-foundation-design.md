# onebox 基础架构设计（第一阶段）

**日期：** 2026-11-12
**上游依据：** [高性能块式Markdown编辑器技术方案.md](../../高性能块式Markdown编辑器技术方案.md)
**范围：** 技术方案第五节「第一阶段 — 基础脚手架搭建」，含经确认的选型修订

---

## 1. 目标与验收

搭建可运行的桌面端编辑器骨架，打通「磁盘 Markdown → ProseMirror 文档 → 视口按需渲染 → 写回磁盘」全链路。

**验收标准：**

1. `pnpm tauri dev` 可启动桌面窗口，窗口内可编辑 Markdown 文本
2. 打开本地 `.md` 文件，内容正确渲染为块
3. 编辑后保存，写回的 Markdown 可被第三方标准编辑器正常打开
4. 滚动时视口外块的内容 DOM 被销毁，仅剩占位元素；滚回时内容恢复
5. 内核单元测试通过；DOM 计数与帧率测量点可读数

---

## 2. 生态核实结论

下表记录实施前对 npm 依赖和本机工具链的核实结果。

| 方案原文 | 核实结果（2026-11-12） | 处理 |
|---|---|---|
| SolidJS 2.0 | latest `1.9.19`；2.0 仅 `2.0.0-rc.21`（next 标签），未正式发布 | 改用 1.9.19 |
| @tanstack/solid-virtual | `3.13.53`，peer `solid-js ^1.3.0`，无 2.x 版本 | 第一阶段不引入，见 §4.3 |
| Kobalte | `0.13.14`，peer `solid-js ^1.9.8`；2.0 仅 `alpha.4` | 第一阶段不引入（无菜单/弹窗需求），第三阶段再评估 |
| Tiptap + Solid 绑定 | 官方无 `@tiptap/solid`；社区 `solid-tiptap@0.9.0` peer 为 `solid-js ^1.7` | 不引入绑定层，见 §4.2 |
| Tauri v2 | CLI/API `2.12.4` 可用；**本机无 rustc/cargo** | 需要安装 Rust 工具链 |
| prosemirror-markdown | `1.13.9`，基于 markdown-it；默认 schema 不含表格/任务列表 | 自建 parser/serializer 规则，见 §5.2 |
| Tiptap 版本 | `3.33.1`（v3，方案未指定大版本） | 锁 v3 |
| TypeScript | latest `7.0.2`（原生 Go 版）；5.x 最新 `5.9.3` | 锁 5.9.3，降低新工具链风险 |

**关键结论：** 虚拟滚动、UI 组件、Tiptap 绑定三个核心依赖的稳定版全部只支持 Solid 1.x。方案第 60 行「提供封装层，不降级回退框架版本」在此不成立——peer 冲突无法用封装层解决，需 fork 三个库。而方案 §2.2.4 选择 Solid 的理由（无虚拟 DOM、编译期细粒度响应式、局部更新无 diff）在 1.9 已完全成立；2.0 的增量是异步响应模型与资源管理，并非块级渲染性能来源。

---

## 3. 已确认决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | Solid **1.9.19** 稳定版 | 生态全通，第一阶段能推进到虚拟滚动而非生态适配 |
| D2 | **本阶段安装 Rust 并接入 Tauri v2 外壳**；Rust 侧只做最小异步文件读写 | 遵循方案第一阶段要求；pulldown-cmark 分片解析留第二阶段 |
| D3 | 虚拟化走**方案 A：单 EditorView + 可见性装饰 + 占位 nodeView** | 编辑语义全部 ProseMirror 原生，零同步层；实测后再决定是否升级 |
| D4 | 不引入 `solid-tiptap`、`@tanstack/solid-virtual`、`Kobalte` | 方案 A 下均无用武之地，见 §4 |

### 3.1 虚拟化方案取舍（D3 依据）

- **方案 A（采纳）** — 单 EditorView 持完整文档，离屏块 nodeView 只返回带缓存高度的空占位 div。选区/撤销/跨块 Enter-Backspace/复制粘贴/IME 全部原生。**代价：占位 div 数 = 块数，DOM 仍随文档线性增长（常量为 1）。**
- **方案 B（升级路径）** — master EditorState 持全文档（无 DOM），EditorView 只装视口附近的块，窗口随滚动滑动。DOM 真正 O(视口)，相邻块操作仍原生。代价：需自研 master↔window 双向位置映射、滚动保光标/IME、全局撤销对齐。
- **方案 C（方案原文，未采纳）** — 每块一个独立 Tiptap 实例。N 个块状态 ↔ 1 个主状态的同步层最重，跨块选区无法原生支持，全局撤销需自研。

**A 未完全满足方案「DOM 节点数量不随文档长度线性增长」这条红线。** 处理方式：第一阶段即埋测量点，用 10 万 / 100 万字实测 DOM 数与滚动帧率；不达标则升级方案 B。nodeView 是预留的升级接缝。

---

## 4. 架构

### 4.1 分层

```
磁盘 .md（纯净 GFM，无私有标记）
  ↕  Tauri command（Rust 异步 IO）
io/FileSystem 接口
  ↕
core/editor —— 单个 Tiptap Editor（完整 ProseMirror 文档）
  ├─ schema      GFM 节点与 mark
  ├─ markdown    prosemirror-markdown 双向转换
  └─ viewport
       ├─ visibility    视口 → 每块可见性装饰（PM plugin）
       ├─ heights       块高缓存，防占位↔内容切换时滚动跳动
       └─ blockNodeView 可见 → contentDOM；不可见 → 占位 div
  ↕
ui/EditorShell —— Solid 外壳：滚动容器、状态栏
```

**核心哲学（继承方案 §3.1）：** 文档模型与视觉体验解耦。块只是视觉概念，绝不写入 Markdown 正文。第一阶段不产生任何元数据文件。

### 4.2 为什么只有一个编辑器实例

nodeView 向 ProseMirror 交出 `contentDOM` 后，**ProseMirror 自己渲染块内容并接管输入**。因此不需要嵌套 Tiptap 实例，也不需要在多个 EditorState 之间同步。方案 §3.1 第 5 层「每个可视区内的顶层块独立挂载小型 Tiptap 编辑器实例」由「每块一个 nodeView + PM 原生渲染」替代。

Tiptap 提供 schema 装配、命令 API 与扩展生态，StarterKit 覆盖了第一阶段所需节点。Tiptap 构造 EditorView 时会以扩展的 nodeViews 覆盖 `editorProps.nodeViews`，因此通过 ProseMirror 插件的 `props.nodeViews` 注册。Solid 用 `onMount` 挂载编辑器、`onCleanup` 销毁。

### 4.3 为什么不用 TanStack Virtual

TanStack Virtual 的模型是「计算并只渲染这些条目」，适用于方案 B/C。方案 A 中所有顶层块都在 DOM 里（离屏的是占位 div），需要解决的是「判断谁可见」，用原生 `IntersectionObserver` 更直接，且自动处理变高块，无需高度估算即可判定可见性。

高度缓存（§5.4）用途不是判定可见性，而是**占位时撑住原有高度，避免滚动位置跳动**。

升级到方案 B 时再引入 TanStack Virtual。

### 4.4 目录结构

```
onebox/
├─ src/
│  ├─ index.tsx                 Solid 入口
│  ├─ App.tsx                   装配 io + editor + shell
│  ├─ core/
│  │  ├─ schema.ts              扩展清单 → Schema
│  │  ├─ markdown.ts            parseMarkdown / serializeMarkdown / detectUnsupported
│  │  ├─ editor.ts              createEditor
│  │  └─ viewport/
│  │     ├─ visibility.ts       可见性 plugin + PluginKey
│  │     ├─ heights.ts          HeightCache + estimateHeight
│  │     ├─ blockNodeView.ts    nodeView 工厂
│  │     └─ observer.ts         IntersectionObserver → 可见集合 → dispatch
│  ├─ io/
│  │  ├─ types.ts               FileSystem 接口
│  │  └─ tauri.ts               Tauri 实现
│  ├─ ui/
│  │  └─ EditorShell.tsx        滚动容器 + 状态栏
│  └─ styles/editor.css
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ build.rs
│  └─ src/
│     ├─ main.rs
│     ├─ lib.rs                 Builder + 命令注册
│     └─ fs.rs                  read_text / write_text
├─ tests/
│  ├─ markdown.test.ts
│  ├─ heights.test.ts
│  └─ visibility.test.ts
├─ package.json                 精确版本，无 ^ / ~
├─ pnpm-lock.yaml
├─ vite.config.ts
├─ tsconfig.json
└─ index.html
```

`core/` 不 import 任何 Solid 或 Tauri API，可独立单测。`io/types.ts` 是前端与桌面底座的唯一耦合点。

---

## 5. 组件契约

### 5.1 io — 文件读写

```ts
// io/types.ts
export interface FileSystem {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
}
```

Tauri 实现调用 `invoke('read_text', { path })` / `invoke('write_text', { path, content })`。

Rust 侧（`src-tauri/src/fs.rs`）两个 async command，用 `tokio::fs` 执行，返回 `Result<_, String>`。**不阻塞前端主线程**（方案约束 4）。路径来源仅限 Tauri 文件对话框，不接受任意拼接路径。

第二阶段在此接口下追加 pulldown-cmark 分片解析命令，上层不改。

### 5.2 core/markdown — GFM 双向

```ts
export function parseMarkdown(text: string, schema: Schema): Node
export function serializeMarkdown(doc: Node): string
export function detectUnsupported(text: string): UnsupportedKind[]
```

基于 `prosemirror-markdown` 的 `MarkdownParser` / `MarkdownSerializer`，针对 Tiptap 生成的 schema 显式配置 token 与 node/mark 映射。markdown-it 配置 `html: false`、`linkify: false`、`typographer: false`，避免非 GFM 转换。

**第一阶段支持的语法：** 段落、ATX 标题、引用、围栏代码块、无序/有序列表、分隔线、硬换行、`**strong**`、`*em*`、`` `code` ``、`~~strike~~`、链接。

**第一阶段不支持：** 表格、任务列表、脚注、内嵌 HTML、**图片**。

图片是 GFM 标准语法，但 StarterKit 不含 Image 扩展，`![alt](url)` 会被静默丢弃。因此必须纳入 `detectUnsupported`，与表格同等对待。

**检测取向：宁可误判为只读，不可漏判导致数据丢失。** 误判的代价是文件暂时只读，漏判的代价是用户内容永久丢失。

**数据安全（必须实现）：** 打开文件时先 `detectUnsupported`。若命中不支持语法，文档置为**只读**，禁止写回，状态栏显示只读标记。理由：静默丢弃表格等内容会造成用户数据丢失，比报错更糟。只读状态下仍可滚动与复制。

**检测实现取向：图片用 markdown-it 自身的 token 流判定，不用正则。** 正则无法穷尽 inline / reference / collapsed / shortcut 四种图片形式与嵌套括号 alt；漏检会让文件以可编辑打开，保存时正文被改写。tokenizer 能识别全部形式，且 fenced code 内的图片天然不产生 image token。表格、任务列表、脚注仍用正则（commonmark 预设不含这些规则），其中任务列表必须匹配任意缩进与空标签。

**解析必须容错：** schema 无 image 节点，parser 对 `image` token 用 `{ ignore: true, noCloseToken: true }` 而非抛异常。`noCloseToken` 不可省：markdown-it 的 image 是单 token，缺了它 `ignore` 只会注册 `image_open`/`image_close`，`image` 本身仍无 handler 而抛异常（已核实 prosemirror-markdown 1.13.9 源码）。否则带图片的文件连解析都过不去，「只读打开」根本无法实现。代价是只读视图里图片不显示——磁盘内容由只读闸门保护，不受影响。

**已知局限：** 忽略 image token 会连同 alt 文本一起丢弃，纯图片文件解析后为空文档，只读视图会显示空白。磁盘安全不受影响。第一阶段接受此局限，不额外做原始文本回退视图。

**Schema 约束（方案约束 1）：** 只注册 GFM 原生类型。StarterKit v3 默认包含 `underline`，**必须显式禁用**——`<u>` 不是 GFM 标准语法，会违反兼容性红线。

### 5.3 core/editor — 装配

```ts
export function createEditor(opts: {
  element: HTMLElement
  fs: FileSystem
  onUpdate: (doc: Node) => void
}): { editor: Editor; destroy: () => void }
```

装配 StarterKit（禁用 underline）、markdown 链路、visibility plugin、`editorProps.nodeViews`。`onUpdate` 由外壳做 800ms 防抖序列化与写盘；窗口关闭或切换文件前强制 flush，避免丢最后一次编辑。

### 5.4 core/viewport/heights — 高度缓存

```ts
export class HeightCache {
  get(block: Node): number | undefined
  set(block: Node, height: number): void
}
export function estimateHeight(block: Node): number
```

**以顶层块节点对象为键（`WeakMap<Node, number>`），不用位置或块 ID。** ProseMirror 节点是不可变持久化对象：未修改的块在 transaction 后仍是同一对象引用，缓存命中；被编辑的块产生新对象，自然失效并重测。这样既避免了编辑后位置偏移导致的缓存错位，也**不需要块 ID，不会污染 Markdown**（方案 §3.3）。

无缓存时用 `estimateHeight`：`max(28, ceil(textContent.length / 80) * 24)`（单位 px；每行 80 字符、行高 24、下限 28）。这三个常量是初值，实测后调整。可见块由 `ResizeObserver` 测真实高度写回缓存。

### 5.5 core/viewport/visibility — 可见性 plugin

```ts
export const visibilityKey: PluginKey<{ visible: ReadonlySet<number> }>
export function createVisibilityPlugin(): Plugin
```

plugin state 是可见块的起始位置集合，通过 `tr.setMeta(visibilityKey, { visible })` 更新。`props.decorations` 只为可见及选区内的顶层块生成 `Decoration.node`。占位块自身带 `data-visible="false"`。添加或移除可见装饰都会触发 nodeView 更新。

文档、可见集合和选区所覆盖的块均未变时，复用上一份 `DecorationSet`。早期实现为离屏块也创建装饰，百万字语料下单次可见性事务峰值约为 1,265 ms。缩减装饰数量后，实测峰值为 10.2 ms。

**可见集合是唯一真相来源**，nodeView 通过 `visibilityKey.getState(view.state)` 读取，不另设外部注册表。

**强制可见规则（必须实现）：**
- 含当前选区的块始终可见——否则选区落入无 contentDOM 的占位块，PM 无法映射 DOM 位置
- `view.composing` 为真时，含 composition 的块始终可见，且推迟可见性更新——中文 IME 输入中途销毁块会丢字

### 5.6 core/viewport/blockNodeView — 占位与内容切换

```ts
export function createBlockNodeView(
  node: Node, view: EditorView, getPos: () => number | undefined,
  heights: HeightCache, getObserver: () => ViewportObserver | null
): NodeView
```

对每个可作为 `doc` 直接子节点的类型注册同一工厂。**节点名以 Tiptap 实际注册名为准（camelCase）**：`paragraph`、`heading`、`blockquote`、`codeBlock`、`bulletList`、`orderedList`、`horizontalRule`。**不对 `listItem` 注册**——它不是顶层块。

**但注册是按类型名、对所有深度生效的**：`listItem` / `blockquote` 内部的 `paragraph` 同样会进入这个工厂。工厂必须先用 `view.state.doc.resolve(pos).depth === 0` 判定是否顶层；非顶层一律按节点自身 `toDOM` 正常渲染，不做占位、不注册观测。否则嵌套块的 pos 不在顶层可见集里，会被判为不可见而整段销毁内容。

**可见块的 DOM 用节点自身的 `toDOM` 渲染**（经 `DOMSerializer.renderSpec`），保留 `h2` / `pre > code.language-*` / `ul` / `ol` / `hr` 语义，外层再包 `div.onebox-block` 承载高度与后续拖拽手柄。恒用 div 会丢失语义，而 nodeView 拥有 DOM，后续 CSS 无法补救。`horizontalRule` 是 leaf，`renderSpec` 不返回 `contentDOM`，属正确行为。

**`update` 必须在 markup 变化时返回 false**：`toDOM` 产物带 attrs（标题级别、代码语言），PM 不会重新应用 `toDOM`，不重建就会出现级别 2→3 仍留在 `<h2>`。

构造时读可见性：

- **可见** → `{ dom: 块外壳, contentDOM: 内容容器 }`，PM 原生渲染子节点并接管输入
- **不可见** → `{ dom: 占位 div }`，`style.height` 取 `HeightCache` 或 `estimateHeight`，**不提供 contentDOM**

`update(node, outerDeco, innerDeco)`：**可见性翻转 → 返回 `false`**；**`!node.sameMarkup(current)` → 返回 `false`**（attrs 变了必须重建，见上）；其余返回 `true`，节点内容由 PM 自行更新子节点。返回 `true` 且块处于隐藏态时，必须按新节点重算占位高度——隐藏块的内容也会被撤销、跨块替换等 transaction 改到。

`destroy()`：断开该块的 ResizeObserver，并向 observer 注销。**注销必须重新调用 `getObserver()`，不得使用构造时捕获的实例。** Task 9 的 `createEditor` 先建 EditorView 再建 observer，首批 nodeView 构造时 `getObserver()` 返回 `null`，由 `createEditor` 对 `view.dom.children` 补挂。若 destroy 用捕获到的 `null`，补挂进去的外壳就永远注销不掉：`states` 与 IntersectionObserver 会随每次可见性翻转累积脱离文档的元素（2 万块文档滚一遍即累积 2 万条，每帧 flush 都要遍历，且 IO 对 target 是强引用，整棵子树无法回收），只有 `isConnected` 过滤在兜着不崩。`getObserver` 在 Task 9 是返回单一变量的稳定闭包，两次调用必得同一实例，不存在注册/注销落在不同 observer 上的风险。

`ignoreMutation`：忽略 contentDOM 之外（块外壳 UI 部分）的 mutation，避免 PM 把 UI 变更解析成文档内容。**但 `type === 'selection'` 的 mutation 一律不忽略**——PM 自身的默认实现（`prosemirror-view` dist:1125）对 selection 恒返回 false，吞掉它 PM 就不再从 DOM 回读选区。

#### 高度测量不变量

`HeightCache` 存的是块外壳的 `offsetHeight`，占位块把它写进 `style.height`。二者相等的前提是**外壳为 BFC**：`.onebox-block { display: flow-root }`。

`position: relative` 不建立 BFC，`p` / `h2` / `ul` / `pre` 的 UA margin 会折叠到外壳之外，可见块实际占据 `offsetHeight + margin` 而占位块只占 `offsetHeight`，每块约 16px 系统性偏矮，3000 块累计数万像素滚动漂移。**不能靠「测量时加上 margin」修**：margin 折叠出去后外壳自身的 computed margin 仍是 0，加进去补不回子元素的 margin。唯一正确的修法是让外壳成为 BFC，或清零内容 margin 并把间距放到外壳 padding 上。第一阶段选前者。

该不变量无法用 happy-dom 单测验证（不做布局），由 Task 10 在真 Chrome 量「同一块可见时占据高度 vs 转占位后高度」，要求差值 ≤ 1px。

#### 机制验证（已核实源码）

`prosemirror-view@1.42.9` dist/index.js：

- **L1385 `matchesNode`** 要求 `sameOuterDeco(...) && innerDeco.eq(this.innerDeco)`。装饰变化 → 匹配失败 → 走 update 路径
- **L1617 `CustomNodeViewDesc.update`** 调用 `spec.update(node, outerDeco, innerDeco)`；返回 false 时上层（**L1906 / L1945**）销毁并重建 nodeView
- **L1331** 对「无 contentDOM 的非文本节点」自动设 `contentEditable = "false"`，正是占位块所需
- **L1626** 兜底：无 contentDOM 的非叶节点即使没有 `spec.update` 也返回 false

结论：可见性装饰翻转 → 占位块 ↔ 真实内容块重建，是**公开 API 保证的行为**。

### 5.7 core/viewport/observer — 视口观测

`IntersectionObserver` 观测块外壳元素，`rootMargin` 提供上下预加载缓冲（初值 200px，实测调整）。

回调收集可见块位置集合，**仅当集合实际变化时**，经 `requestAnimationFrame` 合并后 dispatch 一次 `setMeta` transaction。

理由：装饰变化会触发 PM 遍历全部顶层块。每帧 dispatch 在 2 万块量级下开销显著；按「集合变化」去重 + rAF 合并可把 dispatch 次数降到实际进出视口的频次。

**去重必须与 plugin 的权威可见集比较，observer 不得自存一份副本。** 这是 §5.5「可见集合是唯一真相来源，不另设外部注册表」的直接推论。plugin 在每个 `docChanged` transaction 里自行 map + 按真实块起点过滤，私有副本必然与它漂移：删除一个块再插回等长块（同一帧内、中间没有 flush）后，文档起点复原而 plugin 集合已丢掉中间那个位置；此时 DOM 算出的集合恰好等于过期副本，去重判定「无变化」，纠正事务永远不再派发，**屏上的块永久停在占位态**。读 `visibilityKey.getState(view.state).visible` 同时省掉「位置平移后 plugin 已映射正确、却因副本不等而再派发一次全量 `updateState`」的冗余开销。`setMeta` 事务的 `apply` 原样返回 `meta.visible`，故派发后 plugin 状态恒等于新集合，不会自激循环。

`flush` 在 `view.composing` 为真时重排到下一帧，不派发——IME 组合中途销毁块会丢字。`disconnect()` 取消待执行帧。

`observe(el)` 以「未相交」起步，新建的可见块在 IO 首次上报前会被短暂漏掉。该窗口**有界**：占位外壳自己会收到 IO 条目，下一帧补回，再下一帧集合相等即停，不会自激振荡。第一阶段不为此加 pending 集合或宽限期机制。

### 5.8 ui/EditorShell — Solid 外壳

滚动容器 + 编辑器挂载点 + 状态栏（文件名、只读标记、保存状态）。`onMount` 创建编辑器，`onCleanup` 销毁。

界面极简：无 Tooltip、无弹窗、无 toast、无解释文案。块拖拽手柄、悬浮菜单、斜杠命令面板属第三阶段，本阶段不做。

---

## 6. 数据流

**打开**
Rust 异步读 → md 字符串 → `detectUnsupported` → `parseMarkdown` → ProseMirror doc → EditorState → 单个 EditorView

**滚动**
IntersectionObserver → 可见块集合 → 集合变化时 rAF 合并 dispatch → plugin 重建装饰 → PM 对受影响块调 `spec.update` 返回 false → 销毁重建 nodeView → 可见块渲染内容 / 不可见块渲染占位

**编辑**
PM 原生处理输入、选区、撤销、IME → doc 变更 → `onUpdate` 防抖 → `serializeMarkdown` → Rust 异步写盘

**测高**
可见块 ResizeObserver → `HeightCache.set(node, height)` → 该块下次离屏时占位高度准确，滚动不跳动

---

## 7. 错误处理

只在系统边界做校验，内部代码信任框架保证。

| 边界 | 处理 |
|---|---|
| Rust 文件读写失败 | `Result::Err(String)` → 前端 reject → 状态栏显示失败标记，不弹窗 |
| 文件含不支持语法 | 只读打开，禁止写回（§5.2），防数据丢失 |
| Markdown 解析异常 | 拒绝替换当前文档，保留原内容，状态栏标记 |
| 序列化结果含非 GFM 输出 | 写盘前断言校验；不通过则拒绝写盘 |
| IME 输入中滚动 | 推迟可见性更新，保护 composition（§5.5） |
| 选区落入占位块 | 强制该块可见（§5.5） |

不引入全局错误边界、重试机制或降级回退——本阶段无此需求。

---

## 8. 测试策略

**内核单测（vitest，纯 TS，不依赖浏览器）**
- `markdown.test.ts`：支持语法的往返一致性（parse → serialize → parse 幂等）；`detectUnsupported` 正确识别表格/任务列表/脚注/HTML；underline 已禁用
- `heights.test.ts`：节点对象 identity 命中/失效行为；`estimateHeight` 下限保护
- `visibility.test.ts`：plugin state 更新与装饰生成；选区块与 composition 块强制可见

**浏览器行为验证（真 Chrome）**
- 离屏块 contentDOM 消失、占位 div 存在且高度正确
- 滚回后内容恢复、光标与选区可用
- 跨块 Enter/Backspace、跨块拖选、全局 Ctrl+Z、复制粘贴多块
- 中文 IME 连续输入不丢字
- 打开 → 编辑 → 保存 → 第三方编辑器打开无格式错乱

单测验证代码正确性，浏览器验证功能正确性，两者不可互相替代。

---

## 9. 性能测量点

第一阶段即埋，供后续判断 A 是否需升级 B。**仅 dev 模式输出到 console，不加任何可见 UI。**

- DOM 节点总数（`document.querySelectorAll('*').length`）
- 当前可见块数 / 顶层块总数
- nodeView 创建与销毁计数
- 单次 visibility transaction 耗时
- 滚动帧率

测量语料：1 万 / 10 万 / 100 万字符三档。方案红线要求 100 万字符滚动 60fps；若 A 在 10 万字符档即出现明显掉帧或 DOM 数不可接受，直接升级方案 B，不等到第四阶段。

---

## 10. 版本锁定

`package.json` 使用精确版本，无 `^` / `~`（方案 §2.2.4 版本管控要求）。`pnpm-lock.yaml` 与 `src-tauri/Cargo.lock` 一并提交。

| 包 | 版本 |
|---|---|
| solid-js | 1.9.19 |
| vite | 8.3.8 |
| vite-plugin-solid | 2.11.16 |
| typescript | 5.9.3 |
| @tiptap/core | 3.33.1 |
| @tiptap/pm | 3.33.1 |
| @tiptap/starter-kit | 3.33.1 |
| prosemirror-markdown | 1.13.9 |
| markdown-it | 14.3.3 |
| @types/markdown-it | 14.2.0 |
| @tauri-apps/api | 2.12.4 |
| @tauri-apps/cli | 2.12.4 |
| vitest | 5.1.0 |

`markdown-it` 是直接依赖（需自建 tokenizer 配置 §5.2），**锁 14.3.3 而非 latest 15.0.3**：`prosemirror-markdown` 依赖 `markdown-it ^14.0.0`，装 15 会产生两份实例。

兼容性已核实：`vite-plugin-solid` peer 支持 vite `^8.0.0` 与 solid-js `^1.7.2`；`vitest@5.1.0` peer 支持 vite `^8.0.0`；vite 8 engines `node ^20.19 || >=22.12`，本机 node v26.13.0 满足。

Rust 工具链经 rustup 安装（系统依赖，安装前向用户确认命令）。Tauri v2 的 Rust crate 版本由 `Cargo.lock` 锁定。

---

## 11. 范围边界

**本阶段做**
- Vite + Solid 1.9.19 + TS + Tauri v2 可运行骨架
- Rust 最小异步 read/write
- 基础 GFM schema 与 markdown 双向
- 单 EditorView + 可见性装饰 + 占位 nodeView + 高度缓存
- 打开/保存 `.md`，不支持语法只读保护
- 内核单测 + 性能测量点

**本阶段不做**
- 表格、任务列表、脚注 → 第二阶段
- pulldown-cmark 分片解析、Rust AST → 第二阶段
- 块拖拽、悬浮菜单、斜杠命令、块类型转换 → 第三阶段
- Mermaid / KaTeX 视口懒加载 → 第三阶段
- `.editor-meta.json` 元数据隔离 → 第三阶段
- Kobalte 组件引入 → 第三阶段
- 完整压测与内存泄漏排查 → 第四阶段

---

## 12. 需回写技术方案文档的偏离项

实施时同步更新 [技术方案](../../高性能块式Markdown编辑器技术方案.md)，保持文档与代码一致（方案第 120 行要求）：

1. **§2.1 技术栈表 + §2.2.4** — SolidJS 2.0 → 1.9.19，附生态 peer 冲突证据；版本管控要求中「不降级回退框架版本」需修订
2. **§2.1 表 + §3.1 第 4 层** — @tanstack/solid-virtual → IntersectionObserver，注明升级方案 B 时再引入
3. **§3.1 第 5 层 + §3.2** — 「每块独立挂载小型 Tiptap 实例」→「单 EditorView + 每块 nodeView，PM 原生渲染」
4. **§1.2 性能红线** — DOM 条款标注方案 A 的实际保证（占位数 = 块数，线性、常量为 1）与升级触发条件
5. **§2.1 表** — Kobalte 标注为第三阶段引入；补充 Tiptap 锁 v3、TypeScript 锁 5.9.3
