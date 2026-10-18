import { describe, expect, it } from 'vitest'
import { supportsCapability, workspaceIdentity, type ExecutionTarget } from './execution-target'

describe('execution identity and capabilities', () => {
  it('keeps different machines separate without changing native paths', () => {
    expect(workspaceIdentity('ssh:a', '/home/u/project')).not.toBe(workspaceIdentity('ssh:b', '/home/u/project'))
    expect(JSON.parse(workspaceIdentity('ssh:a', 'C:\\Users\\dev\\project'))).toEqual(['ssh:a', 'C:\\Users\\dev\\project'])
  })
  it('never implies unsupported remote capabilities or falls back to local', () => {
    const target: ExecutionTarget = { id: 'ssh:a', kind: 'ssh', name: 'A', available: true, experimental: true, capabilities: ['sessions', 'file-preview'], lifetime: 'ssh-connection' }
    expect(supportsCapability(target, 'file-preview')).toBe(true)
    expect(supportsCapability(target, 'pty')).toBe(false)
    expect(supportsCapability({ ...target, available: false }, 'sessions')).toBe(false)
  })
})
