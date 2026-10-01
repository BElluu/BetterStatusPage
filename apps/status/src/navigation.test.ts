import { describe, expect, it } from 'vitest'
import { navigation } from './navigation'

describe('navigation', () => {
  it('navigates the whole page', () => {
    navigation.assign('#signed-out')
    expect(window.location.hash).toBe('#signed-out')
  })
})
