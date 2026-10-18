import { createContext, useContext, type ReactNode } from 'react'

const WorkspaceActivity = createContext(true)
/** Kept-mounted Code views may stream in the background, but must not capture other areas' input. */
export function WorkspaceActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <WorkspaceActivity.Provider value={active}>{children}</WorkspaceActivity.Provider>
}
export function useCodeWorkspaceActive(): boolean { return useContext(WorkspaceActivity) }
