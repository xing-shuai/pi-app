// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHost } from './host'
const dirs: string[] = []
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'host-input-')); dirs.push(home)
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let stdout = '', stderr = ''
  output.on('data', (data) => { stdout += data }); diagnostics.on('data', (data) => { stderr += data })
  const running = await startHost({ home, pty: false, input, output, diagnostics })
  return { input, output, running, text: () => ({ stdout, stderr }) }
}
it('does not treat a file as a usable remote HOME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-home-file-')); dirs.push(dir)
  const file = join(dir, 'not-a-directory'); await writeFile(file, 'fixture')
  await expect(startHost({ home: file, pty: false, input: new PassThrough(), output: new PassThrough(), diagnostics: new PassThrough() })).rejects.toThrow('home_unavailable')
})
it.each(['input', 'output'] as const)('captures an early %s error during async initialization', async (stream) => {
  const home = await mkdtemp(join(tmpdir(), 'host-early-error-')); dirs.push(home)
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  const pending = startHost({ home, pty: false, input, output, diagnostics })
  ;(stream === 'input' ? input : output).emit('error', new Error('fixture-private-error'))
  const running = await pending
  expect(await running.host.handle({ id: 'closed', type: 'get_state' })).toMatchObject({ success: false, errorCode: 'host_closed' })
  await running.dispose()
})

it('accepts CRLF handshake framing without accepting non-JSON input', async () => {
  const f = await fixture()
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CRLF handshake timeout')), 2000)
    f.output.once('data', (chunk: Buffer) => { clearTimeout(timer); resolve(chunk.toString()) })
  })
  f.input.write('{"id":"hello","type":"get_state"}\r\n')
  expect(JSON.parse(await reply)).toMatchObject({ id: 'hello', success: true })
  await f.running.dispose()
})

it('emits a fixed EOF marker for the clean-before-handshake case', async () => {
  const f = await fixture()
  const ended = new Promise<void>((resolve) => f.input.once('end', resolve))
  f.input.end(); await ended; await f.running.dispose()
  expect(f.text()).toEqual({ stdout: '', stderr: '__PI_DESKTOP_REMOTE_HOST_STDIN_CLOSED_V1__\n' })
})
it('identifies invalid framing without reflecting the offending bytes', async () => {
  const f = await fixture()
  f.input.write('private-fixture-value\r\n')
  await f.running.dispose()
  expect(f.text()).toEqual({ stdout: '', stderr: '__PI_DESKTOP_REMOTE_HOST_INPUT_INVALID_V1__\n' })
})
