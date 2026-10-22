import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecWatch, OutputBatch, formatNotice, logFileReader } from '../src/exec-watch.ts'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function fakeSession() {
  let finish
  const s = { output: '', readOffset: 0, done: false, exitCode: undefined, consumed: false }
  s.completion = new Promise(resolve => { finish = resolve })
  s.finish = code => { s.done = true; s.exitCode = code; finish() }
  let offset = 0
  s.observer = {
    read() { const start = Math.max(offset, s.readOffset); offset = s.output.length; return s.output.slice(start) },
    completion: s.completion,
    state: () => ({ done: s.done, exitCode: s.exitCode }),
    consumedByAgent: () => s.consumed,
  }
  return s
}

test('interval reports carry the session id and only unseen output; empty intervals are silent', async () => {
  const s = fakeSession(), notices = []
  const watch = new ExecWatch({ sessionId: 7, command: 'build', observer: s.observer, notify: n => notices.push(n), intervalMs: 40, settleMs: 5 })
  s.output += 'one\ntwo\n'
  s.readOffset = 4 // the agent already read "one\n" with write_stdin
  await delay(60)
  assert.equal(notices.length, 1)
  assert.deepEqual(notices[0], { sessionId: 7, command: 'build', lines: ['two'], final: false })
  await delay(60)
  assert.equal(notices.length, 1, 'no new output, no report')
  s.output += 'three\n'
  s.finish(2)
  await delay(30)
  assert.deepEqual(notices[1], { sessionId: 7, command: 'build', lines: ['three', 'Process exited with code 2'], final: true })
  assert.ok(watch.stopped)
  const text = formatNotice(notices[1])
  assert.match(text, /Session: 7 \(build\)/)
  assert.match(text, /\| Process exited with code 2/)
  assert.match(formatNotice(notices[0]), /write_stdin\(session_id=7\)/)
})

test('no final notice when the agent already received the exit', async () => {
  const s = fakeSession(), notices = []
  new ExecWatch({ sessionId: 1, command: 'x', observer: s.observer, notify: n => notices.push(n), intervalMs: 10_000, settleMs: 5 })
  s.consumed = true
  s.finish(0)
  await delay(30)
  assert.deepEqual(notices, [])
})

test('long batches keep the first 3 and last 20 lines', () => {
  const batch = new OutputBatch()
  for (let i = 1; i <= 30; i++) batch.add(`l${i}`)
  const out = batch.drain()
  assert.deepEqual(out.slice(0, 4), ['l1', 'l2', 'l3', '… [7 lines omitted]'])
  assert.equal(out.length, 24)
})

test('SSH log reader returns only bytes appended since the last read, across split UTF-8', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'exec-watch-')), 'output.log')
  writeFileSync(file, 'a\n')
  const read = logFileReader(file)
  assert.equal(read(), 'a\n')
  assert.equal(read(), '')
  const bytes = Buffer.from('é\n')
  appendFileSync(file, bytes.subarray(0, 1))
  assert.equal(read(), '')
  appendFileSync(file, bytes.subarray(1))
  assert.equal(read(), 'é\n')
})
