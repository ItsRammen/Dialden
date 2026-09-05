import type {
  BumperDirectoryStatus,
  BumperScanItem,
  BumperScanResult,
  BumperScanStatus,
} from '../services/BumperAdministrationService'
import type { StationAssetKind } from '../services/StationAssetService'
import { renderLayout, renderLibraryNavigation } from './layout'
import { escapeHtml, formatTime } from './utils'

export type BumperAdminFilter = 'all' | 'attention' | BumperScanStatus

export interface BumperAdministrationViewModel {
  readonly directory?: BumperDirectoryStatus
  readonly scan: BumperScanResult
  readonly filter: BumperAdminFilter
  readonly shows: readonly string[]
  readonly canChangeAccess?: boolean
  readonly writable: boolean
  readonly preview?: { readonly id: number; readonly filename: string }
  readonly notice?: { readonly kind: 'success' | 'warning'; readonly message: string }
  readonly updateAvailable?: boolean
}

const KINDS: ReadonlyArray<{ value: StationAssetKind; label: string }> = [
  { value: 'bumper-more', label: 'More of the same show' },
  { value: 'bumper-up-next', label: 'Up next' },
  { value: 'bumper-now-next', label: 'Now and next' },
  { value: 'ident-general', label: 'Generic station ident' },
  { value: 'filler-general', label: 'Duration filler' },
  { value: 'standby-loop', label: 'Standby loop' },
]

export function renderBumperAdministration(
  view: BumperAdministrationViewModel
): string {
  const visible = view.scan.items.filter((item) => matchesFilter(item, view.filter))
  const content = `
    <div class="bumper-admin">
      <header class="bumper-admin-header">
        <div>
          <p class="collection-eyebrow">Station continuity</p>
          <h1>Station Assets</h1>
          <p>Import clips, choose when they play, and manage your station identity.</p>
        </div>
        <form method="post" action="/library/bumpers/scan">
          <button class="btn btn-primary" type="submit">Scan bumper files</button>
        </form>
      </header>
      ${renderLibraryNavigation('bumpers')}
      ${view.notice ? `<div class="bumper-notice bumper-notice-${view.notice.kind}" role="status">${escapeHtml(view.notice.message)}</div>` : ''}
      ${view.directory ? `<section class="bumper-source" aria-label="Station assets folder">
        <strong>${view.directory.state !== 'ready' ? 'Folder needs attention' : view.directory.writable ? 'Folder connected · Changes enabled' : !view.directory.changesEnabled ? 'Folder connected · Changes disabled' : 'Folder connected · Read-only access'}</strong>
        <code>${escapeHtml(view.directory.path)}</code>
        <p>${escapeHtml(view.directory.message)}</p>
        ${view.canChangeAccess ? `<form class="bumper-access-control" method="post" action="/library/bumpers/access"><input type="hidden" name="enabled" value="${view.directory.changesEnabled ? 'false' : 'true'}"><button class="btn btn-secondary" type="submit">${view.directory.changesEnabled ? 'Disable station asset changes' : 'Enable station asset changes'}</button><span>Saved in <a href="/settings#library-services">Settings → Library</a>. No restart required.</span></form>` : ''}
        <details><summary>Unraid folder setup</summary><p>Use a <strong>Path</strong> mapping: your host folder (for example, <code>/mnt/user/Media/Interludes/</code>) → container path <code>${escapeHtml(view.directory.path)}</code>. Use Read/Write access for uploads. Apply the changes in Unraid, then select Scan bumper files. A connected empty folder is detected even when it has no videos.</p><p>Supported files: MP4, MKV, AVI, MOV, and WebM, including subfolders. Other formats are not imported. Files still need a valid duration and playback approval.</p></details>
      </section>` : ''}
      <section class="bumper-summary" aria-label="Bumper scan summary">
        ${summaryCard('Recognized', view.scan.recognized)}
        ${summaryCard('Needs naming', view.scan.invalid + view.scan.legacy)}
        ${summaryCard('Playable', view.scan.playable)}
        ${summaryCard('Scanned assets', view.scan.items.length)}
      </section>
      <section class="bumper-intake" aria-label="Add bumper assets">
        <details>
          <summary><strong>Upload finished clips</strong><span>Import one clip or a batch with shared settings</span></summary>
          <form method="post" action="/library/bumpers/upload" enctype="multipart/form-data" data-bumper-form data-new-bumper>
            <label class="bumper-file-field">Video files<input type="file" name="file" multiple accept=".mp4,.mkv,.mov,.webm,.avi" required${view.writable ? '' : ' disabled'}></label>
            <p class="bumper-upload-selection" data-upload-selection aria-live="polite">Up to 50 clips, 512 MB total. Shared settings apply to every clip; variants advance automatically.</p>
            <video class="bumper-upload-preview" data-upload-preview controls hidden preload="metadata"></video>
            ${renderNewAssetFields(false)}
            <div class="bumper-live-name"><span>Destination filename</span><code data-generated-name>Complete the fields to preview the name</code><small>An occupied variant automatically advances to the next available number.</small></div>
            <div class="bumper-actions"><span></span><button class="btn btn-primary" type="submit"${view.writable ? '' : ' disabled'}>Import clips</button></div>
          </form>
        </details>
        <details>
          <summary><strong>Design a simple bumper</strong><span>Render a branded 1080p clip with FFmpeg</span></summary>
          <form method="post" action="/library/bumpers/generate" data-bumper-form data-new-bumper data-designer>
            ${renderNewAssetFields(true)}
            <div class="bumper-design-colours">
              <label>Background<input name="background" type="color" value="#0b1220"></label>
              <label>Text<input name="foreground" type="color" value="#ffffff"></label>
              <label>Accent<input name="accent" type="color" value="#4f8cff"></label>
            </div>
            <div class="bumper-design-preview" data-design-preview>
              <span data-preview-eyebrow>UP NEXT</span>
              <strong data-preview-headline>Choose a show</strong>
              <small data-preview-support></small>
            </div>
            <div class="bumper-live-name"><span>Destination filename</span><code data-generated-name>Complete the fields to preview the name</code><small>An occupied variant automatically advances to the next available number.</small></div>
            <div class="bumper-actions"><small>Generated clips include silent stereo audio for smooth player transitions.</small><button class="btn btn-primary" type="submit"${view.writable ? '' : ' disabled'}>Render and configure</button></div>
          </form>
        </details>
      </section>
      <nav class="bumper-filters" aria-label="Bumper filters">
        ${filterLink('all', 'All', view.filter)}
        ${filterLink('attention', 'Needs attention', view.filter)}
        ${filterLink('recognized', 'Recognized', view.filter)}
        ${filterLink('invalid', 'Invalid names', view.filter)}
        ${filterLink('legacy', 'Legacy', view.filter)}
      </nav>
      <datalist id="bumper-show-titles">
        ${view.shows.map((show) => `<option value="${escapeHtml(show)}"></option>`).join('')}
      </datalist>
      <section class="bumper-assets" aria-label="Bumper assets">
        ${visible.length > 0 ? visible.map((item) => renderAsset(item, view)).join('') : `<p class="collection-empty">${view.scan.items.length ? 'No assets match this filter. Choose All to see the library.' : 'No clips indexed yet. Scan your connected folder or upload finished clips, then configure their station and playback.'}</p>`}
      </section>
      <p class="bumper-contract-link"><a href="/library/interludes">View all asset files</a>. Filenames follow <code>station__type__details__target-08s__v01.mp4</code>.</p>
    </div>
    <script>
      document.querySelectorAll('[data-bumper-form]').forEach((form) => {
        const slug = (value) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const update = () => {
          const kind = form.querySelector('[name="kind"]').value;
          form.querySelectorAll('[data-for-kind]').forEach((field) => {
            const kinds = field.dataset.forKind.split(' ');
            field.hidden = !kinds.includes(kind);
            field.querySelectorAll('input').forEach((input) => input.disabled = field.hidden);
          });
          if (form.matches('[data-new-bumper]')) {
            const value = (name) => form.querySelector('[name="' + name + '"]')?.value || '';
            const fields = [slug(value('station')) || 'station', kind];
            if (kind === 'bumper-more') fields.push('show-' + (slug(value('show')) || 'show'));
            if (kind === 'bumper-up-next') fields.push('next-' + (slug(value('next')) || 'show'));
            if (kind === 'bumper-now-next') {
              fields.push('now-' + (slug(value('now')) || 'show'));
              fields.push('next-' + (slug(value('next')) || 'show'));
            }
            fields.push('target-' + String(value('targetSeconds') || 8).padStart(2, '0') + 's');
            fields.push('v' + String(value('variant') || 1).padStart(2, '0'));
            const file = form.querySelector('[name="file"]')?.files?.[0];
            const extension = file?.name.includes('.') ? '.' + file.name.split('.').pop().toLowerCase() : '.mp4';
            form.querySelector('[data-generated-name]').textContent = fields.join('__') + extension;
          }
          if (form.matches('[data-designer]')) {
            const value = (name) => form.querySelector('[name="' + name + '"]')?.value || '';
            const preview = form.querySelector('[data-design-preview]');
            let eyebrow = 'YOU ARE WATCHING';
            let headline = value('station') || 'Your station';
            let support = '';
            if (kind === 'bumper-more') { eyebrow = 'MORE'; headline = value('show') || 'Choose a show'; }
            if (kind === 'bumper-up-next') { eyebrow = 'UP NEXT'; headline = value('next') || 'Choose a show'; }
            if (kind === 'bumper-now-next') { eyebrow = 'NOW'; headline = value('now') || 'Choose the current show'; support = 'Up next: ' + (value('next') || 'choose the next show'); }
            if (kind === 'filler-general') eyebrow = 'STAY TUNED';
            if (kind === 'standby-loop') eyebrow = 'WE WILL BE RIGHT BACK';
            preview.querySelector('[data-preview-eyebrow]').textContent = eyebrow;
            preview.querySelector('[data-preview-headline]').textContent = headline;
            preview.querySelector('[data-preview-support]').textContent = support;
            preview.style.background = value('background');
            preview.style.color = value('foreground');
            preview.querySelector('[data-preview-eyebrow]').style.color = value('accent');
          }
        };
        form.addEventListener('input', update);
        form.addEventListener('change', update);
        const fileInput = form.querySelector('[name="file"]');
        const videoPreview = form.querySelector('[data-upload-preview]');
        let previewUrl = '';
        fileInput?.addEventListener('change', () => {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          const files = Array.from(fileInput.files || []);
          const file = files[0];
          const selection = form.querySelector('[data-upload-selection]');
          const total = files.reduce((sum, item) => sum + item.size, 0);
          fileInput.setCustomValidity(files.length > 50 || total > 512 * 1024 * 1024 ? 'Choose up to 50 clips, with a combined size of 512 MB or less.' : '');
          if (selection) selection.textContent = files.length ? files.length + ' clips · ' + (total / 1024 / 1024).toFixed(1) + ' MB · Previewing ' + file.name : 'Up to 50 clips, 512 MB total.';
          previewUrl = file ? URL.createObjectURL(file) : '';
          if (videoPreview) {
            videoPreview.src = previewUrl;
            videoPreview.hidden = !previewUrl;
          }
        });
        videoPreview?.addEventListener('loadedmetadata', () => {
          const duration = form.querySelector('[name="targetSeconds"]');
          if (duration && Number.isFinite(videoPreview.duration)) {
            duration.value = String(Math.min(3600, Math.max(1, Math.round(videoPreview.duration))));
            update();
          }
        });
        update();
      });
    </script>
  `
  return renderLayout('Bumper Manager', content, {
    updateAvailable: view.updateAvailable,
  })
}

function renderNewAssetFields(designer: boolean): string {
  return `<div class="bumper-fields">
    <label>Station<input name="station" required placeholder="Station name"></label>
    <label>Asset type<select name="kind">${KINDS.map((option) => `<option value="${option.value}"${option.value === 'bumper-up-next' ? ' selected' : ''}>${option.label}</option>`).join('')}</select></label>
    <label data-for-kind="bumper-more">Show<input name="show" list="bumper-show-titles" placeholder="SpongeBob SquarePants (1999)"></label>
    <label data-for-kind="bumper-now-next">Now show<input name="now" list="bumper-show-titles" placeholder="SpongeBob SquarePants (1999)"></label>
    <label data-for-kind="bumper-up-next bumper-now-next">Next show<input name="next" list="bumper-show-titles" placeholder="The Fairly OddParents (2001)"></label>
    <label>Target seconds<input name="targetSeconds" type="number" min="1" max="${designer ? 60 : 3600}" required value="8"></label>
    <label>Starting variant<input name="variant" type="number" min="1" max="999" required value="1"></label>
    <label>Playback<select name="playback"><option value="allow" selected>Approve</option><option value="policy">Follow policy</option><option value="block">Block</option></select></label>
  </div>`
}

function renderAsset(
  item: BumperScanItem,
  view: BumperAdministrationViewModel
): string {
  const descriptor = item.descriptor
  const target = descriptor?.targetSeconds ?? Math.max(1, Math.round(item.media.durationSeconds))
  const kind = descriptor?.kind ?? guessKind(item.media.filename)
  const preview = view.preview?.id === item.media.id ? view.preview.filename : undefined
  return `
    <article class="bumper-asset bumper-status-${item.status}">
      <header>
        <div>
          <span class="bumper-status">${statusLabel(item.status)}</span>
          <h2>${escapeHtml(item.media.filename)}</h2>
          <p>${formatTime(item.media.durationSeconds)} · ${item.media.playbackEnabled ? 'Playable' : 'Not playable'} · ${item.media.mediaType === 'interlude' || item.media.isInterlude ? 'Interlude' : 'Not marked'}</p>
        </div>
        <a href="/library/files?search=${encodeURIComponent(item.media.filename)}">File details</a>
      </header>
      ${item.issues.length > 0 ? `<ul class="bumper-issues">${item.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>` : '<p class="bumper-ready">Ready for show-aware scheduling.</p>'}
      ${preview ? `<div class="bumper-preview"><strong>Rename preview</strong><code>${escapeHtml(preview)}</code></div>` : ''}
      <details class="bumper-editor"${preview ? ' open' : ''}><summary>Configure asset</summary>
      <form method="post" action="/library/bumpers/${item.media.id}/configure" data-bumper-form>
        <div class="bumper-fields">
          <label>Station<input name="station" required value="${escapeHtml(descriptor?.station ?? 'nick')}" placeholder="nick"></label>
          <label>Asset type<select name="kind">${KINDS.map((option) => `<option value="${option.value}"${option.value === kind ? ' selected' : ''}>${option.label}</option>`).join('')}</select></label>
          <label data-for-kind="bumper-more">Show<input name="show" list="bumper-show-titles" value="${escapeHtml(descriptor?.show ?? '')}" placeholder="SpongeBob SquarePants (1999)"></label>
          <label data-for-kind="bumper-now-next">Now show<input name="now" list="bumper-show-titles" value="${escapeHtml(descriptor?.now ?? '')}" placeholder="SpongeBob SquarePants (1999)"></label>
          <label data-for-kind="bumper-up-next bumper-now-next">Next show<input name="next" list="bumper-show-titles" value="${escapeHtml(descriptor?.next ?? '')}" placeholder="The Fairly OddParents (2001)"></label>
          <label>Target seconds<input name="targetSeconds" type="number" min="1" max="3600" required value="${target}"></label>
          <label>Variant<input name="variant" type="number" min="1" max="999" required value="${descriptor?.variant ?? 1}"></label>
          <label>Playback<select name="playback"><option value="allow"${item.media.playbackOverride === true ? ' selected' : ''}>Approve</option><option value="policy"${item.media.playbackOverride === null ? ' selected' : ''}>Follow policy</option><option value="block"${item.media.playbackOverride === false ? ' selected' : ''}>Block</option></select></label>
        </div>
        <div class="bumper-actions">
          <button class="btn btn-secondary" name="mode" value="preview" type="submit">Preview name</button>
          <button class="btn btn-primary" name="mode" value="apply" type="submit"${view.writable ? '' : ' disabled'}>Rename and configure</button>
        </div>
      </form>
      </details>
    </article>
  `
}

function guessKind(filename: string): StationAssetKind {
  const value = filename.toLowerCase()
  if (value.includes('standby')) return 'standby-loop'
  if (value.includes('filler')) return 'filler-general'
  if (value.includes('ident')) return 'ident-general'
  if (value.includes('more')) return 'bumper-more'
  if (value.includes('now') && value.includes('next')) return 'bumper-now-next'
  return 'bumper-up-next'
}

function matchesFilter(item: BumperScanItem, filter: BumperAdminFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return item.issues.length > 0
  return item.status === filter
}

function filterLink(
  value: BumperAdminFilter,
  label: string,
  current: BumperAdminFilter
): string {
  return `<a href="/library/bumpers?filter=${value}"${value === current ? ' aria-current="page"' : ''}>${label}</a>`
}

function summaryCard(label: string, value: number): string {
  return `<div><span>${escapeHtml(label)}</span><strong>${value.toLocaleString('en-US')}</strong></div>`
}

function statusLabel(status: BumperScanStatus): string {
  return status === 'recognized' ? 'Recognized' : status === 'invalid' ? 'Invalid name' : 'Legacy name'
}
