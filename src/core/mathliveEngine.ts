import { MathfieldElement } from 'mathlive'
import 'mathlive/fonts.css'
import { safeMathMarkup } from './mathMarkup'

MathfieldElement.createHTML = safeMathMarkup
MathfieldElement.fontsDirectory = null
MathfieldElement.soundsDirectory = null
MathfieldElement.computeEngine = null

export function createMathfield(display: boolean) {
  const field = new MathfieldElement()
  field.defaultMode = display ? 'math' : 'inline-math'
  field.mathVirtualKeyboardPolicy = 'manual'
  field.smartFence = false
  field.setAttribute('aria-label', '公式编辑')
  return field
}
