import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from 'solid-js'
import type { MenuItem } from '../core/blockCommands'
import BlockMenuIcon from './BlockMenuIcon'

function viewportBounds() {
  const viewport = window.visualViewport
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

export default function BlockMenu(props: {
  id: string
  anchor: { x: number; y: number; above: number }
  query?: string
  groups: {
    label: string
    layout?: 'inline'
    items: { item: MenuItem; index: number; applied: boolean; current: boolean }[]
  }[]
  active: number
  submenu?: { items: readonly MenuItem[]; active: number }
  keyboardHighlight: boolean
  isPressing: () => boolean
  onHighlight: (index: number) => void
  onChoose: (index: number) => void
  onChooseSubmenu: (index: number) => void
  onHighlightSubmenu: (index: number) => void
  ref: (element: HTMLDivElement) => void
}) {
  const [viewport, setViewport] = createSignal(viewportBounds())
  let results!: HTMLDivElement
  let children: HTMLDivElement | undefined

  const layout = createMemo(() => {
    const { left, top, width, height } = viewport()
    const right = left + width
    const bottom = top + height
    const margin = 8
    const submenuGap = 6
    const menuWidth = Math.min(220, props.submenu ? (width - margin * 2 - submenuGap) / 2 : width - margin * 2)
    let x = Math.max(left + margin, Math.min(props.anchor.x, right - menuWidth - margin))
    const roomOnRight = right - margin - x - menuWidth
    const roomOnLeft = x - left - margin
    const submenuSide = roomOnRight >= menuWidth + submenuGap || roomOnRight >= roomOnLeft ? 'right' : 'left'
    if (props.submenu) {
      if (submenuSide === 'right') x = Math.min(x, right - margin - menuWidth * 2 - submenuGap)
      else x = Math.max(x, left + margin + menuWidth + submenuGap)
    }
    const above = props.anchor.above - top - margin
    const below = bottom - props.anchor.y - margin
    const maxHeight = 330
    const openUp = below < Math.min(above, maxHeight)
    const heightLimit = Math.min(maxHeight, Math.max(100, openUp ? above : below))
    return { x, openUp, heightLimit, menuWidth, submenuSide }
  })

  onSettled(() => {
    const resize = () => { if (!props.isPressing()) setViewport(viewportBounds()) }
    const visual = window.visualViewport
    window.addEventListener('resize', resize)
    visual?.addEventListener('resize', resize)
    visual?.addEventListener('scroll', resize)
    return () => {
      window.removeEventListener('resize', resize)
      visual?.removeEventListener('resize', resize)
      visual?.removeEventListener('scroll', resize)
    }
  })

  const keepVisible = (list: HTMLDivElement, active: number) => {
    const row = list.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (active === 0) list.scrollTop = 0
    else if (row && row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row && row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
    }
  }
  createEffect(() => props.keyboardHighlight ? { groups: props.groups, active: props.active } : undefined, (highlight) => {
    if (highlight) keepVisible(results, highlight.active)
  })
  createEffect(() => props.submenu, (submenu) => {
    if (submenu && children) keepVisible(children, submenu.active)
  })

  return (
    <div
      class="block-menu-popup block-menu-compact"
      ref={props.ref}
      style={{
        left: `${layout().x}px`,
        width: `${layout().menuWidth}px`,
        top: layout().openUp ? undefined : `${props.anchor.y}px`,
        bottom: layout().openUp ? `${window.innerHeight - props.anchor.above}px` : undefined,
        '--block-menu-max-height': `${layout().heightLimit}px`,
      }}
      onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div class={['block-menu', { 'block-menu-searchable': props.query !== undefined }]}>
        <Show when={props.query !== undefined}>
          <div class="block-menu-query" aria-hidden="true">
            <span>/</span>
            <span class={{ 'block-menu-hint': !props.query }}>{props.query || '输入以搜索'}</span>
          </div>
        </Show>
        <div
          class="block-menu-results"
          ref={results}
          id={props.id}
          role="listbox"
          aria-label={props.query === undefined ? '编辑器菜单' : '区块命令'}
        >
          <For each={props.groups} fallback={<div class="block-menu-empty" role="status">没有匹配的命令</div>}>
            {(group) => (
              <div role="group" aria-label={group.label}>
                <div class="block-menu-section" aria-hidden="true">{group.label}</div>
                <div role="presentation" class={{ 'block-menu-inline': group.layout === 'inline' }}>
                  <For each={group.items}>{({ item, index, applied, current }) => (
                    <button
                      type="button"
                      role="option"
                      tabindex={-1}
                      id={`${props.id}-${index}`}
                      data-index={index}
                      data-activate-on-release
                      aria-selected={index === props.active ? 'true' : 'false'}
                      aria-current={current ? 'true' : undefined}
                      aria-haspopup={'children' in item ? 'listbox' : undefined}
                      aria-expanded={'children' in item ? (props.submenu ? 'true' : 'false') : undefined}
                      aria-label={group.layout === 'inline' ? (applied ? `${item.label}，已应用` : item.label) : undefined}
                      title={group.layout === 'inline' ? item.label : undefined}
                      data-action={group.layout === 'inline' ? item.label : undefined}
                      data-applied={applied ? '' : undefined}
                      class={{ 'block-menu-item': true, highlighted: index === props.active }}
                      onPointerEnter={(event) => { if (event.pointerType === 'mouse') props.onHighlight(index) }}
                      onClick={() => props.onChoose(index)}
                    >
                      <Show when={group.layout === 'inline'} fallback={
                        <>
                          <BlockMenuIcon name={item.icon} />
                          <span>{item.label}</span>
                          <Show when={'children' in item}><span class="block-menu-arrow" aria-hidden="true">›</span></Show>
                          <Show when={!item.headingLevel && item.shortcut}><kbd>{item.shortcut}</kbd></Show>
                          <Show when={current}><span class="block-menu-check" aria-hidden="true">✓</span></Show>
                        </>
                      }><span aria-hidden="true">{item.icon}</span></Show>
                    </button>
                  )}</For>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={props.submenu}>
        {(submenu) => (
          <div class="block-menu block-menu-submenu" data-side={layout().submenuSide} data-above={layout().openUp}>
            <div class="block-menu-results" ref={(list) => { children = list }}
              id={`${props.id}-charts`} role="listbox" aria-label="ECharts 图表">
              <For each={submenu().items}>{(item, index) => (
                <button type="button" role="option" tabindex={-1} id={`${props.id}-charts-${index()}`}
                   class={['block-menu-item', { highlighted: index() === submenu().active }]}
                  data-index={index()} data-activate-on-release aria-selected={index() === submenu().active ? 'true' : 'false'}
                  onPointerEnter={(event) => { if (event.pointerType === 'mouse') props.onHighlightSubmenu(index()) }}
                  onClick={() => props.onChooseSubmenu(index())}>
                  <BlockMenuIcon name={item.icon} /><span>{item.label}</span>
                </button>
              )}</For>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
