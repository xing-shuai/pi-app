import { CLAUDE_DESKTOP_THEME } from './desktop-theme'
import type { CustomTheme } from './custom-theme'

/** Dark color samples taken from the user's supplied Desktop reference, not the older warm-charcoal preset. */
export const REFERENCE_DESKTOP_THEME = {
  light: { ...CLAUDE_DESKTOP_THEME.light, preset: null, shadow: 0 },
  dark: {
    ...CLAUDE_DESKTOP_THEME.dark,
    preset: null,
    surface: '#151515',
    ink: '#c4c2b8',
    accent: '#d97757',
    contrast: 48,
    colors: { sidebar: '#111111', chat: '#151515', userBubble: '#2a2a28', codeBg: '#1d1d1c', border: '#292929' },
    chatFontSize: 16,
    radius: 12,
    shadow: 0,
  },
} satisfies CustomTheme
