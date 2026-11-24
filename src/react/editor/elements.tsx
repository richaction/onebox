/** @jsxImportSource react */
'use client'

import { useTodoListElement, useTodoListElementState } from '@platejs/list/react'
import { BlockSelectionPlugin, useBlockSelected } from '@platejs/selection/react'
import { createContext, useContext, useEffect, useState, type MouseEvent } from 'react'
import { PlateElement, useEditorPlugin, useReadOnly, type PlateElementProps } from 'platejs/react'
import { resourceKind, type EditorResources } from './platform'

export const Resources = createContext<EditorResources>({})

export function Paragraph(props: PlateElementProps) {
  const { element } = props
  const indent = typeof element.indent === 'number' ? element.indent : 0
  const style = { paddingInlineStart: indent > 1 ? `${(indent - 1) * 1.35}em` : undefined }
  if (typeof element.checked === 'boolean') return <Task {...props} />
  if (typeof element.listStyleType === 'string') {
    const bullet = element.listStyleType === 'decimal' ? `${element.listStart ?? 1}.` : '•'
    return <PlateElement {...props} className="plate-list" style={style}>
      <span aria-hidden="true" contentEditable={false} className="plate-list-marker">{bullet}</span>
      {props.children}
    </PlateElement>
  }
  return <PlateElement as="p" {...props} />
}

function Task(props: PlateElementProps) {
  const readOnly = useReadOnly()
  const state = useTodoListElementState({ element: props.element })
  const { checkboxProps } = useTodoListElement(state)
  return <PlateElement {...props} className="plate-list" style={{
    paddingInlineStart: typeof props.element.indent === 'number' && props.element.indent > 1
      ? `${(props.element.indent - 1) * 1.35}em` : undefined,
  }}>
    <span className="plate-list-marker" contentEditable={false}>
      <input type="checkbox" aria-label="待办状态" checked={checkboxProps.checked} disabled={readOnly}
        onMouseDown={checkboxProps.onMouseDown} onChange={(event) => checkboxProps.onCheckedChange(event.currentTarget.checked)} />
    </span>
    {props.children}
  </PlateElement>
}

export function CodeBlock(props: PlateElementProps) {
  const language = typeof props.element.lang === 'string' ? props.element.lang : undefined
  return <PlateElement {...props} className="plate-code-block" data-language={language}>
    <pre><code>{props.children}</code></pre>
  </PlateElement>
}

export function Rule(props: PlateElementProps) {
  return <PlateElement {...props}><hr contentEditable={false} />{props.children}</PlateElement>
}

export function Table(props: PlateElementProps) {
  return <PlateElement {...props} className="plate-table-wrap"><table><tbody>{props.children}</tbody></table></PlateElement>
}

export function Link(props: PlateElementProps) {
  const { openLink } = useContext(Resources)
  const readOnly = useReadOnly()
  const href = typeof props.element.url === 'string' ? props.element.url : ''
  const kind = resourceKind(href)
  return <PlateElement as="a" {...props} attributes={{ ...props.attributes,
    href: kind === 'web' ? href : undefined, target: '_blank', rel: 'noopener noreferrer',
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!readOnly && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return }
      if (kind === 'relative' && openLink) {
        event.preventDefault()
        void openLink(href).catch(console.error)
      }
    },
  }} />
}

export function Image(props: PlateElementProps) {
  const { readImage } = useContext(Resources)
  const href = typeof props.element.url === 'string' ? props.element.url : ''
  const alt = typeof props.element.alt === 'string' ? props.element.alt : '图片'
  const [loaded, setLoaded] = useState<{ href: string; url: string }>()
  useEffect(() => {
    if (resourceKind(href) !== 'relative' || !readImage) return
    let active = true
    let url: string | undefined
    void readImage(href).then((blob) => {
      if (!active || !blob) return
      url = URL.createObjectURL(blob)
      setLoaded({ href, url })
    }).catch(() => {})
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [href, readImage])
  const url = loaded?.href === href ? loaded.url : undefined
  return <PlateElement {...props}>
    <figure contentEditable={false}>
      {url ? <img src={url} alt={alt} /> : <span className="plate-image-caption">{alt} · {href}</span>}
    </figure>
    {props.children}
  </PlateElement>
}

export function Formula(props: PlateElementProps) {
  const latex = typeof props.element.texExpression === 'string' ? props.element.texExpression : ''
  return <PlateElement as={props.element.type === 'inline_equation' ? 'span' : 'div'} {...props}>
    <code contentEditable={false}>{latex}</code>{props.children}
  </PlateElement>
}

export function BlockSelection({ element, attributes }: Pick<PlateElementProps, 'element' | 'attributes'>) {
  const selected = useBlockSelected()
  const readOnly = useReadOnly()
  const { api, editor } = useEditorPlugin(BlockSelectionPlugin)
  if (readOnly || typeof element.id !== 'string' || !attributes.className?.includes('slate-selectable')) return null
  return <>
    {selected && <span contentEditable={false} className="plate-block-selected" aria-hidden="true" />}
    <span contentEditable={false} className="plate-block-gutter" aria-hidden="true"
      onDoubleClick={(event) => {
        event.preventDefault()
        editor.tf.deselect()
        api.blockSelection.set(String(element.id))
        api.blockSelection.focus()
      }} />
  </>
}
