import createDOMPurify from 'dompurify'
import { MathfieldElement } from 'mathlive'
import 'mathlive/fonts.css'

const sanitizer = createDOMPurify(window)
sanitizer.addHook('uponSanitizeAttribute', (node, attribute) => {
  if (attribute.attrName === 'contenteditable' && !node.classList?.contains('ML__keyboard-sink')) {
    attribute.keepAttr = false
  }
  if (attribute.attrName === 'style' && /url\s*\(|@import|\\/iu.test(attribute.attrValue)) attribute.keepAttr = false
})
MathfieldElement.createHTML = (html) => sanitizer.sanitize(html, {
  ADD_ATTR: ['contenteditable'],
  FORBID_TAGS: ['a', 'img', 'iframe', 'audio', 'video'],
  FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
})
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
