import type { MiddlewareHandler } from 'hono'

/** Short, bounded server-side history. Never retain URLs, queries or error text. */
export class PlaybackHealthService {
  private requests: { at: number; scope: string; status: number; ms: number; manifest: boolean }[] = []
  private lags: { at: number; ms: number }[] = []
  private timer?: ReturnType<typeof setInterval>
  private operations: { at: number; name: string; ms: number }[] = []

  async measure<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    const start = this.now()
    try { return await work() } finally {
      const at = this.now()
      const ms = Math.max(0, at - start)
      if (ms >= 250) {
        this.operations = [...this.operations.filter(item => item.at >= at - 60000), { at, name, ms }].slice(-40)
        console.warn('Slow playback operation', JSON.stringify({ at, name, ms }))
      }
    }
  }
  constructor(private readonly now = () => Date.now(), sample = true) {
    if (sample) {
      let previous = now()
      this.timer = setInterval(() => {
        const at = now()
        this.recordLag(Math.max(0, at - previous - 1000))
        previous = at
      }, 1000)
      this.timer.unref()
    }
  }
  stop(): void { if (this.timer) clearInterval(this.timer) }
  recordLag(ms: number): void {
    this.lags = [...this.lags.filter(x => x.at >= this.now() - 60000), { at: this.now(), ms }].slice(-120)
    if (ms >= 500) console.warn('Playback event-loop delay', JSON.stringify({ at: this.now(), ms }))
  }
  readonly middleware: MiddlewareHandler = async (c, next) => {
    const match = c.req.path.match(/^\/api\/v1\/(channels|tuner-sessions)\/([^/]+)\/live\/([^/]+)$/)
    if (!match || !['GET', 'HEAD'].includes(c.req.method)) {
      // Static categories only: never retain query strings, IDs, or credentials.
      const category = c.req.path.includes('/guide') ? 'request.guide'
        : c.req.path.includes('/schedule') ? 'request.schedule'
        : c.req.path.startsWith('/api/admin/') ? 'request.admin' : 'request.other'
      return this.measure(category, next)
    }
    const start = this.now()
    let status = 500
    try { await next(); status = c.res.status } finally {
      this.requests = [...this.requests.filter(x => x.at >= this.now() - 60000), {
        at: this.now(), scope: `${match[1]}:${match[2]}`, status,
        ms: Math.max(0, this.now() - start), manifest: match[3] === 'index.m3u8',
      }].slice(-2000)
    }
  }
  snapshot(channelId: string, sessionId?: string): Record<string, number | string> {
    const cutoff = this.now() - 60000
    const scope = sessionId ? `tuner-sessions:${encodeURIComponent(sessionId)}` : `channels:${encodeURIComponent(channelId)}`
    const requests = this.requests.filter(x => x.at >= cutoff && x.scope === scope)
    const lags = this.lags.filter(x => x.at >= cutoff)
    const lastSegment = requests.filter(x => !x.manifest && x.status < 400).at(-1)
    return {
      slowOperations60s: JSON.stringify(this.operations.filter(item => item.at >= cutoff)),
      serverEventLoopMaxDelayMs60s: Math.max(0, ...lags.map(x => x.ms)),
      hlsRequests60s: requests.length,
      hlsErrors60s: requests.filter(x => x.status >= 400).length,
      hlsExpiredSession60s: requests.filter(x => x.status === 410).length,
      hlsNotFound60s: requests.filter(x => x.status === 404).length,
      hlsUnavailable60s: requests.filter(x => x.status === 503).length,
      hlsMaxResponseSetupMs60s: Math.max(0, ...requests.map(x => x.ms)),
      hlsLastSegmentResponseAgeMs: lastSegment ? this.now() - lastSegment.at : -1,
    }
  }
}
