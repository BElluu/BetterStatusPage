import { createVault, createVaultUseGuard, type Vault } from '@better-kit/vault'
import { requestIdentity } from '@better-kit/auth'
import { db } from '../db/client.js'
import { audit } from './audit.js'
import { secretBox } from './sealer.js'

/** Vaults and secrets of this application. The database handle is the lazy one, so the database may be opened after this module loads. */
export const vault: Vault = createVault({ db, audit, identity: requestIdentity, secretBox })

/** Keeps a token that may not use vault secrets away from monitors and channels that reference one. */
export const vaultUseGuard = createVaultUseGuard({ target: 'monitor or channel' })
