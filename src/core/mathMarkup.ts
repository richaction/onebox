import createDOMPurify from 'dompurify'

const sanitizer = createDOMPurify(window)
sanitizer.addHook('uponSanitizeAttribute', (node, attribute) => {
  if (attribute.attrName === 'contenteditable' && !node.classList?.contains('ML__keyboard-sink')) {
    attribute.keepAttr = false
  }
  if (attribute.attrName === 'style' && /url\s*\(|@import|\\/iu.test(attribute.attrValue)) attribute.keepAttr = false
})

export function safeMathMarkup(html: string) {
  return sanitizer.sanitize(html, {
    ADD_ATTR: ['contenteditable'],
    FORBID_TAGS: ['a', 'img', 'iframe', 'audio', 'video'],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'],
  })
}
