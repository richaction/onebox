import { convertLatexToMarkup, validateLatex } from 'mathlive/ssr'
import 'mathlive/static.css'
import { safeMathMarkup } from './mathMarkup'

export function previewMath(latex: string, display: boolean) {
  if (validateLatex(latex).length) return
  // The static renderer starts at display style even with the inline mode option.
  return safeMathMarkup(convertLatexToMarkup(display ? latex : `\\textstyle ${latex}`))
}
