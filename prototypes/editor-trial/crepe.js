import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

export async function mount(root, markdown) {
  const crepe = new Crepe({ root, defaultValue: markdown })
  await crepe.create()
  return () => crepe.getMarkdown()
}
