import { createContext, useContext, useRef } from 'react'
import { isVirtualWorkspacePath } from '@shared/remote-code'
import { useUIStore } from '@renderer/stores/ui-store'

export const MarkdownWorkspaceOrigin = createContext<string | null | undefined>(undefined)
/** Bind file authority to the source transcript, never whichever host is foreground later. */
export function useMarkdownWorkspaceOrigin(baseDirectory?: string, explicit?: string | null): string | null {
  const inherited = useContext(MarkdownWorkspaceOrigin)
  const fromBase = isVirtualWorkspacePath(baseDirectory) ? baseDirectory!.split('/').slice(0, 5).join('/') : undefined
  const value = explicit !== undefined ? explicit : fromBase !== undefined ? fromBase : inherited !== undefined ? inherited : useUIStore.getState().currentWorkspace
  return useRef(value).current
}
