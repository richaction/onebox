# Onebox

Onebox 是一款本地桌面 Markdown 编辑器与文件工作区。你可以在同一个窗口写笔记、整理文件，查看 PDF、Office 文档、图片和压缩包。笔记直接保存为磁盘上的 `.md` 或 `.markdown` 文件。

[项目状态](#项目状态) · [核心功能](#核心功能) · [界面截图](#界面截图) · [快速开始](#快速开始) · [连接 AI](#连接-ai) · [本地开发](#本地开发)

![Onebox 调试样例。左侧是工作树，正文显示 Markdown 表格](docs/screenshots/editor-workspace.png)

## 项目状态

**Markdown 编辑器完成度约 70%。** 这是对编辑体验的当前估计。日常写作、表格、代码块、公式与图表已可使用。中文输入、触控板选区、复杂 Markdown 的保存保真度和长文档滚动仍在打磨。

## 核心功能

### Markdown 编辑

- **正文与区块**。拖动可选中文字。输入 `/` 或右键打开区块菜单，插入标题、待办、引用、代码块、表格和附件。表格可编辑行列，正文支持脚注、嵌套列表和常见行内格式。
- **代码块**。移入代码块后，顶部工具条显示语言选择、复制和继续写正文。语言列表可搜索，正文会按语言高亮。
- **LaTeX 公式**。支持行内和独立公式。单击可在原位置编辑，按住 Option 单击可改 LaTeX 源码。调试样例包含矩阵、多行推导、分段函数和混排公式。
- **Mermaid 与 ECharts**。Mermaid 编辑时左侧写源码，右侧实时预览。语法出错时会显示诊断并保留上次成功预览。ECharts 可在正文显示图表并编辑配置。单击图表即可打开遮罩放大预览。
- **图片与附件**。支持插入、拖入或粘贴本地附件。独立图片和 Mermaid 默认占内容宽度的 90%。图片可从边缘拖动缩放，比例实时显示并随文档保存。双击图片或点悬停时出现的放大按钮，可在遮罩中查看。导入的附件保存在文档旁的 `assets/`，以相对路径引用。
- **本地保存**。编辑已有文档时自动保存，也可另存为。包含当前无法安全写回的语法时，Onebox 会以只读方式打开。长文档使用分批加载和按视口渲染，调试样例包含十万字符和百万字符文档。

### 文件工作区

- **用工作树管理本地目录**。可以新建、重命名、拖动、复制、剪切和粘贴文件及文件夹。文件夹展开、收起时会保留现有的文件选区。
- **批量操作文件**。用 Shift 连选，用 Ctrl 或 ⌘ 点选。右侧列出所选文件和图片缩略图，支持批量复制、剪切以及点击单个文件弹出预览。
- **与 Finder 互通**。macOS 上可以在 Finder 复制文件或文件夹，再到 Onebox 工作树中粘贴，也可以从 Onebox 复制到 Finder。剪切到 Finder 时用 ⌥⌘V 移动。复制遇到同名项会生成带编号的副本。
- **移动文档时维护链接**。在工作区内移动 Markdown 时，符合条件的本地附件可随文档移动，相关的相对链接会更新。

### 本地文件预览

单击文件即可在 Onebox 内查看，也可以通过「打开方式」交给系统应用。常规预览在本机完成，渲染资源随应用提供。

| 类型 | 可以查看和操作 |
| --- | --- |
| PDF | 连续滚动、调整目录栏宽度、按目录跳转到对应页面 |
| Office | 预览常见的新旧版 Word、Excel 和 PowerPoint 文件，切换 Excel 工作表 |
| 图片 | 查看 PNG、JPEG、GIF、WebP、AVIF、SVG、TIFF 等格式，支持旋转、缩放、拖动和适配窗口 |
| 文本和音视频 | 预览 UTF-8、UTF-16、GB18030 文本，播放 MP4、WAV 等媒体文件 |
| 压缩包 | 浏览 ZIP、TAR.GZ、7Z 中的文件，预览其中支持的格式，或将单个文件另存到本地 |

### AI 写作侧栏

- **正文编辑**。选中文字后，右键点「AI → 正文编辑」，在正文里输入修改要求。
- **引用到侧栏**。选中文字后，右键点「AI → 引用到侧栏」，将选区添加到右侧 AI 输入框。也可从输入框旁的「＋」添加其他引用。
- **审阅修改**。侧栏生成建议后，会在正文预览替换或插入。点「撤销」收起预览，点「✓ 确认」才保存改动。也可以编辑建议后重新预览。确认后仍可撤销本条改动。
- **切换会话**。侧栏顶部的「＋」开启新会话。从标题下拉可以按日期浏览、搜索和切换同一文档的会话。会话保留到本次 Onebox 退出，拖动侧栏边缘设置的宽度会记住。

## 界面截图

### Mermaid 源码与实时预览

![审核状态图在 Onebox 中编辑。左侧是 Mermaid 源码，右侧是带嵌套状态的实时预览](docs/screenshots/mermaid-editor.png)

在图上方点击「编辑」打开分栏。较窄的窗口中可用「源码」和「预览」切换。调试样例还有并发时序、实体关系和发布计划等图表。

### 复杂公式

![公式专项样张中的矩阵二次型、分段函数和贝叶斯后验公式](docs/screenshots/formula-editor.png)

这份样张覆盖行内公式、矩阵、分段函数和多行推导，可直接点击公式测试光标、选区和编辑。

### AI 写作与修改建议

![Markdown 正文旁打开 AI 侧栏，右侧显示引用、原文与建议对照，以及替换和插入按钮](docs/screenshots/ai-revision.jpg)

截图使用样例文档和对话。侧栏底部是模型菜单，旁边的电池图标可查看用量。

### PDF 预览与文档目录

![左侧工作树和 PDF 预览。PDF 右侧打开了可跳转的文档目录](docs/screenshots/file-preview.png)

### 多选文件与图片缩略图

![工作树中同时选中六个文件。右侧列出文件类型、图片缩略图及剪切和复制按钮](docs/screenshots/selection-preview.png)

## 快速开始

可以从源码运行当前开发版。准备 Git、Node.js（建议 24 或 26）、pnpm 和通过 `rustup` 安装的 Rust 稳定工具链。macOS 可用 `xcode-select --install` 安装命令行工具。其它平台的桌面依赖见 [Tauri v2 环境准备](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/richaction/onebox.git
cd onebox
pnpm install --frozen-lockfile
pnpm dev:app
```

启动后，在侧栏点击「打开文件夹…」选择本地目录。也可以选「打开调试样例」，在独立的可编辑副本中体验公式、Mermaid、多格式文件预览和大文档。

### 连接 AI

1. 安装官方 Codex CLI，或在 macOS 上安装带有 Codex 的 ChatGPT 或 Codex 桌面版。AI 侧栏通过本机的 Codex 连接服务。
2. 打开一个 Markdown 文件，点击标题栏右侧的「✨ AI」，再从输入框旁的模型菜单选择「使用 ChatGPT 登录」，在浏览器中完成登录。
3. 从模型菜单选择账号可用的模型和该模型提供的思考强度。将鼠标移到电池图标可查看 Codex 返回的额度和重置时间。实际额度和周期以账号返回的数据为准。

AI 连接默认跟随系统代理。发送时，提问和添加的引用会交给 Codex 处理。AI 登录与本地编辑、文件管理和常规预览相互独立。

### 常用操作

| 操作 | 快捷键或入口 |
| --- | --- |
| 打开文件或工作区 | ⌘O 打开文件，⌘⇧O 打开工作区 |
| 插入区块 | 在正文输入 `/`，也可以右键打开区块菜单 |
| 编辑 Mermaid | 点击图上方的「编辑」，改完点「完成」 |
| 编辑公式 | 单击公式，按住 Option 单击可编辑 LaTeX 源码 |
| 调整正文图片宽度 | 悬停后拖动左右边缘，双击边缘恢复 90% |
| 多选文件 | Shift 连选，Ctrl 或 ⌘ 点选 |
| 复制、剪切和粘贴 | ⌘C、⌘X、⌘V，也可以用工作树右键菜单。点击工作区名称后粘贴到根目录 |
| 保存与另存为 | 编辑时自动保存，⌘S 查看保存提示，⌘⇧S 另存为 |
| 关闭弹出预览或取消剪切 | Esc |

Windows 和 Linux 上，可在 Onebox 内用 Ctrl 代替上述 ⌘ 组合键。

### 构建 macOS 应用

安装依赖后，从仓库根目录运行构建命令。

```sh
pnpm tauri build --bundles app --config '{"bundle":{"active":true}}'
open src-tauri/target/release/bundle/macos/Onebox.app
```

构建得到的 `Onebox.app` 可拖到 Finder 的「应用程序」目录。只需要当前平台的可执行文件时，可运行 `pnpm tauri build --no-bundle`。[Tauri 打包说明](https://v2.tauri.app/distribute/macos-application-bundle/)

## 本地开发

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:app` | 启动或唤回桌面调试窗口 |
| `pnpm dev:status` | 查看调试状态和日志位置 |
| `pnpm dev:restart` / `pnpm dev:stop` | 保存会话后重启或停止调试 |
| `pnpm dev` | 在 `http://localhost:1420` 调试前端界面 |
| `pnpm typecheck` / `pnpm test` | 检查 TypeScript 类型和运行前端测试 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 运行 Rust 测试 |
| `pnpm build` | 将前端静态产物构建到 `dist/` |

`pnpm dev:app` 维护一个桌面调试实例。前端热更新会保留文档、光标、滚动位置和撤销记录。Rust 或原生配置变更后，调试进程先保存文档，再重启并恢复工作区。文件对话框、剪贴板和磁盘操作请在桌面窗口中验证。

桌面端使用 Tauri 2 和 Rust，界面使用 SolidJS 2，Markdown 编辑基于 Tiptap 3 和 ProseMirror。编辑与 Markdown 转换在 [`src/core/`](src/core)，界面在 [`src/ui/`](src/ui)，桌面文件操作在 [`src-tauri/src/`](src-tauri/src)。多格式预览使用 Flyfish Full。

### 设计与验证资料

- [调试样例与操作清单](examples/manual-testing/00%20开始测试.md)
- [Mermaid 多场景编辑](examples/manual-testing/01%20编辑器/Mermaid%20多场景编辑.md) · [Mermaid 联调与压力样张](examples/manual-testing/01%20编辑器/Mermaid%20联调与压力样张.md) · [公式专项验收](examples/manual-testing/01%20编辑器/公式专项验收.md)
- [原始需求与技术方案](docs/高性能块式Markdown编辑器技术方案.md)
- [第一阶段验收](docs/superpowers/plans/2026-11-15-onebox-foundation-verification.md)
- [第二阶段计划与验收](docs/superpowers/plans/2026-11-15-onebox-phase-two.md)
- [工作区设计与验收](docs/superpowers/plans/2026-11-15-onebox-workspace.md)

项目采用 [MIT 许可证](LICENSE)。
