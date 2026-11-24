import { isTauri } from '@tauri-apps/api/core'
import { render } from 'solid-js/web'
import { enableButtonClickTolerance } from './core/buttonClickTolerance'
import './styles/editor.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
const disableButtonClickTolerance = enableButtonClickTolerance(document)
import.meta.hot?.dispose(disableButtonClickTolerance)
const editorMode = new URLSearchParams(location.search).get('editor')
if (editorMode === 'plate' || (!isTauri() && editorMode !== 'legacy')) {
  const { mountPlate } = await import('./react/start')
  const unmount = mountPlate(root)
  import.meta.hot?.dispose(unmount)
} else {
  const { default: App } = await import('./App')
  render(() => <App />, root)
}
