import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { createResourceController } from '../src/controllers/ResourceController'
import type { ResourceMonitorService, ResourceSample } from '../src/services/ResourceMonitorService'

const sample: ResourceSample = {
  cpuPercent: 19.7, cores: 8, intervalMs: 5000,
  gpu: { available: false, frequencyMhz: 800, hardwarePipelines: 1, softwarePipelines: 0 },
  channels: [{ channelId: '<Nick>', hardware: true, cpuPercent: 150 }],
}
async function view(value: ResourceSample) {
  const monitor = mock<ResourceMonitorService>()
  monitor.sample.mockReturnValue(value)
  return (await createResourceController({ monitor, processes: () => [] }).request('/api/admin/v1/resources/view')).text()
}
describe('resource usage presentation', () => {
  test('distinguishes total CPU, per-core CPU and frequency without inventing utilization', async () => {
    const html = await view(sample)
    expect(html).toContain('19.7%')
    expect(html).toContain('Share of all 8 CPU cores')
    expect(html).toContain('150.0%')
    expect(html).toContain('800 MHz')
    expect(html).toContain('Clock frequency, not utilization')
    expect(html).not.toContain('undefined')
    expect(html).toContain('&lt;Nick&gt;')
    expect(html).not.toContain('<Nick>')
  })
  test('shows measured utilization and an explicit idle state', async () => {
    const html = await view({ ...sample, channels: [], gpu: { available: true, busyPercent: 20, hardwarePipelines: 0, softwarePipelines: 0 } })
    expect(html).toContain('20%')
    expect(html).toContain('No channels are running')
    expect(html).not.toContain('<table')
  })
})
