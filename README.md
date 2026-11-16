# onebox

Onebox 是一款本地桌面 Markdown 编辑器。它以块为单位编辑标题、列表、引用、代码和表格，文档直接保存为 `.md` 或 `.markdown` 文件。

项目处于早期开发阶段，使用 Tauri v2、SolidJS `1.9.X` 稳定版（当前锁定 `1.9.19`）和 Tiptap。

## 基本使用

- **打开和保存** · 用 `⌘O`（`Ctrl+O`）打开文件，`⌘S`（`Ctrl+S`）保存，`⌘⇧S`（`Ctrl+Shift+S`）另存为。首次保存时选择路径。已有路径的可编辑文档在停止输入约 800 毫秒后自动保存。遇到可能无法安全写回的语法时，状态栏显示「只读」。
- **编辑区块** · 在空段落输入 `/` 或在正文中右键打开菜单。可按方向键选择命令，按回车执行。输入 `###` 加空格可直接创建三级标题。
- **管理工作区** · 点击「工作区」选择本地文件夹，在侧栏浏览 Markdown 文档。可在侧栏拖动文档或文件夹，或右键选择目标目录。顶部「移动」和「复制」操作当前文档，并处理相关附件的相对链接。
- **插入图片和附件** · 从块菜单插入，也可粘贴或拖入本地文件。导入的文件位于文档旁的 `assets/` 目录，工作区侧栏默认隐藏该目录。

## 界面截图

![Onebox 桌面窗口，左侧是工作区文件树，右侧是 Markdown 文档](docs/screenshots/workspace.png)

## 本地开发

准备 Git、Node.js（建议 24 或 26）、pnpm 和通过 `rustup` 安装的 Rust 稳定工具链。macOS 桌面开发可用 `xcode-select --install` 安装命令行工具。Windows 需要 C++ Build Tools 和 WebView2，Linux 的系统依赖按发行版安装。[Tauri v2 环境准备](https://v2.tauri.app/start/prerequisites/)

```sh
git clone https://github.com/richaction/onebox.git
cd onebox
pnpm install --frozen-lockfile
pnpm tauri dev
```

`pnpm tauri dev` 会启动桌面窗口和前端热更新。只调试编辑器界面时可运行 `pnpm dev`，然后访问 `http://localhost:1420`。文件对话框、磁盘保存和工作区需要在桌面窗口中验证。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 检查 TypeScript 类型 |
| `pnpm test` | 运行前端测试 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 运行 Rust 测试 |
| `pnpm build` | 构建前端静态产物到 `dist/` |

编辑器内核和 Markdown 转换位于 `src/core/`，界面位于 `src/ui/`，桌面文件读写、解析和工作区命令位于 `src-tauri/src/`。

## 构建正式版并安装

安装依赖后，从仓库根目录运行以下命令，在 macOS 上生成可直接打开的应用。

```sh
pnpm tauri build --bundles app --config '{"bundle":{"active":true}}'
open src-tauri/target/release/bundle/macos/onebox.app
```

仓库默认关闭安装包生成，命令中的 `--config` 为本次构建开启打包。Tauri 会先构建前端，再编译正式版并生成 `onebox.app`。可将 `.app` 拖入 Finder 的「应用程序」，之后从那里启动。[Tauri macOS 应用打包](https://v2.tauri.app/distribute/macos-application-bundle/)

如需在当前平台只构建正式版可执行文件，运行 `pnpm tauri build --no-bundle`。默认产物为 `src-tauri/target/release/onebox`，Windows 上为 `onebox.exe`。[Tauri CLI 构建参数](https://v2.tauri.app/reference/cli/#build)

## 项目文档

- [原始需求与技术方案](docs/高性能块式Markdown编辑器技术方案.md)
- [第一阶段验收记录](docs/superpowers/plans/2026-11-15-onebox-foundation-verification.md)
- [第二阶段计划与验收](docs/superpowers/plans/2026-11-15-onebox-phase-two.md)
- [工作区设计与验收](docs/superpowers/plans/2026-11-15-onebox-workspace.md)
