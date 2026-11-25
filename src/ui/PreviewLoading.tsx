import { createEffect, createSignal, Show, type Accessor } from 'solid-js'

const LOADING_HINT_DELAY_MS = 300

export function createLoadingHint(pending: Accessor<boolean>) {
  const [visible, setVisible] = createSignal(false)
  createEffect(pending, (loading) => {
    if (!loading) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), LOADING_HINT_DELAY_MS)
    return () => clearTimeout(timer)
  })
  return visible
}

export default function PreviewLoading(props: { label: string }) {
  const visible = createLoadingHint(() => true)

  return <Show when={visible()}>
    <div class="preview-status preview-status-loading" role="status">
      <span class="preview-spinner" aria-hidden="true" />
      <p>{props.label}</p>
    </div>
  </Show>
}
