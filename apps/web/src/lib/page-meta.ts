import { useEffect } from 'react'

/**
 * The document's title, description and robots rule for a page (0146): the public pages are
 * indexed with their own title and description in the reader's language; the staff area and
 * the waiting screen are never indexed.
 */
export function usePageMeta(opts: { title: string; description?: string; index?: boolean }) {
  const { title, description, index = false } = opts
  useEffect(() => {
    const previous = document.title
    document.title = title
    const set = (name: string, content: string, attr: 'name' | 'property' = 'name') => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`)
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute(attr, name)
        document.head.appendChild(el)
      }
      el.setAttribute('content', content)
    }
    if (description) {
      set('description', description)
      set('og:description', description, 'property')
    }
    set('og:title', title, 'property')
    set('robots', index ? 'index, follow' : 'noindex, nofollow')
    return () => {
      document.title = previous
    }
  }, [title, description, index])
}
