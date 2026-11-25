import type { AiModel } from '../io/ai'

export const reasoningTiers = [
  { label: '低', values: ['low', 'minimal'] },
  { label: '中', values: ['medium'] },
  { label: '高', values: ['high', 'xhigh', 'max', 'ultra'] },
] as const

type ReasoningTier = (typeof reasoningTiers)[number]

function reasoningTier(value?: string | null) {
  return reasoningTiers.find((tier) => tier.values.some((effort) => effort === value))
}

export function reasoningLabel(value?: string | null) {
  return reasoningTier(value)?.label
}

export function supportedReasoningEffort(model: AiModel | undefined, tier: ReasoningTier) {
  for (const effort of tier.values) {
    const option = model?.supportedReasoningEfforts?.find(({ reasoningEffort }) => reasoningEffort === effort)
    if (option) return option
  }
}

export function resolveSavedReasoningEffort(model: AiModel | undefined, value?: string | null) {
  const tier = reasoningTier(value)
  return tier ? supportedReasoningEffort(model, tier)?.reasoningEffort : undefined
}
