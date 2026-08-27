const PACKET_SIZE = 188
const CLOCK_WRAP_90K = 0x2_0000_0000

export interface MpegTsTransportState {
  readonly programSignature?: string
  readonly nextTimestamp90k?: number
  /** Next payload continuity counter for each decimal PID. */
  readonly continuityCounters: Readonly<Record<string, number>>
}

export interface MpegTsSpliceResult {
  readonly bytes: Uint8Array
  readonly state: MpegTsTransportState
}

export class MpegTsTransportIncompatibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MpegTsTransportIncompatibleError'
  }
}

interface PacketInfo {
  readonly offset: number
  readonly pid: number
  readonly payloadStart: boolean
  readonly adaptationControl: number
  readonly payloadOffset: number | null
}

/**
 * Re-times one independently muxed MPEG-TS segment onto a viewer's continuous
 * transport clock. Packet payloads and encoded media are never decoded.
 */
export function spliceMpegTsSegment(
  input: Uint8Array,
  durationSeconds: number,
  previous: MpegTsTransportState
): MpegTsSpliceResult {
  if (
    input.byteLength < PACKET_SIZE ||
    input.byteLength % PACKET_SIZE !== 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new MpegTsTransportIncompatibleError(
      'Segment is not a complete MPEG-TS presentation'
    )
  }

  const bytes = Uint8Array.from(input)
  const packets: PacketInfo[] = []
  for (let offset = 0; offset < bytes.length; offset += PACKET_SIZE) {
    if (bytes[offset] !== 0x47) {
      throw new MpegTsTransportIncompatibleError(
        `MPEG-TS sync byte is missing at packet ${offset / PACKET_SIZE}`
      )
    }
    const adaptationControl = (bytes[offset + 3]! >> 4) & 0x03
    if (adaptationControl === 0) {
      throw new MpegTsTransportIncompatibleError(
        'MPEG-TS packet uses a reserved adaptation-field control'
      )
    }
    packets.push({
      offset,
      pid: ((bytes[offset + 1]! & 0x1f) << 8) | bytes[offset + 2]!,
      payloadStart: (bytes[offset + 1]! & 0x40) !== 0,
      adaptationControl,
      payloadOffset: packetPayloadOffset(bytes, offset, adaptationControl),
    })
  }

  const programSignature = readProgramSignature(bytes, packets)
  if (!programSignature) {
    throw new MpegTsTransportIncompatibleError(
      'Segment does not contain a complete PAT and PMT'
    )
  }
  if (
    previous.programSignature &&
    previous.programSignature !== programSignature
  ) {
    throw new MpegTsTransportIncompatibleError(
      'Target channel transport program map is incompatible'
    )
  }

  const reference = firstTransportTimestamp90k(bytes, packets)
  if (reference === null) {
    throw new MpegTsTransportIncompatibleError(
      'Segment does not expose a PCR, PTS, or DTS clock reference'
    )
  }
  const outputReference = previous.nextTimestamp90k ?? reference
  const timestampOffset = outputReference - reference
  const counters: Record<string, number> = {
    ...previous.continuityCounters,
  }

  for (const packet of packets) {
    rewriteContinuityCounter(bytes, packet, counters)
    rewritePacketTimestamps(bytes, packet, timestampOffset)
  }

  return {
    bytes,
    state: {
      programSignature,
      nextTimestamp90k: wrap90k(
        outputReference + Math.max(1, Math.round(durationSeconds * 90_000))
      ),
      continuityCounters: counters,
    },
  }
}

function packetPayloadOffset(
  bytes: Uint8Array,
  offset: number,
  adaptationControl: number
): number | null {
  if (adaptationControl === 2) return null
  if (adaptationControl === 1) return offset + 4
  const adaptationLength = bytes[offset + 4]!
  const payloadOffset = offset + 5 + adaptationLength
  return payloadOffset < offset + PACKET_SIZE ? payloadOffset : null
}

function rewriteContinuityCounter(
  bytes: Uint8Array,
  packet: PacketInfo,
  counters: Record<string, number>
): void {
  const key = String(packet.pid)
  const hasPayload = packet.adaptationControl === 1 || packet.adaptationControl === 3
  const existing = bytes[packet.offset + 3]! & 0x0f
  if (hasPayload) {
    const assigned = counters[key] ?? existing
    bytes[packet.offset + 3] =
      (bytes[packet.offset + 3]! & 0xf0) | assigned
    counters[key] = (assigned + 1) & 0x0f
    return
  }
  if (counters[key] !== undefined) {
    bytes[packet.offset + 3] =
      (bytes[packet.offset + 3]! & 0xf0) |
      ((counters[key]! + 15) & 0x0f)
  }
}

function firstTransportTimestamp90k(
  bytes: Uint8Array,
  packets: readonly PacketInfo[]
): number | null {
  for (const packet of packets) {
    const pcr = readPcrBase(bytes, packet)
    if (pcr !== null) return pcr
    const timestamps = readPesTimestampOffsets(bytes, packet)
    if (timestamps.length > 0) return readTimestamp(bytes, timestamps[0]!)
  }
  return null
}

function rewritePacketTimestamps(
  bytes: Uint8Array,
  packet: PacketInfo,
  offset90k: number
): void {
  if (
    (packet.adaptationControl === 2 || packet.adaptationControl === 3) &&
    bytes[packet.offset + 4]! > 0
  ) {
    // The tuner has proven and rewritten continuity itself. Carrying a source
    // muxer's discontinuity_indicator across the splice would still invite a
    // native TV decoder reset even without an HLS discontinuity tag.
    bytes[packet.offset + 5] = bytes[packet.offset + 5]! & 0x7f
  }
  const pcrOffset = pcrByteOffset(bytes, packet)
  if (pcrOffset !== null) {
    writePcrBase(
      bytes,
      pcrOffset,
      wrap90k(readPcrBaseAt(bytes, pcrOffset) + offset90k)
    )
  }
  for (const timestampOffset of readPesTimestampOffsets(bytes, packet)) {
    writeTimestamp(
      bytes,
      timestampOffset,
      wrap90k(readTimestamp(bytes, timestampOffset) + offset90k)
    )
  }
}

function pcrByteOffset(
  bytes: Uint8Array,
  packet: PacketInfo
): number | null {
  if (packet.adaptationControl !== 2 && packet.adaptationControl !== 3) return null
  const length = bytes[packet.offset + 4]!
  if (length < 7 || (bytes[packet.offset + 5]! & 0x10) === 0) return null
  return packet.offset + 6
}

function readPcrBase(
  bytes: Uint8Array,
  packet: PacketInfo
): number | null {
  const offset = pcrByteOffset(bytes, packet)
  return offset === null ? null : readPcrBaseAt(bytes, offset)
}

function readPcrBaseAt(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x2000000 +
    bytes[offset + 1]! * 0x20000 +
    bytes[offset + 2]! * 0x200 +
    bytes[offset + 3]! * 2 +
    (bytes[offset + 4]! >> 7)
  )
}

function writePcrBase(
  bytes: Uint8Array,
  offset: number,
  value: number
): void {
  const extension = ((bytes[offset + 4]! & 0x01) << 8) | bytes[offset + 5]!
  let remaining = wrap90k(value)
  bytes[offset] = Math.floor(remaining / 0x2000000) & 0xff
  remaining %= 0x2000000
  bytes[offset + 1] = Math.floor(remaining / 0x20000) & 0xff
  remaining %= 0x20000
  bytes[offset + 2] = Math.floor(remaining / 0x200) & 0xff
  remaining %= 0x200
  bytes[offset + 3] = Math.floor(remaining / 2) & 0xff
  bytes[offset + 4] =
    ((remaining & 0x01) << 7) | 0x7e | ((extension >> 8) & 0x01)
  bytes[offset + 5] = extension & 0xff
}

function readPesTimestampOffsets(
  bytes: Uint8Array,
  packet: PacketInfo
): number[] {
  const start = packet.payloadOffset
  if (
    !packet.payloadStart ||
    start === null ||
    start + 14 > packet.offset + PACKET_SIZE ||
    bytes[start] !== 0 ||
    bytes[start + 1] !== 0 ||
    bytes[start + 2] !== 1
  ) {
    return []
  }
  const flags = (bytes[start + 7]! >> 6) & 0x03
  const headerLength = bytes[start + 8]!
  const headerEnd = start + 9 + headerLength
  if (headerEnd > packet.offset + PACKET_SIZE) return []
  if (flags === 2 && headerLength >= 5) return [start + 9]
  if (flags === 3 && headerLength >= 10) return [start + 9, start + 14]
  return []
}

function readTimestamp(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! >> 1) & 0x07) * 0x40000000 +
    bytes[offset + 1]! * 0x400000 +
    (bytes[offset + 2]! >> 1) * 0x8000 +
    bytes[offset + 3]! * 0x80 +
    (bytes[offset + 4]! >> 1)
  )
}

function writeTimestamp(
  bytes: Uint8Array,
  offset: number,
  value: number
): void {
  let remaining = wrap90k(value)
  const prefix = bytes[offset]! & 0xf0
  const high = Math.floor(remaining / 0x40000000) & 0x07
  remaining %= 0x40000000
  bytes[offset] = prefix | (high << 1) | 0x01
  bytes[offset + 1] = Math.floor(remaining / 0x400000) & 0xff
  remaining %= 0x400000
  bytes[offset + 2] =
    ((Math.floor(remaining / 0x8000) & 0x7f) << 1) | 0x01
  remaining %= 0x8000
  bytes[offset + 3] = Math.floor(remaining / 0x80) & 0xff
  bytes[offset + 4] = ((remaining & 0x7f) << 1) | 0x01
}

function readProgramSignature(
  bytes: Uint8Array,
  packets: readonly PacketInfo[]
): string | null {
  let pmtPid: number | null = null
  for (const packet of packets) {
    if (packet.pid !== 0) continue
    const section = psiSectionOffset(bytes, packet)
    if (section === null || bytes[section] !== 0x00) continue
    const sectionLength = ((bytes[section + 1]! & 0x0f) << 8) |
      bytes[section + 2]!
    const end = section + 3 + sectionLength - 4
    for (let cursor = section + 8; cursor + 4 <= end; cursor += 4) {
      const program = (bytes[cursor]! << 8) | bytes[cursor + 1]!
      if (program !== 0) {
        pmtPid = ((bytes[cursor + 2]! & 0x1f) << 8) |
          bytes[cursor + 3]!
        break
      }
    }
    if (pmtPid !== null) break
  }
  if (pmtPid === null) return null

  for (const packet of packets) {
    if (packet.pid !== pmtPid) continue
    const section = psiSectionOffset(bytes, packet)
    if (section === null || bytes[section] !== 0x02) continue
    const sectionLength = ((bytes[section + 1]! & 0x0f) << 8) |
      bytes[section + 2]!
    const end = section + 3 + sectionLength - 4
    if (end > packet.offset + PACKET_SIZE || section + 12 > end) continue
    const program = (bytes[section + 3]! << 8) | bytes[section + 4]!
    const pcrPid = ((bytes[section + 8]! & 0x1f) << 8) |
      bytes[section + 9]!
    const programInfoLength = ((bytes[section + 10]! & 0x0f) << 8) |
      bytes[section + 11]!
    const streams: string[] = []
    for (
      let cursor = section + 12 + programInfoLength;
      cursor + 5 <= end;
    ) {
      const streamType = bytes[cursor]!
      const pid = ((bytes[cursor + 1]! & 0x1f) << 8) |
        bytes[cursor + 2]!
      const infoLength = ((bytes[cursor + 3]! & 0x0f) << 8) |
        bytes[cursor + 4]!
      streams.push(`${streamType.toString(16)}:${pid}`)
      cursor += 5 + infoLength
    }
    if (streams.length > 0) {
      return `${program}|${pmtPid}|${pcrPid}|${streams.join(',')}`
    }
  }
  return null
}

function psiSectionOffset(
  bytes: Uint8Array,
  packet: PacketInfo
): number | null {
  const payload = packet.payloadOffset
  if (!packet.payloadStart || payload === null) return null
  const section = payload + 1 + bytes[payload]!
  return section + 3 <= packet.offset + PACKET_SIZE ? section : null
}

function wrap90k(value: number): number {
  return ((Math.round(value) % CLOCK_WRAP_90K) + CLOCK_WRAP_90K) % CLOCK_WRAP_90K
}
