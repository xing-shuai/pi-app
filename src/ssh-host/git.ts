import { realpath } from 'node:fs/promises'
import { Files, under, relativeInput } from './files'
import { fail, text, type RecordValue, Processes } from './common'

export class Git {
  constructor(readonly files: Files, readonly processes: Processes) {}
  private async exec(root: string, args: string[], input?: string) {
    const env = Object.fromEntries(Object.entries(this.processes.env).filter(([key]) => !key.startsWith('GIT_')))
    return this.processes.run('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], root, input, 30000, { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })
  }
  async operation(op: string, args: RecordValue): Promise<unknown> {
    const ws = this.files.workspace(args)
    const root = ws.root
    const execute = async () => {
      await under(root)
      const repo = await this.exec(root, ['rev-parse', '--show-toplevel'])
      const isRepo = repo.code === 0 && await realpath(repo.out.trim()).catch(() => '') === root
      const emptyBranch: { isRepo: boolean; branch: string | null; head: string; upstream: string | null; ahead: number; behind: number; dirty: number } = { isRepo: false, branch: null, head: '', upstream: null, ahead: 0, behind: 0, dirty: 0 }
      if (!isRepo) {
        if (op === 'git.status') return { snapshot: { isRepo: false, branch: '', raw: '', stagedRaw: '', status: '', log: '' }, branchStatus: emptyBranch }
        if (op === 'git.branches') return { branches: [] }
        if (op === 'git.worktrees') return { ok: true, repositoryPath: null, trees: [] }
        fail('not_a_repository')
      }
      const run = (argv: string[], input?: string) => this.exec(root, argv, input)
      const output = async (argv: string[], optional = false): Promise<string> => { const result = await run(argv); if (result.code && !optional) fail('git_failed'); return result.code ? '' : result.out }
      const diff = ['--no-color', '--no-ext-diff', '--no-textconv']
      if (op === 'git.status') {
        const [branch, raw, stagedRaw, status, log, v2] = await Promise.all([
          output(['symbolic-ref', '--quiet', '--short', 'HEAD'], true), output(['diff', ...diff]), output(['diff', '--cached', ...diff]),
          output(['status', '--porcelain', '-b']), output(['log', '--oneline', '-12'], true), output(['status', '--porcelain=v2', '--branch']),
        ])
        const branchStatus = { ...emptyBranch, isRepo: true }
        for (const line of v2.split('\n')) {
          if (line.startsWith('# branch.oid ')) branchStatus.head = line.slice(13).trim() === '(initial)' ? '' : line.slice(13, 25)
          else if (line.startsWith('# branch.head ')) branchStatus.branch = line.slice(14) === '(detached)' ? null : line.slice(14)
          else if (line.startsWith('# branch.upstream ')) branchStatus.upstream = line.slice(18)
          else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { branchStatus.ahead = +m[1]; branchStatus.behind = +m[2] } }
          else if (line && !line.startsWith('#')) branchStatus.dirty++
        }
        return { snapshot: { isRepo: true, branch: branch.trim(), raw: await this.untracked(root, raw), stagedRaw, status, log: log.trim() }, branchStatus }
      }
      if (op === 'git.diff') {
        const path = args.path === undefined ? undefined : relativeInput(args.path)
        if (path !== undefined) await under(root, path, true)
        return output(['diff', ...diff, ...(args.staged === true ? ['--cached'] : []), ...(path !== undefined ? ['--', path] : [])])
      }
      if (op === 'git.branches') {
        const format = ['%(refname)', '%(objectname:short)', '%(committerdate:unix)', '%(upstream:short)', '%(worktreepath)', '%(HEAD)'].join('%00')
        const out = await output(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'])
        const branches = out.split('\n').filter(Boolean).flatMap((line) => {
          const [ref, head, date, upstream, worktree, mark] = line.split('\0')
          const remote = ref.startsWith('refs/remotes/'), name = ref.slice(remote ? 13 : 11), current = mark?.trim() === '*'
          if (remote && name.endsWith('/HEAD')) return []
          return [{ name, remote, head, date: +date || 0, upstream: upstream || null, current, worktree: worktree && !current && worktree !== root ? worktree : null }]
        }).sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date)
        return { branches }
      }
      if (op === 'git.switch') {
        const name = text(args.name).trim()
        if (!name || name.startsWith('-') || /[\x00-\x20]/.test(name) || (await run(['check-ref-format', '--branch', name])).code !== 0) return { ok: false, reason: 'invalid-name', message: 'Invalid branch name' }
        let target = name, argv = ['switch', name]
        if (args.create === true) argv = ['switch', '-c', name]
        else if (args.remote === true) {
          if (!name.includes('/')) fail('invalid_name')
          target = name.slice(name.indexOf('/') + 1)
          if (target.startsWith('-') || (await run(['check-ref-format', '--branch', target])).code !== 0) fail('invalid_name')
          const exists = await run(['show-ref', '--verify', '--quiet', `refs/heads/${target}`])
          argv = exists.code === 0 ? ['switch', target] : ['switch', '-c', target, '--track', name]
        }
        let stashed = false
        if (args.stash === true) {
          const previous = await output(['rev-parse', '--verify', 'refs/stash'], true)
          const result = await run(['stash', 'push', '--include-untracked', '-m', `pi-desktop: switch to ${target}`])
          if (result.code) return { ok: false, reason: 'git', message: 'Git stash failed' }
          stashed = previous !== await output(['rev-parse', '--verify', 'refs/stash'], true)
        }
        const result = await run(argv)
        if (result.code) {
          if (stashed) await run(['stash', 'pop'])
          const paths = result.err.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim())
          return paths.length && !args.stash ? { ok: false, reason: 'dirty-conflict', files: paths } : { ok: false, reason: 'git', message: 'Git switch failed' }
        }
        return { ok: true, branch: target, stashed }
      }
      if (op === 'git.stage' || op === 'git.unstage') {
        if (!Array.isArray(args.files) || args.files.length > 500) fail('invalid_arguments')
        for (const file of args.files) {
          const path = relativeInput(text(file?.path))
          if (!path || path === '.' || path.split('/').includes('.git')) fail('invalid_path')
          await under(root, path, true)
          const patches = file.hunkPatches ?? (file.patch === undefined ? [] : [file.patch])
          if (!Array.isArray(patches) || patches.length > 100) fail('invalid_arguments')
          if (patches.length) {
            for (const raw of patches) {
              const patch = text(raw)
              await this.validatePatch(root, path, patch)
              const result = await run(['apply', '--cached', '--recount', ...(op === 'git.unstage' ? ['-R'] : []), '--whitespace=nowarn', '-'], patch)
              if (result.code) return { ok: false, error: 'git_apply_failed' }
            }
          } else {
            const result = op === 'git.stage' ? await run(['add', '--', path]) : await run(['reset', '-q', 'HEAD', '--', path])
            if (result.code) {
              if (op === 'git.unstage' && (await run(['rev-parse', '--verify', 'HEAD'])).code !== 0) {
                if ((await run(['rm', '--cached', '-r', '--', path])).code === 0) continue
              }
              return { ok: false, error: 'git_failed' }
            }
          }
        }
        return { ok: true }
      }
      if (op === 'git.worktrees') {
        const raw = await output(['worktree', 'list', '--porcelain', '-z'])
        const records = raw.split('\0\0').filter(Boolean).map((record) => record.split('\0'))
        const trees = records.flatMap((fields, index) => {
          const path = fields.find((s) => s.startsWith('worktree '))?.slice(9)
          if (!path || fields.includes('bare') || fields.some((s) => s.startsWith('prunable'))) return []
          return [{ path, branch: fields.find((s) => s.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, ''), isMain: index === 0, detached: fields.includes('detached') }]
        })
        return { ok: true, repositoryPath: records[0]?.find((s) => s.startsWith('worktree '))?.slice(9) ?? null, trees }
      }
      fail('unsupported_operation')
    }
    return ['git.stage', 'git.unstage', 'git.switch'].includes(op) ? this.files.locks.get(ws.id)!.run(execute) : execute()
  }
  private async validatePatch(root: string, expected: string, patch: string): Promise<void> {
    if (Buffer.byteLength(patch) > 1024 * 1024 || !patch.startsWith('diff --git ')) fail('invalid_patch')
    let headers = 0, old = 0, next = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        // Conservative: reject Git quoted names, renames, binary patches and multi-file patches.
        if (line !== `diff --git a/${expected} b/${expected}` || ++headers > 1) fail('invalid_patch')
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const prefix = line.startsWith('--- ') ? 'a/' : 'b/'
        const path = line.slice(4)
        if (path !== '/dev/null' && path !== prefix + expected) fail('invalid_patch')
        if (prefix === 'a/') old++; else next++
      } else if (/^(rename |copy |GIT binary|Binary files|old mode|new mode)/.test(line)) fail('invalid_patch')
    }
    if (headers !== 1 || old !== 1 || next !== 1 || patch.includes('120000') || patch.includes('160000')) fail('invalid_patch')
    await under(root, expected, true)
  }
  private async untracked(root: string, raw: string): Promise<string> {
    const result = await this.exec(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    let total = Buffer.byteLength(raw)
    for (const path of result.out.split('\0').filter(Boolean).slice(0, 100)) {
      if (/[\n\r\t"\\]/.test(path)) continue
      try {
        const abs = await under(root, path), data = await this.files.bytes(abs, 256 * 1024)
        if (data.truncated || data.data.includes(0)) continue
        const content = data.data.toString('utf8')
        const lines = content ? content.split('\n') : []
        if (content.endsWith('\n')) lines.pop()
        const patch = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
          ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ...(content.endsWith('\n') ? [] : ['\\ No newline at end of file'])] : []), ''].join('\n')
        if ((total += Buffer.byteLength(patch)) > 8 * 1024 * 1024) break
        raw += '\n' + patch
      } catch { /* unsafe or unavailable untracked entry */ }
    }
    return raw
  }
}
