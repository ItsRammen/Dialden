import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AudioNormalizationService } from '../src/services/AudioNormalizationService'
const enabled = { enabled: true, nightMode: false }

test('analysis is queued, deduplicated, serial, and persists for reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dialden-audio-'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0, active = 0, maximum = 0
  const path = join(dir, 'source'); writeFileSync(path, 'media')
  const second = join(dir, 'second'); writeFileSync(second, 'other')
  const cache = join(dir, 'measurements.json')
  const service = new AudioNormalizationService(cache, async () => enabled, async () => {
    calls++; active++; maximum = Math.max(active, maximum); await gate; active--
    return { integrated: -25, peak: -10 }
  })
  try {
    expect(service.filter(path, 0, enabled)).not.toContain('volume=')
    service.filter(path, 0, enabled); service.filter(second, 0, enabled)
    release(); await service.whenIdle()
    expect(calls).toBe(2); expect(maximum).toBe(1)
    expect(service.filter(path, 0, enabled)).toContain('volume=7.000dB')
    const restarted = new AudioNormalizationService(cache, async () => enabled, async () => { throw new Error('Unchanged file must reuse measurement') })
    restarted.filter(path, 0, enabled); await restarted.whenIdle()
    expect(restarted.status().failures).toBe(0)
    expect(restarted.filter(path, 0, enabled)).toContain('volume=7.000dB')
    writeFileSync(path, 'replacement source, different size')
    const changed = new AudioNormalizationService(cache, async () => enabled, async () => ({ integrated: -10, peak: -1 }))
    expect(changed.filter(path, 0, enabled)).not.toContain('volume=')
    await changed.whenIdle()
    expect(changed.filter(path, 0, enabled)).toContain('volume=-8.000dB')
  } finally { release(); await service.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('peak ceiling limits gain; disabled, night-only and failed measurements stay usable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dialden-audio-'))
  const path = join(dir, 'source'); writeFileSync(path, 'media')
  const service = new AudioNormalizationService(join(dir, 'cache'), async () => enabled, async () => ({ integrated: -30, peak: -3 }))
  try {
    expect(service.filter(path, 0, { enabled: false, nightMode: false })).toBe('')
    expect(service.filter(path, 0, { enabled: false, nightMode: true })).toContain('acompressor=')
    expect(service.status().queued).toBe(0)
    service.filter(path, 0, enabled); await service.whenIdle()
    expect(service.filter(path, 0, enabled)).toContain('volume=1.000dB')
    service.filter(path, 1, enabled); await service.whenIdle() // Separate audio track identity.
    expect(service.status().measured).toBe(2)
    const broken = new AudioNormalizationService(join(dir, 'empty'), async () => enabled, async () => { throw new Error('Unreadable audio') })
    expect(broken.filter(path, 0, enabled)).toContain('alimiter=')
    await broken.whenIdle(); expect(broken.status().failures).toBe(1)
    expect(broken.filter(path, 0, enabled)).not.toContain('volume=')
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('silent tracks are cached without amplification or repeated failed analysis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dialden-silence-'))
  const path = join(dir, 'silent'); writeFileSync(path, 'silence')
  const service = new AudioNormalizationService(join(dir, 'cache'), async () => enabled, async () => ({ integrated: -70, peak: -70, silent: true }))
  try {
    service.filter(path, 0, enabled); await service.whenIdle()
    expect(service.filter(path, 0, enabled)).toContain('volume=0.000dB')
    expect(service.status().failures).toBe(0)
  } finally { await service.stop(); rmSync(dir, { recursive: true, force: true }) }
})
