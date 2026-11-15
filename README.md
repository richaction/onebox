# onebox

基于 Tauri v2、SolidJS 1.9.19 和 Tiptap 的桌面 Markdown 编辑器。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

在桌面窗口中按 ⌘O（Ctrl+O）打开 `.md`，按 ⌘S（Ctrl+S）保存，按 ⌘⇧S（Ctrl+Shift+S）另存为。已打开的可编辑文件在停止输入约 800 ms 后自动保存。遇到第一阶段不支持的语法时，状态栏显示「只读」。

[第一阶段验收记录](docs/superpowers/plans/2026-11-15-onebox-foundation-verification.md)
