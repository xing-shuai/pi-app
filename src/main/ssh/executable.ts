import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/** Resolve on the client, before sshpass runs. Exit 127 alone cannot identify which machine failed. */
export async function resolveLocalOpenSsh(path = process.env.PATH || ''): Promise<string | undefined> {
  for (const entry of path.split(delimiter)) {
    const candidate = join(isAbsolute(entry) ? entry : resolve(entry || '.'), 'ssh')
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch { /* Keep searching PATH without exposing arbitrary filesystem errors. */ }
  }
  return undefined
}
export const LOCAL_SSH_LOOKUP_TIMEOUT = 'Local OpenSSH path lookup timed out. Check slow or unavailable PATH folders before reconnecting.'
export const LOCAL_SSH_UNAVAILABLE = 'The local OpenSSH client is not executable on PATH. Install or repair the local ssh client.'
