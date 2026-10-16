// Entity keys live in the config-as-code package; kept so call sites do not change.
export {
  ENTITY_KEY_ERROR, ENTITY_KEY_PATTERN, isValidEntityKey, keyForNew, randomEntityKey, slugifyKey,
  type KeyOwner, type KeyResult,
} from '@better-kit/config-as-code'
