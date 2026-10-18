import type { CustomTheme } from './custom-theme'

/** Shared by the native startup surface and renderer preset picker. Existing user themes are preserved. */
export const CLAUDE_DESKTOP_THEME = {
  light: {
    fontUi: null, fontCode: null, preset: 'claude',
    accent: '#c96442', surface: '#faf9f5', ink: '#141413', contrast: 40,
    translucentSidebar: false, diffAdded: '#2f7d4f', diffRemoved: '#b5452e',
    colors: { sidebar: '#f3f1ea', userBubble: '#f0eee6', codeBg: '#f5f4ee', border: '#e3e0d5' },
    fontDisplay: 'serif', proseFont: 'display', chatFontSize: 16, chatLineHeight: 1.7, radius: 10, shadow: 30,
  },
  dark: {
    fontUi: null, fontCode: null, preset: 'claude',
    accent: '#d97757', surface: '#262624', ink: '#f5f4ef', contrast: 55,
    translucentSidebar: false, diffAdded: '#6fbf8a', diffRemoved: '#e0806a',
    colors: { sidebar: '#1f1e1d', userBubble: '#30302e', codeBg: '#1f1e1d', border: '#3b3a36' },
    fontDisplay: 'serif', proseFont: 'display', chatFontSize: 16, chatLineHeight: 1.7, radius: 10, shadow: 40,
  },
} satisfies CustomTheme
