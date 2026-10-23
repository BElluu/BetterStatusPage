import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { safeLocalStorage } from '@better-kit/contracts'
import { ToastProvider, configureUi } from '@better-kit/ui'
import App from './App'
import { uiConfig } from './uiConfig'
import './index.css'

configureUi(uiConfig)

const storedDarkMode = safeLocalStorage.get('tpl-dark-mode')
if (storedDarkMode === 'true' || (storedDarkMode === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
