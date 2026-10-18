/** Leaf state shared by the store and IPC channel. No store/channel imports: session
 * reset must be synchronous and must not asynchronously initialize the whole channel. */
export const extensionDialogIds = new Set<string>()
export function clearExtensionDialogDedupe(): void { extensionDialogIds.clear() }
