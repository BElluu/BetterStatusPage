import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { safeLocalStorage, safeSessionStorage } from '@better-forge/contracts'
import { configureUi } from '@better-forge/ui'
import App from './App'
import { adminUiConfig } from './uiConfig'
import { ToastProvider } from '@better-forge/ui'
import './index.css'

// Remove credentials left by versions that stored JWTs in sessionStorage.
safeSessionStorage.remove('token')
safeSessionStorage.remove('mustChangePwd')

configureUi(adminUiConfig)

const storedDarkMode = safeLocalStorage.get('bsp-dark-mode')
if (storedDarkMode === 'true' || (storedDarkMode === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 0,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
