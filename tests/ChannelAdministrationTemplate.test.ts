import { describe, expect, test } from 'bun:test'
import { renderChannelAdministration } from '../src/templates/channelAdministration'

describe('channel administration template', () => {
  test('renders editable schedules and escapes persisted display values', () => {
    const markup = renderChannelAdministration(
      {
        channels: [
          {
            id: 'kids',
            name: '<script>Kids</script>',
            enabled: true,
            timezone: 'UTC',
            slots: [
              {
                days: ['mon', 'tue'],
                start: '06:30',
                end: '08:30',
                groups: ['comfort', 'learning'],
              },
            ],
          },
        ],
        manuallyOffAir: ['kids'],
        programmingGroups: ['comfort', 'learning'],
        configurationError: null,
      },
      { editId: 'kids' }
    )

    expect(markup).toContain('Manually off air')
    expect(markup).toContain('mon,tue | 06:30-08:30 | comfort,learning')
    expect(markup).toContain('action="/channels/kids"')
    expect(markup).toContain('&lt;script&gt;Kids&lt;/script&gt;')
    expect(markup).not.toContain('<script>Kids</script>')
  })
})
