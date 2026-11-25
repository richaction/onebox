import { createMemo, For, Show } from 'solid-js'
import type { AiAccount, AiModel, AiUsage } from '../io/ai'
import AiComposerMenu, { type ComposerMenu } from './AiComposerMenu'
import { quotaWindows } from '../core/aiQuota'
import { reasoningLabel, reasoningTiers, supportedReasoningEffort } from '../core/aiReasoning'

function planName(plan: string) {
  return plan.replace(/(^|_)([a-z])/gu, (_match, prefix: string, letter: string) => (prefix ? ' ' : '') + letter.toUpperCase())
}

function Battery(props: { level?: number }) {
  return <span class="ai-battery" classList={{ 'ai-battery-low': (props.level ?? 100) <= 15 }} aria-hidden="true">
    <i style={{ width: `${props.level ?? 0}%` }} />
  </span>
}

function modelFamily(model: AiModel) {
  const name = `${model.model} ${model.displayName ?? ''}`.toLowerCase().replace(/_/gu, '-')
  if (/\b(?:gpt|chatgpt|codex|openai|o\d+)\b/u.test(name)) return 'openai'
  if (/\b(?:claude|opus|sonnet|haiku|anthropic)\b/u.test(name)) return 'claude'
  if (/\bgemini\b/u.test(name)) return 'gemini'
  if (/\bgrok\b/u.test(name)) return 'grok'
  if (/\bdeepseek\b/u.test(name)) return 'deepseek'
  return 'other'
}

function ModelLabel(props: { text: string; model?: AiModel }) {
  return <span class="ai-model-label">
    <Show when={props.model} keyed>{(model) => {
      const family = modelFamily(model)
      return <span class={`ai-model-icon ai-model-icon-${family}`} aria-hidden="true" />
    }}</Show>
    <span class="ai-model-name">{props.text}</span>
  </span>
}

export default function AiComposerControls(props: {
  account?: AiAccount | null
  models: readonly AiModel[]
  model?: AiModel
  usage?: AiUsage
  loadingAccount: boolean
  loadingModels: boolean
  loadingUsage: boolean
  signingIn: boolean
  canCancelLogin: boolean
  working: boolean
  effort?: string
  menu?: ComposerMenu | 'conversations'
  accountError: string
  modelError: string
  usageError: string
  onChooseModel: (model: AiModel) => void
  onChooseEffort: (effort: string) => void
  onMenu: (menu: ComposerMenu | undefined) => void
  onSignIn: () => void
  onCancelSignIn: () => void
  onSignOut: () => void
  onRefreshModels: () => void
  onRefreshUsage: () => void
  onRefreshAccount: () => void
}) {
  const quota = createMemo(() => quotaWindows(props.usage))
  const usageLabel = () => {
    const limiting = quota().limiting
    return limiting ? `Codex 用量，${limiting.label}剩余 ${limiting.remaining}%` : 'Codex 用量'
  }
  const effort = () => reasoningLabel(props.effort ?? props.model?.defaultReasoningEffort)
  const toggle = (menu: ComposerMenu) => {
    if (props.menu === menu) props.onMenu(undefined)
    else open(menu)
  }
  const open = (menu: ComposerMenu) => props.onMenu(menu)
  const dismiss = (menu: ComposerMenu) => { if (props.menu === menu) props.onMenu(undefined) }
  const modelLabel = () => props.model?.displayName || props.model?.model
    || (props.loadingAccount ? '连接中…' : props.account ? '选择模型' : '登录')
  const signIn = (label: string) => <Show when={props.signingIn} fallback={
    <button class="ai-popup-option" type="button" disabled={props.loadingAccount || props.working}
      onClick={props.onSignIn}>{label}</button>
  }>
    <p class="ai-popup-hint">请在浏览器完成 ChatGPT 登录</p>
    <button class="ai-popup-option" type="button" disabled={!props.canCancelLogin} onClick={props.onCancelSignIn}>取消登录</button>
  </Show>

  return (
    <div class="ai-composer-settings">
      <AiComposerMenu kind="usage" open={props.menu === 'usage'} label={usageLabel()}
        onToggle={() => toggle('usage')} onDismiss={() => dismiss('usage')}
        trigger={<Battery level={quota().limiting?.remaining} />}>
        <section aria-label="用量详情">
          <strong>Codex 用量</strong>
          <Show when={props.account} fallback={
            <button class="ai-popup-option" type="button" onClick={() => open('model')}>登录后查看用量</button>
          }>
            <For each={quota().windows}>
              {(window) => <div class="ai-quota">
                <div>
                  <span>{window.label}</span>
                  <Show when={window.resetsAt}>
                    {(timestamp) => <small>重置于 {new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp() * 1000)}</small>}
                  </Show>
                </div>
                <span class="ai-quota-level"><Battery level={window.remaining} /> 剩余 {window.remaining}%</span>
              </div>}
            </For>
            <Show when={props.usageError}>
              <p class="ai-popup-error" role="status">{props.usageError}</p>
            </Show>
            <Show when={!quota().windows.length && !props.usageError}>
              <p class="ai-popup-hint">{props.loadingUsage ? '正在读取用量…' : '暂无用量数据'}</p>
            </Show>
            <button class="ai-popup-option" type="button" disabled={props.loadingUsage} onClick={props.onRefreshUsage}>刷新用量</button>
          </Show>
        </section>
      </AiComposerMenu>
      <AiComposerMenu kind="model" open={props.menu === 'model'}
        label={`AI 模型，${modelLabel()}${effort() ? `，思考强度 ${effort()}` : ''}`}
        onToggle={() => toggle('model')} onDismiss={() => dismiss('model')}
        trigger={<><ModelLabel text={modelLabel()} model={props.model} /><i aria-hidden="true" /></>}>
        <section aria-label="模型与登录">
          <Show when={props.account} keyed fallback={signIn('使用 ChatGPT 登录')}>
            {(account) => <>
              <div class="ai-model-account">
                <span title={account.email}>ChatGPT {planName(account.plan)}</span>
                <button class="ai-subtle" type="button" disabled={props.working} onClick={props.onSignOut}>退出登录</button>
              </div>
              <div class="ai-model-options" aria-label="可用模型">
                <For each={props.models}>{(model) =>
                  <button class="ai-popup-option ai-model-option" type="button"
                    aria-pressed={model.model === props.model?.model} disabled={props.working}
                    onClick={() => props.onChooseModel(model)}>
                    <ModelLabel text={model.displayName || model.model} model={model} />
                    <Show when={model.model === props.model?.model}><span aria-hidden="true">✓</span></Show>
                  </button>
                }</For>
              </div>
              <Show when={props.model && reasoningTiers.some((tier) => supportedReasoningEffort(props.model, tier))}>
                <div class="ai-reasoning">
                  <div class="ai-reasoning-label">思考强度</div>
                  <div class="ai-effort-options" role="group" aria-label="思考强度">
                    <For each={reasoningTiers}>{(tier) => {
                      const option = () => supportedReasoningEffort(props.model, tier)
                      return <button class="ai-composer-trigger" type="button" aria-pressed={!!option() && effort() === tier.label}
                        disabled={props.working || !option()} title={option()?.description} onClick={() => {
                          const next = option()
                          if (next) props.onChooseEffort(next.reasoningEffort)
                        }}>{tier.label}</button>
                    }}</For>
                  </div>
                </div>
              </Show>
              <Show when={!props.models.length}>
                <p class="ai-popup-hint">{props.loadingModels ? '正在加载模型…' : props.modelError || '此账号暂无可用模型'}</p>
                <Show when={!props.loadingModels}>
                  <button class="ai-popup-option" type="button" onClick={props.onRefreshModels}>重新加载模型</button>
                  {signIn('重新授权 ChatGPT')}
                </Show>
              </Show>
            </>}
          </Show>
          <Show when={props.accountError}>
            <p class="ai-popup-error" role="status">{props.accountError}</p>
            <button class="ai-popup-option" type="button" disabled={props.loadingAccount} onClick={props.onRefreshAccount}>重新检查登录</button>
          </Show>
        </section>
      </AiComposerMenu>
    </div>
  )
}
