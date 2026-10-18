import type { ThemeVariant, ThemeVariantKey } from '@shared/custom-theme'
import { CLAUDE_DESKTOP_THEME } from '@shared/desktop-theme'

export type ThemePreset = {
  id: string
  /** i18n key under settings:appearance.presets */
  labelKey: string
  light?: ThemeVariant
  dark?: ThemeVariant
}

const base = { fontUi: null, fontCode: null } as const

/**
 * Built-in themes. `default` has no variants: it means "no custom theme" (globals.css as shipped).
 * Each preset's `preset` id is kept on the saved variant until a field is edited.
 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'default', labelKey: 'default' },
  {
    id: 'claude',
    labelKey: 'claude',
    ...CLAUDE_DESKTOP_THEME,
  },
  {
    id: 'vscode-plus',
    labelKey: 'vscodePlus',
    light: {
      ...base,
      preset: 'vscode-plus',
      accent: '#007acc',
      surface: '#ffffff',
      ink: '#000000',
      contrast: 45,
      translucentSidebar: true,
      diffAdded: '#008000',
      diffRemoved: '#ee0000',
    },
  },
  {
    id: 'codex-dark',
    labelKey: 'codexDark',
    dark: {
      ...base,
      preset: 'codex-dark',
      accent: '#339cff',
      surface: '#181818',
      ink: '#ffffff',
      contrast: 60,
      translucentSidebar: false,
    },
  },
]

export function presetVariant(id: string, variant: ThemeVariantKey): ThemeVariant | undefined {
  const v = THEME_PRESETS.find((p) => p.id === id)?.[variant]
  return v ? structuredClone(v) : undefined
}

export function presetsFor(variant: ThemeVariantKey): ThemePreset[] {
  return THEME_PRESETS.filter((p) => p.id === 'default' || p[variant])
}
