import { afterEach, describe, expect, it } from 'vitest'
import { applyUiZoom, readUiZoom, referenceUiZoom, REFERENCE_UI_ZOOM } from './ui-zoom'

afterEach(() => { localStorage.removeItem('pi-desktop:ui-zoom'); document.documentElement.style.removeProperty('zoom'); document.documentElement.style.removeProperty('--ui-zoom') })
describe('reference display density', () => {
  it('matches the supplied effective scale on the measured 1.5-DPR display', () => {
    expect(referenceUiZoom(1.5)).toBe(REFERENCE_UI_ZOOM)
    expect(1.5 * referenceUiZoom(1.5)).toBe(1.25)
    expect(referenceUiZoom(1.25)).toBe(1)
    expect(referenceUiZoom(1)).toBe(1)
  })
  it('persists the reference calibration and keeps viewport/layout zoom in sync', () => {
    applyUiZoom(REFERENCE_UI_ZOOM)
    expect(readUiZoom()).toBe(REFERENCE_UI_ZOOM)
    expect(document.documentElement.style.getPropertyValue('--ui-zoom')).toBe(String(REFERENCE_UI_ZOOM))
    applyUiZoom(1.25)
    expect(readUiZoom()).toBe(1.25)
  })
  it('does not accept arbitrary or invalid zoom input', () => {
    applyUiZoom(99)
    expect(readUiZoom()).toBe(1)
    localStorage.setItem('pi-desktop:ui-zoom', 'not-a-number')
    expect(readUiZoom()).toBe(1)
  })
})
