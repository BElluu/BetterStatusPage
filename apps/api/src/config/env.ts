export function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  options: { max?: number } = {},
): number {
  const raw = env[name]
  if (!raw) return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || (options.max !== undefined && value > options.max)) {
    const range = options.max === undefined ? 'a positive integer' : `an integer between 1 and ${options.max}`
    throw new Error(`${name} must be ${range}`)
  }
  return value
}
