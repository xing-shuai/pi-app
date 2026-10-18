const KEY = 'pi-desktop:ui-zoom'
export const REFERENCE_UI_ZOOM = 5 / 6
export const UI_ZOOM_LEVELS = [REFERENCE_UI_ZOOM, 0.9, 1, 1.1, 1.25] as const

/** The supplied screenshots have an effective 1.25 scale on the user's 1.5-scale display. */
export function referenceUiZoom(devicePixelRatio: number): number {
  return Math.abs(devicePixelRatio - 1.5) < 0.02 ? REFERENCE_UI_ZOOM : 1
}
function normalizeZoom(value: number): number {
  return UI_ZOOM_LEVELS.some((allowed) => Math.abs(allowed - value) < 0.000001) ? value : 1
}
export function readUiZoom(): number {
  return normalizeZoom(Number(localStorage.getItem(KEY) || '1'))
}
export function applyUiZoom(value: number): void {
  const zoom = normalizeZoom(value)
  localStorage.setItem(KEY, String(zoom))
  document.documentElement.style.zoom = String(zoom)
  document.documentElement.style.setProperty('--ui-zoom', String(zoom))
  window.dispatchEvent(new Event('resize'))
}
