import { expect, test } from 'bun:test'
import { ChannelIconService, channelIconNetwork } from '../src/services/ChannelIconService'
import type { LibraryChannelPolicy } from '../src/config/library'
const channel: LibraryChannelPolicy = { id: 'nick', name: 'Nickelodeon', enabled: true, timezone: 'UTC', slots: [] }
const custom = { has: () => false, path: () => '/custom/nick.png' }
test('exact identities only; custom names are not guessed', () => {
  expect(channelIconNetwork(channel)).toBe('nickelodeon')
  expect(channelIconNetwork({ name: 'Disney Junior' })).toBe('disney-junior')
  expect(channelIconNetwork({ name: 'My Nickelodeon Movies' })).toBeUndefined()
})
test('uploaded art takes priority without fetching or changing branding', async () => {
  const service = new ChannelIconService({ ...custom, has: () => true }, { ...custom, save: async () => { throw Error('unexpected save') } }, async () => { throw Error('unexpected request') })
  expect(await service.resolve(channel)).toBe('/custom/nick.png')
})
test('concurrent channels share a single download and subsequent requests use disk cache', async () => {
  let requests = 0, saved = false
  const service = new ChannelIconService(custom, {
    has: () => saved, path: () => '/cache/nickelodeon.png',
    save: async (id, file) => { expect(id).toBe('nickelodeon'); expect(file.size).toBe(3); saved = true; return '/cache/nickelodeon.png' },
  }, async (url) => { requests++; expect(url.endsWith('/nickelodeon-us.png')).toBe(true); return new Response(new Uint8Array([1,2,3])) })
  expect(await Promise.all([service.resolve(channel), service.resolve(channel)])).toEqual(['/cache/nickelodeon.png', '/cache/nickelodeon.png'])
  expect(await service.resolve(channel)).toBe('/cache/nickelodeon.png')
  expect(requests).toBe(1)
})
test('failures back off and oversized input never reaches the PNG store', async () => {
  let requests = 0, saves = 0
  const service = new ChannelIconService(custom, { ...custom, save: async () => { saves++; return '' } }, async () => { requests++; return new Response(new Uint8Array(5 * 1024 * 1024 + 1)) })
  expect(await service.resolve(channel)).toBeUndefined()
  expect(await service.resolve(channel)).toBeUndefined()
  expect(requests).toBe(1)
  expect(saves).toBe(0)
})
