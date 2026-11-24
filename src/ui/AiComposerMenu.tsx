import { createUniqueId, Show, type JSX } from 'solid-js'

export type ComposerMenu = 'quote' | 'usage' | 'model'

export default function AiComposerMenu(props: {
  kind: ComposerMenu
  label: string
  open: boolean
  onToggle: () => void
  onDismiss: () => void
  trigger: JSX.Element
  children: JSX.Element
}) {
  const popupId = createUniqueId()

  return (
    <div class={`ai-composer-menu ai-${props.kind}-menu`} data-ai-composer-menu={props.kind}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || !props.open) return
        const menu = event.currentTarget
        requestAnimationFrame(() => {
          if (menu.isConnected && !menu.contains(document.activeElement)) props.onDismiss()
        })
      }}>
      <button class={`ai-composer-trigger ai-${props.kind}-trigger`} type="button"
        aria-label={props.label} title={props.kind === 'quote' ? props.label : undefined}
        aria-expanded={props.open} aria-controls={popupId}
        onClick={props.onToggle}>
        {props.trigger}
      </button>
      <Show when={props.open}>
        <div id={popupId} class={`ai-composer-popup ai-${props.kind}-popup`}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}
