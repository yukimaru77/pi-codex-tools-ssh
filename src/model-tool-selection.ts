import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

export const CODEX_TOOL_NAMES = ['exec_command', 'write_stdin', 'exec_list', 'exec_stop', 'apply_patch', 'view_image'] as const
/** Registered for compatibility but never activated: exec_command covers them. */
export const LEGACY_SHELL_TOOL_NAMES = ['shell', 'local_shell', 'shell_command'] as const
export const STANDARD_TOOL_NAMES = ['bash', 'edit', 'write'] as const
const REQUIRED_CODEX_TOOLS = ['exec_command', 'write_stdin', 'apply_patch'] as const
const MANAGED_TOOLS = new Set<string>([...CODEX_TOOL_NAMES, ...LEGACY_SHELL_TOOL_NAMES, ...STANDARD_TOOL_NAMES])
export const TOOL_STATUS_KEY = 'codex-tools'

type ModelIdentity = { id?: string; name?: string } | undefined

/** Match the GPT family, not the provider: OpenRouter GPT works; OpenAI o3 does not.
 * Accept GPT-6, GPT 6, GPT6 and namespaced ids. Avoid accidental matches in mygpt.
 */
export function isGptModel(model: ModelIdentity): boolean {
  const gpt = /(?:^|[^a-z0-9])gpt(?=$|[^a-z])/i
  return [model?.id, model?.name].some(value => typeof value === 'string' && gpt.test(value))
}

export function selectModelTools(
  model: ModelIdentity,
  active: readonly string[],
  available: readonly { name: string; exposure?: string }[],
): { tools: string[]; mode: 'codex' | 'standard'; missing: string[] } {
  const registered = new Set(available.filter(tool => tool.exposure !== 'hidden').map(tool => tool.name))
  const wantsCodex = isGptModel(model)
  const missing = wantsCodex ? REQUIRED_CODEX_TOOLS.filter(name => !registered.has(name)) : []
  // Never leave the model without usable workspace tools after a partial load.
  const mode = wantsCodex && missing.length === 0 ? 'codex' : 'standard'
  const enabled = mode === 'codex' ? CODEX_TOOL_NAMES : STANDARD_TOOL_NAMES
  const tools = new Set(active.filter(name => !MANAGED_TOOLS.has(name)))
  if (registered.has('read')) tools.add('read')
  for (const name of enabled) if (registered.has(name)) tools.add(name)
  return { tools: [...tools], mode, missing }
}

/** Runtime selection only: no model/default settings, credentials, sessions or SSH
 * backends are changed. Disabled direct tools are also unavailable to codemode.
 * Existing exec processes remain alive across model changes until normal shutdown.
 */
export function registerModelToolSelection(pi: ExtensionAPI): void {
  function apply(model: ModelIdentity, ctx: ExtensionContext) {
    const active = pi.getActiveTools()
    const selected = selectModelTools(model, active, pi.getAllTools())
    if (active.length !== selected.tools.length || active.some((name, i) => name !== selected.tools[i])) {
      pi.setActiveTools(selected.tools)
    }
    if (ctx.hasUI) {
      const fallback = selected.missing.length ? ' (Codex tools unavailable)' : ''
      ctx.ui.setStatus(TOOL_STATUS_KEY, `tools: ${selected.mode === 'codex' ? 'Codex (GPT)' : 'standard'}${fallback}`)
    }
  }

  pi.on('session_start', (_event, ctx) => { apply(ctx.model, ctx) })
  // event.model is authoritative even if the old model is still in ctx.
  pi.on('model_select', (event, ctx) => { apply(event.model, ctx) })
  // Reconcile after reloads or another extension changes the active set.
  pi.on('before_agent_start', (_event, ctx) => { apply(ctx.model, ctx) })
}
