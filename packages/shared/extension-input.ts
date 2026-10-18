/** Compatibility for extensions passing legacy options to the SDK's string-placeholder API. */
export function extensionInputPresentation(value: unknown, explicitDefault?: unknown): { placeholder?: string; defaultValue?: string } {
  const options = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const placeholder = typeof value === 'string' ? value : typeof options?.placeholder === 'string' ? options.placeholder : undefined
  const initial = typeof explicitDefault === 'string' ? explicitDefault : typeof options?.defaultValue === 'string' ? options.defaultValue : undefined
  return { ...(placeholder !== undefined ? { placeholder } : {}), ...(initial !== undefined ? { defaultValue: initial } : {}) }
}
/** User-disabled remote-pi onboarding only. Cancel, never auto-approve relay or permissions. */
export function skipAgentNameOnboarding(title: unknown, value: unknown): boolean {
  if (typeof title !== 'string' || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const initial = (value as Record<string, unknown>).defaultValue
  if (typeof initial !== 'string' || !initial.trim() || initial.length > 120 || /[\x00-\x1f\x7f]/.test(initial)) return false
  return title === `Agent name: (default: ${initial})`
}
