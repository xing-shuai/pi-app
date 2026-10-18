import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('product preload sandbox boundary (run after build)', () => {
  it('does not require validators, SDKs or Node filesystem modules in the sandbox', () => {
    const source = readFileSync(new URL('../../out/preload/index.cjs', import.meta.url), 'utf8')
    const dependencies = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
    assert.deepEqual([...new Set(dependencies)], ['electron'])
    for (const channel of ['ipc:chat-event', 'ipc:routine-event', 'ipc:ssh-event']) assert.ok(source.includes(channel), `missing ${channel}`)
  })
})
