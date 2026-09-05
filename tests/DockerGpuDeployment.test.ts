import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const readRootFile = (name: string): string =>
  readFileSync(join(root, name), 'utf8')

describe('Docker Intel GPU deployment', () => {
  test('keeps programme mounts read-only while making only Station Assets writable', () => {
    const compose = readRootFile('docker-compose.yml')
    const template = readRootFile('templates/toasttv.xml')
    const stationAssets = template.match(
      /<Config Name="Station Assets"[^>]*>[^<]*<\/Config>/
    )?.[0]

    expect(compose).not.toContain('TOASTTV_STATION_ASSETS_WRITABLE')
    expect(compose).toContain('TOASTTV_STATION_ASSETS_PATH')
    expect(compose).toMatch(/target: \/media\/interludes\s+read_only: false/)
    expect(stationAssets).toContain('Target="/media/interludes"')
    expect(stationAssets).toContain('Mode="rw"')
    expect(template).not.toContain('TOASTTV_STATION_ASSETS_WRITABLE')
  })

  test('maps the DRM directory independently from the FFmpeg render node', () => {
    const override = readRootFile('docker-compose.qsv.yml')
    const environment = readRootFile('docker-compose.env.example')

    expect(override).toContain('- "/dev/dri:/dev/dri"')
    expect(override).not.toContain('${TOASTTV_QSV_DEVICE')
    expect(environment).toMatch(
      /^TOASTTV_QSV_DEVICE=\/dev\/dri\/renderD128$/m
    )
  })

  test('keeps the Unraid mapping optional and the probe default concrete', () => {
    const template = readRootFile('templates/toasttv.xml')
    const deviceMapping = template.match(
      /<Config Name="Intel GPU Device Mapping"[^>]*><\/Config>/
    )?.[0]
    const probeSetting = template.match(
      /<Config Name="Quick Sync Device"[^>]*>[^<]*<\/Config>/
    )?.[0]

    expect(deviceMapping).toContain('Target="/dev/dri"')
    expect(deviceMapping).toContain('Default=""')
    expect(deviceMapping).toContain('Type="Device"')
    expect(probeSetting).toContain('Target="TOASTTV_QSV_DEVICE"')
    expect(probeSetting).toContain('>/dev/dri/renderD128</Config>')
  })

  test('preserves injected media groups while adding every render-node group', () => {
    const entrypoint = readRootFile('docker-entrypoint.sh')

    expect(entrypoint).toContain('for inherited_gid in $(id -G')
    expect(entrypoint).toContain('"$qsv_directory"/renderD*')
    expect(entrypoint).toContain('--groups "$supplemental_groups"')
    expect(entrypoint).not.toContain('exec gosu')
  })

  test('does not abort startup when the optional GPU device is absent', () => {
    const entrypoint = readRootFile('docker-entrypoint.sh')

    // With `set -e`, a bare `return` inherits the failed `-c` test status and
    // exits the whole entrypoint before ToastTV can use its CPU fallback.
    expect(entrypoint).toContain('[ -c "$candidate_node" ] || return 0')
    expect(entrypoint).not.toMatch(/\|\| return\s*$/m)
  })
})
