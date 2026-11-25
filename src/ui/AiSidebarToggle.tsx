export default function AiSidebarToggle(props: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  ref?: (button: HTMLButtonElement) => void
}) {
  return <div class="file-preview-actions ai-toggle-slot">
    <button type="button" class="ai-toggle" ref={props.ref} data-activate-on-release aria-expanded={props.open}
      aria-label="AI 侧栏" title={props.open ? '收起 AI 侧栏' : '打开 AI 侧栏'} aria-controls="onebox-ai-sidebar"
      onClick={() => (props.open ? props.onClose : props.onOpen)()}
      onKeyDown={(event) => {
        if (!props.open || event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
        event.preventDefault()
        props.onClose()
      }}>
      <span class="ai-toggle-spark" aria-hidden="true">✨</span>AI
    </button>
  </div>
}
