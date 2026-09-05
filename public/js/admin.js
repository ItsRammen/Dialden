/* Shared feedback for the admin shell. Forms keep their own submission routes. */
(function () {
  'use strict'

  var toasts = document.getElementById('toast-container')
  function prepareToast(node) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('toast') || node.dataset.dismissible) return
    node.dataset.dismissible = 'true'
    var dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'admin-toast-dismiss'
    dismiss.setAttribute('aria-label', 'Dismiss notification')
    dismiss.textContent = '×'
    dismiss.addEventListener('click', function () { node.remove() })
    node.appendChild(dismiss)
    // Errors and warnings stay available until dismissed. Successes leave after
    // enough time to read them, unless the user is interacting with the notice.
    if (node.classList.contains('success')) {
      window.setTimeout(function () {
        if (!node.matches(':hover') && !node.contains(document.activeElement)) node.remove()
      }, 6000)
    }
  }
  if (toasts) {
    toasts.querySelectorAll('.toast').forEach(prepareToast)
    new MutationObserver(function (records) {
      records.forEach(function (record) { record.addedNodes.forEach(prepareToast) })
    }).observe(toasts, { childList: true })
  }

  var form = document.getElementById('settings-form')
  var status = document.getElementById('settings-save-status')
  if (!form || !status) return
  var button = form.querySelector('button[type="submit"]')
  function snapshot() {
    return JSON.stringify(Array.from(new FormData(form).entries()).filter(function (entry) {
      return typeof entry[1] === 'string'
    }))
  }
  var saved = snapshot()
  var submitted = null
  var pending = false
  function update(message) {
    var dirty = snapshot() !== saved
    status.textContent = message || (dirty ? 'Unsaved changes' : 'No unsaved changes')
    status.dataset.state = pending ? 'saving' : dirty ? 'dirty' : 'saved'
    if (button) {
      button.disabled = pending
      button.textContent = pending ? 'Saving…' : 'Save settings'
    }
  }
  form.addEventListener('input', function () { if (!pending) update() })
  form.addEventListener('change', function () { if (!pending) update() })
  form.addEventListener('htmx:beforeRequest', function (event) {
    if (event.detail.elt !== form) return
    submitted = snapshot()
    pending = true
    update('Saving changes…')
  })
  form.addEventListener('htmx:afterRequest', function (event) {
    if (event.detail.elt !== form) return
    pending = false
    if (event.detail.successful) {
      saved = submitted
      update(snapshot() === saved ? 'Settings saved' : 'New changes still need saving')
    } else {
      update('Could not save. Your changes are still here; try again.')
    }
  })
  update()
})()
