(function () {
  'use strict'

  var modal = document.querySelector('.channel-modal')
  if (modal) {
    document.documentElement.classList.add('channel-modal-open')
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') window.location.href = '/channels'
    })
    var firstControl = modal.querySelector('input:not([type="hidden"]), button, select, textarea')
    if (firstControl) firstControl.focus()
  }

  var branding = document.querySelector('[data-branding-editor]')
  if (branding) {
    var brandingCustom = branding.querySelector('[data-branding-custom]')
    var refreshBranding = function () {
      var selected = branding.querySelector('input[name="brandingMode"]:checked')
      if (brandingCustom) brandingCustom.hidden = !selected || selected.value !== 'custom'
    }
    branding.addEventListener('change', function (event) {
      if (event.target && event.target.name === 'brandingMode') refreshBranding()
    })
    refreshBranding()
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
