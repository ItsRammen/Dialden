(function () {
  'use strict'

  var modal = document.querySelector('.channel-modal')
  if (modal) {
    document.documentElement.classList.add('channel-modal-open')
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        window.location.href = modal.getAttribute('data-modal-close-href') || '/channels'
      }
    })
    var firstControl = modal.querySelector('input:not([type="hidden"]), button, select, textarea')
    if (firstControl) firstControl.focus()
  }

  var branding = document.querySelector('[data-branding-editor]')
  if (branding) {
    var brandingCustom = branding.querySelector('[data-branding-custom]')
    var burnInToggle = branding.querySelector('[data-branding-burn-in]')
    var burnInNote = branding.querySelector('[data-branding-burn-in-note]')
    var burnInOptions = branding.querySelectorAll('[data-branding-burn-in-options]')
    var logoFile = branding.querySelector('[data-logo-file]')
    var logoPreview = branding.querySelector('[data-logo-preview]')
    var logoPlaceholder = branding.querySelector('[data-logo-placeholder]')
    var logoScreen = branding.querySelector('[data-logo-screen]')
    var logoPosition = branding.querySelector('[data-logo-position]')
    var logoSize = branding.querySelector('[data-logo-size]')
    var logoOpacity = branding.querySelector('[data-logo-opacity]')
    var logoX = branding.querySelector('[data-logo-x]')
    var logoY = branding.querySelector('[data-logo-y]')
    var sizeOutput = branding.querySelector('[data-logo-size-output]')
    var opacityOutput = branding.querySelector('[data-logo-opacity-output]')
    var previewCaption = branding.querySelector('[data-logo-preview-caption]')
    var originalLogoSrc = logoPreview ? logoPreview.getAttribute('src') : ''

    var selectedBrandingMode = function () {
      var selected = branding.querySelector('input[name="brandingMode"]:checked')
      return selected ? selected.value : 'inherit'
    }

    var burnInEnabled = function () {
      return selectedBrandingMode() !== 'off' && !!burnInToggle && burnInToggle.checked
    }

    var refreshLogoPreview = function () {
      if (!logoPreview || !logoScreen) return
      var position = logoPosition ? logoPosition.value : '2'
      var size = logoSize ? Number(logoSize.value) : 12
      var opacity = logoOpacity ? Number(logoOpacity.value) : 210
      var x = logoX ? Math.min(Number(logoX.value) || 0, 500) : 24
      var y = logoY ? Math.min(Number(logoY.value) || 0, 500) : 24
      var burnIn = burnInEnabled()
      logoScreen.setAttribute('data-position', position)
      logoScreen.setAttribute('data-burn-in', String(burnIn))
      logoPreview.style.width = burnIn ? size + '%' : '28%'
      logoPreview.style.opacity = burnIn ? String(opacity / 255) : '1'
      logoPreview.style.setProperty('--logo-x', Math.min(x / 8, 40) + 'px')
      logoPreview.style.setProperty('--logo-y', Math.min(y / 8, 40) + 'px')
      if (sizeOutput) sizeOutput.textContent = size + '%'
      if (opacityOutput) opacityOutput.textContent = Math.round((opacity / 255) * 100) + '%'
      if (previewCaption) {
        previewCaption.textContent = burnIn
          ? 'Burn-in preview · final video'
          : 'App logo preview · video remains clean'
      }
    }

    var refreshBranding = function () {
      var mode = selectedBrandingMode()
      var burnIn = mode !== 'off' && !!burnInToggle && burnInToggle.checked
      if (brandingCustom) brandingCustom.hidden = mode !== 'custom'
      if (logoFile) logoFile.disabled = mode !== 'custom'
      if (burnInToggle) {
        burnInToggle.disabled = mode === 'off'
        if (mode === 'off') burnInToggle.checked = false
        burnIn = mode !== 'off' && burnInToggle.checked
      }
      Array.prototype.forEach.call(burnInOptions, function (option) {
        option.hidden = !burnIn
      })
      if (burnInNote) {
        burnInNote.textContent = mode === 'off'
          ? 'Choose a global or custom logo before enabling burn-in.'
          : burnIn
            ? 'The logo will appear in apps and in the encoded video.'
            : 'App-only is recommended: the logo remains hideable by each client.'
      }
      refreshLogoPreview()
    }

    branding.addEventListener('input', refreshLogoPreview)
    branding.addEventListener('change', function (event) {
      if (
        event.target &&
        (event.target.name === 'brandingMode' || event.target.name === 'brandingBurnIn')
      ) {
        refreshBranding()
        return
      }
      refreshLogoPreview()
    })
    if (logoFile) {
      logoFile.addEventListener('change', function () {
        var file = logoFile.files && logoFile.files[0]
        if (!logoPreview) return
        if (!file) {
          if (originalLogoSrc) {
            logoPreview.src = originalLogoSrc
            logoPreview.hidden = false
            if (logoPlaceholder) logoPlaceholder.hidden = true
          } else {
            logoPreview.removeAttribute('src')
            logoPreview.hidden = true
            if (logoPlaceholder) logoPlaceholder.hidden = false
          }
          refreshLogoPreview()
          return
        }
        var reader = new FileReader()
        reader.addEventListener('load', function () {
          logoPreview.src = String(reader.result || '')
          logoPreview.hidden = false
          if (logoPlaceholder) logoPlaceholder.hidden = true
          refreshLogoPreview()
        })
        reader.readAsDataURL(file)
      })
    }
    refreshBranding()
  }

  Array.prototype.forEach.call(
    document.querySelectorAll('[data-marathon-settings]'),
    function (settings) {
      var toggle = settings.querySelector('[data-marathon-enabled]')
      var status = settings.querySelector('[data-marathon-status]')
      if (!toggle) return
      var refreshMarathon = function () {
        settings.setAttribute('data-enabled', String(toggle.checked))
        if (status) {
          status.textContent = toggle.checked
            ? 'Automatic marathons are active.'
            : 'Off — use the normal mixed lineup.'
        }
      }
      toggle.addEventListener('change', refreshMarathon)
      refreshMarathon()
    }
  )

  var editor = document.querySelector('[data-schedule-editor]')
  if (!editor) return

  var list = editor.querySelector('[data-slot-list]')
  var template = editor.querySelector('[data-slot-template]')
  var serialized = editor.querySelector('[data-schedule-serialized]')
  var empty = editor.querySelector('[data-schedule-empty]')
  var form = editor.closest('form')
  var advancedDirty = false

  function checkedValues(row, selector) {
    return Array.prototype.map.call(
      row.querySelectorAll(selector + ':checked'),
      function (input) { return input.value }
    )
  }

  function customGroups(row) {
    var input = row.querySelector('[data-slot-custom-groups]')
    if (!input || !input.value.trim()) return []
    return input.value.split(',').map(function (value) {
      return value.trim()
    }).filter(Boolean)
  }

  function slotFromRow(row) {
    var start = row.querySelector('[data-slot-start]')
    var end = row.querySelector('[data-slot-end]')
    var groups = checkedValues(row, '[data-slot-group]').concat(customGroups(row))
    var brandingMode = row.querySelector('[data-slot-branding-mode]')
    var brandingLogo = row.querySelector('[data-slot-branding-logo]')
    return {
      days: checkedValues(row, '[data-slot-day]'),
      start: start ? start.value : '00:00',
      end: end ? end.value : '24:00',
      groups: groups.filter(function (value, index, values) {
        return values.indexOf(value) === index
      }),
      branding: brandingMode && brandingMode.value === 'custom'
        ? 'custom:' + (brandingLogo ? brandingLogo.value.trim() : '')
        : (brandingMode ? brandingMode.value : 'channel')
    }
  }

  function scheduleLine(slot) {
    return slot.days.join(',') + ' | ' + slot.start + '-' + slot.end + ' | ' + slot.groups.join(',') + ' | ' + slot.branding
  }

  function drawCalendar(slots) {
    Array.prototype.forEach.call(editor.querySelectorAll('[data-calendar-day]'), function (day) {
      day.textContent = ''
      slots.forEach(function (slot) {
        if (slot.days.indexOf(day.getAttribute('data-calendar-day')) < 0) return
        var entry = document.createElement('span')
        var time = document.createElement('b')
        var groups = document.createElement('small')
        time.textContent = slot.start + '–' + slot.end
        groups.textContent = slot.groups.length ? slot.groups.join(', ') : 'Choose a group'
        entry.appendChild(time)
        entry.appendChild(groups)
        day.appendChild(entry)
      })
    })
  }

  function refresh(options) {
    var rows = Array.prototype.slice.call(list.querySelectorAll('[data-slot]'))
    var slots = rows.map(function (row, index) {
      var number = row.querySelector('[data-slot-number]')
      if (number) number.textContent = String(index + 1)
      return slotFromRow(row)
    })
    empty.hidden = rows.length > 0
    drawCalendar(slots)
    if (!options || !options.preserveAdvanced) {
      serialized.value = slots.map(scheduleLine).join('\n')
      advancedDirty = false
    }
  }

  editor.addEventListener('click', function (event) {
    var remove = event.target.closest('[data-remove-slot]')
    if (remove) {
      remove.closest('[data-slot]').remove()
      refresh()
      return
    }
    if (event.target.closest('[data-add-slot]')) {
      var fragment = template.content.cloneNode(true)
      var row = fragment.querySelector('[data-slot]')
      Array.prototype.forEach.call(row.querySelectorAll('[data-slot-day]'), function (input) {
        input.checked = true
      })
      var firstGroup = row.querySelector('[data-slot-group]')
      if (firstGroup) firstGroup.checked = true
      list.appendChild(fragment)
      refresh()
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })

  editor.addEventListener('input', function (event) {
    if (event.target === serialized) {
      advancedDirty = true
      return
    }
    refresh()
  })
  editor.addEventListener('change', function (event) {
    if (event.target !== serialized) refresh()
  })
  if (form) {
    form.addEventListener('submit', function () {
      if (!advancedDirty) refresh()
    })
  }
  refresh()
})()
