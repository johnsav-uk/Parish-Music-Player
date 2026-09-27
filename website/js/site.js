/* Parish Music Player — website behaviour. No frameworks, no build step. */

(function () {
  'use strict';

  /* ── Settings ───────────────────────────────────────────────────────── */

  // Where the feedback form's messages go. FormSubmit relays them by email;
  // the first message sent triggers a one-off confirmation email to this
  // address, which has to be clicked before any feedback is delivered.
  // After confirming, FormSubmit offers a random alias to put here instead,
  // so the address itself is not in the page source.
  var FEEDBACK_ENDPOINT = 'https://formsubmit.co/ajax/john@johnsav.co.uk';
  var FEEDBACK_FALLBACK = 'mailto:john@johnsav.co.uk';

  // Paste the Buy Me a Coffee page here, e.g. 'https://buymeacoffee.com/yourname'.
  // While it is empty the button shows as "coming soon" and does nothing.
  var COFFEE_URL = 'https://buymeacoffee.com/johnjsav';

  var REPO = 'johnsav-uk/Parish-Music-Player';

  /* ── Installer link: point straight at the latest .exe ──────────────── */

  var installerLinks = document.querySelectorAll('.js-installer');
  var installerMeta = document.querySelector('.js-installer-meta');

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (release) {
      var asset = (release.assets || []).filter(function (a) {
        return /setup.*\.exe$/i.test(a.name);
      })[0];
      if (!asset) return;
      installerLinks.forEach(function (a) { a.href = asset.browser_download_url; });
      if (installerMeta) {
        var mb = Math.round(asset.size / 1048576);
        installerMeta.textContent = 'Version ' + release.tag_name.replace(/^v/, '') +
          ' · ' + mb + ' MB · Windows 10 or 11';
      }
    })
    .catch(function () { /* The links already point at the releases page. */ });

  /* ── Buy Me a Coffee ────────────────────────────────────────────────── */

  var coffee = document.getElementById('coffeeBtn');
  if (coffee) {
    if (COFFEE_URL) {
      coffee.href = COFFEE_URL;
      coffee.target = '_blank';
      coffee.rel = 'noopener';
      coffee.removeAttribute('aria-disabled');
      document.getElementById('coffeeLabel').textContent = 'Buy me a coffee';
    } else {
      coffee.addEventListener('click', function (e) { e.preventDefault(); });
    }
  }

  /* ── Feedback form ──────────────────────────────────────────────────── */

  var form = document.getElementById('feedbackForm');
  if (!form) return;
  var status = document.getElementById('fbStatus');
  var submit = document.getElementById('fbSubmit');
  var message = document.getElementById('fbMessage');
  var email = document.getElementById('fbEmail');

  function say(text, kind) {
    status.textContent = text;
    status.className = 'form-status' + (kind ? ' ' + kind : '');
  }

  function fallbackLink() {
    var body = 'Topic: ' + form.topic.value + '\nVersion: ' + form.version.value + '\n\n' + message.value;
    return FEEDBACK_FALLBACK + '?subject=' + encodeURIComponent('Parish Music Player feedback') +
      '&body=' + encodeURIComponent(body);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    message.removeAttribute('aria-invalid');
    email.removeAttribute('aria-invalid');

    if (!message.value.trim()) {
      message.setAttribute('aria-invalid', 'true');
      message.focus();
      say('Please write a message first.', 'bad');
      return;
    }
    if (email.value && !email.checkValidity()) {
      email.setAttribute('aria-invalid', 'true');
      email.focus();
      say('That email address doesn’t look quite right.', 'bad');
      return;
    }
    if (form._honey.value) return;   // a bot

    var payload = {
      _subject: 'Parish Music Player feedback: ' + form.topic.value,
      _template: 'table',
      _captcha: 'false',
      Name: form.name.value.trim() || '(not given)',
      Email: form.email.value.trim() || '(not given)',
      Parish: form.parish.value.trim() || '(not given)',
      About: form.topic.value,
      Version: form.version.value,
      Message: message.value.trim(),
      Browser: navigator.userAgent
    };
    if (payload.Email !== '(not given)') payload._replyto = payload.Email;

    submit.disabled = true;
    say('Sending…');

    fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || String(res.body.success) !== 'true') throw new Error(res.body.message || 'failed');
        form.reset();
        say('Thank you, your feedback has been sent.', 'ok');
      })
      .catch(function () {
        status.className = 'form-status bad';
        status.textContent = 'Sorry, that didn’t send. ';
        var a = document.createElement('a');
        a.href = fallbackLink();
        a.textContent = 'Send it by email instead';
        status.appendChild(a);
      })
      .then(function () { submit.disabled = false; });
  });
})();
