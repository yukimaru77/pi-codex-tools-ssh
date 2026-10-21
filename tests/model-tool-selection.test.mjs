import assert from 'node:assert/strict'
import test from 'node:test'
import { CODEX_TOOL_NAMES, LEGACY_SHELL_TOOL_NAMES, STANDARD_TOOL_NAMES, isGptModel, selectModelTools, registerModelToolSelection } from '../src/model-tool-selection.ts'

const available = ['read', ...STANDARD_TOOL_NAMES, ...CODEX_TOOL_NAMES, ...LEGACY_SHELL_TOOL_NAMES, 'codemode', 'web_run', 'codex_generate_image', 'ssh_connect', 'monitor_start', 'get_goal'].map(name => ({ name, exposure: 'direct' }))
const base = ['read', ...STANDARD_TOOL_NAMES, ...CODEX_TOOL_NAMES, 'web_run', 'codex_generate_image', 'ssh_connect', 'codemode', 'monitor_start', 'get_goal']

for (const model of [
  { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }, { id: 'openai/gpt-5.4' },
  { name: 'OpenAI: GPT 6.1' }, { name: 'GPT6' }, { id: 'GPT-OSS-120B' },
  { id: 'custom-model', name: 'GPT-6 custom endpoint' },
]) test(`recognizes GPT by id/name: ${JSON.stringify(model)}`, () => assert.equal(isGptModel(model), true))

for (const model of [
  undefined, {}, { id: 'deepseek-v4.1-flash-1017' }, { id: 'claude-sonnet-4-6' },
  { id: 'o3', name: 'o3' }, { id: 'codex-mini-latest' }, { name: 'mygptproxy' },
]) test(`non-GPT uses standard: ${JSON.stringify(model)}`, () => assert.equal(isGptModel(model), false))

test('exclusive loadouts, shared read and unrelated extensions preserved', () => {
  const codex = selectModelTools({ id: 'gpt-6.1-sol' }, base, available)
  assert.equal(codex.mode, 'codex')
  for (const name of CODEX_TOOL_NAMES) assert.ok(codex.tools.includes(name))
  for (const name of STANDARD_TOOL_NAMES) assert.ok(!codex.tools.includes(name))
  const standard = selectModelTools({ id: 'deepseek-v4.1' }, codex.tools, available)
  assert.equal(standard.mode, 'standard')
  for (const name of STANDARD_TOOL_NAMES) assert.ok(standard.tools.includes(name))
  for (const name of CODEX_TOOL_NAMES) assert.ok(!standard.tools.includes(name))
  for (const name of base.filter(n => ![...STANDARD_TOOL_NAMES, ...CODEX_TOOL_NAMES].includes(n))) {
    assert.ok(codex.tools.includes(name)); assert.ok(standard.tools.includes(name))
  }
  assert.deepEqual(selectModelTools({ id: 'gpt-6.1-sol' }, standard.tools, available).tools, codex.tools)
})

test('legacy shell aliases stay registered but inactive in both modes', () => {
  const withLegacy = [...base, ...LEGACY_SHELL_TOOL_NAMES]
  for (const model of [{ id: 'gpt-6.1-sol' }, { id: 'deepseek-v4.1' }]) {
    const { tools } = selectModelTools(model, withLegacy, available)
    for (const name of LEGACY_SHELL_TOOL_NAMES) assert.ok(!tools.includes(name))
  }
})

test('partial/hidden Codex registration falls back to registered standard tools', () => {
  for (const tools of [available.filter(t => t.name !== 'exec_command'), available.map(t => t.name === 'apply_patch' ? { ...t, exposure: 'hidden' } : t)]) {
    const result = selectModelTools({ id: 'gpt-6' }, base, tools)
    assert.equal(result.mode, 'standard'); assert.equal(result.missing.length, 1)
    for (const name of STANDARD_TOOL_NAMES) assert.ok(result.tools.includes(name))
    for (const name of CODEX_TOOL_NAMES) assert.ok(!result.tools.includes(name))
  }
})

test('does not reactivate unrelated disabled tools or insert unregistered tools', () => {
  const tools = selectModelTools({ id: 'claude' }, ['read'], available.filter(t => t.name !== 'write')).tools
  assert.deepEqual(tools, ['read', 'bash', 'edit'])
})

test('session start, stale-context model selection and pre-turn reconciliation are idempotent', () => {
  const handlers = new Map()
  let active = [...base], writes = 0
  const status = []
  const pi = {
    on(name, fn) { handlers.set(name, fn) },
    getActiveTools() { return [...active] }, getAllTools() { return available },
    setActiveTools(names) { active = names; writes++ },
  }
  registerModelToolSelection(pi)
  const ctx = { model: { id: 'gpt-6' }, hasUI: true, ui: { setStatus: (...args) => status.push(args) } }
  handlers.get('session_start')({}, ctx)
  assert.ok(active.includes('apply_patch')); assert.ok(!active.includes('bash'))
  const before = writes
  handlers.get('before_agent_start')({}, ctx)
  assert.equal(writes, before)
  // Model selection must use the event's new model, not ctx's stale one.
  handlers.get('model_select')({ model: { id: 'deepseek' } }, ctx)
  assert.ok(active.includes('bash')); assert.ok(!active.includes('apply_patch'))
  active.push('apply_patch')
  handlers.get('before_agent_start')({}, { ...ctx, model: { id: 'deepseek' }, hasUI: false })
  assert.ok(!active.includes('apply_patch'))
  assert.match(status.at(-1)[1], /standard/)
  // No process termination, credentials, provider or settings writes are exposed.
})
