import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { safeLocalStorage } from '@better-forge/contracts'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LocaleProvider } from './i18n/LocaleContext'
import './index.css'

const storedDarkMode = safeLocalStorage.get('bsp-dark-mode')
if (storedDarkMode === 'true' || (storedDarkMode === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </LocaleProvider>
    </QueryClientProvider>
  </StrictMode>,
)
