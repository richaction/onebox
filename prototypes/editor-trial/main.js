import sample from '../../examples/manual-testing/00 开始测试.md?raw'
import './style.css'

const adapters = {
  blocksuite: () => import('./blocksuite.js'),
  crepe: () => import('./crepe.js'),
}
const buttons = [...document.querySelectorAll('[data-engine]')]
const comparison = document.querySelector('#comparison')
const compare = document.querySelector('#compare')
const status = document.querySelector('#status')
const output = document.querySelector('#exported')
const result = document.querySelector('#comparison-status')
document.querySelector('#original').value = sample

const editors = new Map()
let active

async function choose(name) {
  active = name
  compare.disabled = true
  compare.setAttribute('aria-expanded', 'false')
  comparison.hidden = true
  for (const button of buttons) {
    const selected = button.dataset.engine === name
    button.setAttribute('aria-pressed', String(selected))
    document.getElementById(button.dataset.engine).hidden = !selected
  }
  status.textContent = '正在启动编辑器…'
  if (!editors.has(name)) {
    const slot = document.getElementById(name)
    const mounting = adapters[name]().then(({ mount }) => mount(slot, sample)).catch((error) => {
      editors.delete(name)
      slot.replaceChildren()
      throw error
    })
    editors.set(name, mounting)
  }
  try {
    await editors.get(name)
    if (active !== name) return
    status.textContent = ''
    compare.disabled = false
  } catch (error) {
    if (active === name) status.textContent = `启动失败。 ${error.message}`
    console.error(error)
  }
}

for (const button of buttons) button.addEventListener('click', () => void choose(button.dataset.engine))

compare.addEventListener('click', async () => {
  if (!comparison.hidden) {
    comparison.hidden = true
    compare.setAttribute('aria-expanded', 'false')
    return
  }
  const name = active
  compare.disabled = true
  try {
    const markdown = await (await editors.get(name))()
    if (active !== name) return
    output.value = markdown
    result.textContent = markdown === sample ? '导出内容与样例原文逐字节一致。' : '导出内容与样例原文有差异。可检查格式规范化、内容变化或试改结果。'
    comparison.hidden = false
    compare.setAttribute('aria-expanded', 'true')
    comparison.scrollIntoView({ block: 'nearest' })
  } catch (error) {
    if (active === name) status.textContent = `导出失败。 ${error.message}`
  } finally {
    if (active === name) compare.disabled = false
  }
})

void choose('blocksuite')
