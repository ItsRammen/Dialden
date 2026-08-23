/**
 * Layout Template
 *
 * Base HTML layout with navbar, toast container, and auto-dismiss script.
 */

import packageJson from '../../package.json'

const appVersion: string = packageJson.version

interface LayoutOptions {
  updateAvailable?: boolean
}

export function renderLayout(
  title: string,
  content: string,
  options?: LayoutOptions
): string {
  const updateDot = options?.updateAvailable
    ? '<a href="/settings#about" class="update-dot" title="Update available">●</a>'
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Toast TV</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/app-icon.png">
  <meta name="theme-color" content="#e94560">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
</head>
<body>
<nav class="navbar">
    <a href="/" class="logo">
      <img src="/logo" alt="" class="nav-logo" onerror="this.style.display='none'">
      <span>Toast TV</span>
    </a>
    <div class="nav-links">
      <a href="/">Dashboard</a>
      <a href="/library">Library</a>
      <a href="/channels">Channels</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>
  <main class="container">
    ${content}
  </main>
  <footer class="app-footer">
    <span>${appVersion}</span>${updateDot}
  </footer>
  <div id="toast-container"></div>
  <script>
    // Auto-dismiss toasts after 3 seconds
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList?.contains('toast')) {
            setTimeout(() => {
              node.classList.add('toast-dismiss');
              setTimeout(() => node.remove(), 300);
            }, 3000);
          }
        });
      });
    });
    observer.observe(document.getElementById('toast-container'), { childList: true });
  </script>
</body>
</html>`
}
