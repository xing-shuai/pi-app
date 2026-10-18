import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('Main tray lifecycle contract', () => {
  it('destroys the tray only after the quit guard allows shutdown', () => {
    const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("let isQuittingGracefully"))
    assert.match(readyBlock, /ensureAppTray\(\)/)

    const beforeQuit = source.match(/app\.on\(['"]before-quit['"],\s*\(event\)\s*=>\s*\{([\s\S]*?)\n\}\)/)?.[1]
    assert.ok(beforeQuit, 'before-quit handler must exist')
    const guardPosition = beforeQuit.indexOf('if (!guardAppQuit(event)) return')
    const destroyPosition = beforeQuit.indexOf('destroyAppTray()')
    const preventPosition = beforeQuit.indexOf('event.preventDefault()')
    assert.ok(guardPosition >= 0, 'before-quit must preserve the close-decision guard')
    assert.ok(destroyPosition >= 0, 'before-quit must destroy the tray')
    assert.ok(preventPosition >= 0, 'before-quit must wait for graceful shutdown')
    assert.ok(
      guardPosition < destroyPosition,
      'cancelled or pending quit decisions must leave the tray available',
    )
    assert.ok(
      destroyPosition < preventPosition,
      'tray cleanup must run even when window-all-closed already started graceful shutdown',
    )
  })

  it('waits for the same worker flush when quit arrives after the last window closes', async () => {
    const handlers = new Map()
    const exits = []
    let stopCalls = 0
    let finishStop
    let finishRoutine
    let finishChat
    let finishRemote
    const stopping = new Promise((resolve) => { finishStop = resolve })
    const routineStopping = new Promise((resolve) => { finishRoutine = () => resolve({ settled: true }) })
    const chatStopping = new Promise((resolve) => { finishChat = () => resolve({ settled: true }) })
    const remoteStopping = new Promise((resolve) => { finishRemote = resolve })
    const app = {
      on: (event, handler) => handlers.set(event, handler),
      quit: () => handlers.get('before-quit')({ preventDefault() {} }),
      exit: (code) => exits.push(code),
    }
    const lifecycle = source.slice(source.indexOf('let isQuittingGracefully'))
    const compiled = ts.transpileModule(lifecycle, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText
    runInNewContext(compiled, {
      app,
      process: { platform: 'win32' },
      console,
      guardAppQuit: () => true,
      destroyAppTray() {},
      shutdownSshWorkspace() {},
      workerManager: { stop: () => { stopCalls += 1; return stopping } },
      routineRuntime: { shutdown: () => routineStopping },
      chatRuntime: { shutdown: () => chatStopping },
      remoteCodeRuntime: { shutdown: () => remoteStopping },
      remoteTerminalCount: () => 0,
      sessionPreviewProcess: { stop() {} },
      disposeCompletionNotifications() {},
      shutdownTerminals() {},
      setRunningTerminalsProbe() {},
      runningTerminalCount: () => 0,
    })

    handlers.get('window-all-closed')()
    let prevented = false
    handlers.get('before-quit')({ preventDefault() { prevented = true } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(prevented, true, 'repeated quit must not bypass an unfinished flush')
    assert.equal(stopCalls, 1)
    assert.deepEqual(exits, [])

    finishStop()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(exits, [], 'worker flush must not bypass unfinished product runtimes')
    finishRoutine()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(exits, [], 'routine flush must not bypass unfinished Chat cleanup')
    finishChat()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(exits, [], 'Chat cleanup must not bypass unfinished SSH Code cleanup')
    finishRemote()
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(exits.length > 0, 'app exits after all shared shutdowns complete')
    assert.ok(exits.every((code) => code === 0))
  })
})
