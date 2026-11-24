/** @jsxImportSource react */
'use client'

import { BlockSelectionPlugin } from '@platejs/selection/react'
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { Plate, PlateContent, useEditorSelector, useMarkToolbarButton, useMarkToolbarButtonState, usePlateEditor, usePluginOption } from 'platejs/react'
import { Resources } from './elements'
import type { EditorResources } from './platform'
import { editorPlugins, initMarkdown, serializeMarkdown } from './plugins'

export interface EditorDocument {
  serialize(): string
  composing(): boolean
}

export interface PlateEditorProps {
  markdown: string
  readOnly?: boolean
  resources?: EditorResources
  onReady?: (document: EditorDocument | null) => void
  onChange?: () => void
  onCompositionEnd?: () => void
}

const formatting = [
  ['bold', '粗体', 'B'], ['italic', '斜体', 'I'], ['strikethrough', '删除线', 'S'], ['code', '行内代码', '</>'],
] as const

function FormatButton({ nodeType, name, text }: { nodeType: string; name: string; text: string }) {
  const state = useMarkToolbarButtonState({ nodeType })
  const { props } = useMarkToolbarButton(state)
  return <button type="button" aria-label={name} title={name} aria-pressed={props.pressed}
    onMouseDown={props.onMouseDown} onClick={props.onClick}>{text}</button>
}

function Toolbar() {
  const expanded = useEditorSelector((editor) => editor.api.isExpanded(), [])
  const selectedBlocks = usePluginOption(BlockSelectionPlugin, 'selectedIds')
  if (!expanded || selectedBlocks?.size) return null
  return <div className="plate-format" role="toolbar" aria-label="文字格式" data-activate-on-release>
    {formatting.map(([type, name, text]) => <FormatButton key={type} nodeType={type} name={name} text={text} />)}
  </div>
}

export function PlateEditor({ markdown, readOnly = false, resources, onReady, onChange, onCompositionEnd }: PlateEditorProps) {
  const [supported, setSupported] = useState<boolean>()
  const composing = useRef(false)
  const initialization = useRef<{ supported: boolean }>(null)
  const editor = usePlateEditor({
    plugins: editorPlugins,
    value: (current) => {
      const result = initMarkdown(current, markdown)
      initialization.current = result
      return result.value
    },
  }, [markdown])

  useLayoutEffect(() => {
    const verified = initialization.current?.supported === true
    setSupported(verified)
    if (!onReady || !verified) return
    onReady({ serialize: () => serializeMarkdown(editor), composing: () => composing.current })
    return () => onReady(null)
  }, [editor, onReady])

  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const closeMenu = () => setMenu(undefined)
  const openMenu = (event: MouseEvent) => {
    const element = (event.target as Element).closest('.slate-selectable')
    const id = element?.getAttribute('data-block-id')
    if (!id || composing.current) return
    event.preventDefault()
    editor.tf.deselect()
    const selection = editor.getApi(BlockSelectionPlugin).blockSelection
    if (!selection.has(id)) selection.set(id)
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 156), y: Math.min(event.clientY, window.innerHeight - 128) })
  }
  const applyBlockCommand = (type: string) => {
    const selection = editor.getApi(BlockSelectionPlugin).blockSelection
    const nodes = selection.getNodes({ sort: true })
    editor.tf.withoutNormalizing(() => {
      for (const [node, path] of nodes.toReversed()) {
        if (type === 'delete') editor.tf.removeNodes({ at: path })
        else if (['p', 'h1', 'h2', 'h3', 'blockquote'].includes(node.type)) editor.tf.setNodes({ type }, { at: path })
      }
    })
    selection.clear()
    closeMenu()
    editor.tf.focus()
  }
  const locked = readOnly || supported !== true

  return <Resources.Provider value={resources ?? {}}>
    {supported === false ? <section className="plate-unsupported">
      <p role="status">Plate 暂时无法完整往返转换这份 Markdown。已锁定编辑并显示原文。</p>
      <pre>{markdown}</pre>
    </section> : <Plate editor={editor} readOnly={locked} onValueChange={() => { if (!locked) onChange?.() }}>
      {!locked && <Toolbar />}
      <div className="plate-content-frame" onPointerDownCapture={() => { if (menu) closeMenu() }}>
        <PlateContent className="onebox-plate-content" aria-label="Markdown 正文" aria-readonly={locked}
          placeholder="开始编辑 Markdown…" onContextMenu={locked ? undefined : openMenu}
          onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false; onCompositionEnd?.() }} />
      </div>
      {menu && !locked && <div className="plate-block-menu" role="menu" aria-label="区块操作" data-activate-on-release
        style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}>
        {[['p', '正文'], ['h1', '一级标题'], ['h2', '二级标题'], ['delete', '删除区块']].map(([type, name]) =>
          <button key={type} type="button" role="menuitem" onClick={() => applyBlockCommand(type)}>{name}</button>)}
      </div>}
    </Plate>}
  </Resources.Provider>
}
