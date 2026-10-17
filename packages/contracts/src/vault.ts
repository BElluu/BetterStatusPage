/** Reference to a vault secret, with optional field mapping for json-type secrets */
export interface VaultRef {
  vaultId: number
  secretId: number
  /** Only for json-type secrets: maps our field names to JSON object keys */
  fieldMapping?: Record<string, string>
}
