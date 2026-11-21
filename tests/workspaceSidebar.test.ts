import { createComponent, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../src/ui/WorkspaceSidebar'
import { desktopWorkspace } from '../src/io/tauri'

it('keeps the sidebar steady on open and remembers contextual placement after remount', async () => {
  const root = '/pin-test'
  const folder = { path: `${root}/folder`, name: 'folder', directory: true, markdown: false }
  const file = (name: string, parent = root) => ({ path: `${parent}/${name}`, name, directory: false, markdown: name.endsWith('.md') })
  const first = file('first.md')
  const second = file('second.pdf')
  const nested = file('note.md', folder.path)
  const dotfile = file('.gitignore', folder.path)
  const subfolder = { path: `${folder.path}/child`, name: 'child', directory: true, markdown: false }
  let children = [subfolder, file('.DS_Store', folder.path), dotfile, nested]
  const load = vi.spyOn(desktopWorkspace, 'entries').mockImplementation(async (_root, parent) =>
    parent === folder.path ? children : [file('.DS_Store'), folder, first, second])
  const orderKey = `onebox:workspace-order:${root}`
  const savedOrder = JSON.stringify({ [root]: [folder.path, first.path, second.path] })
  localStorage.setItem(orderKey, savedOrder)
  const [active, setActive] = createSignal<string | null>(first.path)
  const [revision, setRevision] = createSignal(0)
  const host = document.createElement('div')
  document.body.append(host)
  const noop = () => {}
  vi.useFakeTimers()
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  const mount = () => render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries: [file('.DS_Store'), folder, first, second] },
    visible: true, restoring: false, get active() { return active() }, get revision() { return revision() },
    onOpen: (entry) => setActive(entry.path), onOpenFile: async () => { setActive(nested.path); return nested.path }, onOpenWorkspace: noop,
    onCreate: async (parent, name, _directory, onCreated) => {
      const entry = file(name, parent)
      children = [...children, entry]
      onCreated(entry)
      setRevision((value) => value + 1)
      setActive(entry.path)
    },
    onTrash: async () => {}, onRename: async (entry) => entry.path,
    onMove: async () => {}, onPaste: async () => {}, onClose: noop,
  }), host)
  let dispose = mount()
  const names = (path: string) => [...host.querySelectorAll(`ul[data-workspace-folder="${path}"] > li > .workspace-row`)]
    .map((row) => row.getAttribute('data-workspace-entry'))
  const choose = (path: string, action: string) => {
    host.querySelector(`[data-workspace-entry="${path}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    buttons.find((button) => button.textContent === action)!.click()
  }

  try {
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    const button = host.querySelector<HTMLButtonElement>(`[data-workspace-entry="${second.path}"] > button`)!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    expect(button.getAttribute('aria-current')).toBe('page')
    expect(button.hasAttribute('aria-busy')).toBe(false)
    const other = host.querySelector<HTMLButtonElement>(`[data-workspace-entry="${first.path}"] > button`)!
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    const input = host.querySelector<HTMLInputElement>('.filename-field input')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('first')
    expect(active()).toBe(second.path)
    expect(scroll).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(names(root)).toEqual([folder.path, first.path, second.path])

    setActive(nested.path)
    await Promise.resolve()
    expect(names(root)).toEqual([folder.path, first.path, second.path])
    expect(names(folder.path)).toEqual([subfolder.path, dotfile.path, nested.path])
    expect(localStorage.getItem(orderKey)).toBe(savedOrder)

    choose(dotfile.path, '打开文件…')
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual([subfolder.path, dotfile.path, nested.path])
    choose(folder.path, '打开文件…')
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual([nested.path, subfolder.path, dotfile.path])

    choose(dotfile.path, '新建文件…')
    const draft = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    expect(draft.closest('li')?.previousElementSibling?.firstElementChild?.getAttribute('data-workspace-entry')).toBe(dotfile.path)
    draft.value = 'added.md'
    draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    const saved = [nested.path, subfolder.path, dotfile.path, `${folder.path}/added.md`]
    expect(names(folder.path)).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(orderKey)!)[folder.path]).toEqual(saved)
    dispose()
    dispose = mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(names(folder.path)).toEqual(saved)
  } finally {
    dispose()
    vi.useRealTimers()
    scroll.mockRestore()
    load.mockRestore()
    localStorage.removeItem(orderKey)
    host.remove()
  }
})

it('marks a valid drop folder before moving and clears the mark on release', () => {
  const folder = (name: string) => ({ path: `/work/${name}`, name, directory: true, markdown: false })
  const source = folder('source')
  const target = folder('target')
  const host = document.createElement('div')
  document.body.append(host)
  const onMove = vi.fn(async () => {})
  const noop = () => {}
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root: '/work', entries: [source, target] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onMove,
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpen: noop,
    onOpenFile: async () => undefined,
    onOpenWorkspace: noop,
    onPaste: async () => {},
    onClose: noop,
  }), host)
  const sourceRow = host.querySelector<HTMLElement>('[data-workspace-folder="/work/source"]')!
  const targetRow = host.querySelector<HTMLElement>('[data-workspace-folder="/work/target"]')!
  vi.spyOn(sourceRow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 32))
  vi.spyOn(targetRow, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 32, 200, 32))
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(targetRow)
  const pointer = (type: string, y: number, buttons: number) => new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: 30, clientY: y, button: 0, buttons,
  })

  try {
    sourceRow.querySelector('button')!.dispatchEvent(pointer('pointerdown', 12, 1))
    window.dispatchEvent(pointer('pointermove', 22, 1))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(false)

    window.dispatchEvent(pointer('pointermove', 62, 1))
    expect(targetRow.parentElement!.classList.contains('workspace-drop-after')).toBe(true)
    window.dispatchEvent(pointer('pointerup', 62, 0))
    expect(targetRow.parentElement!.classList.contains('workspace-drop-after')).toBe(false)
    expect([...host.querySelectorAll('[data-workspace-entry]')].map((row) => row.getAttribute('data-workspace-entry')))
      .toEqual([target.path, source.path])
    expect(onMove).not.toHaveBeenCalled()

    sourceRow.querySelector('button')!.dispatchEvent(pointer('pointerdown', 12, 1))
    window.dispatchEvent(pointer('pointermove', 48, 1))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(true)
    expect(onMove).not.toHaveBeenCalled()

    window.dispatchEvent(pointer('pointerup', 48, 0))
    expect(targetRow.classList.contains('workspace-drop-target')).toBe(false)
    expect(onMove).toHaveBeenCalledWith(source, target.path)
  } finally {
    localStorage.removeItem('onebox:workspace-order:/work')
    hit.mockRestore()
    dispose()
    host.remove()
  }
})

it('uses the same menu for right click and overflow, with inline creation and confirmed deletion', async () => {
  const entry = { path: '/work/note.md', name: 'note.md', directory: false, markdown: true }
  const folder = { path: '/work/folder', name: 'folder', directory: true, markdown: false }
  const host = document.createElement('div')
  document.body.append(host)
  const onCreate = vi.fn(async (_parent, _name, _directory, onCreated: (entry: typeof folder) => void) => {
    onCreated(folder)
  })
  const onTrash = vi.fn(async () => {})
  const onRename = vi.fn(async () => '/work/renamed.md')
  const onOpen = vi.fn()
  const noop = () => {}
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root: '/work', entries: [entry, folder] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onCreate,
    onTrash,
    onRename,
    onMove: async () => {},
    onOpen,
    onOpenFile: async () => undefined,
    onOpenWorkspace: noop,
    onPaste: async () => {},
    onClose: noop,
  }), host)
  const row = host.querySelector<HTMLElement>('[data-workspace-entry]')!
  const more = row.querySelector<HTMLButtonElement>('.workspace-row-action')!
  const menuItems = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))

  try {
    const rowButton = (path: string) => host.querySelector<HTMLButtonElement>(
      `[data-workspace-entry="${path}"] > .workspace-row-button`,
    )!
    for (const [item, stem] of [[entry, 'note'], [folder, 'folder']] as const) {
      const button = rowButton(item.path)
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
      if (item.directory) expect(button.getAttribute('aria-expanded')).toBe('true')
      button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
      const input = host.querySelector<HTMLInputElement>('.filename-field input')!
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe(stem)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entry)

    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    const rightClickLabels = menuItems().map((button) => button.textContent)
    more.click()
    expect(menuItems().map((button) => button.textContent)).toEqual(rightClickLabels)
    expect(rightClickLabels).toContain('复制路径')
    expect(rightClickLabels).not.toContain('打开此文档')
    expect(rightClickLabels).not.toContain('移动到…')
    expect(rightClickLabels).not.toContain('复制到…')
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    menuItems().find((button) => button.textContent === '复制路径')!.click()
    expect(clipboard).toHaveBeenCalledWith('/work/note.md')
    clipboard.mockRestore()
    more.click()
    menuItems().find((button) => button.textContent === '重命名…')!.click()
    const name = host.querySelector<HTMLInputElement>('.filename-field input')!
    expect(name.value).toBe('note')
    expect(name.closest('.filename-field')?.querySelector('.filename-field-suffix')?.textContent).toBe('.md')
    name.value = 'renamed'
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onRename).toHaveBeenCalledWith(entry, 'renamed')
    await Promise.resolve()
    await Promise.resolve()

    more.click()
    menuItems().find((button) => button.textContent === '新建文件…')!.click()
    const unnamed = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    expect(document.activeElement).toBe(unnamed)
    unnamed.value = '   '
    more.focus()
    expect(host.querySelector('input[aria-label="文件名称"]')).toBeNull()
    expect(document.activeElement).toBe(more)
    expect(onCreate).not.toHaveBeenCalled()

    more.click()
    menuItems().find((button) => button.textContent === '新建文件…')!.click()
    const named = host.querySelector<HTMLInputElement>('input[aria-label="文件名称"]')!
    named.value = 'draft.md'
    more.focus()
    expect(host.contains(named)).toBe(true)
    named.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    more.click()
    menuItems().find((button) => button.textContent === '新建文件夹…')!.click()
    const field = host.querySelector<HTMLInputElement>('.workspace-rows input')!
    expect(host.querySelector('dialog')).toBeNull()
    field.value = 'alpha'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onCreate).toHaveBeenCalledWith('/work', 'alpha', true, expect.any(Function))
    await Promise.resolve()

    more.click()
    menuItems().find((button) => button.textContent === '删除…')!.click()
    expect(onTrash).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('.workspace-trash-confirm')!.click()
    expect(onTrash).toHaveBeenCalledWith(entry)
    await Promise.resolve()
  } finally {
    dispose()
    host.remove()
  }
})

it('copies and cuts one focused file and pastes into the focused folder or root', async () => {
  const root = '/clipboard-test'
  const source = { path: `${root}/sample.pdf`, name: 'sample.pdf', directory: false, markdown: false }
  const folder = { path: `${root}/target`, name: 'target', directory: true, markdown: false }
  const nested = { ...source, path: `${folder.path}/sample.pdf` }
  const load = vi.spyOn(desktopWorkspace, 'entries').mockResolvedValue([nested])
  const host = document.createElement('div')
  document.body.append(host)
  const onOpen = vi.fn()
  const onPaste = vi.fn(async () => {})
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root, entries: [source, folder] },
    visible: true,
    restoring: false,
    active: null,
    revision: 0,
    onOpen,
    onPaste,
    onMove: async () => {},
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpenFile: async () => undefined,
    onOpenWorkspace: () => {},
    onClose: () => {},
  }), host)
  const row = (path: string) => host.querySelector<HTMLElement>(`[data-workspace-entry="${path}"]`)!
  const select = (path: string) => row(path).querySelector<HTMLButtonElement>('.workspace-row-button')!.click()
  const press = (key: string, metaKey = false) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: !metaKey, metaKey })
    document.activeElement!.dispatchEvent(event)
    return event.defaultPrevented
  }

  try {
    select(source.path)
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(source)
    expect(press('c')).toBe(true)
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(source, root, false)
    await Promise.resolve()

    select(folder.path)
    expect(press('v', true)).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(source, folder.path, false)
    await Promise.resolve()

    select(nested.path)
    expect(press('x')).toBe(true)
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(true)
    host.querySelector<HTMLElement>('.workspace-title strong')!.click()
    onPaste.mockRejectedValueOnce(new Error('目标已存在同名文件'))
    expect(press('v')).toBe(true)
    await Promise.resolve()
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(true)
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(nested, root, true)
    await Promise.resolve()
    expect(row(nested.path).classList.contains('workspace-row-cut')).toBe(false)
    expect(press('v')).toBe(false)

    select(nested.path)
    expect(press('x')).toBe(true)
    expect(press('v')).toBe(true)
    expect(onPaste).toHaveBeenLastCalledWith(nested, folder.path, false)
    await Promise.resolve()

    const button = row(source.path).querySelector<HTMLButtonElement>('.workspace-row-button')!
    button.focus()
    expect(press('c')).toBe(true)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    expect(document.activeElement?.tagName).toBe('INPUT')
    expect(press('x')).toBe(false)
    expect(press('v')).toBe(false)
    expect(onPaste).toHaveBeenCalledTimes(5)
  } finally {
    dispose()
    load.mockRestore()
    host.remove()
  }
})
