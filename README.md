# onebox

基于 Tauri v2、SolidJS 1.9.19 和 Tiptap 的桌面 Markdown 编辑器。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

在桌面窗口中按 ⌘O（Ctrl+O）打开 `.md`，按 ⌘S（Ctrl+S）保存，按 ⌘⇧S（Ctrl+Shift+S）另存为。已打开的可编辑文件在停止输入约 800 ms 后开始自动保存。遇到可能无法安全写回的语法时，状态栏显示「只读」。

键入 `/` 或右键打开块操作，输入 `###` 加空格可直接转为三级标题。桌面端可从块菜单插入图片、附件，也可粘贴或拖放文件。使用「工作区」浏览 Markdown 文档，使用「移动」和「复制」维护相对附件路径。附件保存在文档旁的 `assets/`，文件列表默认隐藏此目录。

[第二阶段计划与验收](docs/superpowers/plans/2026-11-15-onebox-phase-two.md)

[第一阶段验收记录](docs/superpowers/plans/2026-11-15-onebox-foundation-verification.md)
