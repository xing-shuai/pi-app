const prefix = '__PI_DESKTOP_REMOTE_HOST_'
/** Only finite categories cross stderr. Never include remote exception text/paths/config objects. */
export function initializationFailureMarkers(error: unknown): string[] {
  const value = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown } : {}
  const markers = [prefix + 'INIT_FAILED_V1__']
  if (value.code === 'home_unavailable') markers.push(prefix + 'HOME_FAILED_V1__')
  else if (value.code === 'EACCES' || value.code === 'EPERM') markers.push(prefix + 'PERMISSION_FAILED_V1__')
  else if (['EMFILE', 'ENFILE', 'ENOMEM'].includes(String(value.code))) markers.push(prefix + 'RESOURCE_FAILED_V1__')
  return markers
}
