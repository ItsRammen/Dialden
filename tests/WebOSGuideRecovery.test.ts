import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const app = readFileSync(new URL('../clients/webos/app.js', import.meta.url), 'utf8')
function extract(start: string, end: string) { return app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start))) }
test('Enter tunes guide selection when focus is missing', () => {
  const tuned: string[] = []
  const context: any = { state: { view: 'channels', overlay: 'guide', catalog: { channelId: 'nick' } }, document: { activeElement: {} }, elements: {}, closestFocusable: () => null, tuneCatalogChannelLive: (id: string) => tuned.push(id) }
  runInNewContext(extract('  function handleKeyDown(event)', '  function moveFocus('), context)
  context.handleKeyDown({ key: 'Enter', target: { tagName: 'BODY' }, preventDefault: () => {} })
  expect(tuned).toEqual(['nick'])
})
test('recent stale guide data remains readable while old entries expire', () => {
  const entry = { fetchedAt: 0, programs: [1] }
  const context: any = { state: { guideCache: { 'nick:0': entry } }, Date: { now: () => 6 * 60000 } }
  runInNewContext(extract('  function guideDayCacheKey(', '  function cancelGuidePrefetch('), context)
  expect(context.getCachedGuideDay('nick', 0)).toBe(entry)
  context.Date.now = () => 31 * 60000
  expect(context.getCachedGuideDay('nick', 0)).toBeNull()
})
test('unchanged card logos reuse the loaded image', () => {
  const context: any = { elements: { channelGrid: { querySelector: () => ({ querySelector: () => ({ getAttribute: () => '/nick.png' }) }) } }, channelBrandingUrl: () => '/nick.png', escapeAttribute: (s: string) => s, clearChildren: () => { throw new Error('Logo discarded') } }
  runInNewContext(extract('  function renderChannelCardLogo(', '  function channelBrandingUrl('), context)
  context.renderChannelCardLogo('nick', {})
})

test('remote OK tunes the focused channel directly even without offsetParent', () => {
  const tuned: number[] = []
  const card = { getAttribute: (key: string) => key === 'data-channel-index' ? '2' : null }
  const context: any = { state: { view: 'channels', overlay: null }, document: { activeElement: card }, elements: {}, closestFocusable: () => card, tuneChannel: (index: number) => tuned.push(index) }
  runInNewContext(extract('  function handleKeyDown(event)', '  function moveFocus('), context)
  context.handleKeyDown({ key: 'OK', target: { tagName: 'BUTTON' }, preventDefault: () => {} })
  context.handleKeyDown({ key: 'OK', repeat: true, target: { tagName: 'BUTTON' }, preventDefault: () => {} })
  expect(tuned).toEqual([2])
})
