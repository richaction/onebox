# Onebox 编辑器试用

两套编辑器都导入同一份项目样例 `examples/manual-testing/00 开始测试.md`。编辑器保留各自的内置工具栏、区块手柄和插入菜单。切换候选项时保留各自的试改，刷新页面恢复样例。

```sh
npm ci --ignore-scripts
npm run build
npm run preview
```

访问 [本机试用页](http://127.0.0.1:4178/)。

| 候选项 | 试用重点 | 迁移时要验证 |
| --- | --- | --- |
| BlockSuite PageEditor 0.19.5 | 整块拖选、区块手柄、悬浮工具栏、斜杠菜单 | 该版本用 BlockSuite 文档模型。试用页通过官方适配器往返 Markdown。需要核对表格、脚注、附件和原文保真 |
| Milkdown Crepe 7.23.0 | 文本选择、选中文字工具栏、区块拖动、代码和表格 | 使用 ProseMirror，Markdown 路径较直接。页边多块选择与 Onebox 中的中文输入仍需逐项对照 |

先用同一段文本分别试正文拖选、页边拖选、连续点击粗体和斜体、中文组词、拖块和斜杠菜单。接着在两边各改一句，打开「对照 Markdown」，查看导出和原文有哪些变化。通过试用页得到的浏览器手感还需在 Onebox 的 macOS WebView 中复测。BlockSuite 试用版本来自 npm 稳定发布，正式接入时需单独验证 AFFiNE 当前版本的 API 和依赖。

[BlockSuite PageEditor](https://github.com/toeverything/blocksuite) · [BlockSuite Markdown 适配器](https://github.com/toeverything/blocksuite/blob/main/docs/guide/adapter.md) · [Milkdown Crepe](https://milkdown.dev/docs/guide/using-crepe)
