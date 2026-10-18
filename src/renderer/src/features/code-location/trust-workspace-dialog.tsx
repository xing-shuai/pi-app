import { CodeLocationModal } from './code-location-modal'

export function TrustWorkspaceDialog({ path, hostLabel, remoteHome = false, onTrust, onClose }: { path: string; hostLabel?: string; remoteHome?: boolean; onTrust: () => void; onClose: () => void }) {
  return <CodeLocationModal title={remoteHome ? 'Use remote home without a project?' : 'Trust this workspace?'} onClose={onClose} className="trust-workspace-dialog" initialFocus="[data-trust-cancel]" footer={<><button data-trust-cancel type="button" onClick={onClose}>Cancel</button><button className="code-location-primary" onClick={onTrust}>{remoteHome ? 'Trust remote home' : 'Trust workspace'}</button></>}>
    {remoteHome ? <p>No project · Remote home uses this directory as the remote working directory. Pi tools can read, write, and execute with your remote account’s permissions, including outside this directory. This is not a private scratch folder or a sandbox.</p> : <p>Pi Code may read, write, or execute files in this folder.<br />Only proceed if you trust this workspace.</p>}
    <code>{path}</code>{hostLabel && <p className="trust-workspace-host">on <span>{hostLabel}</span></p>}
    <p className="code-location-help">Workspace trust is not an OS sandbox. Code runs with the selected machine’s user permissions.</p>
  </CodeLocationModal>
}
