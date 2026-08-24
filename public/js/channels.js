(function () {
  'use strict'

  var modal = document.querySelector('.channel-modal')
  if (modal) {
    document.documentElement.classList.add('channel-modal-open')
    var modalPanel = modal.querySelector('[data-channel-modal-panel]')
    var focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'summary',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',')
    var modalControls = function () {
      return Array.prototype.filter.call(
        modal.querySelectorAll(focusableSelector),
        function (control) {
          return control.getAttribute('tabindex') !== '-1' && !control.hidden && control.getAttribute('aria-hidden') !== 'true' && control.offsetParent !== null
        }
      )
    }
    var closeModal = function () {
      window.location.href = modal.getAttribute('data-modal-close-href') || '/channels'
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeModal()
        return
      }
      if (event.key === 'Tab') {
        var controls = modalControls()
        if (!controls.length) {
          event.preventDefault()
          if (modalPanel) modalPanel.focus()
          return
        }
        var first = controls[0]
        var last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    })
    var firstControl = modal.querySelector('[autofocus], input:not([type="hidden"]):not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [data-modal-close]')
    if (firstControl && firstControl.offsetParent !== null) firstControl.focus()
    else if (modalPanel) modalPanel.focus()
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        if (
          firstControl &&
          firstControl.offsetParent !== null &&
          (document.activeElement === modalPanel || document.activeElement === document.body)
        ) {
          firstControl.focus()
        }
      })
    }

    Array.prototype.forEach.call(
      modal.querySelectorAll('.channel-builder-navigation'),
      function (navigation) {
        navigation.addEventListener('keydown', function (event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          var links = Array.prototype.slice.call(navigation.querySelectorAll('a[href]'))
          if (!links.length) return
          var index = links.indexOf(document.activeElement)
          if (index < 0) return
          event.preventDefault()
          var direction = event.key === 'ArrowRight' ? 1 : -1
          links[(index + direction + links.length) % links.length].focus()
        })
      }
    )
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

  var autoBuilder = document.querySelector('[data-auto-builder]')
  if (autoBuilder) {
    var modeInputs = autoBuilder.querySelectorAll('[data-builder-mode]')
    var modePanels = autoBuilder.querySelectorAll('[data-builder-mode-panel]')
    var presetInputs = autoBuilder.querySelectorAll('[data-builder-preset]')
    var networkSelect = autoBuilder.querySelector('[data-network-select]')
    var eraStart = autoBuilder.querySelector('[data-era-start]')
    var eraEnd = autoBuilder.querySelector('[data-era-end]')
    var airtimeInputs = autoBuilder.querySelectorAll('input[name="airtime"]')
    var handoffPanel = autoBuilder.querySelector('[data-handoff-panel]')
    var handoffToggle = autoBuilder.querySelector('[data-handoff-toggle]')
    var handoffFields = autoBuilder.querySelector('[data-handoff-fields]')
    var handoffStatus = autoBuilder.querySelector('[data-handoff-status]')
    var legacyMigrationFields = autoBuilder.querySelector('[data-legacy-migration-fields]')
    var legacyMigrationButton = autoBuilder.querySelector('[data-legacy-migration-confirm]')
    var legacyMigrationStatus = autoBuilder.querySelector('[data-legacy-migration-status]')
    var currentYear = new Date().getFullYear()

    var selectedBuilderMode = function () {
      var selected = autoBuilder.querySelector('[data-builder-mode]:checked')
      return selected ? selected.value : 'custom'
    }

    var selectedLineupMode = function () {
      var selected = autoBuilder.querySelector('[data-lineup-mode]:checked')
      return selected ? selected.value : 'explicit'
    }

    var numberAttribute = function (element, name, fallback) {
      var value = Number(element && element.getAttribute(name))
      return isFinite(value) ? value : fallback
    }

    var boundedYear = function (value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value))
    }

    var fillYearSelect = function (select, minimum, maximum, selected, markCurrent) {
      if (!select) return
      while (select.firstChild) select.removeChild(select.firstChild)
      var chosen = boundedYear(Number(selected) || minimum, minimum, maximum)
      for (var year = minimum; year <= maximum; year += 1) {
        var option = document.createElement('option')
        option.value = String(year)
        option.textContent = markCurrent && year === currentYear
          ? year + ' (Current)'
          : String(year)
        option.selected = year === chosen
        select.appendChild(option)
      }
    }

    var activeNetworkPanel = function () {
      var selectedId = networkSelect ? networkSelect.value : ''
      var result = null
      Array.prototype.forEach.call(
        autoBuilder.querySelectorAll('[data-network-panel]'),
        function (panel) {
          if (panel.getAttribute('data-network-panel') === selectedId) result = panel
        }
      )
      return result
    }

    var searchValue = function (scope) {
      var input = scope ? scope.querySelector('[data-title-search]') : null
      return input ? input.value.trim().toLowerCase() : ''
    }

    var refreshNetwork = function (modeActive, resetEra) {
      var selectedPanel = activeNetworkPanel()
      if (!selectedPanel || !eraStart || !eraEnd) return
      var minimum = numberAttribute(selectedPanel, 'data-min-year', currentYear)
      var maximum = numberAttribute(selectedPanel, 'data-max-year', currentYear)
      if (resetEra) {
        fillYearSelect(
          eraStart,
          minimum,
          maximum,
          numberAttribute(selectedPanel, 'data-default-start', minimum),
          false
        )
        fillYearSelect(
          eraEnd,
          Number(eraStart.value),
          maximum,
          numberAttribute(selectedPanel, 'data-default-end', maximum),
          true
        )
      } else {
        var start = boundedYear(Number(eraStart.value) || minimum, minimum, maximum)
        eraStart.value = String(start)
        fillYearSelect(
          eraEnd,
          start,
          maximum,
          Number(eraEnd.value) || maximum,
          true
        )
      }

      var selectedStart = Number(eraStart.value)
      var selectedEnd = Number(eraEnd.value)
      var explicitMode = selectedLineupMode() === 'explicit'
      Array.prototype.forEach.call(
        autoBuilder.querySelectorAll('[data-network-panel]'),
        function (panel) {
          var isSelected = panel === selectedPanel
          panel.hidden = !isSelected
          panel.disabled = !modeActive || !isSelected
          panel.setAttribute('data-selection-mode', explicitMode ? 'explicit' : 'automatic')
          var term = searchValue(panel)
          var eligibleRows = 0
          var visibleRows = 0
          var checkedRows = 0
          Array.prototype.forEach.call(
            panel.querySelectorAll('[data-title-row]'),
            function (row) {
              var airStart = Number(row.getAttribute('data-air-start-year'))
              var airEnd = Number(row.getAttribute('data-air-end-year'))
              var eligible = airStart <= selectedEnd && airEnd >= selectedStart
              var text = row.getAttribute('data-search-text') || ''
              var matches = !term || text.indexOf(term) >= 0
              var checkbox = row.querySelector('input[type="checkbox"]')
              row.hidden = !eligible || !matches
              if (checkbox) {
                checkbox.disabled = !modeActive || !isSelected || !eligible || !explicitMode
              }
              if (eligible) eligibleRows += 1
              if (eligible && matches) visibleRows += 1
              if (eligible && checkbox && checkbox.checked) checkedRows += 1
            }
          )
          var count = panel.querySelector('[data-selection-count]')
          if (count) {
            count.textContent = explicitMode
              ? checkedRows + ' of ' + eligibleRows + ' selected'
              : eligibleRows + ' eligible automatically'
          }
          var pickerDescription = panel.querySelector('[data-picker-description]')
          if (pickerDescription) {
            pickerDescription.textContent = explicitMode
              ? 'Every checked title is included; unchecked titles stay out.'
              : 'These titles currently match. ToastTV follows the strict network and era rules as your playable library changes.'
          }
          Array.prototype.forEach.call(
            panel.querySelectorAll('[data-explicit-action]'),
            function (action) {
              action.hidden = !explicitMode
              action.disabled = !modeActive || !isSelected || !explicitMode
            }
          )
          var filterEmpty = panel.querySelector('[data-title-filter-empty]')
          if (filterEmpty) filterEmpty.hidden = eligibleRows === 0 || visibleRows > 0

          var visibleSuggestions = 0
          var suggestionRows = panel.querySelectorAll('[data-network-suggestion]')
          Array.prototype.forEach.call(suggestionRows, function (suggestion) {
            var itemStart = Number(suggestion.getAttribute('data-air-start-year'))
            var itemEnd = Number(suggestion.getAttribute('data-air-end-year'))
            var visible = itemStart <= selectedEnd && itemEnd >= selectedStart
            suggestion.hidden = !visible
            if (visible) visibleSuggestions += 1
          })
          var suggestionEmpty = panel.querySelector('[data-suggestion-empty]')
          if (suggestionEmpty) {
            suggestionEmpty.hidden = suggestionRows.length === 0 || visibleSuggestions > 0
          }
        }
      )
      var lineupStatus = autoBuilder.querySelector('[data-lineup-mode-status]')
      if (lineupStatus) {
        lineupStatus.classList.toggle('is-explicit', explicitMode)
        lineupStatus.textContent = explicitMode
          ? 'Choose at least one title. An empty hand-picked lineup cannot be saved.'
          : 'ToastTV recalculates this strict lineup during library refreshes using the selected network and era.'
      }
    }

    var refreshCustom = function (modeActive) {
      var panel = autoBuilder.querySelector('[data-builder-mode-panel="custom"]')
      if (!panel) return
      var term = searchValue(panel)
      var visibleRows = 0
      var selectedRows = 0
      Array.prototype.forEach.call(
        panel.querySelectorAll('[data-title-row]'),
        function (row) {
          var text = row.getAttribute('data-search-text') || ''
          var visible = !term || text.indexOf(term) >= 0
          var checkbox = row.querySelector('input[type="checkbox"]')
          row.hidden = !visible
          if (checkbox) {
            checkbox.disabled = !modeActive
            if (checkbox.checked) selectedRows += 1
          }
          if (visible) visibleRows += 1
        }
      )
      var count = panel.querySelector('[data-selection-count]')
      if (count) {
        count.textContent = selectedRows + ' selected ' + (selectedRows === 1 ? 'title' : 'titles')
      }
      var filterEmpty = panel.querySelector('[data-title-filter-empty]')
      if (filterEmpty) {
        filterEmpty.hidden = panel.querySelectorAll('[data-title-row]').length === 0 || visibleRows > 0
      }
    }

    var selectedAirtime = function () {
      var selected = autoBuilder.querySelector('input[name="airtime"]:checked')
      return selected ? selected.value : 'all-day'
    }

    var refreshHandoff = function () {
      if (!handoffPanel || !handoffToggle || !handoffFields) return
      var eligible = selectedBuilderMode() === 'network' &&
        !!networkSelect && networkSelect.value === 'cartoon-network' &&
        selectedAirtime() === 'all-day'
      handoffPanel.hidden = selectedBuilderMode() !== 'network' ||
        !networkSelect || networkSelect.value !== 'cartoon-network'
      handoffToggle.disabled = !eligible
      handoffFields.disabled = !eligible || !handoffToggle.checked
      handoffPanel.setAttribute('data-enabled', String(eligible && handoffToggle.checked))
      if (handoffStatus) {
        handoffStatus.textContent = !eligible
          ? 'Choose Cartoon Network with All day airtime to use this handoff.'
          : handoffToggle.checked
            ? 'Locked handoff active. No adult programmes are selected or played.'
            : 'Off — Cartoon Network keeps its ordinary schedule.'
      }
    }

    var refreshBuilderMode = function () {
      var mode = selectedBuilderMode()
      Array.prototype.forEach.call(modePanels, function (panel) {
        var active = panel.getAttribute('data-builder-mode-panel') === mode
        panel.hidden = !active
        var fields = panel.querySelector('[data-builder-mode-fields]')
        if (fields) fields.disabled = !active
      })
      Array.prototype.forEach.call(presetInputs, function (input) {
        input.checked = input.getAttribute('data-builder-preset') === mode
      })
      refreshNetwork(mode === 'network', false)
      refreshCustom(mode === 'custom')
      refreshHandoff()
    }

    var refreshPickerForControl = function (control) {
      var mode = selectedBuilderMode()
      if (control.closest('.channel-network-profile')) {
        refreshNetwork(mode === 'network', false)
      } else {
        refreshCustom(mode === 'custom')
      }
    }

    autoBuilder.addEventListener('input', function (event) {
      if (event.target && event.target.hasAttribute('data-title-search')) {
        refreshPickerForControl(event.target)
      }
    })

    autoBuilder.addEventListener('change', function (event) {
      if (!event.target) return
      if (event.target.hasAttribute('data-builder-mode')) {
        refreshBuilderMode()
      } else if (event.target.hasAttribute('data-lineup-mode')) {
        refreshNetwork(selectedBuilderMode() === 'network', false)
      } else if (event.target === networkSelect) {
        refreshNetwork(selectedBuilderMode() === 'network', true)
        refreshHandoff()
      } else if (event.target === eraStart || event.target === eraEnd) {
        refreshNetwork(selectedBuilderMode() === 'network', false)
      } else if (event.target.hasAttribute('data-handoff-toggle')) {
        refreshHandoff()
      } else if (Array.prototype.indexOf.call(airtimeInputs, event.target) >= 0) {
        refreshHandoff()
      } else if (event.target.name === 'collectionIds') {
        refreshPickerForControl(event.target)
      }
    })

    autoBuilder.addEventListener('click', function (event) {
      if (!event.target) return
      var selectAll = event.target.closest('[data-select-visible]')
      var clearAll = event.target.closest('[data-clear-visible]')
      if (!selectAll && !clearAll) return
      var scope = event.target.closest('.channel-network-library, .channel-custom-builder')
      if (!scope) return
      Array.prototype.forEach.call(
        scope.querySelectorAll('[data-title-row] input[type="checkbox"]'),
        function (checkbox) {
          if (!checkbox.disabled) checkbox.checked = !!selectAll
        }
      )
      refreshPickerForControl(event.target)
    })

    Array.prototype.forEach.call(modeInputs, function (input) {
      input.setAttribute('aria-controls', input.value === 'network'
        ? 'network-channel-options'
        : 'custom-channel-options')
    })
    var networkModePanel = autoBuilder.querySelector('[data-builder-mode-panel="network"]')
    var customModePanel = autoBuilder.querySelector('[data-builder-mode-panel="custom"]')
    if (networkModePanel) networkModePanel.id = 'network-channel-options'
    if (customModePanel) customModePanel.id = 'custom-channel-options'
    if (legacyMigrationFields && legacyMigrationButton) {
      legacyMigrationButton.addEventListener('click', function () {
        legacyMigrationFields.disabled = false
        legacyMigrationButton.hidden = true
        legacyMigrationButton.setAttribute('aria-expanded', 'true')
        autoBuilder.setAttribute('data-legacy-migration-unlocked', 'true')
        if (legacyMigrationStatus) {
          legacyMigrationStatus.textContent = 'Replacement editor unlocked. Review the new channel type and lineup, preview the result, then confirm before applying it.'
        }
        refreshBuilderMode()
        var firstMode = autoBuilder.querySelector('[data-builder-mode]:checked')
        if (firstMode) firstMode.focus()
      })
    }
    refreshBuilderMode()
  }

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
