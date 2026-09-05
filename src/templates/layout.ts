/**
 * Layout Template
 *
 * Base HTML layout with navbar, toast container, and auto-dismiss script.
 */

import { escapeHtml } from './utils'

import packageJson from '../../package.json'

const appVersion: string = packageJson.version

interface LayoutOptions {
  activeSection?: 'dashboard' | 'library' | 'channels' | 'settings'
  updateAvailable?: boolean
}

export function renderLayout(
  title: string,
  content: string,
  options?: LayoutOptions
): string {
  const activeSection = options?.activeSection ?? (title.toLowerCase().includes('channel')
    ? 'channels'
    : title.toLowerCase().includes('librar') ||
        title.toLowerCase().includes('media') ||
        title.toLowerCase().includes('bumper')
      ? 'library'
      : title.toLowerCase().includes('setting') || title.toLowerCase().includes('metadata')
        ? 'settings'
        : 'dashboard')
  const navLink = (section: string, href: string, label: string) =>
    `<a href="${href}"${activeSection === section ? ' aria-current="page"' : ''}>${label}</a>`
  const updateDot = options?.updateAvailable
    ? '<a href="/settings#about" class="update-dot" title="Update available" aria-label="Update available">Update available</a>'
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} · ToastTV Admin</title>
  <link rel="stylesheet" href="/style.css">
  <script src="/js/admin.js" defer></script>
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <meta name="theme-color" content="#0b1220">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
</head>
<body class="app-shell">
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="navbar">
    <a href="/" class="logo" aria-label="ToastTV administration overview">
      <img src="/logo" alt="" class="nav-logo" onerror="this.style.display='none'">
      <span class="brand-copy"><strong>ToastTV</strong><small>Administration</small></span>
    </a>
    <nav class="nav-links" aria-label="Primary navigation">
      ${navLink('dashboard', '/', 'Overview')}
      ${navLink('library', '/library', 'Library')}
      ${navLink('channels', '/channels', 'Channels')}
      ${navLink('settings', '/settings', 'Settings')}
    </nav>
  </header>
  <main class="container" id="main-content">
    ${content}
  </main>
  <footer class="app-footer">
    <span>ToastTV Server</span><span class="footer-separator" aria-hidden="true">·</span><span>v${appVersion}</span>${updateDot}
  </footer>
  <div id="toast-container" role="status" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`
}


export type LibrarySection = 'summary' | 'tv' | 'movies' | 'interludes' | 'bumpers' | 'review' | 'files'

/** One navigation order and current-page indicator for every library surface. */
export function renderLibraryNavigation(active: LibrarySection): string {
  const links: readonly [LibrarySection, string, string][] = [
    ['summary', '/library', 'Overview'],
    ['tv', '/library/tv', 'TV shows'],
    ['movies', '/library/movies', 'Movies'],
    ['bumpers', '/library/bumpers', 'Station Assets'],
    ['interludes', '/library/interludes', 'Asset files'],
    ['review', '/library/review', 'Review queue'],
    ['files', '/library/files', 'File diagnostics'],
  ]
  return `<nav class="collection-library-nav" aria-label="Library sections">${links.map(([id, href, label]) =>
    `<a href="${href}"${id === active ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('')}</nav>`
}

export function renderSettingsNavigation(active: 'server' | 'metadata'): string {
  return `<nav class="admin-settings-nav" aria-label="Settings pages">
    <a href="/settings"${active === 'server' ? ' aria-current="page"' : ''}>Server settings</a>
    <a href="/settings/metadata"${active === 'metadata' ? ' aria-current="page"' : ''}>Metadata and review</a>
  </nav>`
}
