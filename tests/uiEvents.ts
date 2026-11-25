import { flush } from 'solid-js'

// Synthetic test input runs in a single task. Commit Solid's staged DOM changes
// before inspecting the result or sending the next user event.
export function afterUiEvent<T>(action: () => T): T {
  const result = action()
  flush()
  return result
}
