import { render } from '@solidjs/web'
import App from './App'
import { enableButtonClickTolerance } from './core/buttonClickTolerance'
import './styles/editor.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
const disableButtonClickTolerance = enableButtonClickTolerance(document)
import.meta.hot?.dispose(disableButtonClickTolerance)
render(() => <App />, root)
