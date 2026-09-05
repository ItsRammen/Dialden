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
      return c.html('<p class="hint">Measuring…</p>')
    }

    const cpu =
      sample.cpuPercent === null
        ? 'unavailable'
        : `${sample.cpuPercent.toFixed(1)}% of ${sample.cores} cores`

    const gpu = sample.gpu.available
      ? `${sample.gpu.busyPercent?.toFixed(0)}% busy`
      : sample.gpu.frequencyMhz !== undefined
        ? `${sample.gpu.frequencyMhz} MHz of ${sample.gpu.maxFrequencyMhz} MHz`
        : 'not reported by this driver'

    const channels = [...sample.channels].sort(
      (left, right) => right.cpuPercent - left.cpuPercent
    )
    const rows = channels.length
      ? channels
          .map(
            (item) =>
              `<div><dt>${escapeHtml(item.channelId)} <span class="profile-badge">${
                item.hardware ? 'media engine' : 'software'
              }</span></dt><dd>${item.cpuPercent.toFixed(0)}% of one core</dd></div>`
          )
          .join('')
      : '<div><dt>Channels</dt><dd>none running</dd></div>'

    return c.html(
      `<dl class="settings-status-list">
         <div><dt>Server CPU</dt><dd>${cpu}</dd></div>
         <div><dt>Media engine</dt><dd>${escapeHtml(gpu)}${
           sample.gpu.available || sample.gpu.frequencyMhz === undefined
             ? ''
             : ' <span class="hint">frequency, not utilisation</span>'
         }</dd></div>
         <div><dt>Pipelines</dt><dd>${sample.gpu.hardwarePipelines} on the media engine, ${sample.gpu.softwarePipelines} in software</dd></div>
         ${rows}
       </dl>`
    )
  })

  return controller
}
