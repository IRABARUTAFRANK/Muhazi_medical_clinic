import '@fontsource-variable/inter'
import './styles/globals.css'
import { initI18n } from './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { queryClient } from './lib/query-client'
import { safePath, trace } from './lib/sign-in-trace'
import { routeTree } from './routeTree.gen'

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Route changes go into the sign-in trace: the path only (the query string can carry patient
// data, see safePath), never the part after `#`.
router.subscribe('onResolved', (e) => {
  const to = safePath(e.toLocation.pathname, e.toLocation.searchStr)
  const from = e.fromLocation
    ? safePath(e.fromLocation.pathname, e.fromLocation.searchStr)
    : undefined
  if (e.pathChanged || from !== to) trace('route', { to })
})

// A tab left open across an update asks for files the new deploy no longer has (a page's
// code, a language's words): it reloads itself once instead of failing or showing raw keys.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  const key = 'mmc.reloaded-for-update'
  if (sessionStorage.getItem(key) === window.location.href) return
  sessionStorage.setItem(key, window.location.href)
  window.location.reload()
})

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root element')

// the chosen language's strings first (one file, not three), then the page
void initI18n().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
})
