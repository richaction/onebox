import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type AiAccount = { email: string; plan: string }
export type AiModel = {
  model: string
  displayName?: string
  isDefault?: boolean
  defaultReasoningEffort?: string | null
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[] | null
}
type UsageWindow = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
export type AiUsage = { limitId?: string | null; primary?: UsageWindow | null; secondary?: UsageWindow | null }
type AssistantItem = { type: string; id: string; text: string; phase?: string }
export type AiEvent =
  | { method: 'account/updated' | 'disconnected' }
  | { method: 'account/login/completed'; params: { loginId: string | null; success: boolean; error?: string } }
  | { method: 'account/rateLimits/updated'; params: { rateLimits: AiUsage } }
  | { method: 'turn/started' | 'turn/completed'; params: { threadId: string; turn: { id: string; status: string; error?: { message: string } } } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: AssistantItem } }

export const ai = {
  account: () => invoke<AiAccount | null>('ai_account'),
  models: () => invoke<AiModel[]>('ai_models'),
  async usage() {
    const usage = await invoke<{ rateLimits: AiUsage; rateLimitsByLimitId?: { codex?: AiUsage } }>('ai_usage')
    return usage.rateLimitsByLimitId?.codex ?? usage.rateLimits
  },
  login: () => invoke<string>('ai_login'),
  cancelLogin: (loginId: string) => invoke('ai_cancel_login', { loginId }),
  logout: () => invoke('ai_logout'),
  newThread: () => invoke<string>('ai_new_thread'),
  closeThread: (threadId: string) => invoke('ai_close_thread', { threadId }),
  start: (threadId: string, text: string, model: string, effort?: string | null) => invoke<string>('ai_start_turn', { threadId, text, model, effort }),
  stop: (threadId: string, turnId: string) => invoke('ai_stop_turn', { threadId, turnId }),
  events: (callback: (event: AiEvent) => void) => listen<AiEvent>('onebox-ai', ({ payload }) => callback(payload)),
}
