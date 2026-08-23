import { Hono } from 'hono'
import type { IMediaRepository } from '../repositories/IMediaRepository'

interface HealthControllerDeps {
  database: IMediaRepository
  checkFfmpeg?: () => Promise<boolean>
}

async function commandIsAvailable(command: string): Promise<boolean> {
  try {
    const process = Bun.spawn([command, '-version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return (await process.exited) === 0
  } catch {
    return false
  }
}

async function checkFfmpegToolchain(): Promise<boolean> {
  const [ffmpeg, ffprobe] = await Promise.all([
    commandIsAvailable('ffmpeg'),
    commandIsAvailable('ffprobe'),
  ])
  return ffmpeg && ffprobe
}

export function createHealthController(deps: HealthControllerDeps): Hono {
  const controller = new Hono()

  controller.get('/api/v1/health', async (c) => {
    let databaseOk = false
    try {
      await deps.database.getAllSettings()
      databaseOk = true
    } catch {
      databaseOk = false
    }

    const ffmpegOk = await (deps.checkFfmpeg ?? checkFfmpegToolchain)()
    const healthy = databaseOk && ffmpegOk

    return c.json(
      {
        status: healthy ? 'ok' : 'degraded',
        database: databaseOk ? 'ok' : 'error',
        ffmpeg: ffmpegOk ? 'ok' : 'unavailable',
      },
      healthy ? 200 : 503
    )
  })

  return controller
}
