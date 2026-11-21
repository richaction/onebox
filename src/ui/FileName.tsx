import { createSignal, onMount, Show } from 'solid-js'

export function splitName(name: string, directory?: boolean) {
  const dot = name.lastIndexOf('.')
  return directory || dot <= 0 ? { stem: name, suffix: '' }
    : { stem: name.slice(0, dot), suffix: name.slice(dot) }
}

export function NameField(props: {
  name: string
  directory?: boolean
  onRename: (stem: string) => Promise<unknown>
  onClose: () => void
}) {
  const { stem, suffix } = splitName(props.name, props.directory)
  const [draft, setDraft] = createSignal(stem)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let input!: HTMLInputElement
  onMount(() => {
    input.focus({ preventScroll: true })
    input.setSelectionRange(stem.length, stem.length)
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
            aria-label="新名称" aria-invalid={!!error()} readOnly={pending()}
            onInput={(event) => {
              setDraft(event.currentTarget.value)
              setError(undefined)
            }}
            onBlur={() => { if (!pending() && !error()) void submit() }}
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
  return (
    <div class="filename-title">
      <Show when={props.edit} fallback={<strong title={props.name}>{props.name}</strong>}>
        <label class="filename-inline" title={props.name}>
          <span class="filename-inline-stem">
            <span aria-hidden="true">{stem() || ' '}</span>
            <input value={stem()} type="text" autocomplete="off" spellcheck={false}
              aria-label="文件名" aria-invalid={!!props.edit?.error}
              onCompositionStart={() => props.edit?.onPause()}
              onCompositionEnd={(event) => props.edit?.onInput(event.currentTarget.value)}
              onInput={(event) => { if (!event.isComposing) props.edit?.onInput(event.currentTarget.value) }}
              onBlur={() => props.edit?.onSave()}
              onKeyDown={(event) => {
                if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') props.edit?.onCancel()
                event.currentTarget.blur()
              }} />
          </span>
          <span class="filename-inline-suffix">{splitName(props.name).suffix}</span>
        </label>
        <Show when={props.edit?.error}>{(issue) => <span class="filename-error" role="alert">{issue()}</span>}</Show>
      </Show>
    </div>
  )
}
