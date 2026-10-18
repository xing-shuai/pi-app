// @vitest-environment node
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl, type RecordValue } from './common'

it('handles a signal during async startup with a fixed reason and bounded cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-ssh-signal-'))
  const built = await build({ entryPoints: ['src/ssh-host/entry.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
  const url = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});process.kill(process.pid,'SIGTERM')`], { env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (data) => { stdout += data }); child.stderr.on('data', (data) => { stderr += data })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 7000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(stderr.trim()).toBe('__PI_DESKTOP_REMOTE_HOST_SIGNALLED_V1__')
  } finally { clearTimeout(deadline); child.kill('SIGKILL'); await rm(home, { recursive: true, force: true }) }
})

it('bundles into one Node-only file and auto-starts when imported as a data URL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-ssh-bundle-'))
  const result = await build({ entryPoints: ['src/ssh-host/entry.ts'], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true })
  expect(result.outputFiles).toHaveLength(1)
  expect(Object.keys(result.metafile!.inputs).every((path) => path.startsWith('src/ssh-host/'))).toBe(true)
  expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports).every((entry) => entry.external && entry.path.startsWith('node:'))).toBe(true)
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(url)})`], {
    env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/bash' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const records: RecordValue[] = []
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bundle handshake timeout')), 5000)
      readJsonl(child.stdout, (record) => { records.push(record); clearTimeout(timer); resolve() }, () => { clearTimeout(timer); reject(new Error('non-protocol stdout')) })
      child.stdin.write('{"id":"hello","type":"get_state"}\n')
    })
    expect(records).toMatchObject([{ id: 'hello', command: 'get_state', success: true, data: { host: { home, workspaces: [] }, isStreaming: false } }])
    child.stdin.end()
    expect(await closed).toBe(0)
    expect(stderr.trim()).toBe('__PI_DESKTOP_REMOTE_HOST_STDIN_CLOSED_V1__')
  } finally { child.kill('SIGKILL'); await rm(home, { recursive: true, force: true }) }
})
