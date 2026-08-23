import type { ChannelAdministrationSnapshot } from '../services/ChannelService'
import type { LibraryChannelPolicy } from '../config/library'
import { renderLayout } from './layout'
import { escapeHtml } from './utils'

interface ChannelAdministrationOptions {
  readonly editId?: string
  readonly error?: string
  readonly changed?: 'created' | 'updated' | 'deleted'
}

export function renderChannelAdministration(
  snapshot: ChannelAdministrationSnapshot,
  options: ChannelAdministrationOptions = {}
): string {
  const edit = snapshot.channels.find((channel) => channel.id === options.editId)
  const groups = snapshot.programmingGroups
  const offAir = new Set(snapshot.manuallyOffAir)

  return renderLayout(
    'Channels',
    `<link rel="stylesheet" href="/css/channels.css">
    <div class="channel-admin">
      <header class="channel-admin-hero">
        <div>
          <p class="channel-admin-eyebrow">Broadcast setup</p>
          <h1>Channels</h1>
          <p>Create schedules from approved collections. Channel settings are saved in appdata and take effect immediately.</p>
        </div>
        <a class="channel-admin-link" href="/">Back to dashboard</a>
      </header>

      ${
        snapshot.configurationError
          ? `<p class="channel-admin-alert channel-admin-alert-error"><strong>Saved configuration was rejected.</strong> ${escapeHtml(snapshot.configurationError)}. No persisted channel was activated.</p>`
          : ''
      }
      ${
        options.error
          ? `<p class="channel-admin-alert channel-admin-alert-error">${escapeHtml(options.error)}</p>`
          : ''
      }
      ${
        options.changed
          ? `<p class="channel-admin-alert channel-admin-alert-success">Channel ${escapeHtml(options.changed)} successfully. The live schedule has been reloaded.</p>`
          : ''
      }

      <section class="channel-admin-grid" aria-label="Configured channels">
        ${
          snapshot.channels.length > 0
            ? snapshot.channels
                .map((channel) => renderChannelCard(channel, offAir.has(channel.id)))
                .join('')
            : '<p class="channel-admin-empty">No channels are configured. Add one below.</p>'
        }
      </section>

      <section class="channel-admin-editor" id="editor">
        <header>
          <div>
            <p class="channel-admin-eyebrow">${edit ? 'Edit channel' : 'New channel'}</p>
            <h2>${edit ? escapeHtml(edit.name) : 'Add a channel'}</h2>
          </div>
          ${edit ? '<a href="/channels#editor">Cancel edit</a>' : ''}
        </header>
        <form method="post" action="${edit ? `/channels/${encodeURIComponent(edit.id)}` : '/channels'}">
          <div class="channel-admin-fields">
            <label>Channel ID
              <input name="id" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value="${escapeHtml(edit?.id ?? '')}" ${edit ? 'readonly' : ''} placeholder="cartoon-classics">
              <small>Stable identifier used by TV clients; it cannot be renamed.</small>
            </label>
            <label>Display name
              <input name="name" required maxlength="100" value="${escapeHtml(edit?.name ?? '')}" placeholder="Cartoon Classics">
            </label>
            <label>Timezone
              <input name="timezone" required maxlength="100" value="${escapeHtml(edit?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}" placeholder="America/New_York">
              <small>Use an IANA timezone such as America/New_York or Asia/Taipei.</small>
            </label>
            <label class="channel-admin-checkbox"><input type="checkbox" name="enabled" ${edit?.enabled === false ? '' : 'checked'}> Enabled and visible to TV clients</label>
          </div>
          <label>Schedule slots
            <textarea name="slots" rows="9" spellcheck="false" placeholder="mon,tue,wed,thu,fri | 06:30-08:30 | comfort,learning">${escapeHtml(formatSlots(edit?.slots ?? []))}</textarea>
          </label>
          <p class="channel-admin-help">Enter one slot per line: <code>days | start-end | programming groups</code>. Times use 24-hour local channel time and slots cannot cross midnight.</p>
          <div class="channel-admin-groups">
            <strong>Groups currently assigned by the library policy</strong>
            ${
              groups.length > 0
                ? `<div>${groups.map((group) => `<code>${escapeHtml(group)}</code>`).join('')}</div>`
                : '<p>No collection programming groups are configured. A channel can be saved, but it will have no eligible programming until collections have group assignments.</p>'
            }
          </div>
          <button type="submit">${edit ? 'Save channel' : 'Create channel'}</button>
        </form>
      </section>
    </div>`
  )
}

function renderChannelCard(
  channel: LibraryChannelPolicy,
  manuallyOffAir: boolean
): string {
  const state = !channel.enabled
    ? 'Disabled'
    : manuallyOffAir
      ? 'Manually off air'
      : 'Enabled'
  return `<article class="channel-admin-card">
    <header>
      <div><h2>${escapeHtml(channel.name)}</h2><code>${escapeHtml(channel.id)}</code></div>
      <span class="channel-admin-state channel-admin-state-${!channel.enabled ? 'disabled' : manuallyOffAir ? 'off' : 'enabled'}">${state}</span>
    </header>
    <dl>
      <div><dt>Timezone</dt><dd>${escapeHtml(channel.timezone)}</dd></div>
      <div><dt>Schedule slots</dt><dd>${channel.slots.length}</dd></div>
    </dl>
    <div class="channel-admin-actions">
      <a href="/channels?edit=${encodeURIComponent(channel.id)}#editor">Edit</a>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/enabled">
        <input type="hidden" name="enabled" value="${channel.enabled ? 'false' : 'true'}">
        <button type="submit">${channel.enabled ? 'Disable' : 'Enable'}</button>
      </form>
      <form method="post" action="/channels/${encodeURIComponent(channel.id)}/delete" onsubmit="return confirm('Delete this channel?')">
        <button class="channel-admin-danger" type="submit">Delete</button>
      </form>
    </div>
  </article>`
}

function formatSlots(slots: LibraryChannelPolicy['slots']): string {
  return slots
    .map(
      (slot) =>
        `${slot.days.join(',')} | ${slot.start}-${slot.end} | ${slot.groups.join(',')}`
    )
    .join('\n')
}
