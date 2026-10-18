import { Notification } from 'electron'
import { configStore } from './config-store'
import { getMainWindow } from './window'

const delivered = new Set<string>()
/** Completion notification only; never triggers or retries work. Respects existing desktop preferences. */
export function notifyProductCompletion(info: { key: string; title: string; failed: boolean }): void {
  if (delivered.has(info.key)) return
  delivered.add(info.key)
  if (delivered.size > 1000) delivered.delete(delivered.values().next().value!)
  if (!configStore.get('alertNotificationEnabled')) return
  if (info.failed ? !configStore.get('alertOnRunFailed') : !configStore.get('alertOnRunIdle')) return
  if (configStore.get('completionNotificationOnlyWhenUnfocused') && getMainWindow()?.isFocused()) return
  if (!Notification.isSupported()) return
  try {
    const zh = configStore.get('language') === 'zh'
    const notification = new Notification({ title: info.title.slice(0, 100), body: info.failed ? (zh ? '执行失败，请在应用中查看详情。' : 'Execution failed. Review details in the app.') : (zh ? '执行完成，结果已保存在应用中。' : 'Completed. The result is saved in the app.'), silent: !configStore.get('alertSoundEnabled') })
    notification.on('click', () => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) { win.show(); win.restore(); win.focus() }
    })
    notification.show()
  } catch { /* OS notification availability must not affect execution. */ }
}
