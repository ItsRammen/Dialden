import { describe, expect, test } from 'bun:test'
import {
  ChannelQualityTierService,
  type TierDecision,
} from '../src/services/ChannelQualityTierService'

describe('ChannelQualityTierService', () => {
  test('hardware acceleration always selects full quality at lineup scale', () => {
    const service = new ChannelQualityTierService()
    for (const count of [1, 4, 12]) {
      const decision = service.resolve({
        hardwareAcceleration: true,
        enabledChannelCount: count,
      })
      expect(decision.tier).toBe('full')
      expect(decision.profile.maximumHeight).toBe(1080)
      expect(decision.maximumConcurrentWorkers).toBe(count)
      expect(decision.source).toBe('probe')
    }
  })

  test('small software lineups run standard 720p across every channel', () => {
    const service = new ChannelQualityTierService()
    for (const count of [0, 1, 3]) {
      const decision = service.resolve({
        hardwareAcceleration: false,
        enabledChannelCount: count,
      })
      expect(decision.tier).toBe('standard')
      expect(decision.profile.maximumHeight).toBe(720)
      expect(decision.profile.maximumWidth).toBe(1280)
      expect(decision.maximumConcurrentWorkers).toBe(Math.max(1, count))
    }
  })

  test('large software lineups bound concurrency instead of dropping resolution', () => {
    const service = new ChannelQualityTierService()
    const decision = service.resolve({
      hardwareAcceleration: false,
      enabledChannelCount: 8,
    })
    expect(decision.tier).toBe('economy')
    expect(decision.profile.maximumHeight).toBe(720)
    expect(decision.maximumConcurrentWorkers).toBe(2)
    expect(decision.reason).toContain('on demand')
  })

  test('operator override wins and is reported as such', () => {
    const service = new ChannelQualityTierService({ override: 'standard' })
    const decision: TierDecision = service.resolve({
      hardwareAcceleration: true,
      enabledChannelCount: 9,
    })
    expect(decision.tier).toBe('standard')
    expect(decision.source).toBe('override')
    expect(decision.reason).toContain('operator override')

    const forcedFull = new ChannelQualityTierService({ override: 'full' }).resolve(
      { hardwareAcceleration: false, enabledChannelCount: 9 }
    )
    expect(forcedFull.tier).toBe('full')
    expect(forcedFull.profile.maximumHeight).toBe(1080)
    expect(forcedFull.source).toBe('override')
  })

  test('rejects unknown override values', () => {
    expect(
      () =>
        new ChannelQualityTierService({
          override: 'ultra' as never,
        })
    ).toThrow('full, standard, or economy')
  })

  test('keeps one resolution for the entire lineup', () => {
    const service = new ChannelQualityTierService()
    const decisions = [
      service.resolve({ hardwareAcceleration: false, enabledChannelCount: 2 }),
      service.resolve({ hardwareAcceleration: false, enabledChannelCount: 8 }),
      service.resolve({ hardwareAcceleration: true, enabledChannelCount: 8 }),
    ]
    const heights = new Set(decisions.map((decision) => decision.profile.maximumHeight))
    for (const decision of decisions) {
      expect(heights.has(decision.profile.maximumHeight)).toBe(true)
    }
    expect(heights.size).toBeGreaterThan(0)
  })
})
