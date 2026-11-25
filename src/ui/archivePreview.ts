import './archivePreview.css'

interface ArchiveNode {
  key: string
  name: string
  path: string
  children?: Map<string, ArchiveNode>
  size?: string
}

interface ArchiveRow {
  node: ArchiveNode
  button: HTMLButtonElement
  parent?: ArchiveRow
}

const splitWidth = '(max-width: 599px)'

export function customizeArchivePreview(shell: HTMLElement) {
  const sidebar = shell.querySelector('.archive-sidebar')
  const source = sidebar?.querySelector('.archive-list')
  const search = sidebar?.querySelector<HTMLInputElement>('.archive-search')
  const toolbar = shell.querySelector('.archive-preview-toolbar')
  const preview = shell.querySelector('.archive-preview')
  if (!sidebar || !source || !search || !toolbar || !preview) return
  toolbar.setAttribute('data-activate-on-release', '')

  const heading = document.createElement('h2')
  heading.textContent = '压缩包内容'
  sidebar.querySelector('.archive-head-main')?.prepend(heading)
  search.setAttribute('aria-label', '筛选压缩包内的文件')

  const list = document.createElement('div')
  list.className = 'ob-archive-list'
  const tree = document.createElement('div')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', '压缩包目录')
  const result = document.createElement('p')
  result.className = 'ob-archive-results'
  result.setAttribute('role', 'status')
  list.append(tree, result)
  source.after(list)

  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'ob-archive-back'
  back.textContent = '‹ 返回目录'
  toolbar.prepend(back)
  const hint = document.createElement('p')
  hint.className = 'ob-archive-hint'
  hint.textContent = '选择文件以预览'
  preview.append(hint)
  shell.classList.add('ob-archive')

  const compact = matchMedia(splitWidth)
  const collapsed = new Set<string>()
  const collapsedMatches = new Set<string>()
  const collapsedFolders = () => search.value.trim() ? collapsedMatches : collapsed
  const nodes = new Map<string, ArchiveNode>()
  let entries = new Map<string, HTMLButtonElement>()
  let rows: ArchiveRow[] = []
  let rowsByKey = new Map<string, ArchiveRow>()
  let focused: ArchiveRow | undefined
  let selected: string | undefined

  const focusRow = (row: ArchiveRow) => {
    if (focused) focused.button.tabIndex = -1
    focused = row
    row.button.tabIndex = 0
    row.button.focus()
  }

  const render = (focusKey?: string) => {
    const wasFocused = tree.contains(document.activeElement)
    const previous = focusKey ?? focused?.node.key
    const filtering = search.value.trim().length > 0
    const closed = collapsedFolders()
    const fragment = document.createDocumentFragment()
    rows = []
    rowsByKey = new Map()

    const appendNodes = (siblings: Map<string, ArchiveNode>, level: number, parent?: ArchiveRow) => {
      const ordered = [...siblings.values()].sort((left, right) => Number(!!right.children) - Number(!!left.children))
      ordered.forEach((node, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ob-archive-row'
        button.title = node.path
        button.tabIndex = -1
        button.dataset.key = node.key
        button.style.setProperty('--archive-indent', `${Math.min(level - 1, 8) * 12}px`)
        button.setAttribute('role', 'treeitem')
        button.setAttribute('aria-label', node.name)
        button.setAttribute('aria-level', String(level))
        button.setAttribute('aria-posinset', String(index + 1))
        button.setAttribute('aria-setsize', String(ordered.length))
        const expanded = !!node.children && !closed.has(node.key)
        if (node.children) button.setAttribute('aria-expanded', String(expanded))
        else button.setAttribute('aria-selected', String(node.key === selected))

        const arrow = document.createElement('span')
        arrow.className = 'ob-archive-arrow'
        const icon = document.createElement('span')
        icon.className = node.children ? 'ob-archive-folder' : 'ob-archive-file'
        const label = document.createElement('span')
        label.className = 'ob-archive-name'
        label.textContent = node.name
        button.append(arrow, icon, label)
        if (node.size) {
          const size = document.createElement('small')
          size.textContent = node.size
          button.append(size)
        }
        const row = { node, button, parent }
        rows.push(row)
        rowsByKey.set(node.key, row)
        fragment.append(button)
        if (node.children && expanded) appendNodes(node.children, level + 1, row)
      })
    }

    appendNodes(nodes, 1)
    tree.replaceChildren(fragment)
    focused = (previous && rowsByKey.get(previous)) || (selected && rowsByKey.get(selected)) || rows[0]
    if (focused) {
      focused.button.tabIndex = 0
      if (wasFocused) focusRow(focused)
    }
    result.textContent = rows.length ? '' : filtering ? '没有匹配的文件' : '压缩包内没有文件'
  }

  const update = (filterChanged = false) => {
    const next = new Map<string, HTMLButtonElement>()
    let selection: string | undefined
    for (const button of source.querySelectorAll<HTMLButtonElement>('.archive-entry')) {
      const path = button.title
      const key = `file:${path}`
      next.set(key, button)
      if (button.classList.contains('active')) selection = key
    }

    // The renderer rebuilds its rows even when only the active entry changes.
    const changed = next.size !== entries.size || [...next.keys()].some((key) => !entries.has(key))
    entries = next
    if (selection) {
      if (selected) rowsByKey.get(selected)?.button.setAttribute('aria-selected', 'false')
      selected = selection
      rowsByKey.get(selected)?.button.setAttribute('aria-selected', 'true')
      shell.classList.add('ob-archive-selected')
      shell.classList.toggle('ob-archive-text', /\.txt$/iu.test(selected))
    }
    if (!changed) {
      if (filterChanged) render()
      return
    }

    nodes.clear()
    for (const [key, button] of entries) {
      const segments = button.title.split('/')
      const name = segments.pop() || button.title
      let siblings = nodes
      let path = ''
      for (const folder of segments.filter(Boolean)) {
        path = path ? `${path}/${folder}` : folder
        const folderKey = `folder:${path}`
        let folderNode = siblings.get(folderKey)
        if (!folderNode) {
          folderNode = { key: folderKey, name: folder, path, children: new Map() }
          siblings.set(folderKey, folderNode)
        }
        siblings = folderNode.children!
      }
      siblings.set(key, { key, name, path: button.title, size: button.querySelector('small')?.textContent ?? '' })
    }
    render()
  }

  const toggle = (row: ArchiveRow, open: boolean) => {
    const closed = collapsedFolders()
    if (open) closed.delete(row.node.key)
    else closed.add(row.node.key)
    render(row.node.key)
  }

  const activate = (row: ArchiveRow) => {
    if (row.node.children) {
      toggle(row, row.button.getAttribute('aria-expanded') === 'false')
      return
    }
    shell.classList.add('ob-archive-detail')
    if (row.node.key !== selected || shell.querySelector(':scope > .archive-error:not(.archive-hidden)')) {
      entries.get(row.node.key)?.click()
    }
    if (compact.matches) queueMicrotask(() => {
      if (!shell.querySelector(':scope > .archive-password-dialog:not(.archive-hidden)')) back.focus()
    })
  }

  const showDirectory = () => {
    shell.classList.remove('ob-archive-detail')
    if (focused) focusRow(focused)
    else search.focus()
  }
  back.addEventListener('click', showDirectory)
  search.addEventListener('input', () => {
    collapsedMatches.clear()
    update(true)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && focused) {
      event.preventDefault()
      focusRow(focused)
    } else if (event.key === 'Escape' && search.value) {
      event.preventDefault()
      search.value = ''
      search.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  tree.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return
    const row = rowsByKey.get(event.target.dataset.key ?? '')
    if (!row || row === focused) return
    if (focused) focused.button.tabIndex = -1
    focused = row
    row.button.tabIndex = 0
  })
  tree.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.ob-archive-row') : null
    const row = button && rowsByKey.get(button.dataset.key ?? '')
    if (row) activate(row)
  })
  tree.addEventListener('keydown', (event) => {
    if (!focused || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const index = rows.indexOf(focused)
    const expanded = focused.button.getAttribute('aria-expanded')
    let next: ArchiveRow | undefined
    switch (event.key) {
      case 'ArrowUp': next = rows[index - 1]; break
      case 'ArrowDown': next = rows[index + 1]; break
      case 'Home': next = rows[0]; break
      case 'End': next = rows.at(-1); break
      case 'ArrowLeft':
        if (expanded === 'true') toggle(focused, false)
        else next = focused.parent
        break
      case 'ArrowRight':
        if (expanded === 'false') toggle(focused, true)
        else if (expanded === 'true') next = rows[index + 1]
        break
      default: return
    }
    event.preventDefault()
    if (next) focusRow(next)
  })
  const observer = new MutationObserver(() => update())
  observer.observe(source, { childList: true })
  update(true)
  return () => observer.disconnect()
}
