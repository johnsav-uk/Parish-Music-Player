/**
 * Input handling: one button, a keyboard, and a Bluetooth clicker, mapped onto
 * three intentions.
 *
 *   TRIGGER  short press          -> play the armed track
 *   FADE     double press or hold -> fade out over the configured seconds
 *   PANIC    Escape               -> immediate silence
 *
 * Why a double press fades rather than stopping dead: in a sanctuary an abrupt
 * cut is far more noticeable than a three-second fade, and the operator needs
 * one gesture they can use without looking. Instant stop stays available on
 * Escape for genuine emergencies.
 *
 * Three input problems in the original are fixed here.
 *
 * 1. A press while a track was playing restarted it from the beginning. Here a
 *    lone press during playback does nothing; only the second press of a pair
 *    acts, so a stray clicker knock is harmless.
 *
 * 2. Touching any slider moved keyboard focus into it, and the global key
 *    handler then ignored every key because the event target was an input. The
 *    spacebar silently stopped working for the rest of the service. Controls now
 *    release focus as soon as they are done, and the handler decides by control
 *    type rather than refusing everything.
 *
 * 3. mousedown/mouseup and touchstart/touchend were both bound, so a touch
 *    screen fired the press twice. Pointer events handle all input devices once.
 */

export const Intent = {
  TRIGGER: 'TRIGGER',
  FADE: 'FADE',
  PANIC: 'PANIC',
  // A press that arrived while a track was sounding and did not form a pair.
  // It deliberately does not stop the music, but it must still be acknowledged:
  // a press that produces no visible response at all reads as a broken player.
  NUDGE: 'NUDGE',
};

// Keys a presentation clicker is likely to send out of the box. Most send arrow
// keys; some send Page Up / Page Down, and a few send B or Enter for "advance".
// A clicker that sends something else can be taught, see learnKey().
export const DEFAULT_TRIGGER_CODES =
  ['Space', 'ArrowRight', 'ArrowDown', 'PageDown', 'Enter', 'NumpadEnter', 'KeyB'];
export const DEFAULT_FADE_CODES = ['ArrowLeft', 'ArrowUp', 'PageUp', 'KeyF'];

const PANIC_CODES = new Set(['Escape']);

/** Human-readable name for a KeyboardEvent.code, for the Setup screen. */
export function describeKey(code) {
  const names = {
    Space: 'Space', ArrowRight: 'Right arrow', ArrowLeft: 'Left arrow',
    ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', PageUp: 'Page Up',
    PageDown: 'Page Down', Enter: 'Enter', NumpadEnter: 'Enter (numpad)',
    Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Period: 'Full stop',
  };
  if (names[code]) return names[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.slice(6) + ' (numpad)';
  return code;
}

/** Keys must reach a text field; they must not reach the transport. */
function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  if (el.tagName === 'TEXTAREA') return true;
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type);
}

/** Arrow keys legitimately belong to a focused slider or dropdown. */
function isValueControl(el) {
  return !!el && ((el.tagName === 'INPUT' && el.type === 'range') || el.tagName === 'SELECT');
}

export class Controls {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.button       the big press target
   * @param {HTMLElement} opts.holdBar      progress indicator for the hold gesture
   * @param {object} opts.settings
   * @param {(intent:string)=>void} opts.onIntent
   * @param {()=>boolean} opts.isSounding   true while a track is playing or fading
   */
  constructor({ button, holdBar, settings, onIntent, isSounding }) {
    this.button = button;
    this.holdBar = holdBar;
    this.settings = settings;
    this.onIntent = onIntent;
    this.isSounding = isSounding;

    this.triggerCodes = new Set(settings.triggerKeys);
    this.fadeCodes = new Set(settings.fadeKeys);
    this.learning = null;          // 'trigger' | 'fade' while teaching a key

    this.holdTimer = null;
    this.holdStart = 0;
    this.holdRaf = null;
    this.holdConsumed = false;
    this.pressActive = false;
    this.lastPressAt = 0;

    this._bindButton();
    this._bindKeyboard();
    this._bindFocusGuards();
  }

  // -- Gesture resolution ----------------------------------------------------

  _pressStart() {
    if (this.pressActive) return;            // ignore a repeat from another device
    this.pressActive = true;
    this.holdConsumed = false;
    this.holdStart = Date.now();
    this.button.classList.add('holding');
    this._animateHoldBar();

    this.holdTimer = setTimeout(() => {
      // A hold means "fade out", which only means anything while a track is
      // sounding. With nothing playing, the gesture must NOT be consumed: a
      // deliberate press that happens to last longer than the threshold should
      // still start the music on release. Swallowing it made a slightly slow
      // press — the normal way people use a clicker — do nothing at all.
      if (!this.isSounding()) { this._endHoldVisuals(); return; }
      this.holdConsumed = true;
      this._endHoldVisuals();
      this.onIntent(Intent.FADE);
    }, this.settings.holdThresholdMs);
  }

  _pressEnd() {
    if (!this.pressActive) return;
    this.pressActive = false;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this._endHoldVisuals();

    if (this.holdConsumed) { this.holdConsumed = false; return; }

    const now = Date.now();
    const sinceLast = now - this.lastPressAt;
    this.lastPressAt = now;

    // A double press only means anything while something is sounding. That
    // keeps the play action instant: it never waits to see if a second press
    // is coming.
    if (this.isSounding()) {
      if (sinceLast > 0 && sinceLast < this.settings.doublePressMs) {
        this.lastPressAt = 0;
        this.onIntent(Intent.FADE);
      } else {
        // A lone press during playback still must not stop the music, but the
        // operator gets told what the press would have to be to do something.
        this.onIntent(Intent.NUDGE);
      }
      return;
    }

    this.onIntent(Intent.TRIGGER);
  }

  _cancelPress() {
    if (!this.pressActive) return;
    this.pressActive = false;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdConsumed = false;
    this._endHoldVisuals();
  }

  _animateHoldBar() {
    const threshold = this.settings.holdThresholdMs;
    const tick = () => {
      if (!this.pressActive) return;
      const pct = Math.min(100, ((Date.now() - this.holdStart) / threshold) * 100);
      this.holdBar.style.width = pct.toFixed(0) + '%';
      if (pct < 100) this.holdRaf = requestAnimationFrame(tick);
    };
    this.holdRaf = requestAnimationFrame(tick);
  }

  _endHoldVisuals() {
    if (this.holdRaf) cancelAnimationFrame(this.holdRaf);
    this.holdRaf = null;
    this.holdBar.style.width = '0%';
    this.button.classList.remove('holding');
  }

  // -- Bindings --------------------------------------------------------------

  _bindButton() {
    const b = this.button;
    b.addEventListener('pointerdown', e => {
      e.preventDefault();                     // no text selection, no focus steal
      b.setPointerCapture?.(e.pointerId);     // keeps the release even off-target
      this._pressStart();
    });
    b.addEventListener('pointerup', e => { e.preventDefault(); this._pressEnd(); });
    b.addEventListener('pointercancel', () => this._cancelPress());
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (isTextEntry(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Teaching mode swallows the next key and assigns it.
      if (this.learning) {
        e.preventDefault();
        this._captureKey(e.code);
        return;
      }

      if (PANIC_CODES.has(e.code)) {
        e.preventDefault();
        this.onIntent(Intent.PANIC);
        return;
      }

      // Let a focused slider or dropdown keep its own arrow keys; everything
      // else routes to the transport.
      const ownedByControl = isValueControl(document.activeElement) && e.code !== 'Space';

      if (this.triggerCodes.has(e.code) && !ownedByControl) {
        e.preventDefault();
        if (!e.repeat) this._pressStart();     // held key becomes a hold gesture
        return;
      }
      if (this.fadeCodes.has(e.code) && !ownedByControl) {
        e.preventDefault();
        if (!e.repeat) this.onIntent(Intent.FADE);
      }
    });

    document.addEventListener('keyup', e => {
      if (isTextEntry(e.target)) return;
      if (this.triggerCodes.has(e.code) && this.pressActive) {
        e.preventDefault();
        this._pressEnd();
      }
    });

    // Losing the window mid-press must not leave a hold timer armed.
    window.addEventListener('blur', () => this._cancelPress());
  }

  /**
   * Keep keyboard focus out of the settings controls.
   *
   * Sliders and dropdowns hand focus back as soon as the interaction finishes,
   * and a click on empty space returns focus to the transport button, so the
   * spacebar and the clicker always work no matter what was touched last.
   */
  _bindFocusGuards() {
    document.addEventListener('change', e => {
      if (isValueControl(e.target)) setTimeout(() => e.target.blur(), 0);
    });
    document.addEventListener('pointerup', e => {
      // Sliders only, deliberately.
      //
      // A dropdown opens its list on pointer-down, and the pointer-up that
      // follows a fraction of a second later arrives while the list is open.
      // Blurring it there closed the list again, so the instrument chooser
      // appeared and vanished in the same gesture and the only way to use it
      // was to guess. A dropdown gives focus back on `change` instead, which is
      // the handler above, or when something else is clicked, which is the
      // handler below.
      if (e.target.tagName === 'INPUT' && e.target.type === 'range') {
        setTimeout(() => e.target.blur(), 0);
      }
    });
    document.addEventListener('pointerdown', e => {
      const el = e.target;
      const interactive = el.closest('input, select, button, label, .pl-item, a');
      if (!interactive && document.activeElement !== document.body) document.activeElement.blur();
    });
  }

  // -- Teaching a clicker ----------------------------------------------------

  /**
   * Wait for the next key press and assign it to an action.
   *
   * The README used to tell anyone whose clicker sent something unexpected to
   * raise an issue and wait for a new release. This lets them fix it in the
   * sacristy in five seconds instead.
   *
   * @param {'trigger'|'fade'} action
   * @param {(codes: {trigger: string[], fade: string[]}) => void} onDone
   */
  learnKey(action, onDone) {
    this.learning = action;
    this._learnDone = onDone;
  }

  cancelLearn() {
    this.learning = null;
    this._learnDone = null;
  }

  _captureKey(code) {
    const action = this.learning;
    this.learning = null;
    if (code === 'Escape') { if (this._learnDone) this._learnDone(this.keyMap()); return; }

    // A key can only mean one thing, so remove it from the other action first.
    this.triggerCodes.delete(code);
    this.fadeCodes.delete(code);
    (action === 'fade' ? this.fadeCodes : this.triggerCodes).add(code);

    this.settings.triggerKeys = [...this.triggerCodes];
    this.settings.fadeKeys = [...this.fadeCodes];
    this.settings.save();
    if (this._learnDone) this._learnDone(this.keyMap());
  }

  keyMap() {
    return { trigger: [...this.triggerCodes], fade: [...this.fadeCodes] };
  }

  resetKeys() {
    this.triggerCodes = new Set(DEFAULT_TRIGGER_CODES);
    this.fadeCodes = new Set(DEFAULT_FADE_CODES);
    this.settings.triggerKeys = [...this.triggerCodes];
    this.settings.fadeKeys = [...this.fadeCodes];
    this.settings.save();
    return this.keyMap();
  }

  /**
   * Bluetooth media buttons (Play/Pause, Next, Stop).
   *
   * Chrome and WebView2 only route these through the Media Session API while
   * something is registered as playing media, and a Web Audio graph alone does
   * not qualify. A silent looping audio element claims the session. It also
   * marks the page as audible, which stops the browser throttling the timers
   * the MIDI scheduler depends on when the window is not in front.
   */
  enableMediaKeys() {
    if (!('mediaSession' in navigator) || this._mediaKeysReady) return;
    if (!this.settings.mediaKeys) return;
    this._mediaKeysReady = true;

    const el = document.createElement('audio');
    el.loop = true;
    el.volume = 0.0001;                       // inaudible, but counts as playback
    // One second of silence, as a WAV data URI; no extra file to ship.
    el.src = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAA==';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this._keepAlive = el;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Parish Music Player',
      artist: 'Liturgical music',
    });

    const map = {
      play: Intent.TRIGGER,
      nexttrack: Intent.TRIGGER,
      pause: Intent.FADE,
      stop: Intent.FADE,
      previoustrack: Intent.FADE,
    };
    for (const [action, intent] of Object.entries(map)) {
      try {
        navigator.mediaSession.setActionHandler(action, () => this.onIntent(intent));
      } catch (e) {
        // Not every action is supported on every platform.
      }
    }
  }

  /** Called by the app so the silent element follows the transport state. */
  setMediaPlaybackState(isPlaying) {
    if (!this._keepAlive) return;
    if (isPlaying) this._keepAlive.play().catch(() => {});
    else this._keepAlive.pause();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }
}
