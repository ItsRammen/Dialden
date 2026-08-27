import { describe, expect, test } from 'bun:test'
import {
  MpegTsTransportIncompatibleError,
  spliceMpegTsSegment,
  type MpegTsTransportState,
} from '../src/services/MpegTsTransportSplicer'

const PACKET_SIZE = 188

describe('MPEG-TS transport splicer', () => {
  test('keeps timestamps and continuity counters monotonic across channel segments', () => {
    const first = spliceMpegTsSegment(
      segment({ timestamp: 900_000, patCounter: 7, videoCounter: 3 }),
      1,
      { continuityCounters: {} }
    )
    const secondInput = segment({ timestamp: 45_000, patCounter: 2, videoCounter: 12 })
    secondInput[2 * PACKET_SIZE + 5] =
      secondInput[2 * PACKET_SIZE + 5]! | 0x80
    const second = spliceMpegTsSegment(
      secondInput,
      1,
      first.state
    )

    expect(first.state.programSignature).toBe('1|4096|256|1b:256,f:257')
    expect(first.state.nextTimestamp90k).toBe(990_000)
    expect(second.state.nextTimestamp90k).toBe(1_080_000)
    expect(readPcr(second.bytes, 2)).toBe(990_000)
    expect(readPts(second.bytes, 2)).toBe(990_900)
    expect(packetCounter(second.bytes, 0)).toBe(8)
    expect(packetCounter(second.bytes, 2)).toBe(4)
    expect(second.bytes[2 * PACKET_SIZE + 5]! & 0x80).toBe(0)
  })

  test('rejects a changed program map instead of guessing a seamless cut', () => {
    const first = spliceMpegTsSegment(segment({ timestamp: 0 }), 1, {
      continuityCounters: {},
    })
    expect(() =>
      spliceMpegTsSegment(
        segment({ timestamp: 90_000, audioPid: 300 }),
        1,
        first.state
      )
    ).toThrow(MpegTsTransportIncompatibleError)
  })

  test('rejects torn and non-transport input without emitting rewritten bytes', () => {
    const state: MpegTsTransportState = { continuityCounters: {} }
    expect(() => spliceMpegTsSegment(new Uint8Array(188), 1, state)).toThrow(
      'sync byte'
    )
    expect(() => spliceMpegTsSegment(new Uint8Array(187), 1, state)).toThrow(
      'complete MPEG-TS'
    )
  })
})

function segment(options: {
  timestamp: number
  patCounter?: number
  videoCounter?: number
  audioPid?: number
}): Uint8Array {
  const audioPid = options.audioPid ?? 257
  const packets = [
    psiPacket(0, options.patCounter ?? 0, patSection()),
    psiPacket(4096, 0, pmtSection(audioPid)),
    mediaPacket(256, options.videoCounter ?? 0, 0xe0, options.timestamp, true),
    mediaPacket(audioPid, 0, 0xc0, options.timestamp + 450, false),
  ]
  const bytes = new Uint8Array(PACKET_SIZE * packets.length)
  packets.forEach((packet, index) => bytes.set(packet, index * PACKET_SIZE))
  return bytes
}

function packet(pid: number, counter: number, payloadStart: boolean): Uint8Array {
  const value = new Uint8Array(PACKET_SIZE)
  value.fill(0xff)
  value[0] = 0x47
  value[1] = (payloadStart ? 0x40 : 0) | ((pid >> 8) & 0x1f)
  value[2] = pid & 0xff
  value[3] = 0x10 | (counter & 0x0f)
  return value
}

function psiPacket(pid: number, counter: number, section: Uint8Array): Uint8Array {
  const value = packet(pid, counter, true)
  value[4] = 0
  value.set(section, 5)
  return value
}

function patSection(): Uint8Array {
  return Uint8Array.from([
    0x00, 0xb0, 0x0d,
    0x00, 0x01, 0xc1, 0x00, 0x00,
    0x00, 0x01, 0xf0, 0x00,
    0, 0, 0, 0,
  ])
}

function pmtSection(audioPid: number): Uint8Array {
  return Uint8Array.from([
    0x02, 0xb0, 0x17,
    0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe1, 0x00,
    0xf0, 0x00,
    0x1b, 0xe1, 0x00, 0xf0, 0x00,
    0x0f, 0xe0 | ((audioPid >> 8) & 0x1f), audioPid & 0xff, 0xf0, 0x00,
    0, 0, 0, 0,
  ])
}

function mediaPacket(
  pid: number,
  counter: number,
  streamId: number,
  timestamp: number,
  withPcr: boolean
): Uint8Array {
  const value = packet(pid, counter, true)
  let payload = 4
  if (withPcr) {
    value[3] = 0x30 | (counter & 0x0f)
    value[4] = 7
    value[5] = 0x10
    writePcr(value, 6, timestamp)
    payload = 12
  }
  value.set([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5], payload)
  writeTimestamp(value, payload + 9, timestamp + 900, streamId === 0xe0 ? 0x20 : 0x20)
  return value
}

function writePcr(bytes: Uint8Array, offset: number, timestamp: number): void {
  let value = timestamp
  bytes[offset] = Math.floor(value / 0x2000000) & 0xff
  value %= 0x2000000
  bytes[offset + 1] = Math.floor(value / 0x20000) & 0xff
  value %= 0x20000
  bytes[offset + 2] = Math.floor(value / 0x200) & 0xff
  value %= 0x200
  bytes[offset + 3] = Math.floor(value / 2) & 0xff
  bytes[offset + 4] = ((value & 1) << 7) | 0x7e
  bytes[offset + 5] = 0
}

function writeTimestamp(
  bytes: Uint8Array,
  offset: number,
  timestamp: number,
  prefix: number
): void {
  let value = timestamp
  const high = Math.floor(value / 0x40000000) & 7
  value %= 0x40000000
  bytes[offset] = prefix | (high << 1) | 1
  bytes[offset + 1] = Math.floor(value / 0x400000) & 0xff
  value %= 0x400000
  bytes[offset + 2] = ((Math.floor(value / 0x8000) & 0x7f) << 1) | 1
  value %= 0x8000
  bytes[offset + 3] = Math.floor(value / 0x80) & 0xff
  bytes[offset + 4] = ((value & 0x7f) << 1) | 1
}

function packetCounter(bytes: Uint8Array, packetIndex: number): number {
  return bytes[packetIndex * PACKET_SIZE + 3]! & 0x0f
}

function readPcr(bytes: Uint8Array, packetIndex: number): number {
  const offset = packetIndex * PACKET_SIZE + 6
  return bytes[offset]! * 0x2000000 +
    bytes[offset + 1]! * 0x20000 +
    bytes[offset + 2]! * 0x200 +
    bytes[offset + 3]! * 2 +
    (bytes[offset + 4]! >> 7)
}

function readPts(bytes: Uint8Array, packetIndex: number): number {
  const offset = packetIndex * PACKET_SIZE + 21
  return ((bytes[offset]! >> 1) & 7) * 0x40000000 +
    bytes[offset + 1]! * 0x400000 +
    (bytes[offset + 2]! >> 1) * 0x8000 +
    bytes[offset + 3]! * 0x80 +
    (bytes[offset + 4]! >> 1)
}
