import { describe, expect, it } from 'vitest'
import { quotaWindows } from '../src/core/aiQuota'

describe('Codex quota display', () => {
  it('keeps daily and weekly allowances separate and summarizes the more limited window', () => {
    const quota = quotaWindows({
      primary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1700604800 },
      secondary: { usedPercent: 92, windowDurationMins: 1440, resetsAt: 1700086400 },
    })
    expect(quota.windows).toEqual([
      { label: '每日额度', remaining: 8, resetsAt: 1700086400 },
      { label: '每周额度', remaining: 78, resetsAt: 1700604800 },
    ])
    expect(quota.limiting).toBe(quota.windows[0])
  })

  it('does not infer daily quota from a shorter window or missing usage', () => {
    expect(quotaWindows({ primary: { usedPercent: 6, windowDurationMins: 10080 }, secondary: null }).windows)
      .toEqual([{ label: '每周额度', remaining: 94, resetsAt: undefined }])
    expect(quotaWindows({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1700018000 } }).limiting)
      .toEqual({ label: '5 小时额度', remaining: 0, resetsAt: 1700018000 })
    expect(quotaWindows()).toEqual({ windows: [], limiting: undefined })
  })
})
