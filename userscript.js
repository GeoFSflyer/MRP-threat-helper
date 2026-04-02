// ==UserScript==
// @name         MRP Threat Helper v16 Sound Only
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  GeoFS threat helper with sound alerts, optional countermeasure suggestions, and combat damage effects.
// @author       Perplexity
// @match        *://*.geo-fs.com/*
// @match        *://geo-fs.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__mrpSoundOnlyV2Loaded) {
    alert('MRP sound-only v2 already loaded');
    return;
  }
  window.__mrpSoundOnlyV2Loaded = true;

  const CONFIG = {
    hudTitle: 'MRP Threat Helper v16 Sound Only',
    ownName: '',
    enableSounds: true,
    soundVolume: 0.9,
    fuzzyThreshold: 0.78,
    showCountermeasures: true,
  };

  const state = {
    lastThreat: null,
    history: [],
    audioCtx: null,
    warningTimer: null,
    warningMode: '',
    drag: null,
    minimized: false,
    settingsOpen: false,
  };

  const senderState = {
    pendingBySender: new Map(),
    lastSender: '',
  };

  const damageFeature = {
    enabled: false,
    hitCount: 0,
    baseTurbulence: null,
    lastEffect: '',
    restoreTimer: null,
    propulsionLossActive: false,
    engineRestore: null,
    propulsionRestoreTimer: null,
  };

  function getEngineCount() {
    try {
      return window.geofs.aircraft.instance.engines.length || 0;
    } catch (e) {
      return 0;
    }
  }

  function applyAirframeStress() {
    try {
      if (damageFeature.baseTurbulence === null) {
        damageFeature.baseTurbulence = (window.weather && window.weather.definition)
          ? window.weather.definition.turbulences
          : 0;
      }
      if (window.weather && window.weather.definition) {
        window.weather.definition.turbulences = 4;
      }
    } catch (e) {
      console.warn('airframe stress damage failed', e);
    }
  }

  function applyPropulsionLoss() {
    try {
      const ac = window.geofs && window.geofs.aircraft && window.geofs.aircraft.instance;
      if (!ac) return;
      if (typeof ac.stopEngine === 'function') {
        ac.stopEngine();
      }
      if (Array.isArray(ac.engines)) {
        ac.engines.forEach((en) => {
          try {
            en.thrust = 0;
            if ('afterBurnerThrust' in en) en.afterBurnerThrust = 0;
          } catch (e) {}
        });
      }
      damageFeature.lastEffect = 'PROPULSION LOSS';
    } catch (e) {
      console.warn('propulsion loss failed', e);
    }
  }

  function applyHitDamage() {
    if (!damageFeature.enabled) return;
    damageFeature.hitCount += 1;
    if (damageFeature.hitCount === 1) {
      return;
    } else if (damageFeature.hitCount === 2) {
      applyAirframeStress(4, 300000);
    } else {
      applyPropulsionLoss();
      applyAirframeStress(8, 420000);
    }
  }

  function resetDamageState() {
    damageFeature.hitCount = 0;
    if (damageFeature.restoreTimer) clearInterval(damageFeature.restoreTimer);
    damageFeature.restoreTimer = null;
    if (damageFeature.propulsionRestoreTimer) clearTimeout(damageFeature.propulsionRestoreTimer);
    damageFeature.propulsionRestoreTimer = null;
    if (damageFeature.baseTurbulence !== null) {
      try {
        if (window.weather && window.weather.definition) window.weather.definition.turbulences = damageFeature.baseTurbulence;
      } catch (e) {}
    }
    try {
      const ac = window.geofs && window.geofs.aircraft && window.geofs.aircraft.instance;
      if (ac && Array.isArray(ac.engines) && damageFeature.engineRestore) {
        ac.engines.forEach((en, i) => {
          const saved = damageFeature.engineRestore[i];
          if (!saved) return;
          if (typeof saved.thrust !== 'undefined') en.thrust = saved.thrust;
          if (typeof saved.afterBurnerThrust !== 'undefined') en.afterBurnerThrust = saved.afterBurnerThrust;
        });
      }
    } catch (e) {}
    damageFeature.propulsionLossActive = false;
    damageFeature.engineRestore = null;
  }

  function ensureAudio() {
    if (state.audioCtx) return state.audioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    state.audioCtx = new Ctx();
    return state.audioCtx;
  }

  function unlockAudio() {
    const ctx = ensureAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function beep(freq, dur, type, vol) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
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
    const v = Math.max(0.02, CONFIG.soundVolume * 0.08);
    if (type === 'lock') beep(880, 0.14, 'sine', v);
    else if (type === 'away') beep(1240, 0.18, 'triangle', v);
    else if (type === 'hit') beep(320, 0.25, 'sawtooth', v);
    else if (type === 'miss') beep(640, 0.18, 'square', v);
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
    const run = () => {
      if (mode === 'lock') playTone('lock');
      else if (mode === 'away') playTone('away');
    };
    run();
    state.warningTimer = setInterval(run, mode === 'away' ? 700 : 850);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeName(s) {
    return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  }

  function levenshtein(a, b) {
    const rows = b.length + 1, cols = a.length + 1;
    const m = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i++) m[i][0] = i;
    for (let j = 0; j < cols; j++) m[0][j] = j;
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const c = b[i - 1] === a[j - 1] ? 0 : 1;
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + c);
      }
    }
    return m[rows - 1][cols - 1];
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  function collectPlayers() {
    const set = new Set();
    document.querySelectorAll('.geofs-chat-message .label').forEach((el) => {
      const cs = ((el.getAttribute('callsign') || el.textContent || '').replace(/:\s*$/, '').trim());
      if (cs) set.add(cs);
    });
    const txt = document.body.innerText || '';
    (txt.match(/[A-Za-z0-9_\-\[\]\(\)]{3,24}/g) || []).forEach((x) => set.add(x));
    return Array.from(set);
  }

  function resolveName(raw) {
    const players = collectPlayers();
    const src = normalizeName(raw);
    if (!src) return raw;
    for (const p of players) if (normalizeName(p) === src) return p;
    let best = { name: raw, score: 0 };
    for (const p of players) {
      const s = similarity(src, normalizeName(p));
      if (s > best.score) best = { name: p, score: s };
    }
    return best.score >= CONFIG.fuzzyThreshold ? best.name : raw;
  }

  function shouldTrackTarget(target) {
    const own = resolveName(CONFIG.ownName || '');
    if (!own) return false;
    return normalizeName(own) === normalizeName(resolveName(target || ''));
  }

  function detectRule(text) {
    const rules = [
      { label: 'Fox-2 / IR missile', patterns: [/\bfox\s*2\b/i, /\bsidewinder\b/i, /\baim[-\s]?9\b/i], counter: 'CHAFF', tactic: 'IR-family shot. Defend immediately.' },
      { label: 'Fox-1 / SARH missile', patterns: [/\bfox\s*1\b/i, /\bsparrow\b/i, /\baim[-\s]?7\b/i, /sarh/i], counter: 'CHAFF', tactic: 'Semi-active radar shot. Break and defend.' },
      { label: 'Fox-3 / ARH missile', patterns: [/\bfox\s*3\b/i, /\bamraam\b/i, /\baim[-\s]?120\b/i, /arh/i], counter: 'CHAFF', tactic: 'Active radar shot. Defend early.' },
      { label: 'Radar lock only', patterns: [/radar\s*lock/i, /locked\s*on/i, /spike/i], counter: 'CHAFF READY', tactic: 'Radar lock only. Watch for away.' },
    ];
    for (const r of rules) {
      if (r.patterns.some((re) => re.test(text))) return r;
    }
    return { label: 'Unclassified threat', counter: 'CHECK CHAT', tactic: 'Threat wording not recognized.' };
  }

  function setThreat(th) {
    state.lastThreat = th;
    render();
  }

  function clearThreat() {
    state.lastThreat = null;
    stopWarningLoop();
    render();
  }

  function parseChatMessage(text, sender) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const lock = clean.match(/^lock\s+(.+?)\s+(.+)$/i);
    const away = /^away$/i.test(clean);
    const hm = clean.match(/^(hit|miss)$/i);

    if (lock) {
      const weapon = lock[1], target = lock[2];
      if (!shouldTrackTarget(target)) return;
      const rule = detectRule(weapon + ' ' + clean);
      const threat = {
        phase: 'lock',
        sender: sender || 'Unknown',
        weapon,
        target: resolveName(target),
        ruleLabel: rule.label,
        counter: rule.counter,
        tactic: rule.tactic,
        raw: clean,
        time: Date.now(),
        statusText: 'LOCK ON YOU',
      };
      senderState.pendingBySender.set((sender || 'Unknown').toLowerCase(), threat);
      senderState.lastSender = (sender || 'Unknown').toLowerCase();
      setThreat(threat);
      startWarningLoop('lock');
      state.history.unshift({ result: 'lock', weapon, target: resolveName(target), sender: sender || 'Unknown' });
      state.history = state.history.slice(0, 12);
      return;
    }

    if (away) {
      const key = (sender || senderState.lastSender || 'Unknown').toLowerCase();
      const prev = senderState.pendingBySender.get(key);
      if (!prev) return;
      const th = { ...prev, phase: 'away', statusText: 'MISSILE AWAY', time: Date.now() };
      senderState.pendingBySender.set(key, th);
      senderState.lastSender = key;
      setThreat(th);
      startWarningLoop('away');
      state.history.unshift({ result: 'away', weapon: th.weapon, target: th.target, sender: th.sender });
      state.history = state.history.slice(0, 12);
      return;
    }

    if (hm) {
      const result = hm[1].toLowerCase();
      const key = (sender || senderState.lastSender || 'Unknown').toLowerCase();
      const prev = senderState.pendingBySender.get(key) || state.lastThreat || {};
      if (!prev.sender && !state.lastThreat) return;
      playTone(result);
      if (result === 'hit') applyHitDamage();
      stopWarningLoop();
      const dmgText = result === 'hit' && damageFeature.enabled
        ? (damageFeature.hitCount === 1
          ? 'No combat damage yet.'
          : damageFeature.hitCount === 2
            ? 'Airframe stress damage applied at turbulence 4.'
            : 'Propulsion loss and airframe stress damage applied at turbulence 8. Propulsion returns after about 1 minute.')
        : 'Shot result recorded.';
      const finalThreat = {
        phase: result,
        sender: sender || prev.sender || 'Unknown',
        weapon: prev.weapon || '',
        target: prev.target || '',
        ruleLabel: prev.ruleLabel || 'Shot result',
        counter: result.toUpperCase(),
        tactic: dmgText,
        raw: clean,
        time: Date.now(),
        statusText: result.toUpperCase(),
      };
      senderState.pendingBySender.delete(key);
      senderState.lastSender = key;
      setThreat(finalThreat);
      state.history.unshift({ result, weapon: prev.weapon || '', target: prev.target || '', sender: sender || prev.sender || 'Unknown' });
      state.history = state.history.slice(0, 12);
      setTimeout(() => {
        if (state.lastThreat && state.lastThreat.phase === result) clearThreat();
      }, 1200);
    }
  }

  function buildPanel() {
    const existing = document.getElementById('mrp-threat-helper');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'mrp-threat-helper';
    panel.style.cssText = 'position:fixed;top:18px;right:18px;z-index:99999;width:360px;max-width:calc(100vw - 20px);background:rgba(9,12,18,.93);color:#edf4ff;border:1px solid rgba(110,164,255,.33);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.38);font:12px/1.45 Arial,sans-serif;backdrop-filter:blur(8px);user-select:none';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move';
    header.innerHTML = '<div style="font-weight:700;letter-spacing:.04em;color:#ffb2b2">' + CONFIG.hudTitle + '</div><div style="display:flex;gap:6px"><button data-a="settings" style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer">⚙</button><button data-a="toggle" style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer">_</button></div>';

    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px';

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    header.querySelector('[data-a="toggle"]').onclick = (e) => {
      e.stopPropagation();
      state.minimized = !state.minimized;
      render();
    };

    header.querySelector('[data-a="settings"]').onclick = (e) => {
      e.stopPropagation();
      state.settingsOpen = !state.settingsOpen;
      render();
    };

    header.onmousedown = (e) => {
      unlockAudio();
      const rect = panel.getBoundingClientRect();
      state.drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      panel.style.right = 'auto';
    };

    document.addEventListener('mousemove', (e) => {
      if (!state.drag) return;
      panel.style.left = Math.max(4, Math.min(window.innerWidth - 190, e.clientX - state.drag.dx)) + 'px';
      panel.style.top = Math.max(4, Math.min(window.innerHeight - 48, e.clientY - state.drag.dy)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      state.drag = null;
    });

    return { panel, body };
  }

  const ui = buildPanel();

  function render() {
    ui.body.style.display = state.minimized ? 'none' : 'block';
    if (state.minimized) return;

    if (state.settingsOpen) {
      ui.body.innerHTML =
        '<div style="font-weight:700;margin-bottom:8px">Settings</div>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Your player name</div><input id="mrp-own-name" value="' + escapeHtml(CONFIG.ownName) + '" style="width:100%;background:#121927;color:#edf4ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px"></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Enable sounds</div><input id="mrp-snd" type="checkbox" ' + (CONFIG.enableSounds ? 'checked' : '') + '></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Sound volume (' + Math.round(CONFIG.soundVolume * 100) + '%)</div><input id="mrp-vol" type="range" min="0" max="1" step="0.05" value="' + CONFIG.soundVolume + '" style="width:100%"></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Show countermeasures</div><input id="mrp-counter" type="checkbox" ' + (CONFIG.showCountermeasures ? 'checked' : '') + '></label>' +
        '<label style="display:block;margin-bottom:8px"><div style="color:#9db0d3;margin-bottom:4px">Enable combat damage effects</div><input id="mrp-dmg" type="checkbox" ' + (damageFeature.enabled ? 'checked' : '') + '></label>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button id="mrp-close" style="background:#162033;color:#dbe7ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer">Cancel</button><button id="mrp-save" style="background:#254a7d;color:#eef5ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer">Save</button></div>';

      ui.body.querySelector('#mrp-close').onclick = () => {
        state.settingsOpen = false;
        render();
      };

      ui.body.querySelector('#mrp-save').onclick = () => {
        CONFIG.ownName = ui.body.querySelector('#mrp-own-name').value.trim();
        CONFIG.enableSounds = ui.body.querySelector('#mrp-snd').checked;
        CONFIG.soundVolume = Math.max(0, Math.min(1, parseFloat(ui.body.querySelector('#mrp-vol').value) || 0));
        CONFIG.showCountermeasures = !!ui.body.querySelector('#mrp-counter').checked;
        damageFeature.enabled = !!ui.body.querySelector('#mrp-dmg').checked;
        state.settingsOpen = false;
        render();
      };
      return;
    }

    const t = state.lastThreat;
    const historyHtml = (state.history || []).slice(0, 8).map((h) =>
      '<div style="display:grid;grid-template-columns:52px 1fr;gap:6px;padding:4px 0;border-top:1px solid rgba(255,255,255,.05)">' +
      '<div style="color:' + (h.result === 'hit' ? '#ff9c9c' : h.result === 'miss' ? '#9de2ae' : '#9ec8ff') + ';font-weight:700">' + escapeHtml(String(h.result).toUpperCase()) + '</div>' +
      '<div style="color:#bcd0ee">' + escapeHtml(h.weapon || 'Unknown') + ' on ' + escapeHtml(h.target || 'Unknown') + ' by ' + escapeHtml(h.sender || 'Unknown') + '</div>' +
      '</div>'
    ).join('');

    if (!t) {
      ui.body.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px">Standby</div>' +
        '<div style="color:#b9c7df">' + (CONFIG.ownName ? 'Watching only for locks targeted at your player name.' : 'Set your player name in Settings so only locks on you are tracked.') + '</div>' +
        '<div style="margin-top:10px;font-size:11px;color:#9db0d3">Recent outcomes</div>' +
        '<div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px">' + (historyHtml || '<div style="color:#8ca0c7">No completed shots yet.</div>') + '</div>' +
        '<div style="margin-top:10px;color:#8ca0c7;font-size:11px">Console test: <code>window.__mrpParse("lock fox2 YourName","Enemy")</code></div>';
      return;
    }

    const age = Math.floor((Date.now() - t.time) / 1000);
    const phaseColor = t.phase === 'hit' ? '#ff9c9c' : t.phase === 'miss' ? '#8fe3a1' : '#89d0a6';
    const counterDisplay = CONFIG.showCountermeasures ? (t.counter || 'CHECK') : ' ';
    const tacticDisplay = CONFIG.showCountermeasures ? (t.tactic || '') : ' ';

    ui.body.innerHTML =
      '<div>' +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start">' +
      '<div><div style="font-size:16px;color:' + phaseColor + ';font-weight:800;letter-spacing:.08em">' + escapeHtml(String(t.phase).toUpperCase()) + '</div>' +
      '<div style="margin-top:8px;font-size:28px;font-weight:800;color:#9ec8ff;line-height:1.1">' + escapeHtml(counterDisplay) + '</div></div>' +
      '<div style="font-size:11px;color:#9db0d3">' + age + 's ago</div></div>' +
      '<div style="margin-top:10px;display:grid;grid-template-columns:78px 1fr;gap:6px">' +
      '<div style="color:#8ca0c7">Sender</div><div>' + escapeHtml(t.sender || 'Unknown') + '</div>' +
      '<div style="color:#8ca0c7">Weapon</div><div>' + escapeHtml(t.weapon || 'Unspecified') + '</div>' +
      '<div style="color:#8ca0c7">Target</div><div>' + escapeHtml(t.target || 'Unknown') + '</div>' +
      '<div style="color:#8ca0c7">Rule</div><div>' + escapeHtml(t.ruleLabel || 'Unknown') + '</div>' +
      '<div style="color:#8ca0c7">Status</div><div>' + escapeHtml(t.statusText || '') + '</div></div>' +
      (CONFIG.showCountermeasures
        ? '<div style="margin-top:10px;padding:8px 9px;border:1px solid rgba(255,255,255,.09);border-radius:9px;background:rgba(255,255,255,.03)"><div style="font-size:11px;color:#9db0d3;margin-bottom:4px">Tactic</div><div>' + escapeHtml(tacticDisplay) + '</div></div>'
        : '') +
      '<div style="margin-top:10px;font-size:11px;color:#9db0d3">Recent outcomes</div>' +
      '<div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px">' + (historyHtml || '<div style="color:#8ca0c7">No completed shots yet.</div>') + '</div>' +
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);color:#9db0d3;font-size:11px">' + escapeHtml(t.raw || '') + '</div>' +
      '</div>';
  }

  window.__mrpParse = parseChatMessage;
  window.__mrpAirframeStress = applyAirframeStress;
  window.__mrpPropulsionLoss = applyPropulsionLoss;
  window.__mrpRestorePropulsion = () => {
    try {
      const ac = window.geofs && window.geofs.aircraft && window.geofs.aircraft.instance;
      if (ac && typeof ac.startEngine === 'function') ac.startEngine();
      console.log('MRP: manual propulsion restore');
    } catch (e) {
      console.warn(e);
    }
  };

  function hookChat() {
    const seen = new WeakSet();
    const scan = () => {
      document.querySelectorAll('.geofs-chat-message').forEach((node) => {
        if (seen.has(node)) return;
        seen.add(node);
        const label = node.querySelector('.label');
        const sender = ((label && label.getAttribute('callsign')) || (label && label.textContent) || '').replace(/:\s*$/, '').trim() || 'Unknown';
        const full = (node.textContent || '').trim();
        let msg = full;
        if (label) {
          const lt = (label.textContent || '').trim();
          if (lt && full.toLowerCase().startsWith(lt.toLowerCase())) msg = full.slice(lt.length).trim();
          else msg = full.replace(/^[^:]{0,60}:\s*/, '').trim();
        }
        parseChatMessage(msg, sender);
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('pointerdown', unlockAudio, true);
  hookChat();
  render();
  window.__mrpResetDamage = resetDamageState;
  alert('MRP Threat Helper userscript loaded. Set your player name in ⚙ Settings.');
})();
