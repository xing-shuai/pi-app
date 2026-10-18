import { ReferenceAsterisk } from './reference-sidebar'

export function ReferenceCodeHome({ userName }: { userName?: string }) {
  const name = userName?.trim()
  return (
    <section className="reference-code-home" aria-label="Code home">
      <h1>
        <span className="reference-code-star"><ReferenceAsterisk size={28} /></span>
        <span>{name ? `What's up next, ${name}?` : "What's up next?"}</span>
      </h1>
    </section>
  )
}
