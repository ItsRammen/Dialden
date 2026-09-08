import { expect, test } from 'bun:test'
const { createProgressWatchdog } = require('../clients/webos/playback-policy.js')
const sample = (now: number, time = 10, frames: number | null = null, enabled = true, key = 'nick') => ({now,time,frames,enabled,key})
test('detects an eventless freeze and throttles retries', () => {
  const check = createProgressWatchdog(20000)
  expect(check(sample(0))).toBe(false)
  expect(check(sample(19000))).toBe(false)
  expect(check(sample(20000))).toBe(true)
  expect(check(sample(21000))).toBe(false)
  expect(check(sample(40000))).toBe(true)
})
test('advancing playback and static cards with advancing frames stay healthy', () => {
  const check = createProgressWatchdog(20000)
  for (let n = 0; n < 90; n++) expect(check(sample(n * 1000, n, n * 30 + 1))).toBe(false)
})
test('detects frozen video frames even when the media clock advances', () => {
  const check = createProgressWatchdog(20000)
  expect(check(sample(0, 10, 300))).toBe(false)
  expect(check(sample(1000, 11, 330))).toBe(false)
  expect(check(sample(10000, 20, 330))).toBe(false)
  expect(check(sample(21000, 31, 330))).toBe(true)
})
test('pauses, backgrounding and source changes reset observation', () => {
  const check = createProgressWatchdog(20000)
  check(sample(0)); expect(check(sample(60000, 10, null, false))).toBe(false)
  expect(check(sample(61000))).toBe(false)
  expect(check(sample(80000, 10, null, true, 'disney'))).toBe(false)
  expect(check(sample(99000, 10, null, true, 'disney'))).toBe(false)
})

test('does not trust a frame counter that has never advanced', () => {
  const check = createProgressWatchdog(20000)
  for (let n = 0; n < 60; n++) expect(check(sample(n * 1000, n, 1))).toBe(false)
})
