import { Extension, InputRule, isNodeActive, type ChainedCommands } from '@tiptap/core'
import { NodeSelection, type EditorState, type Selection } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'
import { chartTemplates } from './chartTemplates'

export interface MenuItem {
  label: string
  search: string
  icon: string
  shortcut?: string
  headingLevel?: 1 | 2 | 3 | 4 | 5
}

export interface CommandItem extends MenuItem {
  run: (chain: ChainedCommands) => ChainedCommands
}

export const blockCommands: readonly CommandItem[] = [
  {
    label: '正文', search: 'text plain paragraph 文本', icon: 'T',
    run: (chain) => chain.setParagraph(),
  },
  ...([1, 2, 3, 4, 5] as const).map((level): CommandItem => ({
    label: `${'一二三四五'[level - 1]}级标题`, search: `heading h${level} 标题${level}`,
    icon: `H${level}`, headingLevel: level, shortcut: '#'.repeat(level),
    run: (chain) => chain.setHeading({ level }),
  })),
  {
    label: '无序列表', search: 'bullet list 项目符号', icon: '☷', shortcut: '-',
    run: (chain) => chain.toggleBulletList(),
  },
  {
    label: '有序列表', search: 'num numbered ordered list', icon: '≡', shortcut: '1.',
    run: (chain) => chain.toggleOrderedList(),
  },
  {
    label: '任务列表', search: 'todo task checklist 待办 [] [ ]', icon: '☑', shortcut: '- [ ]',
    run: (chain) => chain.command(({ state, commands }) =>
      (isNodeActive(state, 'listItem') || commands.toggleBulletList()) &&
      commands.updateAttributes('listItem', { checked: false }),
    ),
  },
  {
    label: '引用', search: 'quote blockquote', icon: '❝', shortcut: '>',
    run: (chain) => chain.toggleBlockquote(),
  },
  {
    label: '代码块', search: 'code fence', icon: '‹/›', shortcut: '```',
    run: (chain) => chain.toggleCodeBlock(),
  },
]

function insertFence(chain: ChainedCommands, language: string, source: string) {
  return chain.insertContent({
    type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: source }],
  })
}

export const diagramCommands: readonly CommandItem[] = [
  ...chartTemplates.map(({ label, key, option }): CommandItem => ({
    label, search: `图表 chart echarts ${key}`, icon: key,
    run: (chain) => insertFence(chain, 'echarts', JSON.stringify(option, null, 2)),
  })),
  {
    label: '流程图', search: '流程图 图表 时序 甘特 思维导图 mermaid diagram', icon: 'flowchart',
    run: (chain) => insertFence(chain, 'mermaid', 'flowchart LR\n  A[开始] --> B[处理] --> C[完成]'),
  },
]

export const insertCommands: readonly CommandItem[] = [
  {
    label: '公式', search: '公式 math latex katex', icon: '∑', shortcut: '$$',
    run: (chain) => chain.insertContent({
      type: 'math', attrs: { display: true, latex: '\\displaystyle \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}' },
    }),
  },
  {
    label: '分隔线', search: 'div divider rule', icon: '―', shortcut: '---',
    run: (chain) => chain.setHorizontalRule(),
  },
  {
    label: '表格', search: 'table grid', icon: '▦',
    run: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
]

export const tableCommands: readonly CommandItem[] = [
  { label: '向上插入行', search: 'insert row above', icon: '↑', run: (chain) => chain.addRowBefore() },
  { label: '向下插入行', search: 'insert row below', icon: '↓', run: (chain) => chain.addRowAfter() },
  { label: '向左插入列', search: 'insert column left', icon: '←', run: (chain) => chain.addColumnBefore() },
  { label: '向右插入列', search: 'insert column right', icon: '→', run: (chain) => chain.addColumnAfter() },
  { label: '删除行', search: 'delete row', icon: '−', run: (chain) => chain.deleteRow() },
  { label: '删除列', search: 'delete column', icon: '−', run: (chain) => chain.deleteColumn() },
  { label: '删除表格', search: 'delete table', icon: '×', run: (chain) => chain.deleteTable() },
]

export function selectedBlock(selection: Selection) {
  if (selection instanceof NodeSelection && selection.node.isBlock && selection.node.type.name !== 'viewportGroup') {
    return { node: selection.node, from: selection.from, end: selection.to }
  }
  const { $from, to } = selection
  const blockDepth = $from.node(1)?.type.name === 'viewportGroup' ? 2 : 1
  for (let depth = $from.depth; depth >= blockDepth; depth--) {
    const node = $from.node(depth)
    if (depth !== blockDepth && node.type.name !== 'listItem') continue
    const from = $from.before(depth)
    const end = $from.after(depth)
    return to <= end ? { node, from, end } : undefined
  }
}

export const blockEditCommands: readonly CommandItem[] = [
  {
    label: '复制区块', search: 'duplicate block', icon: '⧉',
    run: (chain) => chain.command(({ tr, dispatch }) => {
      const block = selectedBlock(tr.selection)
      if (!block) return false
      if (dispatch) tr.insert(block.end, block.node)
      return true
    }),
  },
  {
    label: '删除区块', search: 'delete block', icon: '×',
    run: (chain) => chain.command(({ tr, dispatch }) => {
      const block = selectedBlock(tr.selection)
      if (!block) return false
      if (dispatch) tr.delete(block.from, block.end)
      return true
    }),
  },
]

export function slashTrigger(state: EditorState) {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null
  // Read only one delimiter, the slash, and the maximum-length query.
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 34), $from.parentOffset, '', '\ufffc')
  const trigger = /(?:^|\s)\/([^/\s]{0,32})$/u.exec(before)
  if (!trigger) return null
  const query = trigger[1]
  const from = $from.pos - query.length - 1
  const code = state.schema.marks.code
  if (code && state.doc.rangeHasMark(from, $from.pos, code)) return null
  return { from, to: $from.pos, query }
}

export const MarkdownTaskInput = Extension.create({
  name: 'oneboxTaskInput',
  addInputRules() {
    return [new InputRule({
      find: /^\[([ xX])\] $/,
      handler: ({ state, range, match }) => {
        const $pos = state.doc.resolve(range.from)
        for (let depth = $pos.depth; depth > 0; depth--) {
          const item = $pos.node(depth)
          if (item.type.name !== 'listItem') continue
          state.tr.delete(range.from, range.to)
          state.tr.setNodeAttribute($pos.before(depth), 'checked', match[1] !== ' ')
          return
        }
        return null
      },
    })]
  },
})

export const ViewportGroupEditing = Extension.create({
  name: 'oneboxViewportGroupEditing',
  priority: 1100,
  addKeyboardShortcuts() {
    const joinAcrossGroup = (before: boolean) => this.editor.commands.command(({ tr }) => {
      const { empty, $from } = tr.selection
      if (!empty || $from.depth !== 2 || $from.node(1).type.name !== 'viewportGroup') return false
      const group = $from.node(1)
      const edge = before
        ? $from.index(1) === 0 && $from.parentOffset === 0
        : $from.index(1) === group.childCount - 1 && $from.parentOffset === $from.parent.content.size
      if (!edge || !$from.parent.isTextblock) return false
      const boundary = before ? $from.before(1) : $from.after(1)
      if (!canJoin(tr.doc, boundary)) return false
      tr.join(boundary)
      const innerBoundary = boundary - 1
      if (canJoin(tr.doc, innerBoundary)) tr.join(innerBoundary)
      return true
    })
    return {
      Backspace: () => joinAcrossGroup(true),
      Delete: () => joinAcrossGroup(false),
    }
  },
})
