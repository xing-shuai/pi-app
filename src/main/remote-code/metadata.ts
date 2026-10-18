import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const schema = z.object({
  version: z.literal(1),
  roots: z.array(z.object({ profileId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().min(1).max(4096).startsWith('/'), name: z.string().max(4096) }).strict()).max(500),
}).strict()
export type RemoteMetadata = z.infer<typeof schema>
export class RemoteMetadataStore {
  private file: string
  constructor(private directory: string) { this.file = join(directory, 'metadata.json') }
  load(): RemoteMetadata {
    try {
      const directory = lstatSync(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid remote metadata directory')
      const stat = lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid remote metadata')
      return schema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, roots: [] }
      // Fail closed: corrupt metadata never authorizes remote execution.
      throw new Error('Remote Code metadata is invalid; restore or remove remote-code/metadata.json before continuing')
    }
  }
  save(data: RemoteMetadata): void {
    schema.parse(data)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Remote metadata directory must not be a symlink')
    chmodSync(this.directory, 0o700)
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
    renameSync(tmp, this.file)
  }
}
