/** Same narrowly scoped cancel policy as shared/extension-input, kept helper-local so
 * its standalone bundle never acquires a renderer/worker shared runtime chunk. */
export function skipAgentNameOnboarding(title: unknown, value: unknown): boolean {
  if (typeof title !== 'string' || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const initial = (value as Record<string, unknown>).defaultValue
  if (typeof initial !== 'string' || !initial.trim() || initial.length > 120 || /[\x00-\x1f\x7f]/.test(initial)) return false
  return title === `Agent name: (default: ${initial})`
}
