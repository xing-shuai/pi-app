import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Remote paths must never reach local file-link/preview handlers. No raw HTML or remote images. */
export function RemoteMarkdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => /^https?:\/\//i.test(href || '')
      ? <a href={href} onClick={(event) => { event.preventDefault(); void window.piDesktop?.invoke('ipc:shell.openExternal', { url: href }).catch(() => {}) }}>{children}</a>
      : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</ReactMarkdown>
}
