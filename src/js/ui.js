/**
 * Rendering and DOM wiring.
 *
 * The interface is split in two. The Player tab carries only what the person
 * running the service touches: the list, what is playing, and one big button.
 * Everything else lives on the Setup tab, because a volunteer should never be
 * a slider away from ruining a service.
 *
 * Each MIDI row carries its own instrument chooser, so the instrument for every
 * hymn is decided in the sacristy beforehand rather than mid-service.
 *
 * The playlist is built with DOM nodes rather than an innerHTML template. The
 * original interpolated the filename straight into innerHTML, so a file named
 * with an HTML tag in it executed script when the list rendered.
 *
 * There is one animation loop for the whole application, and it idles whenever
 * nothing is sounding.
 */

import { State, displayName, TEMPO_MIN, TEMPO_MAX } from './player.js';

const $ = id => document.getElementById(id);

/** 83.4 -> "1:23", 3725 -> "1:02:05". */
const formatTime = seconds => {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
};

/**
 * A button that acts once when pressed and then repeats while held, for the
 * tempo steps: nudging a hymn by eight per cent should not take eight clicks.
 *
 * It never takes focus, because a focused button would swallow the spacebar
 * that drives the transport. The release is listened for on the window, since
 * the playlist rebuilds its rows on every change and the button pressed may no
 * longer be in the page when the pointer comes up.
 */
function pressAndRepeat(button, act) {
  button.tabIndex = -1;
  button.addEventListener('mousedown', e => e.preventDefault());   // no focus
  button.addEventListener('click', e => e.stopPropagation());
  button.addEventListener('pointerdown', e => {
    if (e.button !== 0 || button.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    act();
    let interval = null;
    const delay = setTimeout(() => { interval = setInterval(act, 110); }, 450);
    const stop = () => {
      clearTimeout(delay);
      clearInterval(interval);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
  });
}

/**
 * Turn the containing playlist row's drag source on or off.
 *
 * Used to stop a press on a row's instrument dropdown from being read as the
 * start of a drag, which would close the dropdown again.
 */
const setRowDraggable = (el, on) => {
  const row = el.closest('.pl-item');
  if (row) row.draggable = on;
};

const STATUS_CLASS = {
  [State.EMPTY]: 's-empty',
  [State.READY]: 's-ready',
  [State.LOADING]: 's-loading',
  [State.PLAYING]: 's-playing',
  [State.FADING]: 's-fading',
};

export class UI {
  constructor(player, settings) {
    this.player = player;
    this.settings = settings;
    this.instruments = [];
    this.el = {
      playlist: $('playlist'),
      nowPlaying: $('nowPlaying'),
      nextTrack: $('nextTrack'),
      mainBtn: $('mainBtn'),
      pill: $('pill'),
      pFill: $('pFill'),
      seek: $('seek'),
      tElapsed: $('tElapsed'),
      tTotal: $('tTotal'),
      tCue: $('tCue'),
      tempoLive: $('tempoLive'),
      tempoDown: $('tempoDown'),
      tempoUp: $('tempoUp'),
      tempoVal: $('tempoVal'),
      vFill: $('vFill'),
      sfInfo: $('sfInfo'),
      fileIn: $('fileIn'),
      instrument: $('midiInst'),
    };
    this.dragFrom = null;
    this.rafId = null;

    player.on('change', () => this.render());
    player.on('status', (msg, state) => this.setStatus(msg, state));

    this._bindTabs();
    this._bindPlaylist();
    this._bindSeek();
    this._bindTempo();
  }

  // -- Tabs ------------------------------------------------------------------

  _bindTabs() {
    const tabs = [
      { tab: $('tabPlayer'), panel: $('panelPlayer') },
      { tab: $('tabSetup'), panel: $('panelSetup') },
    ];
    const show = active => {
      for (const { tab, panel } of tabs) {
        const on = tab === active;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('active', on);
        panel.hidden = !on;
      }
      // Keyboard focus must not be left inside a hidden panel, or the
      // spacebar would stop reaching the transport.
      active.blur();
    };
    for (const { tab } of tabs) tab.addEventListener('click', () => show(tab));
    show(tabs[0].tab);
    this.showPlayerTab = () => show(tabs[0].tab);
  }

  // -- Status and transport --------------------------------------------------

  setStatus(text, state) {
    this.el.pill.textContent = text;
    this.el.pill.className = 'status-pill ' + (STATUS_CLASS[state] || 's-empty');
  }

  showSoundfontWarning(show) {
    this.el.sfInfo.classList.toggle('show', !!show);
  }

  render() {
    const p = this.player;
    this.el.nowPlaying.textContent = p.currentTrack ? displayName(p.currentTrack.name) : '—';
    this.el.nextTrack.textContent = p.nextTrack
      ? displayName(p.nextTrack.name)
      : '— (end of playlist)';

    const label = p.state === State.PLAYING ? '⏸ Playing…'
                : p.state === State.FADING ? '▼ Fading…'
                : p.state === State.LOADING ? '… Loading'
                : '▶ Play';
    this.el.mainBtn.textContent = label;
    this.el.mainBtn.classList.toggle('fading', p.state === State.FADING);

    this.renderPlaylist();
    this.renderTempo();
    this.renderTime();
    this._ensureLoop();
  }

  // -- Tempo -----------------------------------------------------------------

  /** The live control, shown for a MIDI hymn only. */
  renderTempo() {
    const track = this.player.currentTrack;
    const show = !!(track && track.midi);
    this.el.tempoLive.hidden = !show;
    if (!show) return;
    this.el.tempoVal.textContent = track.tempo + '%';
    this.el.tempoVal.classList.toggle('changed', track.tempo !== 100);
    this.el.tempoDown.disabled = track.tempo <= TEMPO_MIN;
    this.el.tempoUp.disabled = track.tempo >= TEMPO_MAX;
  }

  _bindTempo() {
    const step = delta => () => {
      const p = this.player, track = p.currentTrack;
      if (track && track.midi) p.setTrackTempo(p.index, track.tempo + delta);
    };
    pressAndRepeat(this.el.tempoDown, step(-1));
    pressAndRepeat(this.el.tempoUp, step(+1));
  }

  /** The - 100% + shifter on a MIDI row of the list. */
  _buildTempoShifter(track, i) {
    const wrap = document.createElement('span');
    wrap.className = 'pl-tempo';
    wrap.title = 'Tempo for this hymn, remembered for next time';
    wrap.draggable = false;
    wrap.addEventListener('pointerenter', () => setRowDraggable(wrap, false));
    wrap.addEventListener('pointerleave', () => setRowDraggable(wrap, true));

    const set = pct => this.player.setTrackTempo(i, pct);
    const button = (text, label, delta, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tempo-btn';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      pressAndRepeat(b, () => set(this.player.tracks[i].tempo + delta));
      return b;
    };

    // Clicking the figure puts the hymn back to its own tempo.
    const value = document.createElement('button');
    value.type = 'button';
    value.className = 'pl-tempo-val' + (track.tempo !== 100 ? ' changed' : '');
    value.textContent = track.tempo + '%';
    value.title = track.tempo !== 100 ? 'Back to 100%' : 'Tempo as written';
    value.tabIndex = -1;
    value.addEventListener('mousedown', e => e.preventDefault());
    value.addEventListener('click', e => { e.stopPropagation(); set(100); });

    wrap.append(button('−', 'Slower', -1, track.tempo <= TEMPO_MIN), value,
                button('+', 'Faster', +1, track.tempo >= TEMPO_MAX));
    return wrap;
  }

  // -- Timeline --------------------------------------------------------------

  /** Elapsed and total time, VLC style, plus the bar. */
  renderTime() {
    const p = this.player;
    const total = p.isSounding ? p.currentDuration : p.duration;
    const pos = this.seekPreview !== null ? this.seekPreview : p.position;
    // Positions are in the file's own seconds; the clock shows real time, so
    // a hymn slowed to 90% shows as longer, as it will actually take.
    const rate = p.rate;
    this.el.tElapsed.textContent = formatTime(pos / rate);
    this.el.tTotal.textContent = formatTime(total / rate);
    this.el.pFill.style.width = (total ? Math.min(1, pos / total) * 100 : 0).toFixed(1) + '%';

    // Say plainly when play will not start from the top, since nothing else
    // on screen would show it.
    const cued = !p.isSounding && p.currentTrack && p.currentTrack.cue > 0;
    this.el.tCue.textContent = cued ? 'Starts at ' + formatTime(p.currentTrack.cue / rate) : '';
    this.el.seek.classList.toggle('off', !this._canSeek());
  }

  _canSeek() {
    const s = this.player.state;
    return !!this.player.currentTrack && (s === State.READY || s === State.PLAYING);
  }

  /**
   * Click or drag on the bar to move. The jump happens on release, not while
   * dragging, so sweeping across the bar is one jump rather than dozens.
   */
  _bindSeek() {
    const bar = this.el.seek;
    this.seekPreview = null;
    const at = e => {
      const r = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const p = this.player;
      return frac * (p.isSounding ? p.currentDuration : p.duration);
    };

    bar.addEventListener('pointerdown', e => {
      if (!this._canSeek() || e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      this.seekPreview = at(e);
      this.renderTime();
    });
    bar.addEventListener('pointermove', e => {
      if (this.seekPreview === null) return;
      this.seekPreview = at(e);
      this.renderTime();
    });
    const end = (e, commit) => {
      if (this.seekPreview === null) return;
      const target = at(e);
      this.seekPreview = null;
      bar.classList.remove('dragging');
      if (commit && this._canSeek()) this.player.seek(target);
      this.renderTime();
    };
    bar.addEventListener('pointerup', e => end(e, true));
    bar.addEventListener('pointercancel', e => end(e, false));
  }

  // -- Playlist --------------------------------------------------------------

  renderPlaylist() {
    const box = this.el.playlist;
    const p = this.player;

    // Rebuilding the list would close an open dropdown mid-choice.
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') {
      this._refreshRowClasses();
      return;
    }

    box.textContent = '';

    if (!p.tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'pl-empty';
      empty.textContent = 'No music loaded. Click “Load files” to choose this service’s music.';
      box.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    p.tracks.forEach((track, i) => frag.appendChild(this._buildRow(track, i)));
    box.appendChild(frag);
  }

  _rowClass(i) {
    const p = this.player;
    return 'pl-item'
      + (i === p.index ? ' active' : i === p.index + 1 ? ' queued' : '');
  }

  _refreshRowClasses() {
    for (const row of this.el.playlist.querySelectorAll('.pl-item')) {
      const i = Number(row.dataset.i);
      row.className = this._rowClass(i) + (row.classList.contains('midi') ? ' midi' : '');
    }
  }

  _buildRow(track, i) {
    const row = document.createElement('div');
    row.className = this._rowClass(i) + (track.midi ? ' midi' : '');
    row.draggable = true;
    row.dataset.i = String(i);

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.title = 'Drag to reorder';
    handle.textContent = '↕';

    const num = document.createElement('span');
    num.className = 'pl-num';
    num.textContent = String(i + 1);

    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = displayName(track.name);

    row.append(handle, num, name);

    if (track.midi) {
      // The instrument chooser for this one hymn. Clicking it must not also
      // select the track, so the click is stopped here.
      const picker = this._buildInstrumentSelect(track, i);
      row.append(picker, this._buildTempoShifter(track, i));
    } else {
      const badge = document.createElement('span');
      badge.className = 'pl-badge audio';
      badge.textContent = 'audio';
      row.appendChild(badge);
    }
    return row;
  }

  _buildInstrumentSelect(track, i) {
    const wrap = document.createElement('label');
    wrap.className = 'pl-inst';
    wrap.title = 'Instrument for this track';

    const select = document.createElement('select');
    select.className = 'pl-inst-select';
    select.dataset.i = String(i);

    if (!this.instruments.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Church Organ';
      select.appendChild(opt);
    } else {
      let group = null, holder = select;
      for (const inst of this.instruments) {
        if (inst.group !== group) {
          group = inst.group;
          holder = document.createElement('optgroup');
          holder.label = group;
          select.appendChild(holder);
        }
        const opt = document.createElement('option');
        opt.value = inst.key;
        opt.textContent = inst.label;
        if (inst.use) opt.title = inst.use;
        holder.appendChild(opt);
      }
      select.value = track.instrument;
    }

    // A click on the dropdown is not a request to jump to that track.
    const swallow = e => e.stopPropagation();
    select.addEventListener('click', swallow);
    select.addEventListener('pointerdown', swallow);
    select.addEventListener('change', e => {
      e.stopPropagation();
      this.player.setTrackInstrument(Number(select.dataset.i), select.value);
      select.blur();
    });

    // The dropdown has to stay open until the operator picks something or
    // clicks away, and it did not.
    //
    // The row is a drag source, so that the playlist can be reordered. A press
    // anywhere inside it, the dropdown included, arms a drag, and the moment
    // the pointer moves a pixel the browser begins dragging the row and closes
    // the list that had just opened. Whether it stayed open therefore depended
    // on holding the mouse perfectly still, which is the fiddliness.
    //
    // Marking the wrapper `draggable = false` does not help, and neither does
    // cancelling `dragstart` here: the drag source is the row, so `dragstart`
    // fires there and never passes through this element at all. The row's own
    // draggability has to be suspended instead, for as long as the pointer is
    // over the dropdown.
    wrap.draggable = false;
    wrap.addEventListener('pointerenter', () => setRowDraggable(wrap, false));
    wrap.addEventListener('pointerleave', () => setRowDraggable(wrap, true));

    wrap.appendChild(select);
    return wrap;
  }

  _bindPlaylist() {
    const box = this.el.playlist;

    // Safety net for the draggability suspended while the pointer is over an
    // instrument dropdown. The native list is drawn by the operating system
    // and can swallow the pointer as it opens, so `pointerleave` is not
    // guaranteed to arrive, and a row left undraggable could no longer be
    // reordered. Any press elsewhere in the playlist restores every row.
    box.addEventListener('pointerdown', e => {
      if (e.target.closest('.pl-inst, .pl-tempo')) return;
      for (const row of box.querySelectorAll('.pl-item')) row.draggable = true;
    });

    box.addEventListener('click', e => {
      if (e.target.closest('.pl-inst, .pl-tempo')) return;
      const row = e.target.closest('.pl-item');
      if (!row || !row.dataset.i || this.justDragged) return;
      this.player.jumpTo(Number(row.dataset.i));
    });

    box.addEventListener('dragstart', e => {
      const row = e.target.closest('.pl-item');
      if (!row) return;
      this.dragFrom = Number(row.dataset.i);
      this.justDragged = false;
      row.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.i);
    });

    box.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const row = e.target.closest('.pl-item');
      for (const el of box.querySelectorAll('.pl-item')) el.classList.remove('drag-over');
      if (row) row.classList.add('drag-over');
    });

    box.addEventListener('drop', e => {
      e.preventDefault();
      const row = e.target.closest('.pl-item');
      if (!row || this.dragFrom === null) return;
      this.justDragged = true;
      this.player.move(this.dragFrom, Number(row.dataset.i));
      this.dragFrom = null;
    });

    box.addEventListener('dragend', e => {
      const row = e.target.closest('.pl-item');
      if (row) row.style.opacity = '';
      for (const el of box.querySelectorAll('.pl-item')) el.classList.remove('drag-over');
      setTimeout(() => { this.justDragged = false; }, 50);
    });
  }

  /** One loop, running only while something is sounding. */
  _ensureLoop() {
    if (!this.player.isSounding || this.rafId !== null) return;
    const tick = () => {
      if (!this.player.isSounding) {
        this.rafId = null;
        this.el.vFill.style.width = '0%';
        this.renderTime();
        return;
      }
      this.renderTime();
      this.el.vFill.style.width = (this.player.level * 100).toFixed(0) + '%';
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Populate the instrument lists from soundfonts/manifest.json. */
  async loadInstruments() {
    try {
      const res = await fetch('soundfonts/manifest.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('manifest ' + res.status);
      const manifest = await res.json();
      const list = Array.isArray(manifest.instruments) ? manifest.instruments : [];
      if (!list.length) throw new Error('manifest is empty');

      // The player needs each instrument's group to decide how to voice a
      // performance on it.
      this.player.instrumentGroups = Object.fromEntries(
        list.map(i => [i.key, i.group || 'Other']));

      this.instruments = list.map(i => ({
        key: i.key,
        label: i.label || i.key,
        group: i.group || 'Other',
        use: i.use || '',
      }));

      const sel = this.el.instrument;
      sel.textContent = '';
      let group = null, holder = sel;
      for (const inst of this.instruments) {
        if (inst.group !== group) {
          group = inst.group;
          holder = document.createElement('optgroup');
          holder.label = group;
          sel.appendChild(holder);
        }
        const opt = document.createElement('option');
        opt.value = inst.key;
        opt.textContent = inst.label;
        if (inst.use) opt.title = inst.use;
        holder.appendChild(opt);
      }

      const known = this.instruments.some(i => i.key === this.settings.instrument);
      const wanted = known ? this.settings.instrument
                   : this.instruments.some(i => i.key === 'church_organ') ? 'church_organ'
                   : this.instruments[0].key;
      sel.value = wanted;
      this.settings.instrument = wanted;
      this.showSoundfontWarning(false);
    } catch (err) {
      console.warn('Instrument list unavailable:', err.message);
      this.showSoundfontWarning(true);
    }
  }
}
