/** Electron wraps rejected invokes; show the actionable backend reason, not transport boilerplate. */
export function sshErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/, '')
}
export function needsRemotePathReview(message: string): boolean {
  return /remote (?:Pi|Node|workspace|folder|startup|login shell)|Pi was not found|configured remote Node/i.test(message)
}
