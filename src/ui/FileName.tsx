import { createSignal, onSettled, Show, untrack } from 'solid-js'

export function splitName(name: string, directory?: boolean) {
  const dot = name.lastIndexOf('.')
  return directory || dot <= 0 ? { stem: name, suffix: '' }
    : { stem: name.slice(0, dot), suffix: name.slice(dot) }
}

export function onInlineNameBlur(input: HTMLInputElement, commit: () => void) {
  const doc = input.ownerDocument
  const window = doc.defaultView!
  let pointer: number | undefined
  let released = false
  let pending = false
  let releaseTimer: number | undefined
  let timer: number | undefined
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || doc.activeElement !== input || event.target === input) return
    window.clearTimeout(releaseTimer)
    pointer = event.pointerId
    released = false
  }
  const finish = () => {
    window.clearTimeout(releaseTimer)
    pointer = undefined
    released = false
    if (!pending) return
    pending = false
    // A blur during mousedown must not move the row under the next mouseup and click.
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (doc.activeElement !== input) commit() }, 0)
  }
  const release = (event: PointerEvent) => {
    if (pointer === undefined || event.pointerId !== pointer || released) return
    if (event.type === 'pointercancel') { finish(); return }
    released = true
    releaseTimer = window.setTimeout(finish, 400)
  }
  const click = () => { if (released) finish() }
  const blur = () => {
    if (pointer !== undefined) { pending = true; return }
    window.clearTimeout(timer)
    commit()
  }
  input.addEventListener('blur', blur)
  doc.addEventListener('pointerdown', press, true)
  doc.addEventListener('pointerup', release, true)
  doc.addEventListener('pointercancel', release, true)
  doc.addEventListener('click', click, true)
  window.addEventListener('blur', finish)
  return () => {
    window.clearTimeout(releaseTimer)
    window.clearTimeout(timer)
    input.removeEventListener('blur', blur)
    doc.removeEventListener('pointerdown', press, true)
    doc.removeEventListener('pointerup', release, true)
    doc.removeEventListener('pointercancel', release, true)
    doc.removeEventListener('click', click, true)
    window.removeEventListener('blur', finish)
  }
}

export function NameField(props: {
  name: string
  directory?: boolean
  onRename: (stem: string) => Promise<unknown>
  onClose: () => void
}) {
  const { stem, suffix } = untrack(() => splitName(props.name, props.directory))
  const [draft, setDraft] = createSignal(stem)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let input!: HTMLInputElement
  onSettled(() => {
    input.focus({ preventScroll: true })
    input.setSelectionRange(stem.length, stem.length)
    return onInlineNameBlur(input, () => { if (!pending() && !error()) void submit() })
  })

  const submit = async () => {
    if (pending()) return
    const value = input.value
    if (value === stem) {
      props.onClose()
      return
    }
    if (!value.trim()) {
      setError('请输入名称')
      return
    }
    setPending(true)
    setError(undefined)
    try {
      await props.onRename(value)
      props.onClose()
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure))
      input.focus({ preventScroll: true })
    } finally {
      setPending(false)
    }
  }

  return (
    <div class="filename-rename">
      <div class="filename-field">
        <span class="filename-inline-stem">
          <span aria-hidden="true">{draft()}</span>
          <input ref={input} value={stem} type="text" autocomplete="off" spellcheck={false}
            aria-label="新名称" aria-invalid={!!error() ? 'true' : 'false'} readonly={pending()}
            onInput={(event) => {
              setDraft(event.currentTarget.value)
              setError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
              event.preventDefault()
              event.stopPropagation()
              if (event.key === 'Enter') void submit()
              else if (!pending()) props.onClose()
            }} />
        </span>
        <Show when={suffix}><span class="filename-field-suffix" title="扩展名固定">{suffix}</span></Show>
      </div>
      <Show when={error()}>{(issue) => <span class="filename-error" role="alert">{issue()}</span>}</Show>
    </div>
  )
}

export interface TitleEdit {
  stem: string
  error?: string
  onInput: (stem: string) => void
  onPause: () => void
  onSave: () => void
  onCancel: () => void
}

export default function FileName(props: { name: string; edit?: TitleEdit }) {
  const stem = () => props.edit?.stem ?? splitName(props.name).stem
  const InlineTitleInput = () => {
    let input!: HTMLInputElement
    onSettled(() => onInlineNameBlur(input, () => props.edit?.onSave()))
    return (
      <input ref={input}
        value={stem()} type="text" autocomplete="off" spellcheck={false}
        aria-label="文件名" aria-invalid={!!props.edit?.error ? 'true' : 'false'}
        onCompositionStart={() => props.edit?.onPause()}
        onCompositionEnd={(event) => props.edit?.onInput(event.currentTarget.value)}
        onInput={(event) => { if (!event.isComposing) props.edit?.onInput(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') props.edit?.onCancel()
          event.currentTarget.blur()
        }} />
    )
  }
  return (
    <div class="filename-title">
      <Show when={props.edit} fallback={<strong title={props.name}>{props.name}</strong>}>
        <label class="filename-inline" title={props.name}>
          <span class="filename-inline-stem">
            <span aria-hidden="true">{stem() || ' '}</span>
            <InlineTitleInput />
          </span>
          <span class="filename-inline-suffix">{splitName(props.name).suffix}</span>
        </label>
        <Show when={props.edit?.error}>{(issue) => <span class="filename-error" role="alert">{issue()}</span>}</Show>
      </Show>
    </div>
  )
}
