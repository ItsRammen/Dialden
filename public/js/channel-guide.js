(function () {
  'use strict';
  var dialog = document.createElement('dialog');
  dialog.className = 'admin-guide';
  dialog.setAttribute('aria-labelledby', 'admin-guide-title');
  dialog.innerHTML = '<header><div><p class="admin-guide-eyebrow">Channel schedule</p><h2 id="admin-guide-title"></h2></div><button type="button" data-close aria-label="Close guide">Close</button></header>' +
    '<div class="admin-guide-toolbar"><div role="group" aria-label="Guide view"><button type="button" data-view="user" aria-pressed="true">User view</button><button type="button" data-view="admin" aria-pressed="false">Admin view</button></div>' +
    '<div role="group" aria-label="Schedule window"><button type="button" data-step="-1" aria-label="Previous eight hours">← Previous</button><button type="button" data-now>Now</button><button type="button" data-step="1" aria-label="Next eight hours">Next →</button><button type="button" data-refresh>Refresh</button></div></div>' +
    '<p data-range></p><p class="admin-guide-help" data-help></p><p role="status" data-status></p><ol class="admin-guide-list" data-list></ol>';
  document.body.appendChild(dialog);
  var state = { id: '', from: 0, mode: 'user', data: null, request: null, opener: null };
  var list = dialog.querySelector('[data-list]');
  var status = dialog.querySelector('[data-status]');
  var hours = 8 * 60 * 60 * 1000;
  function node(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function format(value, date) {
    return new Intl.DateTimeFormat(undefined, { timeZone: state.data.timezone || 'UTC', month: date ? 'short' : undefined, day: date ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', second: state.mode === 'admin' ? '2-digit' : undefined }).format(new Date(value));
  }
  function duration(seconds) {
    seconds = Math.round(seconds * 1000) / 1000;
    return (seconds >= 60 ? Math.floor(seconds / 60) + 'm ' : '') + Math.round((seconds % 60) * 1000) / 1000 + 's';
  }
  function render() {
    list.replaceChildren();
    dialog.querySelector('[data-help]').textContent = state.mode === 'admin' ? 'Breaks are grouped together. Expand a break to see its clips in playback order. Times follow the channel timezone.' : 'Programs only. Station assets still play between programs; start times are unchanged.';
    if (!state.data) return;
    var data = state.data;
    dialog.querySelector('[data-range]').textContent = format(state.from, true) + ' – ' + format(state.from + hours, true) + ' · ' + (data.timezone || 'UTC');
    var programs = data.programs.filter(function (p) { return state.mode === 'admin' || ['ident', 'bumper', 'interlude'].indexOf(p.type) === -1; });
    if (state.mode === 'admin') {
      var grouped = [];
      programs.forEach(function (p) {
        var isAsset = ['ident', 'bumper', 'interlude'].indexOf(p.type) !== -1;
        var previous = grouped[grouped.length - 1];
        if (isAsset && previous && previous.clips && Date.parse(previous.scheduledEnd) === Date.parse(p.scheduledStart)) {
          previous.clips.push(p);
          previous.scheduledEnd = p.scheduledEnd;
        } else if (isAsset) {
          grouped.push({ title: 'Break', scheduledStart: p.scheduledStart, scheduledEnd: p.scheduledEnd, clips: [p] });
        } else grouped.push(p);
      });
      programs = grouped;
    }
    status.textContent = programs.length ? programs.length + ' scheduled items' : 'No programs in this window.';
    if (data.truncated) status.textContent += ' This window is truncated' + (data.coverageEnd ? ' at ' + format(data.coverageEnd, true) : '') + '; choose a later window to see more.';
    programs.forEach(function (p) {
      var row = node('li', '', 'admin-guide-item');
      var current = Date.parse(p.scheduledStart) <= data.serverTimeMs && Date.parse(p.scheduledEnd) > data.serverTimeMs;
      if (current) row.classList.add('is-current');
      row.appendChild(node('div', format(p.scheduledStart) + ' – ' + format(p.scheduledEnd), 'admin-guide-time'));
      var body = node('div', '', 'admin-guide-body');
      body.appendChild(node('strong', p.title || 'Untitled'));
      body.appendChild(node('span', [current ? 'On now' : '', p.collectionTitle, p.episodeLabel].filter(Boolean).join(' · ')));
      if (p.clips) {
        var imported = 0, generated = 0;
        var details = node('details', '', 'admin-guide-break');
        details.appendChild(node('summary', 'Show ' + p.clips.length + ' clips'));
        var clips = node('ol', '', 'admin-guide-clips');
        p.clips.forEach(function (clip) {
          var seconds = (Date.parse(clip.scheduledEnd) - Date.parse(clip.scheduledStart)) / 1000;
          if (clip.generated) generated += seconds; else imported += seconds;
          var entry = node('li', '', 'admin-guide-clip');
          var playing = Date.parse(clip.scheduledStart) <= data.serverTimeMs && Date.parse(clip.scheduledEnd) > data.serverTimeMs;
          if (playing) entry.classList.add('is-current');
          entry.appendChild(node('strong', clip.title || 'Untitled'));
          entry.appendChild(node('small', (playing ? 'Playing now · ' : '') + format(clip.scheduledStart) + ' · ' + duration(seconds) + ' · ' + (clip.generated ? 'Generated card' : 'Media #' + clip.mediaId)));
          clips.appendChild(entry);
        });
        details.appendChild(clips);
        body.appendChild(node('small', duration(imported + generated) + ' total · ' + duration(imported) + ' imported · ' + duration(generated) + ' generated'));
        body.appendChild(details);
      } else if (state.mode === 'admin') {
        var seconds = Math.round((Date.parse(p.scheduledEnd) - Date.parse(p.scheduledStart)) / 1000);
        body.appendChild(node('small', (p.type || 'program') + ' · ' + Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's · Media #' + p.mediaId));
      }
      row.appendChild(body);
      list.appendChild(row);
    });
  }
  async function load() {
    if (state.request) state.request.abort();
    var request = new AbortController();
    state.request = request;
    state.data = null;
    render();
    dialog.querySelector('[data-range]').textContent = '';
    status.textContent = 'Loading schedule…';
    try {
      var response = await fetch('/api/v1/channels/' + encodeURIComponent(state.id) + '/guide?hours=8&from=' + state.from, { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Schedule unavailable');
      var data = await response.json();
      if (!Array.isArray(data.programs)) throw new Error('Invalid schedule');
      if (state.request !== request || !dialog.open) return;
      state.data = data;
      render();
    } catch (error) {
      if (request.signal.aborted) return;
      status.textContent = 'Could not load this schedule. Select Refresh to try again.';
    }
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-channel-guide]');
    if (!button) return;
    state.opener = button;
    state.id = button.getAttribute('data-channel-guide');
    state.from = Date.now();
    dialog.querySelector('h2').textContent = button.getAttribute('data-guide-name');
    dialog.showModal();
    load();
  });
  function outsideGuide(event) {
    var bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  var backdropPress = false;
  dialog.addEventListener('pointerdown', function (event) {
    backdropPress = event.target === dialog && outsideGuide(event);
  });
  dialog.addEventListener('pointercancel', function () { backdropPress = false; });
  dialog.addEventListener('click', function (event) {
    var closeBackdrop = backdropPress && event.target === dialog && outsideGuide(event);
    backdropPress = false;
    if (closeBackdrop) { dialog.close(); return; }

    var button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close')) dialog.close();
    if (button.hasAttribute('data-view')) {
      state.mode = button.getAttribute('data-view');
      dialog.querySelectorAll('[data-view]').forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
      render();
    }
    if (button.hasAttribute('data-step')) { state.from += Number(button.getAttribute('data-step')) * hours; load(); }
    if (button.hasAttribute('data-now')) { state.from = Date.now(); load(); }
    if (button.hasAttribute('data-refresh')) load();
  });
  dialog.addEventListener('close', function () {
    if (state.request) state.request.abort();
    if (state.opener) state.opener.focus();
  });
})();
