import type { AiUsage } from '../io/ai'

function windowName(minutes?: number | null) {
  if (minutes === 1440) return '每日额度'
  if (minutes === 10080) return '每周额度'
  if (!minutes || minutes < 0) return '使用额度'
  if (minutes % 1440 === 0) return `${minutes / 1440} 天额度`
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`
  return `${minutes} 分钟额度`
}

export function quotaWindows(usage?: AiUsage) {
  const windows = [usage?.primary, usage?.secondary]
    .filter((window) => window != null)
    .filter((window) => Number.isFinite(window.usedPercent))
    .sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))
    .map((window) => ({
      label: windowName(window.windowDurationMins),
      remaining: Math.round(100 - Math.max(0, Math.min(100, window.usedPercent))),
      resetsAt: window.resetsAt,
    }))
  return {
    windows,
    limiting: windows.reduce<typeof windows[number] | undefined>(
      (lower, window) => !lower || window.remaining < lower.remaining ? window : lower,
      undefined,
    ),
  }
}
