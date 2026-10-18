import { expect, it } from 'vitest'
import { extensionInputPresentation, skipAgentNameOnboarding } from './extension-input'
it('supports legacy defaultValue objects without object string coercion', () => {
  expect(extensionInputPresentation({ defaultValue: 'main', placeholder: 'Branch' })).toEqual({ defaultValue: 'main', placeholder: 'Branch' })
  expect(extensionInputPresentation('Text', 'prefilled')).toEqual({ placeholder: 'Text', defaultValue: 'prefilled' })
  expect(extensionInputPresentation({ unexpected: true })).toEqual({})
})
it('only skips the exact optional naming wizard, never arbitrary input or permission prompts', () => {
  expect(skipAgentNameOnboarding('Agent name: (default: video_3d)', { defaultValue: 'video_3d' })).toBe(true)
  expect(skipAgentNameOnboarding('Agent name: (default: video_3d)', { defaultValue: 'other' })).toBe(false)
  expect(skipAgentNameOnboarding('Allow dangerous command?', { defaultValue: 'yes' })).toBe(false)
  expect(skipAgentNameOnboarding('Agent name: (default: video_3d)', 'video_3d')).toBe(false)
})
