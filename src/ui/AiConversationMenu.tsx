import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from 'solid-js'

export type ConversationListItem = { id: number; title: string; updatedAt?: number }

const dayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })

export default function AiConversationMenu(props: {
  current: ConversationListItem
  history: readonly ConversationListItem[]
  open: boolean
  disabled: boolean
  onToggle: () => void
  onDismiss: () => void
  onSelect: (id: number) => void
}) {
  const popupId = createUniqueId()
  const [search, setSearch] = createSignal('')
  let searchField: HTMLInputElement | undefined

  const groups = createMemo(() => {
    if (!props.open) return []
    const query = search().trim().toLocaleLowerCase()
    const now = new Date()
    const midnight = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime()
    const ranges = [
      { label: '今天', start: midnight(0) }, { label: '昨天', start: midnight(1) },
      { label: '最近 7 天', start: midnight(6) }, { label: '过去 30 天', start: midnight(29) },
      { label: '更早', start: -Infinity },
    ].map((range) => ({ ...range, items: [] as ConversationListItem[] }))
    const undated: ConversationListItem[] = []
    const conversations = [props.current, ...props.history].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    for (const conversation of conversations) {
      if (query && !conversation.title.toLocaleLowerCase().includes(query)) continue
      const { updatedAt } = conversation
      if (updatedAt === undefined) undated.push(conversation)
      else ranges.find(({ start }) => updatedAt >= start)?.items.push(conversation)
    }
    return [{ label: '', items: undated }, ...ranges].filter(({ items }) => items.length)
  })

  createEffect(() => props.open, (open) => {
    if (!open) { setSearch(''); return }
    queueMicrotask(() => { if (props.open) searchField?.focus({ preventScroll: true }) })
  })

  return (
    <div class="ai-conversations" data-ai-composer-menu="conversations" onKeyDown={(event) => {
      if (!props.open) return
      const menu = event.currentTarget
      if (event.key === 'Tab') {
        requestAnimationFrame(() => {
          if (menu.isConnected && !menu.contains(document.activeElement)) props.onDismiss()
        })
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.isComposing) return
      const options = [...menu.querySelectorAll<HTMLButtonElement>('.ai-conversation-option:enabled')]
      if (!options.length) return
      if (event.key === 'Enter') {
        if (event.target === searchField) { event.preventDefault(); options[0].click() }
        return
      }
      event.preventDefault()
      const index = options.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % options.length : index < 0 ? options.length - 1 : index - 1
      if (next < 0) searchField?.focus()
      else options[next]?.focus()
    }}>
      <button class="ai-conversation-trigger" type="button" aria-label="会话列表" aria-haspopup="dialog"
        aria-expanded={props.open ? 'true' : 'false'} aria-controls={popupId} disabled={props.disabled} onClick={props.onToggle}>
        <span>{props.current.title}</span><i aria-hidden="true" />
      </button>
      <Show when={props.open}>
        <div class="ai-conversation-popup" id={popupId} role="dialog" aria-label="选择会话">
          <label class="ai-conversation-search">
            <span aria-hidden="true" />
            <input ref={searchField} type="search" aria-label="搜索会话" placeholder="搜索会话"
              value={search()} onInput={(event) => setSearch(event.currentTarget.value)} />
          </label>
          <div class="ai-conversation-list">
            <For each={groups()} fallback={<p class="ai-conversation-empty" role="status">没有匹配的会话</p>}>
              {(group) => <section aria-label={group.label || undefined}>
                <Show when={group.label}><h3>{group.label}</h3></Show>
                <For each={group.items}>{(conversation) =>
                  <button class="ai-conversation-option" type="button" aria-current={conversation.id === props.current.id ? 'true' : 'false'}
                    disabled={props.disabled} title={conversation.title} onClick={() => props.onSelect(conversation.id)}>
                    <i aria-hidden="true" /><span>{conversation.title}</span>
                    <Show when={conversation.updatedAt}>{(time) =>
                      <time datetime={new Date(time()).toISOString()}>{dayFormatter.format(time())}</time>
                    }</Show>
                  </button>
                }</For>
              </section>}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
