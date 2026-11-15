import { Extension, InputRule, type ChainedCommands } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { canJoin } from '@tiptap/pm/transform'

export interface CommandItem {
  label: string
  search: string
  run: (chain: ChainedCommands) => ChainedCommands
}

export const blockCommands: readonly CommandItem[] = [
  { label: '正文', search: 'text paragraph', run: (chain) => chain.setParagraph() },
  { label: '一级标题', search: 'heading h1 #', run: (chain) => chain.setHeading({ level: 1 }) },
  { label: '二级标题', search: 'heading h2 ##', run: (chain) => chain.setHeading({ level: 2 }) },
  { label: '三级标题', search: 'heading h3 ###', run: (chain) => chain.setHeading({ level: 3 }) },
  { label: '无序列表', search: 'bullet list', run: (chain) => chain.toggleBulletList() },
  { label: '有序列表', search: 'numbered ordered list', run: (chain) => chain.toggleOrderedList() },
  {
    label: '任务列表', search: 'todo task checklist',
    run: (chain) => chain.command(({ editor, commands }) =>
      (editor.isActive('listItem') || commands.toggleBulletList()) &&
      commands.updateAttributes('listItem', { checked: false }),
    ),
  },
  { label: '引用', search: 'quote', run: (chain) => chain.toggleBlockquote() },
  { label: '代码块', search: 'code', run: (chain) => chain.toggleCodeBlock() },
  { label: '分隔线', search: 'divider rule', run: (chain) => chain.setHorizontalRule() },
  { label: '表格', search: 'table', run: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
]

export const tableCommands: readonly CommandItem[] = [
  { label: '向下插入行', search: 'insert row', run: (chain) => chain.addRowAfter() },
  { label: '向右插入列', search: 'insert column', run: (chain) => chain.addColumnAfter() },
  { label: '删除列', search: 'delete column', run: (chain) => chain.deleteColumn() },
  { label: '删除表格', search: 'delete table', run: (chain) => chain.deleteTable() },
]

export function slashTrigger(state: EditorState) {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
  const trigger = /(?:^|\s)\/([^/\s]{0,32})$/u.exec(before)
  if (!trigger) return null
  const query = trigger[1]
  return { from: $from.pos - query.length - 1, to: $from.pos, query }
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
