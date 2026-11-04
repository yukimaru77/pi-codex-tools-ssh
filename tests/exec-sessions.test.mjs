import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import codexTools from '../src/index.ts'

function host() {
  const tools = new Map(), commands = new Map(), listeners = new Map(), events = new Map(), sent = [], status = {}, notices = []
  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    events: {
      on: (name, fn) => { events.set(name, [...(events.get(name) ?? []), fn]); return () => {} },
      emit: (name, value) => { for (const fn of events.get(name) ?? []) fn(value) },
    },
    sendMessage: (message, options) => sent.push({ message, options }),
    getActiveTools: () => [], setActiveTools: () => {}, getAllTools: () => [],
  }
  codexTools(pi)
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { setStatus: (k, v) => { status[k] = v }, notify: (t, l) => notices.push({ t, l }) }, model: { id: 'gpt-6' } }
  const call = (name, params) => tools.get(name).execute('id', params, undefined, undefined, ctx)
  const shutdown = () => Promise.all((listeners.get('session_shutdown') ?? []).map(fn => fn({}, ctx)))
  return { tools, commands, sent, status, notices, ctx, call, shutdown, events: pi.events }
}
const text = result => result.content.map(part => part.text).join('\n')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('a still-running exec_command gets guidance, a session log, the footer, exec_list and exec_stop', async t => {
  const h = host()
  t.after(h.shutdown)
  assert.ok(!h.tools.has('monitor_start'))
  assert.ok(h.tools.has('exec_list') && h.tools.has('exec_stop') && h.commands.has('execs'))
  const started = await h.call('exec_command', { cmd: 'echo first; sleep 30', yield_time_ms: 300, login: false })
  const out = text(started)
  const id = started.details.session_id
  assert.equal(typeof id, 'number')
  assert.match(out, /Process running with session ID/)
  assert.match(out, /woken with its new output every 10 minutes and once when it exits/)
  assert.match(out, /end your turn now with a short status reply/)
  const log = out.match(/Full output so far is in (\S+)/)[1]
  assert.match(readFileSync(log, 'utf8'), /first/)
  assert.equal(h.status['codex-exec'], 'exec: 1 running')
  const query = {}
  h.events.emit('pi-monitor:query', query)
  assert.equal(query.active, 1, 'GOAL_WAIT counts the background session')

  assert.match(text(await h.call('exec_list', {})), new RegExp(`session ${id} \\[running\\] local, started \\d+s ago, last output \\d+s ago, notify interval[\\s\\S]*cmd: echo first; sleep 30[\\s\\S]*log: ${log}`))
  const stopped = text(await h.call('exec_stop', { session_id: id }))
  assert.match(stopped, new RegExp(`Stopped session ${id}`))
  assert.match(stopped, /terminated by a signal \(stopped\)/)
  assert.equal(h.status['codex-exec'], undefined)
  assert.match(text(await h.call('exec_list', {})), /No background exec_command sessions are running/)
  assert.match(text(await h.call('exec_list', { status: 'all' })), new RegExp(`session ${id} \\[stopped\\]`))
  await delay(400)
  assert.equal(h.sent.length, 0, 'a stopped session sends no final notice')
  await assert.rejects(h.call('exec_stop', { session_id: 999 }), /unknown background session/)
})

test('notify "exit" reports only on exit, with the session log line range', async t => {
  const h = host()
  t.after(h.shutdown)
  const started = await h.call('exec_command', { cmd: 'echo a; echo b; sleep 0.6; echo c', yield_time_ms: 200, login: false, notify: 'exit' })
  assert.match(text(started), /woken with its new output once, when it exits/)
  await delay(1500)
  assert.equal(h.sent.length, 1)
  const notice = h.sent[0].message.content
  assert.match(notice, /The process has exited/)
  assert.match(notice, /lines 1-3 of the session log/)
  assert.match(notice, /\| c\n\| Process exited with code 0/)
})
