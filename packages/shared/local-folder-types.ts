/** Local, native filesystem paths only. These APIs never select an execution target. */
export type LocalFolderBrowseRequest = { path?: string; includeHidden?: boolean }
export type LocalFolderEntry = { name: string; path: string; directory: true; symlink?: boolean }
export type LocalFolderRoot = { name: string; path: string }
export type LocalFolderBrowseResult = {
  path: string
  home: string
  parent: string | null
  entries: LocalFolderEntry[]
  roots: LocalFolderRoot[]
  truncated: boolean
}
export type LocalFolderResolveRequest = { path: string }
export type LocalFolderResolveResult = { path: string; name: string }
