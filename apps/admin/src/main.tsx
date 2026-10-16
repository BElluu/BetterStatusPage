import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { configureUi } from '@better-kit/ui'
import App from './App'
import { ToastProvider } from './components/ui'
import './index.css'

// What the interface keeps in the browser is named after this product.
configureUi({ storagePrefix: 'bsp' })

const storedDarkMode = localStorage.getItem('bsp-dark-mode')
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
