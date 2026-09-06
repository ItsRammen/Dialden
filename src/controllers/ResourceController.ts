import { Hono } from 'hono'
import type {
  ResourceMonitorService,
  ChannelProcess,
} from '../services/ResourceMonitorService'

interface ResourceControllerDeps {
  monitor: ResourceMonitorService
  /** Running pipelines, and whether each is on the media engine. */
  processes: () => ChannelProcess[]
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  )

/**
 * Live resource figures.
 *
 * Two consumers: JSON for anything scripted, and a small HTML fragment the
 * settings page polls. The fragment exists because the useful question after
 * switching a pipeline to the media engine — what does a channel cost now —
 * is not answerable from a page rendered once at load.
 */
export function createResourceController(deps: ResourceControllerDeps) {
  const { monitor, processes } = deps
  const controller = new Hono()

  controller.get('/api/admin/v1/resources', (c) =>
    c.json(monitor.sample(processes()))
  )

  controller.get('/api/admin/v1/resources/view', (c) => {
    const sample = monitor.sample(processes())
    if (sample.intervalMs === null) {
      // The first sample is a baseline; percentages need two.
      return c.html('<p class="engine-empty">Measuring usage… The first reading will appear in a few seconds.</p>')
    }

    const cpu = sample.cpuPercent === null ? 'Unavailable' : `${sample.cpuPercent.toFixed(1)}%`
    const busy = sample.gpu.available && typeof sample.gpu.busyPercent === 'number'
    const frequency = sample.gpu.frequencyMhz
    const gpu = busy ? `${sample.gpu.busyPercent!.toFixed(0)}%`
      : frequency !== undefined ? `${frequency} MHz` : 'Unavailable'
    const gpuDetail = busy ? 'Reported hardware utilization'
      : frequency !== undefined
        ? `Clock frequency, not utilization${sample.gpu.maxFrequencyMhz !== undefined ? ` · maximum ${sample.gpu.maxFrequencyMhz} MHz` : ''}`
        : 'This driver does not report hardware usage.'
    const channels = [...sample.channels].sort((left, right) => right.cpuPercent - left.cpuPercent)
    const rows = channels.map((item) => `<tr>
      <th scope="row">${escapeHtml(item.channelId)}</th>
      <td><span class="engine-path ${item.hardware ? 'engine-path-hardware' : ''}">${item.hardware ? 'Hardware' : 'Software'}</span></td>
      <td class="engine-number">${item.cpuPercent.toFixed(1)}%</td>
    </tr>`).join('')
    return c.html(`<div class="engine-metrics">
      <div class="engine-metric"><span>Server CPU</span><strong>${cpu}</strong><small>Share of all ${sample.cores} CPU cores</small></div>
      <div class="engine-metric"><span>Media engine</span><strong>${escapeHtml(gpu)}</strong><small>${escapeHtml(gpuDetail)}</small></div>
      <div class="engine-metric"><span>Active channels</span><strong>${channels.length}</strong><small>${sample.gpu.hardwarePipelines} hardware · ${sample.gpu.softwarePipelines} software</small></div>
    </div>
    <div class="engine-channel-header"><h4>Usage by channel</h4><span>Refreshes every 5 seconds</span></div>
    ${channels.length ? `<div class="engine-table-scroll"><table class="engine-table">
      <caption>Channel CPU is measured against one core and can exceed 100%.</caption>
      <thead><tr><th scope="col">Channel</th><th scope="col">Processing</th><th scope="col" class="engine-number">CPU / core</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
      : '<p class="engine-empty">No channels are running. Usage will appear when a viewer starts watching.</p>'}`)

  })

  return controller
}
