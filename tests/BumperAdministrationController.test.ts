import { describe, expect, test } from 'bun:test'
import { mock } from 'jest-mock-extended'
import { createBumperAdministrationController } from '../src/controllers/BumperAdministrationController'
import type { BumperAdministrationService } from '../src/services/BumperAdministrationService'
import type { CollectionLibraryService } from '../src/services/CollectionLibraryService'

function fixture(writable = true) {
  let enabled = writable
  const bumpers = mock<BumperAdministrationService>()
  const library = mock<CollectionLibraryService>()
  bumpers.scan.mockResolvedValue({ items: [], recognized: 0, invalid: 0, legacy: 0, playable: 0 })
  bumpers.directoryStatus.mockImplementation(async () => ({ path: '/media/interludes', state: 'ready', changesEnabled: enabled, writable: enabled, message: 'Folder connected' }))
  library.list.mockResolvedValue([])
  return { bumpers, app: createBumperAdministrationController({ bumpers, library, writable: async () => enabled, setWritable: async (value) => { enabled = value } }) }
}

function batch() {
  const body = new FormData()
  body.set('station', 'Nick')
  body.set('kind', 'ident-general')
  body.set('targetSeconds', '8')
  body.set('variant', '1')
  body.append('file', new File(['first'], 'first.mp4'))
  body.append('file', new File(['second'], 'second.mp4'))
  return body
}

describe('Bumper import', () => {
  test('the page control enables and revokes imports without rebuilding the controller', async () => {
    const { app, bumpers } = fixture(false)
    expect((await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })).status).toBe(403)
    const enable = await app.request('/library/bumpers/access', { method: 'POST', body: new URLSearchParams({ enabled: 'true' }) })
    expect(enable.status).toBe(303)
    expect((await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })).status).toBe(200)
    await app.request('/library/bumpers/access', { method: 'POST', body: new URLSearchParams({ enabled: 'false' }) })
    expect((await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })).status).toBe(403)
    expect(bumpers.upload).toHaveBeenCalledTimes(2)
  })

  test('reports folder failures once, without a contradictory scan or read-only banner', async () => {
    const { app, bumpers } = fixture(false)
    bumpers.directoryStatus.mockResolvedValue({ path: '/media/interludes', state: 'missing', changesEnabled: false, writable: false, message: 'Folder not found inside ToastTV.' })
    const html = await (await app.request('/library/bumpers?notice=scan')).text()
    expect(html.match(/Folder not found inside ToastTV\./g)).toHaveLength(1)
    expect(html).not.toContain('The Station Assets library is read-only')
    expect(html).not.toContain('Scan complete:')
    expect(html).toContain('Enable station asset changes')
  })

  test('imports every selected clip with shared settings', async () => {
    const { bumpers, app } = fixture()
    const response = await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Imported 2 of 2 clips.')
    expect(bumpers.upload).toHaveBeenCalledTimes(2)
    expect(bumpers.upload.mock.calls.map((call) => call[0])).toEqual(['first.mp4', 'second.mp4'])
    expect(bumpers.upload.mock.calls[1]?.[2]).toMatchObject({ station: 'Nick', kind: 'ident-general', variant: 1 })
  })

  test('reports partial failure and continues importing the other clips', async () => {
    const { bumpers, app } = fixture()
    bumpers.upload.mockRejectedValueOnce(new Error('Unsupported clip'))
    const response = await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })
    expect(response.status).toBe(400)
    const html = await response.text()
    expect(html).toContain('Imported 1 of 2 clips.')
    expect(html).toContain('first.mp4: Unsupported clip')
    expect(bumpers.upload).toHaveBeenCalledTimes(2)
  })

  test('refuses imports into a library configured as read-only', async () => {
    const { bumpers, app } = fixture(false)
    const response = await app.request('/library/bumpers/upload', { method: 'POST', body: batch() })
    expect(response.status).toBe(403)
    expect(bumpers.upload).not.toHaveBeenCalled()
  })

  test('shows a connected empty folder separately from its empty index', async () => {
    const { app } = fixture()
    const response = await app.request('/library/bumpers')
    const html = await response.text()
    expect(html).toContain('Folder connected')
    expect(html).toContain('/media/interludes')
    expect(html).toContain('No clips indexed yet')
  })
})
