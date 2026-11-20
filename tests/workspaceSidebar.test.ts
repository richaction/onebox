import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../src/ui/WorkspaceSidebar'

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
    readonly: false,
    revision: 0,
    onMove,
    onCreate: async () => {},
    onTrash: async () => {},
    onRename: async (entry) => entry.path,
    onOpen: noop,
    onOpenFile: noop,
    onOpenWorkspace: noop,
    onCopy: noop,
    onMoveDocument: noop,
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
  const host = document.createElement('div')
  document.body.append(host)
  const onCreate = vi.fn(async () => {})
  const onTrash = vi.fn(async () => {})
  const onRename = vi.fn(async () => '/work/renamed.md')
  const noop = () => {}
  const dispose = render(() => createComponent(WorkspaceSidebar, {
    workspace: { root: '/work', entries: [entry] },
    visible: true,
    restoring: false,
    active: null,
    readonly: false,
    revision: 0,
    onCreate,
    onTrash,
    onRename,
    onMove: async () => {},
    onOpen: noop,
    onOpenFile: noop,
    onOpenWorkspace: noop,
    onCopy: noop,
    onMoveDocument: noop,
    onClose: noop,
  }), host)
  const row = host.querySelector<HTMLElement>('[data-workspace-entry]')!
  const more = row.querySelector<HTMLButtonElement>('.workspace-row-action')!
  const menuItems = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))

  try {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    const rightClickLabels = menuItems().map((button) => button.textContent)
    more.click()
    expect(menuItems().map((button) => button.textContent)).toEqual(rightClickLabels)
    expect(rightClickLabels).toContain('复制路径')
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    menuItems().find((button) => button.textContent === '复制路径')!.click()
    expect(clipboard).toHaveBeenCalledWith('/work/note.md')
    clipboard.mockRestore()
    more.click()
    menuItems().find((button) => button.textContent === '重命名…')!.click()
    const name = host.querySelector<HTMLInputElement>('.filename-field input')!
    expect(name.value).toBe('note')
    expect(name.parentElement?.textContent).toBe('.md')
    name.value = 'renamed'
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onRename).toHaveBeenCalledWith(entry, 'renamed')
    await Promise.resolve()
    await Promise.resolve()
    more.click()
    menuItems().find((button) => button.textContent === '新建文件夹…')!.click()
    const field = host.querySelector<HTMLInputElement>('.workspace-rows input')!
    expect(host.querySelector('dialog')).toBeNull()
    field.value = 'alpha'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onCreate).toHaveBeenCalledWith('/work', 'alpha', true)
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
