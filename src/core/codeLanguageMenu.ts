import { trackMenuPress } from './menuPress'

type Language = { id: string; label: string }

export function codeLanguageMenu(document: Document, languages: readonly Language[], current: Language,
  choose: (id: string) => void,
) {
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'code-language'
  trigger.dataset.activateOnRelease = ''
  trigger.dataset.languageId = current.id
  trigger.textContent = current.label
  trigger.setAttribute('aria-label', '代码语言：' + current.label)
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  let popup: HTMLElement | undefined
  let closeListeners: (() => void) | undefined

  function close(restoreFocus = false) {
    closeListeners?.()
    popup?.remove()
    popup = undefined
    closeListeners = undefined
    trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus) trigger.focus({ preventScroll: true })
  }

  function open() {
    if (trigger.disabled || popup) return
    const menu = document.createElement('div')
    menu.className = 'code-language-menu'
    menu.dataset.activateOnRelease = ''
    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = '搜索语言…'
    search.setAttribute('aria-label', '搜索语言')
    search.spellcheck = false
    const list = document.createElement('div')
    list.className = 'code-language-options'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', '代码语言')
    // Safari may blur the search input without moving focus to the clicked button.
    list.onmousedown = (event) => {
      if (event.button === 0 && (event.target as Element).closest('button')) event.preventDefault()
    }
    menu.append(search, list)
    const bounds = trigger.getBoundingClientRect()
    const viewport = document.documentElement
    const viewportWidth = viewport.clientWidth || document.defaultView?.innerWidth || 242
    const viewportHeight = viewport.clientHeight || document.defaultView?.innerHeight || 400
    const width = Math.min(226, Math.max(0, viewportWidth - 16))
    const below = viewportHeight - bounds.bottom - 9
    const above = bounds.top - 9
    const openUp = below < 210 && above > below
    Object.assign(menu.style, {
      inlineSize: `${width}px`,
      left: `${Math.max(8, Math.min(bounds.right - width, viewportWidth - width - 8))}px`,
      top: openUp ? '' : `${bounds.bottom + 4}px`,
      bottom: openUp ? `${viewportHeight - bounds.top + 4}px` : '',
      maxHeight: `${Math.max(100, Math.min(312, openUp ? above : below))}px`,
    })
    const render = () => {
      const query = search.value.trim().toLowerCase()
      list.replaceChildren()
      for (const language of languages) {
        if (!`${language.label} ${language.id}`.toLowerCase().includes(query)) continue
        const option = document.createElement('button')
        option.type = 'button'
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(language.id === current.id))
        option.dataset.languageId = language.id
        option.textContent = language.label
        option.onclick = () => { close(true); choose(language.id) }
        list.append(option)
      }
      if (!list.childElementCount) {
        const empty = document.createElement('span')
        empty.className = 'code-language-empty'
        empty.textContent = '没有匹配的语言'
        list.append(empty)
      }
    }
    search.oninput = render
    const pointer = trackMenuPress(document, () => close())
    menu.addEventListener('focusout', () => queueMicrotask(() => {
      if (!pointer.active(menu) && !pointer.active(trigger) && popup === menu && document.activeElement !== trigger &&
        !menu.contains(document.activeElement)) close()
    }))
    menu.onkeydown = (event) => {
      if (event.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); close(true); return }
      const options = Array.from(list.querySelectorAll('button'))
      if (event.key === 'Enter' && event.target === search && search.value.trim()) {
        event.preventDefault()
        options[0]?.click()
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const index = options.indexOf(document.activeElement as HTMLButtonElement)
      event.preventDefault()
      if (event.key === 'ArrowUp' && index === 0) search.focus()
      else options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))]?.focus()
    }
    const press = (event: PointerEvent) => {
      const path = event.composedPath()
      pointer.start(event, path.includes(menu) ? menu : path.includes(trigger) ? trigger : undefined)
      if (!path.includes(menu) && !path.includes(trigger)) close()
    }
    const scrolled = (event: Event) => {
      if (!pointer.active(menu) && !pointer.active(trigger) && !(event.target instanceof Node && menu.contains(event.target))) close()
    }
    const away = () => close()
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('scroll', scrolled, true)
    document.defaultView?.addEventListener('blur', away)
    closeListeners = () => {
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('scroll', scrolled, true)
      document.defaultView?.removeEventListener('blur', away)
      pointer.destroy()
    }
    popup = menu
    trigger.setAttribute('aria-expanded', 'true')
    render()
    document.body.append(menu)
    const selected = list.querySelector('[aria-selected="true"]')
    if (selected) list.scrollTop = Math.max(0, selected.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom)
    search.focus({ preventScroll: true })
  }

  trigger.onclick = () => popup ? close(true) : open()
  return { trigger, close }
}
