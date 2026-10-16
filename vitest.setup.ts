import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { configureUi } from '@better-kit/ui'

// The admin tests run as the product does: what the interface keeps in the browser is named after it.
configureUi({ storagePrefix: 'bsp' })

afterEach(() => cleanup())
