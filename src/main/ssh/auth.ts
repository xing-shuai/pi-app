import { spawn } from 'node:child_process'
import type { SshAuthCapabilities } from '@shared/ssh-workspace'

export const PASSWORD_HELPER_UNAVAILABLE = 'SSH password authentication requires sshpass on PATH. Install sshpass or use Key / Agent authentication.'

/** No shell, credentials, output capture or persistent capability cache. */
export async function detectSshAuthCapabilities(
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
  timeoutMs = 1500,
): Promise<SshAuthCapabilities> {
  if (platform === 'win32') return { password: false, passwordUnavailableReason: 'SSH password authentication is unavailable on Windows. Use Key / Agent authentication.' }
  if (platform !== 'linux' && platform !== 'darwin') return { password: false, passwordUnavailableReason: 'SSH password authentication is supported only on Linux and macOS with sshpass.' }
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (password: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(password ? { password: true } : { password: false, passwordUnavailableReason: PASSWORD_HELPER_UNAVAILABLE })
    }
    try {
      const child = spawnProcess('sshpass', ['-V'], { stdio: 'ignore', windowsHide: true })
      timer = setTimeout(() => { finish(false); child.kill() }, timeoutMs)
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
    } catch { finish(false) }
  })
}
