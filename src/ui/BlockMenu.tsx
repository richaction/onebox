import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import type { MenuItem } from '../core/blockCommands'

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
  items: { item: MenuItem; section?: string }[]
  active: number
  keyboardHighlight: boolean
  isPressing: () => boolean
  onHighlight: (index: number) => void
  onChoose: (index: number) => void
  onClose: () => void
  ref: (element: HTMLDivElement) => void
}) {
  const [viewport, setViewport] = createSignal(viewportBounds())
  let results!: HTMLDivElement
  const activeItem = () => props.items[props.active]?.item

  const layout = createMemo(() => {
    const { left, top, width, height } = viewport()
    const right = left + width
    const bottom = top + height
    const margin = 8
    const menuWidth = Math.min(304, width - margin * 2)
    const x = Math.max(left + margin, Math.min(props.anchor.x, right - menuWidth - margin))
    const above = props.anchor.above - top - margin
    const below = bottom - props.anchor.y - margin
    const maxHeight = props.query === undefined ? 396 : 428
    const openUp = below < Math.min(above, maxHeight)
    const heightLimit = Math.min(maxHeight, Math.max(100, openUp ? above : below))
    const preview = right - (x + menuWidth) >= 204 ? 'right' : x - left >= 204 ? 'left' : undefined
    return { x, openUp, heightLimit, menuWidth, preview }
  })

  onMount(() => {
    const resize = () => { if (!props.isPressing()) setViewport(viewportBounds()) }
    const visual = window.visualViewport
    window.addEventListener('resize', resize)
    visual?.addEventListener('resize', resize)
    visual?.addEventListener('scroll', resize)
    onCleanup(() => {
      window.removeEventListener('resize', resize)
      visual?.removeEventListener('resize', resize)
      visual?.removeEventListener('scroll', resize)
    })
  })

  createEffect(() => {
    if (!props.keyboardHighlight) return
    props.items
    const row = results.querySelector<HTMLElement>(`[data-index="${props.active}"]`)
    if (props.active === 0) results.scrollTop = 0
    else if (row && row.offsetTop < results.scrollTop) results.scrollTop = row.offsetTop
    else if (row && row.offsetTop + row.offsetHeight > results.scrollTop + results.clientHeight) {
      results.scrollTop = row.offsetTop + row.offsetHeight - results.clientHeight
    }
  })

  return (
    <div
      class="block-menu-popup"
      ref={props.ref}
      style={{
        left: `${layout().x}px`,
        width: `${layout().menuWidth}px`,
        top: layout().openUp ? undefined : `${props.anchor.y}px`,
        bottom: layout().openUp ? `${window.innerHeight - props.anchor.above}px` : undefined,
        '--block-menu-max-height': `${layout().heightLimit}px`,
      }}
      onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
    >
      <div class="block-menu">
        <Show when={props.query !== undefined}>
          <div class="block-menu-query" aria-hidden="true">
            <span>/</span>
            <span classList={{ 'block-menu-hint': !props.query }}>{props.query || '输入以搜索'}</span>
          </div>
        </Show>
        <div
          class="block-menu-results"
          ref={results}
          id={props.id}
          role="listbox"
          aria-label={props.query === undefined ? '区块操作' : '区块命令'}
        >
          <For each={props.items} fallback={<div class="block-menu-empty" role="status">没有匹配的命令</div>}>
            {({ item, section }, index) => (
              <>
                <Show when={section}><div class="block-menu-section" role="presentation">{section}</div></Show>
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`${props.id}-${index()}`}
                  data-index={index()}
                  aria-selected={index() === props.active}
                  classList={{ 'block-menu-item': true, highlighted: index() === props.active }}
                  onPointerEnter={(event) => { if (event.pointerType === 'mouse') props.onHighlight(index()) }}
                  onClick={() => props.onChoose(index())}
                >
                  <span class="block-menu-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                  <Show when={item.shortcut}><kbd>{item.shortcut}</kbd></Show>
                </button>
              </>
            )}
          </For>
        </div>
        <footer class="block-menu-footer">
          <button type="button" tabIndex={-1} onClick={props.onClose}>关闭菜单 <kbd>Esc</kbd></button>
        </footer>
      </div>
      <Show when={layout().preview ? activeItem()?.preview : undefined}>
        {(preview) => (
          <aside class="block-menu-preview" data-side={layout().preview} aria-hidden="true">
            <div class="block-menu-example" data-example={preview().kind} data-level={activeItem()?.icon}>
              <Switch>
                <Match when={preview().kind === 'heading'}><strong>章节标题</strong></Match>
                <Match when={preview().kind === 'text'}>在这里开始写作。</Match>
                <Match when={preview().kind === 'bullet'}><ul><li>要点一</li><li>要点二</li></ul></Match>
                <Match when={preview().kind === 'ordered'}><ol><li>第一步</li><li>第二步</li></ol></Match>
                <Match when={preview().kind === 'task'}><span>☑ 已完成<br />☐ 待完成</span></Match>
                <Match when={preview().kind === 'quote'}><blockquote>记录值得记住的话。</blockquote></Match>
                <Match when={preview().kind === 'code'}><code>print("Hello")</code></Match>
                <Match when={preview().kind === 'divider'}><hr /></Match>
                <Match when={preview().kind === 'table'}>
                  <table><tbody><tr><th>项目</th><th>状态</th></tr><tr><td>初稿</td><td>完成</td></tr></tbody></table>
                </Match>
                <Match when={preview().kind === 'media'}><span class="block-menu-media-icon">{activeItem()?.icon}</span></Match>
              </Switch>
            </div>
            <p>{preview().caption}</p>
          </aside>
        )}
      </Show>
    </div>
  )
}
