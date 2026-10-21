import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_TOOL_NAMES, STANDARD_TOOL_NAMES } from '../src/model-tool-selection.ts'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createCodemodeExtension } from '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js'

const root = new URL('../', import.meta.url).pathname
const scratch = await mkdtemp(join(tmpdir(), 'pi-model-tools-smoke-'))
const agentDir = join(scratch, 'agent')
const originalFetch = globalThis.fetch
const originalAgentDir = process.env.PI_CODING_AGENT_DIR
let session
try {
  await mkdir(agentDir)
  process.env.PI_CODING_AGENT_DIR = agentDir
  globalThis.fetch = async () => { throw new Error('Network forbidden in tool-routing smoke') }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(agentDir, 'models-store.json'),
    refreshOnCreate: false, allowModelNetwork: false,
  })
  const provider = 'tool-routing-fixture'
  modelRuntime.registerProvider(provider, {
    api: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-not-a-real-key',
    models: [
      ['gpt-6-test', 'GPT 6 Test'], ['deepseek-test', 'DeepSeek Test'],
      ['custom-id', 'OpenAI: GPT-6 Test'], ['o3-test', 'o3 Test'],
      ['openai/gpt-6-test', 'Namespaced model'],
    ].map(([id, name]) => ({ id, name, input: ['text'], reasoning: false,
      contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  })
  const model = id => {
    const value = modelRuntime.getModel(provider, id)
    assert.ok(value, `Fixture model exists: ${id}`)
    return value
  }
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ['+codemode'], compaction: { enabled: false }, retry: { enabled: false },
  })
  let protocolVersion
  const extensionFactories = [createCodemodeExtension(), pi => {
    pi.registerTool({
      name: 'fixture_probe', label: 'Fixture Probe', description: 'List callable tool names without invoking them',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const names = ctx.tools.map(tool => tool.name)
        return { content: [{ type: 'text', text: JSON.stringify({ names }) }], details: { names } }
      },
    })
    pi.on('session_start', () => {
      const capabilities = {}; pi.events.emit('codex-tools:capabilities', capabilities)
      protocolVersion = capabilities.protocolVersion
    })
  }]
  const resourceLoader = new DefaultResourceLoader({
    cwd: scratch, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [join(root, 'src/index.ts'),
      ...(process.env.PI_TEST_WITH_SSH === '1' ? ['/Users/nonaka/tasks/pi-ssh-remote-patched/index.min.js'] : [])], extensionFactories,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [],
  })
  await resourceLoader.reload()
  assert.deepEqual(resourceLoader.getExtensions().errors, [], 'Real Pi extension loader accepts the patched package')
  ;({ session } = await createAgentSession({
    cwd: scratch, agentDir, modelRuntime, model: model('gpt-6-test'), thinkingLevel: 'off',
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(scratch),
  }))
  const errors = []
  await session.bindExtensions({ onError: error => errors.push(error) })
  assert.equal(protocolVersion, 1, 'SSH routing capability hook remains installed')
  const execute = (name, args) => {
    const tool = session.agent.state.tools.find(t => t.name === name)
    assert.ok(tool, `Tool is declared: ${name}`)
    return tool.execute(`fixture-${name}`, args, new AbortController().signal)
  }
  async function expectMode(mode) {
    const active = session.getActiveToolNames()
    const enabled = mode === 'codex' ? CODEX_TOOL_NAMES : STANDARD_TOOL_NAMES
    const disabled = mode === 'codex' ? STANDARD_TOOL_NAMES : CODEX_TOOL_NAMES
    for (const name of ['read', 'codemode', 'fixture_probe', ...enabled]) assert.ok(active.includes(name), `${name} active in ${mode}`)
    for (const name of disabled) assert.ok(!active.includes(name), `${name} inactive in ${mode}`)
    const { details } = await execute('fixture_probe', {})
    for (const name of enabled) assert.ok(details.names.includes(name), `${name} callable in ${mode}`)
    for (const name of disabled) assert.ok(!details.names.includes(name), `${name} NOT callable from other tools in ${mode}`)
  }
  await expectMode('codex')
  await execute('apply_patch', { input: '*** Begin Patch\n*** Add File: fixture.txt\n+first\n*** End Patch' })
  assert.equal(await readFile(join(scratch, 'fixture.txt'), 'utf8'), 'first')
  const command = await execute('exec_command', { cmd: "printf 'ROUTER_EXEC_OK'", workdir: scratch, yield_time_ms: 1000 })
  assert.match(JSON.stringify(command.content), /ROUTER_EXEC_OK/)

  await session.setModel(model('deepseek-test'))
  await expectMode('standard')
  await execute('write', { path: 'standard.txt', content: 'before\n' })
  await execute('edit', { path: 'standard.txt', edits: [{ oldText: 'before', newText: 'after' }] })
  assert.equal(await readFile(join(scratch, 'standard.txt'), 'utf8'), 'after\n')
  const bash = await execute('bash', { command: "printf 'ROUTER_BASH_OK'", timeout: 2 })
  assert.match(JSON.stringify(bash.content), /ROUTER_BASH_OK/)

  await session.setModel(model('custom-id')); await expectMode('codex')
  await session.setModel(model('o3-test')); await expectMode('standard')
  // Reload must recompute from the current non-GPT model, not the startup default.
  await session.reload(); await expectMode('standard')
  await session.setModel(model('openai/gpt-6-test')); await expectMode('codex')
  await session.reload(); await expectMode('codex')
  assert.deepEqual(errors, [])
  console.log('PI_MODEL_TOOL_ROUTING_SMOKE_OK: real loader, GPT↔non-GPT, display names, namespaced ids, reloads, callable isolation, local execution and SSH protocol hook')
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' })
    session.dispose()
  }
  globalThis.fetch = originalFetch
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  await rm(scratch, { recursive: true, force: true })
}
