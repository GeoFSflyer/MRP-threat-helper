// GeoFS MRP Helper v2.1
// Host this file on GitHub and load it via the short bookmarklet.
// Bookmarklet: javascript:(function(){if(window.__mrpThreatHelperV20Loaded){alert('Already loaded');return;}var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@latest/mrp-helper.js';s.onerror=function(){alert('MRP Helper: failed to load script.')};document.head.appendChild(s);})();

(function () {
  if (window.__mrpThreatHelperV20Loaded) {
    alert('GeoFS MRP Helper already loaded');
    return;
  }
  window.__mrpThreatHelperV20Loaded = true;

  // ── Config ────────────────────────────────────────────────────────────────

  var CONFIG = {
    hudTitle: 'GeoFS MRP Helper',
    ownName: '',
    enableSounds: true,
    soundVolume: 0.9,
    fuzzyThreshold: 0.78,
    judgmentWindow: 5,   // seconds attacker has to declare hit/miss after "away"
    minHitTime: 3        // hit declared before this many seconds = invalid
  };

  // ── State ─────────────────────────────────────────────────────────────────

  var state = {
    lastThreat: null,
    history: [],
    audioCtx: null,
    warningTimer: null,
    warningMode: '',
    drag: null,
    minimized: false,
    settingsOpen: false
  };

  var senderState = { pendingBySender: new Map(), lastSender: '' };
  var damageFeature = { enabled: false, hitCount: 0, baseTurbulence: null };

  // Hit judge: tracks the 5-second window after "away" is called
  var judgeState = {
    active: false,
    awayTime: null,
    threat: null,
    userCMs: [],             // [{ type, elapsed }] — user's own countermeasures
    countdownInterval: null,
    countdownRemaining: 0,
    judgeResult: null        // 'miss_cm'|'miss_timeout'|'hit_invalid'|'miss_declared'|'hit_valid'
  };

  // ── Audio ─────────────────────────────────────────────────────────────────

  function ensureAudio() {
    if (state.audioCtx) return state.audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    state.audioCtx = new Ctx();
    return state.audioCtx;
  }

  function unlockAudio() {
    var ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
  }

  function beep(freq, dur, type, vol) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var now = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vol || 0.06), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.03);
  }

  function playTone(type) {
    if (!CONFIG.enableSounds) return;
    unlockAudio();
    var v = Math.max(0.02, CONFIG.soundVolume * 0.08);
    if      (type === 'lock')    beep(880,  0.14, 'sine',     v);
    else if (type === 'away')    beep(1240, 0.18, 'triangle', v);
    else if (type === 'hit')     beep(320,  0.25, 'sawtooth', v);
    else if (type === 'miss')    beep(640,  0.18, 'square',   v);
    else if (type === 'invalid') beep(200,  0.30, 'square',   v);
  }

  function stopWarningLoop() {
    if (state.warningTimer) clearInterval(state.warningTimer);
    state.warningTimer = null;
    state.warningMode = '';
  }

  function startWarningLoop(mode) {
    if (!CONFIG.enableSounds) return;
    unlockAudio();
    if (state.warningMode === mode && state.warningTimer) return;
    stopWarningLoop();
    state.warningMode = mode;
    function run() {
      if (mode === 'lock') playTone('lock');
      else if (mode === 'away') playTone('away');
    }
    run();
    state.warningTimer = setInterval(run, mode === 'away' ? 700 : 850);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function normalizeName(s) {
    return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  }

  function applyHitDamage() {
    if (!damageFeature.enabled) return;
    damageFeature.hitCount += 1;
    try {
      if (damageFeature.hitCount >= 2) {
        if (damageFeature.baseTurbulence === null)
          damageFeature.baseTurbulence =
            window.weather && window.weather.definition
              ? window.weather.definition.turbulences : 0;
        if (window.weather && window.weather.definition)
          window.weather.definition.turbulences = damageFeature.hitCount >= 3 ? 8 : 4;
      }
    } catch (e) { console.warn('MRP: damage effect failed', e); }
  }

  function resetDamageState() {
    damageFeature.hitCount = 0;
    if (damageFeature.baseTurbulence !== null) {
      try {
        if (window.weather && window.weather.definition)
          window.weather.definition.turbulences = damageFeature.baseTurbulence;
      } catch (e) {}
    }
  }

  function levenshtein(a, b) {
    var rows = b.length + 1, cols = a.length + 1;
    var m = Array.from({ length: rows }, function () { return Array(cols).fill(0); });
    for (var i = 0; i < rows; i++) m[i][0] = i;
    for (var j = 0; j < cols; j++) m[0][j] = j;
    for (var i = 1; i < rows; i++)
      for (var j = 1; j < cols; j++) {
        var c = b[i - 1] === a[j - 1] ? 0 : 1;
        m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + c);
      }
    return m[rows - 1][cols - 1];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  function collectPlayers() {
    var set = new Set();
    document.querySelectorAll('.geofs-chat-message .label').forEach(function (el) {
      var cs = (el.getAttribute('callsign') || el.textContent || '').replace(/:\s*$/, '').trim();
      if (cs) set.add(cs);
    });
    ((document.body.innerText || '').match(/[A-Za-z0-9_\-\[\]\(\)]{3,24}/g) || [])
      .forEach(function (x) { set.add(x); });
    return Array.from(set);
  }

  function resolveName(raw) {
    var players = collectPlayers();
    var src = normalizeName(raw);
    if (!src) return raw;
    for (var i = 0; i < players.length; i++)
      if (normalizeName(players[i]) === src) return players[i];
    var best = { name: raw, score: 0 };
    for (var i = 0; i < players.length; i++) {
      var s = similarity(src, normalizeName(players[i]));
      if (s > best.score) best = { name: players[i], score: s };
    }
    return best.score >= CONFIG.fuzzyThreshold ? best.name : raw;
  }

  function shouldTrackTarget(target) {
    var own = resolveName(CONFIG.ownName || '');
    if (!own) return false;
    return normalizeName(own) === normalizeName(resolveName(target || ''));
  }

  // ── Threat Classification ─────────────────────────────────────────────────
  // Fox-1 is checked FIRST so AIM-9C is caught before Fox-2's general AIM-9.
  // MICA IR vs MICA EM is handled via negative lookahead in Fox-2.
  // Super 530 (Fox-1) is caught before R.530 (Fox-2) by rule ordering.

  function detectRule(text) {
    var rules = [
      {
        label: 'Fox-1 / SARH missile',
        patterns: [
          /\bfox\s*1\b/i, /\bsarh\b/i,
          /\baim[-\s]?7\b/i, /\bsparrow\b/i,                                           // AIM-7 Sparrow
          /\baim[-\s]?9c\b/i,                                                            // AIM-9C Sidewinder (SARH only)
          /\bsuper\s*530\b/i, /\bmatra\s*super\b/i,                                     // Matra Super 530
          /\bpl[-\s]?11\b/i,                                                             // PL-11
          /\br[-\s]?27r\b/i, /\baa[-\s]?10r\b/i,                                       // R-27R / AA-10R Alamo
          /\br[-\s]?33\b/i, /\baa[-\s]?9\b/i, /\bamos\b/i,                            // R-33 / AA-9 Amos
          /\br[-\s]?23r?\b/i, /\bapex\b/i, /\bizd(?:eliye)?\s*340\b/i,                // R-23R / AA-7 Apex / Izd 340
          /\balenia\b/i, /\baspide\b/i,                                                  // Alenia Aspide
          /\bk[-\s]?13r\b/i, /\baa[-\s]?2d\b/i, /\batoll\b/i, /\bizd(?:eliye)?\s*380\b/i, // K-13R / AA-2D Atoll / Izd 380
          /\br[-\s]?40(?:rd)?\b/i, /\baa[-\s]?6\b/i, /\bacrid\b/i, /\bizd(?:eliye)?\s*46d\b/i, // R-40RD / AA-6 Acrid / Izd 46D
          /\balamo\b/i,                                                                   // Generic Alamo (default SARH)
        ]
      },
      {
        label: 'Fox-2 / IR missile',
        patterns: [
          /\bfox\s*2\b/i,
          /\baim[-\s]?9\b/i, /\bsidewinder\b/i,                                        // AIM-9 Sidewinder (AIM-9C caught by Fox-1 first)
          /\basraam\b/i, /\baim[-\s]?132\b/i,                                           // ASRAAM / AIM-132
          /\biris[-\s]?t\b/i,                                                            // IRIS-T
          /\baam[-\s]?3\b/i,                                                             // AAM-3
          /\bbozdo[gğ]an\b/i, /\bbozdogan\b/i, /\bmerlin\b/i,                          // Bozdoğan / Merlin
          /\bpython\s*5\b/i, /\bpython\b/i,                                             // Rafael Python 5
          /\bmatra\s*magic\b/i, /\bmagic\s*(?:i{1,2}|2)\b/i,                           // Matra Magic II
          /\br[.\s]?510\b/i,                                                             // Matra R.510
          /\br[.\s]?530\b/i,                                                             // Matra R.530 IR (Super 530 caught by Fox-1 first)
          /\bmaa[-\s]?1[ab]?\b/i, /\bpiranha\b/i,                                      // MAA-1A/B Piranha
          /\bmica\s*ir\b/i, /\bmica(?!\s*em)\b/i,                                      // MBDA MICA IR (negative lookahead blocks MICA EM)
          /\bpl[-\s]?9\b/i,                                                              // PL-9
          /\br[-\s]?60\b/i, /\baa[-\s]?8\b/i, /\baphid\b/i,                           // R-60 / AA-8 Aphid
          /\br[-\s]?27t\b/i, /\baa[-\s]?10t\b/i,                                       // R-27T / AA-10T
          /\bsky\s*sword\s*1\b/i, /\btc[-\s]?1\b/i,                                    // Sky Sword 1 / TC-1
          /\br[-\s]?73\b/i, /\baa[-\s]?11\b/i, /\barcher\b/i, /\bizd(?:eliye)?\s*72\b/i, // R-73 / AA-11 Archer / Izd 72
          /\bv3e\b/i, /\ba[-\s]?darter\b/i,                                             // V3E A-Darter
        ]
      },
      {
        label: 'Fox-3 / ARH missile',
        patterns: [
          /\bfox\s*3\b/i, /\barh\b/i,
          /\baim[-\s]?120\b/i, /\bamraam\b/i,                                           // AIM-120 AMRAAM
          /\bmbda\s*meteor\b/i, /\bmeteor\b/i,                                          // MBDA Meteor
          /\bastra\s*mk\s*1\b/i, /\bastra\b/i,                                         // Astra Mk 1
          /\baam[-\s]?4\b/i,                                                             // AAM-4
          /\bg[oö]kdo[gğ]an\b/i, /\bgokdogan\b/i, /\bperegrine\b/i,                   // Gökdoğan / Peregrine
          /\brafael\s*derby\b/i, /\bderby\b/i,                                          // Rafael Derby
          /\br[.\s]?511\b/i,                                                             // Matra R.511
          /\br[-\s]?darter\b/i,                                                          // R-Darter
          /\bmica\s*em\b/i,                                                              // MBDA MICA EM
          /\bpl[-\s]?15\b/i,                                                             // PL-15
          /\br[-\s]?77\b/i, /\baa[-\s]?12\b/i, /\badder\b/i,                          // R-77 / AA-12 Adder
          /\br[-\s]?27ea\b/i, /\baa[-\s]?10ea\b/i,                                     // R-27EA / AA-10EA
          /\bsky\s*sword\s*2\b/i, /\btc[-\s]?2\b/i,                                    // Sky Sword 2 / TC-2
          /\baim[-\s]?174b?\b/i, /\bgunslinger\b/i,                                     // AIM-174B Gunslinger
          /\br[-\s]?37\b/i, /\baa[-\s]?13\b/i, /\baxehead\b/i, /\bizd(?:eliye)?\s*610\b/i, // R-37 / AA-13 Axehead / Izd 610
          /\bpl[-\s]?12\b/i, /\bch[-\s]?aa[-\s]?7\b/i, /\badze\b/i,                  // PL-12 / CH-AA-7 Adze
          /\bfakour[-\s]?90\b/i, /\bfakour\b/i,                                         // Fakour-90
        ]
      },
      {
        label: 'Radar lock only',
        patterns: [
          /\bradar\s*lock\b/i, /\blocked\s*on\b/i, /\bspike\b/i,
        ]
      }
    ];
    for (var i = 0; i < rules.length; i++)
      if (rules[i].patterns.some(function (re) { return re.test(text); })) return rules[i];
    return { label: 'Unclassified threat' };
  }

  // ── Countermeasure Detection ───────────────────────────────────────────────

  function detectCountermeasure(text) {
    var t = (text || '').toLowerCase();
    if (/\bflare[s]?\b/.test(t))                               return 'flares';
    if (/\bchaff\b/.test(t))                                   return 'chaff';
    if (/\bnotch(ing)?\b/.test(t))                             return 'notch';
    if (/\b(jink(ing)?|break(ing)?|evade|evasive)\b/.test(t)) return 'evasive';
    return null;
  }

  // Returns true if the CM type defeats the given threat.
  // Fox-2 (IR)         → flares
  // Fox-1/3 (SARH/ARH) → chaff or notch
  function isCMEffective(ruleLabel, cmType) {
    var label = (ruleLabel || '').toLowerCase();
    if (label.indexOf('fox-2') !== -1 || label.indexOf('ir') !== -1)
      return cmType === 'flares';
    if (label.indexOf('fox-1') !== -1 || label.indexOf('sarh') !== -1 ||
        label.indexOf('fox-3') !== -1 || label.indexOf('arh') !== -1)
      return cmType === 'chaff' || cmType === 'notch';
    return false;
  }

  // ── Hit Judge ─────────────────────────────────────────────────────────────

  function startJudgment(threat) {
    if (judgeState.countdownInterval) clearInterval(judgeState.countdownInterval);
    judgeState.active = true;
    judgeState.awayTime = Date.now();
    judgeState.threat = threat;
    judgeState.userCMs = [];
    judgeState.countdownRemaining = CONFIG.judgmentWindow;
    judgeState.judgeResult = null;
    judgeState.countdownInterval = setInterval(function () {
      judgeState.countdownRemaining = Math.max(0, judgeState.countdownRemaining - 1);
      render();
      if (judgeState.countdownRemaining <= 0) finalizeJudgment('miss_timeout');
    }, 1000);
    render();
  }

  function finalizeJudgment(result) {
    if (judgeState.countdownInterval) {
      clearInterval(judgeState.countdownInterval);
      judgeState.countdownInterval = null;
    }
    judgeState.active = false;
    judgeState.judgeResult = result;

    var threat = judgeState.threat || state.lastThreat || {};
    var cmSnapshot = judgeState.userCMs.slice();
    var finalResult, statusText, logNote;

    if      (result === 'miss_cm')       { finalResult = 'miss';    statusText = 'MISS \u2014 correct CM overrides hit claim'; logNote = 'CM override'; }
    else if (result === 'miss_timeout')  { finalResult = 'miss';    statusText = 'MISS \u2014 no declaration within 5s';       logNote = 'Timeout';    }
    else if (result === 'hit_invalid')   { finalResult = 'invalid'; statusText = 'INVALID \u2014 hit declared in < 3s';        logNote = 'Too fast';   }
    else if (result === 'miss_declared') { finalResult = 'miss';    statusText = 'MISS \u2014 declared by attacker';           logNote = 'Declared';   }
    else                                 { finalResult = 'hit';     statusText = 'HIT \u2014 valid';                           logNote = 'Valid hit';  }

    playTone(finalResult === 'hit' ? 'hit' : finalResult === 'invalid' ? 'invalid' : 'miss');
    if (finalResult === 'hit') applyHitDamage();
    stopWarningLoop();

    var finalThreat = Object.assign({}, threat, {
      phase: finalResult,
      statusText: statusText,
      time: Date.now(),
      judgeResult: result,
      userCMs: cmSnapshot,
      logNote: logNote
    });
    setThreat(finalThreat);
    state.history.unshift({
      result: finalResult,
      weapon: threat.weapon || '',
      target: threat.target || '',
      sender: threat.sender || 'Unknown',
      note: logNote,
      cms: cmSnapshot.map(function (c) { return c.type + '@' + c.elapsed + 's'; }).join(', ')
    });
    state.history = state.history.slice(0, 12);
    setTimeout(function () {
      if (state.lastThreat && state.lastThreat.judgeResult === result) clearThreat();
    }, 2500);
  }

  function setThreat(th) { state.lastThreat = th; render(); }
  function clearThreat() { state.lastThreat = null; stopWarningLoop(); render(); }

  // ── Chat Parser ───────────────────────────────────────────────────────────

  function parseChatMessage(text, sender) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;

    // Detect user's own countermeasures during active judgment window
    if (judgeState.active && CONFIG.ownName) {
      var sNorm = normalizeName(sender || '');
      var oNorm = normalizeName(CONFIG.ownName);
      if (sNorm && oNorm && sNorm === oNorm) {
        var cmType = detectCountermeasure(clean);
        if (cmType) {
          var elapsed = ((Date.now() - judgeState.awayTime) / 1000).toFixed(1);
          judgeState.userCMs.push({ type: cmType, elapsed: elapsed });
          render();
          return;
        }
      }
    }

    var lock = clean.match(/^lock\s+(.+?)\s+(.+)$/i);
    var away = /^away$/i.test(clean);
    var hm   = clean.match(/^(hit|miss)$/i);

    if (lock) {
      var weapon = lock[1], target = lock[2];
      if (!shouldTrackTarget(target)) return;
      var rule = detectRule(weapon + ' ' + clean);
      var threat = {
        phase: 'lock', sender: sender || 'Unknown', weapon: weapon,
        target: resolveName(target), ruleLabel: rule.label,
        raw: clean, time: Date.now(), statusText: 'LOCK ON YOU'
      };
      senderState.pendingBySender.set((sender || 'Unknown').toLowerCase(), threat);
      senderState.lastSender = (sender || 'Unknown').toLowerCase();
      setThreat(threat);
      startWarningLoop('lock');
      state.history.unshift({ result: 'lock', weapon: weapon, target: resolveName(target), sender: sender || 'Unknown', cms: '', note: '' });
      state.history = state.history.slice(0, 12);
      return;
    }

    if (away) {
      var key = (sender || senderState.lastSender || 'Unknown').toLowerCase();
      var prev = senderState.pendingBySender.get(key);
      if (!prev) return;
      var th = Object.assign({}, prev, { phase: 'away', statusText: 'MISSILE AWAY', time: Date.now() });
      senderState.pendingBySender.set(key, th);
      senderState.lastSender = key;
      setThreat(th);
      startWarningLoop('away');
      startJudgment(th);
      state.history.unshift({ result: 'away', weapon: th.weapon, target: th.target, sender: th.sender, cms: '', note: '' });
      state.history = state.history.slice(0, 12);
      return;
    }

    if (hm) {
      var result = hm[1].toLowerCase();
      var key = (sender || senderState.lastSender || 'Unknown').toLowerCase();
      var prev = senderState.pendingBySender.get(key) || state.lastThreat || {};
      if (!prev.sender && !state.lastThreat) return;

      if (judgeState.active) {
        var elapsed = (Date.now() - judgeState.awayTime) / 1000;
        senderState.pendingBySender.delete(key);
        senderState.lastSender = key;
        if (result === 'hit') {
          if (elapsed < CONFIG.minHitTime) {
            finalizeJudgment('hit_invalid');
          } else {
            var threat = judgeState.threat;
            var hasCorrectCM = judgeState.userCMs.some(function (cm) {
              return isCMEffective(threat ? threat.ruleLabel : '', cm.type);
            });
            finalizeJudgment(hasCorrectCM ? 'miss_cm' : 'hit_valid');
          }
        } else {
          finalizeJudgment('miss_declared');
        }
        return;
      }

      // No active judgment window
      playTone(result);
      if (result === 'hit') applyHitDamage();
      stopWarningLoop();
      var finalThreat = {
        phase: result, sender: sender || prev.sender || 'Unknown',
        weapon: prev.weapon || '', target: prev.target || '',
        ruleLabel: prev.ruleLabel || 'Shot result',
        raw: clean, time: Date.now(), statusText: result.toUpperCase()
      };
      senderState.pendingBySender.delete(key);
      senderState.lastSender = key;
      setThreat(finalThreat);
      state.history.unshift({ result: result, weapon: prev.weapon || '', target: prev.target || '', sender: sender || prev.sender || 'Unknown', cms: '', note: '' });
      state.history = state.history.slice(0, 12);
      setTimeout(function () { if (state.lastThreat && state.lastThreat.phase === result) clearThreat(); }, 1200);
    }
  }

  // ── Panel ─────────────────────────────────────────────────────────────────

  function buildPanel() {
    var existing = document.getElementById('mrp-threat-helper');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = 'mrp-threat-helper';
    panel.style.cssText = [
      'position:fixed', 'top:18px', 'right:18px', 'z-index:99999',
      'width:380px', 'max-width:calc(100vw - 20px)',
      'background:rgba(9,12,18,.95)',
      'color:#edf4ff',
      'border:1px solid rgba(110,164,255,.33)',
      'border-radius:12px',
      'box-shadow:0 14px 34px rgba(0,0,0,.5)',
      'font:12px/1.45 Arial,sans-serif',
      'backdrop-filter:blur(8px)',
      '-webkit-backdrop-filter:blur(8px)',
      'user-select:none'
    ].join(';');

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move';
    header.innerHTML =
      '<div style="font-weight:700;letter-spacing:.04em;color:#ffb2b2">' + CONFIG.hudTitle + '</div>' +
      '<div style="display:flex;gap:6px">' +
      '<button data-a="settings" style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer;font:12px Arial">&#9881;</button>' +
      '<button data-a="toggle"   style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer;font:12px Arial">_</button>' +
      '</div>';

    var body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px';

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    header.querySelector('[data-a="toggle"]').addEventListener('click', function (e) {
      e.stopPropagation();
      state.minimized = !state.minimized;
      render();
    });
    header.querySelector('[data-a="settings"]').addEventListener('click', function (e) {
      e.stopPropagation();
      state.settingsOpen = !state.settingsOpen;
      render();
    });
    header.addEventListener('mousedown', function (e) {
      unlockAudio();
      var rect = panel.getBoundingClientRect();
      state.drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      panel.style.right = 'auto';
    });
    document.addEventListener('mousemove', function (e) {
      if (!state.drag) return;
      panel.style.left = Math.max(4, Math.min(window.innerWidth  - 190, e.clientX - state.drag.dx)) + 'px';
      panel.style.top  = Math.max(4, Math.min(window.innerHeight -  48, e.clientY - state.drag.dy)) + 'px';
    });
    document.addEventListener('mouseup', function () { state.drag = null; });
    return { panel: panel, body: body };
  }

  var ui = buildPanel();

  function shieldSettingsInputs(scope) {
    scope.querySelectorAll('input, textarea, select').forEach(function (el) {
      ['keydown', 'keypress', 'keyup'].forEach(function (type) {
        el.addEventListener(type, function (e) {
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        }, true);
      });
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    ui.body.style.display = state.minimized ? 'none' : 'block';
    if (state.minimized) return;

    if (state.settingsOpen) {
      ui.body.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px">Settings</div>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Your callsign (required for CM logging)</div>' +
        '<input id="mrp-own-name" value="' + escapeHtml(CONFIG.ownName) + '" style="width:100%;box-sizing:border-box;background:#121927;color:#edf4ff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:7px 8px"></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Enable sounds</div><input id="mrp-snd" type="checkbox" ' + (CONFIG.enableSounds ? 'checked' : '') + '></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Sound volume (' + Math.round(CONFIG.soundVolume * 100) + '%)</div><input id="mrp-vol" type="range" min="0" max="1" step="0.05" value="' + CONFIG.soundVolume + '" style="width:100%"></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Enable combat damage effects</div><input id="mrp-dmg" type="checkbox" ' + (damageFeature.enabled ? 'checked' : '') + '></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button id="mrp-close" style="background:#162033;color:#dbe7ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer">Cancel</button>' +
        '<button id="mrp-save"  style="background:#254a7d;color:#eef5ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer">Save</button>' +
        '</div>';
      shieldSettingsInputs(ui.body);
      ui.body.querySelector('#mrp-close').addEventListener('click', function () { state.settingsOpen = false; render(); });
      ui.body.querySelector('#mrp-save').addEventListener('click', function () {
        CONFIG.ownName      = ui.body.querySelector('#mrp-own-name').value.trim();
        CONFIG.enableSounds = ui.body.querySelector('#mrp-snd').checked;
        CONFIG.soundVolume  = Math.max(0, Math.min(1, parseFloat(ui.body.querySelector('#mrp-vol').value) || 0));
        damageFeature.enabled = !!ui.body.querySelector('#mrp-dmg').checked;
        state.settingsOpen = false;
        render();
      });
      return;
    }

    var t = state.lastThreat;

    // Judge section
    var judgeHtml = '';
    if (judgeState.active) {
      var threat = judgeState.threat;
      var hasCorrectCM = judgeState.userCMs.some(function (cm) {
        return isCMEffective(threat ? threat.ruleLabel : '', cm.type);
      });
      var cmListHtml = judgeState.userCMs.length
        ? judgeState.userCMs.map(function (cm) {
            var ok = isCMEffective(threat ? threat.ruleLabel : '', cm.type);
            return '<span style="background:' + (ok ? 'rgba(100,220,130,.18)' : 'rgba(255,100,100,.15)') +
              ';border-radius:4px;padding:1px 6px;margin-right:4px;color:' + (ok ? '#8fe3a1' : '#ff9c9c') + '">' +
              escapeHtml(cm.type) + ' @' + escapeHtml(cm.elapsed) + 's ' + (ok ? '\u2713' : '\u2717') + '</span>';
          }).join('')
        : '<span style="color:#9db0d3">None yet</span>';
      judgeHtml =
        '<div style="margin-top:10px;padding:8px;background:rgba(255,200,60,.07);border:1px solid rgba(255,200,60,.3);border-radius:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">' +
        '<div style="font-weight:700;color:#ffd080">\u23f1 Hit Judge Active</div>' +
        '<div style="font-size:18px;font-weight:900;color:' + (judgeState.countdownRemaining <= 2 ? '#ff9c9c' : '#ffd080') + '">' + judgeState.countdownRemaining + 's</div>' +
        '</div>' +
        (CONFIG.ownName
          ? '<div style="font-size:11px;color:#9db0d3;margin-bottom:5px">Monitoring your chat \u2014 flares \u00b7 chaff \u00b7 notch</div>'
          : '<div style="font-size:11px;color:#ffaa50;margin-bottom:5px">\u26a0 Set your callsign in Settings to log CMs</div>') +
        '<div style="font-size:11px;color:#9db0d3;margin-bottom:3px">Your countermeasures:</div>' +
        '<div style="margin-bottom:5px">' + cmListHtml + '</div>' +
        (hasCorrectCM
          ? '<div style="font-size:11px;color:#8fe3a1;font-weight:600">\u2713 Effective CM \u2014 hit claim will be overridden as MISS</div>'
          : '<div style="font-size:11px;color:#9db0d3">No effective CM yet \u2014 awaiting attacker declaration</div>') +
        '</div>';
    } else if (t && t.judgeResult) {
      var rColors = { miss_cm: '#8fe3a1', miss_timeout: '#8fe3a1', miss_declared: '#8fe3a1', hit_invalid: '#ffd080', hit_valid: '#ff9c9c' };
      var cmListHtml2 = (t.userCMs && t.userCMs.length)
        ? t.userCMs.map(function (c) { return escapeHtml(c.type) + ' @' + escapeHtml(c.elapsed) + 's'; }).join(', ')
        : 'None';
      judgeHtml =
        '<div style="margin-top:10px;padding:8px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,.09);border-radius:8px">' +
        '<div style="font-weight:700;color:' + (rColors[t.judgeResult] || '#9db0d3') + ';margin-bottom:3px">Judge: ' + escapeHtml(t.logNote || '') + '</div>' +
        '<div style="font-size:11px;color:#9db0d3">CMs: ' + cmListHtml2 + '</div>' +
        '</div>';
    }

    // History
    var historyHtml = state.history.slice(0, 8).map(function (h) {
      var rc = h.result === 'hit' ? '#ff9c9c' : h.result === 'miss' ? '#9de2ae' : h.result === 'invalid' ? '#ffd080' : '#9ec8ff';
      return '<div style="display:grid;grid-template-columns:60px 1fr;gap:6px;padding:4px 0;border-top:1px solid rgba(255,255,255,.05)">' +
        '<div style="color:' + rc + ';font-weight:700">' + escapeHtml(String(h.result).toUpperCase()) + '</div>' +
        '<div style="color:#bcd0ee">' +
          escapeHtml(h.weapon || 'Unknown') + ' on ' + escapeHtml(h.target || 'Unknown') + ' by ' + escapeHtml(h.sender || 'Unknown') +
          (h.cms  ? '<div style="color:#7a90b4;font-size:10px;margin-top:1px">CMs: ' + escapeHtml(h.cms) + '</div>' : '') +
          (h.note ? '<div style="color:#7a90b4;font-size:10px">' + escapeHtml(h.note) + '</div>' : '') +
        '</div>' +
        '</div>';
    }).join('');

    if (!t) {
      ui.body.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px">Standby</div>' +
        '<div style="color:#b9c7df">' +
          (CONFIG.ownName
            ? 'Watching locks on <b>' + escapeHtml(CONFIG.ownName) + '</b>. Type flares/chaff/notch in chat when a missile is fired at you.'
            : 'Open Settings (\u2699) and enter your callsign to begin tracking.') +
        '</div>' +
        '<div style="margin-top:10px;font-size:11px;color:#9db0d3">Recent outcomes</div>' +
        '<div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px">' +
          (historyHtml || '<div style="color:#8ca0c7">No completed shots yet.</div>') +
        '</div>';
      return;
    }

    var age = Math.floor((Date.now() - t.time) / 1000);
    var phaseColor = t.phase === 'hit' ? '#ff9c9c' : t.phase === 'miss' ? '#8fe3a1' : t.phase === 'invalid' ? '#ffd080' : '#89d0a6';
    ui.body.innerHTML =
      '<div>' +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start">' +
      '<div style="font-size:16px;color:' + phaseColor + ';font-weight:800;letter-spacing:.08em">' + escapeHtml(String(t.phase).toUpperCase()) + '</div>' +
      '<div style="font-size:11px;color:#9db0d3">' + age + 's ago</div>' +
      '</div>' +
      '<div style="margin-top:10px;display:grid;grid-template-columns:78px 1fr;gap:6px">' +
        '<div style="color:#8ca0c7">Sender</div><div>' + escapeHtml(t.sender || 'Unknown') + '</div>' +
        '<div style="color:#8ca0c7">Weapon</div><div>' + escapeHtml(t.weapon || 'Unspecified') + '</div>' +
        '<div style="color:#8ca0c7">Target</div><div>' + escapeHtml(t.target || 'Unknown') + '</div>' +
        '<div style="color:#8ca0c7">Rule</div><div>'   + escapeHtml(t.ruleLabel || 'Unknown') + '</div>' +
        '<div style="color:#8ca0c7">Status</div><div style="color:' + phaseColor + '">' + escapeHtml(t.statusText || '') + '</div>' +
      '</div>' +
      judgeHtml +
      '<div style="margin-top:10px;font-size:11px;color:#9db0d3">Recent outcomes</div>' +
      '<div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px">' +
        (historyHtml || '<div style="color:#8ca0c7">No completed shots yet.</div>') +
      '</div>' +
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);color:#9db0d3;font-size:11px">' +
        escapeHtml(t.raw || '') +
      '</div>' +
      '</div>';
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  window.__mrpParse       = parseChatMessage;
  window.__mrpResetDamage = resetDamageState;

  // ── Chat Hook ─────────────────────────────────────────────────────────────

  function hookChat() {
    var seen = new WeakSet();
    function scan() {
      document.querySelectorAll('.geofs-chat-message').forEach(function (node) {
        if (seen.has(node)) return;
        seen.add(node);
        var label  = node.querySelector('.label');
        var sender = ((label && label.getAttribute('callsign')) || (label && label.textContent) || '')
          .replace(/:\s*$/, '').trim() || 'Unknown';
        var full = (node.textContent || '').trim();
        var msg = full;
        if (label) {
          var lt = (label.textContent || '').trim();
          if (lt && full.toLowerCase().indexOf(lt.toLowerCase()) === 0) msg = full.slice(lt.length).trim();
          else msg = full.replace(/^[^:]{0,60}:\s*/, '').trim();
        }
        parseChatMessage(msg, sender);
      });
    }
    scan();
    var mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('pointerdown', unlockAudio, true);
  hookChat();
  render();

  // Confirm load with a non-blocking visual instead of alert()
  (function () {
    var toast = document.createElement('div');
    toast.textContent = '\u2713 MRP Helper loaded';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#254a7d;color:#eef5ff;padding:8px 18px;border-radius:20px;font:13px Arial;z-index:999999;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    document.body.appendChild(toast);
    setTimeout(function () { toast.style.opacity = '0'; toast.style.transition = 'opacity .5s'; }, 2000);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 2600);
  })();

})();
