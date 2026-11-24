/** @jsxImportSource react */

import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import initialMarkdown from '../../examples/manual-testing/00 开始测试.md?raw'
import { handoffDocument, switchEditor } from '../editorMode'
import { desktopAttachments, desktopWorkspace, tauriFileSystem } from '../io/tauri'
import { Workspace } from './workspace/Workspace'
import { documentEntry, type WorkspacePlatform } from './workspace/platform'
import './workspace/style.css'

const filters = [{ name: 'Markdown', extensions: ['md', 'markdown'] }]

const desktopPlatform: WorkspacePlatform = {
  read: tauriFileSystem.readText,
  write: tauriFileSystem.writeText,
  list: desktopWorkspace.entries,
  restoreWorkspace: async () => await desktopWorkspace.restoreRoot() ?? undefined,
  chooseFolder: async () => {
    const path = await open({ directory: true, multiple: false })
    if (typeof path === 'string') return desktopWorkspace.selectRoot(path)
  },
  chooseDocument: async () => {
    const path = await open({ filters, multiple: false })
    if (typeof path === 'string') return documentEntry(path)
  },
  resources: (path) => ({
    readImage: (href) => desktopAttachments.readImage(path, href),
    openLink: (href) => desktopAttachments.open(path, href),
  }),
}

const sample = documentEntry('00 开始测试.md')
let sampleDraft = initialMarkdown
const browserPlatform: WorkspacePlatform = {
  read: async () => sampleDraft,
  write: async (_path, content) => { sampleDraft = content },
}

function registerDesktopClose(flush: () => Promise<boolean>) {
  const app = getCurrentWindow()
  const close = app.onCloseRequested(async (event) => {
    event.preventDefault()
    if (await flush()) await app.destroy()
  })
  return () => { void close.then((unsubscribe) => unsubscribe()).catch(console.error) }
}

function returnToLegacy(path?: string) {
  switchEditor('legacy', path)
}

function Desktop() {
  const mac = /Mac OS X/u.test(navigator.userAgent)
  const [center, setCenter] = useState<number>()
  const [initialEntry] = useState(() => {
    const path = handoffDocument()
    if (path) return documentEntry(path)
  })
  useEffect(() => {
    if (mac) void invoke<number | null>('title_bar_button_center').then((value) => { if (value) setCenter(value) }).catch(() => {})
    const hot = import.meta.hot
    if (!hot) return
    const focus = () => { void invoke('focus_window') }
    // Keep the single-window launcher aware of the React workbench. Restart must
    // wait for the user to return through the save-aware editor switch.
    const prepare = ({ id }: { id: string }) => hot.send('onebox:prepared', { id, error: '请先通过 Plate 页面的返回按钮保存文档' })
    hot.send('onebox:ready', { native: true })
    hot.on('onebox:focus', focus)
    hot.on('onebox:prepare', prepare)
    return () => {
      hot.off('onebox:focus', focus)
      hot.off('onebox:prepare', prepare)
    }
  }, [mac])
  return <Workspace platform={desktopPlatform} initialEntry={initialEntry} titleBar={{ mac, buttonCenter: center }}
    onSwitchToLegacy={returnToLegacy} registerClose={registerDesktopClose} />
}

export function mountPlate(root: HTMLElement) {
  const react = createRoot(root)
  react.render(isTauri() ? <Desktop /> : <Workspace platform={browserPlatform} initialEntry={sample} />)
  return () => react.unmount()
}
