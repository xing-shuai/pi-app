/** Show the actionable cause, never the prompt payload or credential-bearing config objects. */
export function composerSendErrorDescription(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The session could not accept the message.'
  const plain = message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/, '')
  if (plain === 'EPHEMERAL_SANDBOX_DRAFT') return 'The project session has not finished initialization. Reopen the project or start a new session, then retry.'
  return plain
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .slice(0, 800)
}
