import type { NotificationChannelType } from '@bsp/shared'

export const CHANNEL_TYPES: readonly NotificationChannelType[] = ['email', 'webhook', 'discord', 'teams', 'slack', 'telegram']

/** Telegram needs a chat and a token, direct or from the vault; an edited mask is not a token. */
export function telegramConfigError(config: unknown): string | null {
  const c = (config && typeof config === 'object' ? config : {}) as { botToken?: unknown; vault?: { vaultId?: unknown; secretId?: unknown }; chatId?: unknown }
  if (typeof c.chatId !== 'string' || !c.chatId.trim()) return 'Telegram needs a Chat ID'
  if (c.vault) return Number.isInteger(c.vault.vaultId) && Number.isInteger(c.vault.secretId) && Number(c.vault.secretId) > 0 ? null : 'Pick a vault secret for the bot token'
  if (typeof c.botToken !== 'string' || !c.botToken.trim()) return 'Telegram needs a Bot Token'
  return c.botToken.includes('•') ? 'Paste the full bot token to replace the stored one' : null
}
