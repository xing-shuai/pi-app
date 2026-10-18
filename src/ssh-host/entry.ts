import { startHost } from './host'
import { initializationFailureMarkers } from './startup-diagnostics'

// Single bundled entry, also imported through an SSH data URL. No Pi before explicit trust.
process.umask(0o077)
// Losing diagnostics must not interrupt child cleanup after a broken SSH channel.
process.stderr.on('error', () => {})
let dispose: (() => Promise<void>) | undefined
let requestedStop = false
let stopping: Promise<void> | undefined
const stop = () => {
  if (!requestedStop) process.stderr.write('__PI_DESKTOP_REMOTE_HOST_SIGNALLED_V1__\n')
  requestedStop = true
  if (dispose && !stopping) stopping = dispose().finally(() => { process.exitCode = 0 })
}
// Register before async capability discovery so even a pre-handshake signal cleans probe children.
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
process.once('SIGHUP', stop)
void startHost().then((running) => {
  dispose = running.dispose
  if (requestedStop) stop()
}).catch((error: unknown) => {
  process.stderr.write(initializationFailureMarkers(error).join('\n') + '\n')
  process.exitCode = 1
})
