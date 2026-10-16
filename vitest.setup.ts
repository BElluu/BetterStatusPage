import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { configureUi } from '@better-kit/ui'
import { adminUiConfig } from './apps/admin/src/uiConfig'

// The admin tests run as the product does.
configureUi(adminUiConfig)

afterEach(() => cleanup())
