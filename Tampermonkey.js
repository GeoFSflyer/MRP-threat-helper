// ==UserScript==
// @name         MRP Threat Helper
// @namespace    https://example.local/mrp-threat-helper
// @version      16.0.0
// @description  GeoFS MRP threat helper HUD with expanded weapon table support
// @author       Perplexity
// @match        *://*.geofs.com/*
// @match        *://geofs.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
  'use strict';
  (function () {
  'use strict';

  const CONFIG = {
    hudTitle: 'MRP Threat Helper',
    fuzzyThreshold: 0.78,
    maxSeenLines: 500,
    maxPlayers: 500,
    scanIntervalMs: 700,
    staleThreatMs: 45000,
    ownName: '',
    compactByDefault: false,
    historySize: 12,
    customAliases: ''
  };

  const state = {
    players: new Set(),
    seenEventIds: new Set(),
    lastThreat: null,
    threatHistory: [],
    pendingLocksBySender: new Map(),
    drag: null,
    minimized: CONFIG.compactByDefault,
    settingsOpen: false,
    observer: null,
    debugLog: []
  };

  const LOCK_EXPIRY_MS = 45000;
  const RESULT_EXPIRY_MS = 30000;

  const WEAPON_RULES = [
    {
      label: 'Fox-2 / IR missile',
      patterns: [/\bfox\s*2\b/i,/\bsidewinder\b/i,/\baim[-\s]?9\b/i,/\bir\b/i,/infrared/i,/heat\s*seeker/i,/heatseeker/i,/\br[-\s]?73\b/i,/\br[-\s]?60\b/i,/\bpl[-\s]?5\b/i,/\bpl[-\s]?8\b/i,/\bpl[-\s]?9\b/i,/\bmagic\s*2?\b/i,/\bpython[-\s]?5\b/i,/\basraam\b/i,/\biris[-\s]?t\b/i,/\baam[-\s]?3\b/i,/\baam[-\s]?5\b/i,/\bmica[-\s]?ir\b/i,/\baim[-\s]?132\b/i,/\bbozdogan\b/i,/\bmerlin\b/i,/\bmaa[-\s]?1a\b/i,/\bmaa[-\s]?1b\b/i,/\bpiranha\b/i,/\br\.\s?510\b/i,/\br[-\s]?510\b/i,/\br[-\s]?27t\b/i,/\baa[-\s]?10t\b/i,/\bsky\s*sword\s*1\b/i,/\btc[-\s]?1\b/i,/\brafael\s*python\s*5\b/i,/\bmatra\s*magic\s*ii\b/i,/\bmatra\s*r\.\s?510\b/i],
      counter: 'CHAFF',
      tactic: 'MRP table marks these IR-family weapons to chaff; defend immediately and deny a stable shot line.'
    },
    {
      label: 'Fox-1 / SARH missile',
      patterns: [/\bfox\s*1\b/i,/\bsparrow\b/i,/\baim[-\s]?7\b/i,/\baim[-\s]?4[aeff]?\b/i,/\baim[-\s]?9c\b/i,/\baim[-\s]?26\b/i,/semi[-\s]?active/i,/sarh/i,/\br[-\s]?27r\b/i,/\br[-\s]?27er\b/i,/super[-\s]?530/i,/\bskyflash\b/i,/\baspide\b/i,/\bmim[-\s]?23\b/i,/\bhawk\b/i,/\bpl[-\s]?11\b/i,/\br\.\s?511\b/i,/\br[-\s]?511\b/i,/\br\s?530\b/i,/\br[-\s]?530\b/i,/\br\s?23\b/i,/\br[-\s]?23\b/i,/\br\s?33\b/i,/\br[-\s]?33\b/i,/\brim[-\s]?7\b/i,/\bsea\s*sparrow\b/i],
      counter: 'CHAFF',
      tactic: 'MRP table marks these semi-active radar-guided weapons to chaff; defend the radar shot and time the break.'
    },
    {
      label: 'SARH / radar SAM with flares per MRP table',
      patterns: [/\brim[-\s]?8\b/i,/\btalos\b/i,/\brim[-\s]?66\b/i,/\bstandard\b/i,/\brim[-\s]?162\b/i,/\bessm\b/i,/\brim[-\s]?174\b/i,/\beram\b/i,/\bs[-\s]?200\b/i,/\bs[-\s]?300\b/i,/\bs[-\s]?400\b/i,/\bsa[-\s]?6\b/i,/\bgainful\b/i,/\b9m123\b/i,/\bkhrizantema\b/i,/\bskyflash\b/i,/super[-\s]?530/i],
      counter: 'FLARES',
      tactic: 'Your MRP table marks these radar/SAM interactions to flares, so use flares as the prescribed countermeasure.'
    },
    {
      label: 'Fox-3 / ARH missile',
      patterns: [/\bfox\s*3\b/i,/\bamraam\b/i,/\baim[-\s]?120\b/i,/\baim[-\s]?54\b/i,/\bphoenix\b/i,/active\s*radar/i,/arh/i,/\br[-\s]?77\b/i,/\baa[-\s]?12\b/i,/\badder\b/i,/\br[-\s]?77-?1\b/i,/\bmeteor\b/i,/\bpl[-\s]?12\b/i,/\bpl[-\s]?15\b/i,/\bmica[-\s]?em\b/i,/\bmica\b/i,/\baam[-\s]?4\b/i,/\bamm[-\s]?4\b/i,/\baam[-\s]?4b\b/i,/\bastra\b/i,/\bbvraam\b/i,/\bgokdogan\b/i,/\bperegrine\b/i,/\bderby\b/i,/\br[-\s]?darter\b/i,/\br[-\s]?27ea\b/i,/\baa[-\s]?10ea\b/i,/\bsky\s*sword\s*2\b/i,/\btc[-\s]?2\b/i,/\bdf[-\s]?21\b/i,/\bdf[-\s]?25\b/i,/\bdf[-\s]?26\b/i,/\bhn[-\s]?2000\b/i,/\bcamm\b/i,/\baster\b/i,/\bkh[-\s]?25\b/i,/\bas[-\s]?10\b/i,/\bkaren\b/i,/\baa[-\s]?13\b/i,/\baa[-\s]?9\b/i,/\bas[-\s]?13\b/i,/\bkingbolt\b/i,/\bas[-\s]?16\b/i,/\bkickback\b/i,/\br\.\s?511\b/i],
      counter: 'CHAFF',
      tactic: 'MRP table marks these active-radar weapons to chaff; defend early and defeat the radar-supported shot.'
    },
    {
      label: 'Radar lock only',
      patterns: [/radar\s*lock/i,/locked\s*on/i,/hard\s*lock/i,/spike/i,/painted/i,/tracking\s*radar/i,/track\s*you/i],
      counter: 'CHAFF READY',
      tactic: 'Radar threat declared but launch not confirmed; prep chaff and watch for the away call.'
    },
    {
      label: 'IR lock only',
      patterns: [/ir\s*lock/i,/heat\s*lock/i,/seeker\s*lock/i,/tone\s*on/i],
      counter: 'CHAFF READY',
      tactic: 'Your current MRP table maps many IR-family weapons to chaff, so keep chaff ready and defend the close-range shot geometry.'
    },
    {
      label: 'Gun / cannon attack',
      patterns: [/\bguns?\b/i,/\bcannon\b/i,/\bgun\s*run\b/i,/\bstrafe\b/i,/\bvulcan\b/i,/\bdefa\b/i,/\bgsh[-\s]?30\b/i,/\bm61\b/i,/\bm39\b/i,/\baden\b/i],
      counter: 'BREAK / JINK',
      tactic: 'No expendable countermeasure here; jink hard, force overshoot, and separate vertically if possible.'
    },
    {
      label: 'AAA / flak',
      patterns: [/\baaa\b/i,/flak/i,/anti[-\s]?air/i,/sam\s*site\s*guns?/i,/\bzu[-\s]?23\b/i,/\bshilka\b/i,/\bgepard\b/i],
      counter: 'MANEUVER',
      tactic: 'Stay unpredictable, vary heading and altitude, and do not fly a steady line through the envelope.'
    },
    {
      label: 'MANPADS / short-range IR SAM',
      patterns: [/\bmanpads\b/i,/\bsa[-\s]?7\b/i,/\bsa[-\s]?14\b/i,/\bsa[-\s]?16\b/i,/\bsa[-\s]?18\b/i,/\bsa[-\s]?24\b/i,/\bstrela\b/i,/\bstinger\b/i,/\bistr\b/i,/short[-\s]?range\s*ir\s*sam/i,/\bq[wz]-?\d+\b/i],
      counter: 'FLARES',
      tactic: 'Treat as an IR threat: flare hard and escape the launch zone while denying rear-aspect tracking.'
    },
    {
      label: 'Unknown missile call',
      patterns: [/missile\s*away/i,/missile\s*launch/i,/launched\s*a\s*missile/i,/shot\s*out/i,/\brifle\b/i],
      counter: 'CHECK TYPE',
      tactic: 'Threat family unclear; maneuver immediately and verify whether the shot is radar or IR.'
    },
    {
      label: 'Bomb / guided bomb / JDAM',
      patterns: [/\bbombs?\b/i,/\bmk[-\s]?82\b/i,/\bmk[-\s]?84\b/i,/\bgbu\b/i,/\bjd[aá]m\b/i,/\bcluster\b/i,/\blgb\b/i,/\bjsow\b/i,/\bwcmd\b/i],
      counter: 'EVADE BLAST / REPOSITION',
      tactic: 'Clear the target zone, extend away from the attack axis, and avoid a predictable re-attack path.'
    },
    {
      label: 'Rocket attack',
      patterns: [/\brockets?\b/i,/\bhydra\b/i,/\bs-?8\b/i,/\bs-?13\b/i,/\bs-?24\b/i,/\bs-?25\b/i,/\bzuni\b/i],
      counter: 'BREAK / DISPLACE',
      tactic: 'Spoil aim with crossing motion and a sharp lateral displacement from the attack run.'
    },
    {
      label: 'Torpedo / anti-ship',
      patterns: [/\btorpedo\b/i,/\banti[-\s]?ship\b/i,/\bexocet\b/i,/\bharpoon\b/i,/\bkh[-\s]?35\b/i,/\byj[-\s]?83\b/i],
      counter: 'EVADE / RANGE',
      tactic: 'If applicable to your scenario, clear the attack lane and force a poor geometry solution.'
    }
  ];

  function swallowKeyForInputs(e) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    const editable = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
    if (!editable) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
  }
  document.addEventListener('keydown', swallowKeyForInputs, true);
  document.addEventListener('keypress', swallowKeyForInputs, true);
  document.addEventListener('keyup', swallowKeyForInputs, true);

  function forceFocus(el) {
    if (!el) return;
    setTimeout(() => { el.focus(); el.select && el.select(); }, 0);
  }
  function normalizeName(s) {
    return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  }
  function levenshtein(a, b) {
    const rows = b.length + 1, cols = a.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i++) matrix[i][0] = i;
    for (let j = 0; j < cols; j++) matrix[0][j] = j;
    for (let i = 1; i < rows; i++) for (let j = 1; j < cols; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
    return matrix[rows - 1][cols - 1];
  }
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }
  function bestNameMatch(rawName) {
    const source = normalizeName(rawName);
    if (!source) return { name: rawName, score: 0 };
    for (const player of state.players) if (normalizeName(player) === source) return { name: player, score: 1 };
    let best = { name: rawName, score: 0 };
    for (const player of state.players) {
      const score = similarity(source, normalizeName(player));
      if (score > best.score) best = { name: player, score };
    }
    return best;
  }
  function resolveName(rawName) {
    const best = bestNameMatch(rawName);
    return best.score >= CONFIG.fuzzyThreshold ? best.name : rawName;
  }
  function cleanLine(line) {
    return String(line || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  }
  function parseCustomAliases() {
    const rows = CONFIG.customAliases.split('\n').map((x) => x.trim()).filter(Boolean);
    return rows.map((row) => {
      const parts = row.split('=');
      if (parts.length < 2) return null;
      const alias = parts[0].trim();
      const counter = parts[1].trim().toUpperCase();
      return alias ? { alias, counter } : null;
    }).filter(Boolean);
  }
  function detectAliasOverride(text) {
    const aliases = parseCustomAliases();
    for (const item of aliases) {
      const re = new RegExp(item.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(text)) return { label: `Custom alias: ${item.alias}`, counter: item.counter, tactic: `Custom alias matched '${item.alias}'.` };
    }
    return null;
  }
  function detectRule(text) {
    const aliasRule = detectAliasOverride(text);
    if (aliasRule) return aliasRule;
    for (const rule of WEAPON_RULES) if (rule.patterns.some((re) => re.test(text))) return rule;
    return { label: 'Unclassified threat', counter: 'BREAK / CHECK CHAT', tactic: 'Threat wording not recognized; assume danger, maneuver now, and verify the exact weapon call.' };
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pushHistory(item) {
    state.threatHistory.unshift(item);
    state.threatHistory = state.threatHistory.slice(0, CONFIG.historySize);
  }
  function pushDebug(line) {
    state.debugLog.unshift(`${new Date().toLocaleTimeString()} | ${line}`);
    state.debugLog = state.debugLog.slice(0, 10);
  }
  function collectPlayers() {
    const text = document.body.innerText || '';
    const candidates = text.match(/[A-Za-z0-9_\-\[\]\(\)]{3,24}/g) || [];
    state.players = new Set(Array.from(new Set(candidates)).slice(0, CONFIG.maxPlayers));
    document.querySelectorAll('.geofs-chat-message .label').forEach((el) => {
      const callsign = cleanLine(el.getAttribute('callsign') || el.textContent || '');
      if (callsign && callsign !== ':') state.players.add(callsign.replace(/:\s*$/, ''));
    });
  }
  function parseChatNode(node) {
    const label = node.querySelector('.label');
    const senderRaw = cleanLine((label && (label.getAttribute('callsign') || label.textContent)) || '');
    const sender = senderRaw.replace(/:\s*$/, '') || 'Unknown';
    const full = cleanLine(node.textContent || '');
    if (!full) return null;
    let message = full;
    if (label) {
      const labelText = cleanLine(label.textContent || '');
      if (labelText && full.toLowerCase().startsWith(labelText.toLowerCase())) {
        message = cleanLine(full.slice(labelText.length));
      } else {
        message = cleanLine(full.replace(/^[^:]{0,60}:\s*/, ''));
      }
    } else {
      message = cleanLine(full.replace(/^[^:]{0,60}:\s*/, ''));
    }
    return { sender, message, raw: full };
  }
  function parseThreatMessage(message) {
    const text = cleanLine(message);
    if (!text) return null;
    const lockPattern = /^lock\s+(.+?)\s+(.+)$/i;
    const awayPattern = /^away$/i;
    const hitPattern = /^(hit|miss)$/i;
    const looseHitPattern = /\b(hit|miss)\b/i;
    if (awayPattern.test(text)) return { type: 'away', raw: text };
    const hm = text.match(hitPattern);
    if (hm) return { type: hm[1].toLowerCase(), raw: text };
    const hmLoose = text.match(looseHitPattern);
    if (hmLoose && text.length <= 24) return { type: hmLoose[1].toLowerCase(), raw: text };
    const lm = text.match(lockPattern);
    if (lm) return { type: 'lock', weapon: lm[1], target: lm[2], raw: text };
    return null;
  }
  function isFresh(lock) {
    return lock && (Date.now() - lock.time) <= LOCK_EXPIRY_MS;
  }
  if (document.getElementById('mrp-threat-helper')) document.getElementById('mrp-threat-helper').remove();
  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'mrp-threat-helper';
    panel.style.cssText = 'position:fixed;top:18px;right:18px;z-index:99999;width:390px;max-width:calc(100vw - 20px);background:rgba(9,12,18,.93);color:#edf4ff;border:1px solid rgba(110,164,255,.33);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.38);font:12px/1.45 Arial,sans-serif;backdrop-filter:blur(8px);user-select:none;';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);cursor:move;';
    header.innerHTML = `<div style="font-weight:700;letter-spacing:.04em;color:#ffb2b2;">${CONFIG.hudTitle}</div><div style="display:flex;gap:6px;align-items:center;"><button type="button" data-action="settings" style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer;">⚙</button><button type="button" data-action="toggle" style="background:#1c2740;color:#d9e6ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:2px 8px;cursor:pointer;">_</button></div>`;
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 12px;';
    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);
    header.querySelector('[data-action="toggle"]').addEventListener('click', (e) => { e.stopPropagation(); state.minimized = !state.minimized; render(); });
    header.querySelector('[data-action="settings"]').addEventListener('click', (e) => { e.stopPropagation(); state.settingsOpen = !state.settingsOpen; render(); });
    header.addEventListener('mousedown', (e) => { const rect = panel.getBoundingClientRect(); state.drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }; panel.style.right = 'auto'; });
    document.addEventListener('mousemove', (e) => { if (!state.drag) return; const left = Math.min(window.innerWidth - 190, Math.max(4, e.clientX - state.drag.dx)); const top = Math.min(window.innerHeight - 48, Math.max(4, e.clientY - state.drag.dy)); panel.style.left = `${left}px`; panel.style.top = `${top}px`; });
    document.addEventListener('mouseup', () => { state.drag = null; });
    return { panel, body };
  }
  const ui = buildPanel();
  function bindSettingsEvents() {
    const ownInput = ui.body.querySelector('[data-setting="ownName"]');
    const thresholdInput = ui.body.querySelector('[data-setting="fuzzyThreshold"]');
    const aliasesInput = ui.body.querySelector('[data-setting="customAliases"]');
    const saveBtn = ui.body.querySelector('[data-action="save-settings"]');
    const closeBtn = ui.body.querySelector('[data-action="close-settings"]');
    [ownInput, thresholdInput, aliasesInput].forEach((el) => {
      if (!el) return;
      ['keydown', 'keypress', 'keyup'].forEach((evtName) => { el.addEventListener(evtName, (e) => { e.stopImmediatePropagation(); e.stopPropagation(); }, true); });
      el.addEventListener('focus', () => forceFocus(el), true);
      el.addEventListener('click', (e) => { e.stopPropagation(); forceFocus(el); }, true);
    });
    if (saveBtn) saveBtn.addEventListener('click', () => {
      CONFIG.ownName = ownInput ? ownInput.value.trim() : CONFIG.ownName;
      const parsed = thresholdInput ? parseFloat(thresholdInput.value) : CONFIG.fuzzyThreshold;
      if (!Number.isNaN(parsed)) CONFIG.fuzzyThreshold = Math.max(0.4, Math.min(1, parsed));
      CONFIG.customAliases = aliasesInput ? aliasesInput.value : CONFIG.customAliases;
      state.settingsOpen = false;
      render();
    });
    if (closeBtn) closeBtn.addEventListener('click', () => { state.settingsOpen = false; render(); });
    forceFocus(ownInput || thresholdInput || aliasesInput);
  }
  function renderSettings() {
    ui.body.innerHTML = `<div style="font-weight:700;margin-bottom:8px;">Settings</div><div style="color:#8ca0c7;font-size:11px;margin-bottom:8px;">Set your player name so the helper only tracks locks that target you. Sender matching is enforced for away/hit/miss, and chat updates are watched instantly.</div><label style="display:block;margin-bottom:8px;"><div style="color:#9db0d3;margin-bottom:4px;">Your player name</div><input data-setting="ownName" value="${escapeHtml(CONFIG.ownName)}" style="width:100%;background:#121927;color:#edf4ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px;"></label><label style="display:block;margin-bottom:8px;"><div style="color:#9db0d3;margin-bottom:4px;">Fuzzy threshold (0.4 - 1.0)</div><input data-setting="fuzzyThreshold" type="number" step="0.01" min="0.4" max="1" value="${escapeHtml(String(CONFIG.fuzzyThreshold))}" style="width:100%;background:#121927;color:#edf4ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px;"></label><label style="display:block;margin-bottom:8px;"><div style="color:#9db0d3;margin-bottom:4px;">Custom aliases, one per line: <code>alias = counter</code></div><textarea data-setting="customAliases" rows="6" style="width:100%;resize:vertical;background:#121927;color:#edf4ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px;">${escapeHtml(CONFIG.customAliases)}</textarea></label><div style="color:#8ca0c7;font-size:11px;margin-bottom:8px;">Example lines: <code>aim120c = chaff</code> or <code>r73m = flares</code></div><div style="display:flex;gap:8px;justify-content:flex-end;"><button data-action="close-settings" style="background:#162033;color:#dbe7ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer;">Cancel</button><button data-action="save-settings" style="background:#254a7d;color:#eef5ff;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 10px;cursor:pointer;">Save</button></div>`;
    bindSettingsEvents();
  }
  function renderMain() {
    const threat = state.lastThreat;
    const historyHtml = state.threatHistory.map((h) => `<div style="display:grid;grid-template-columns:46px 1fr;gap:6px;padding:5px 0;border-top:1px solid rgba(255,255,255,.05);"><div style="color:${h.result === 'hit' ? '#ff9c9c' : h.result === 'miss' ? '#9de2ae' : '#9ec8ff'};font-weight:700;">${escapeHtml(h.result.toUpperCase())}</div><div style="color:#bcd0ee;">${escapeHtml(h.weapon || 'Unknown')} on ${escapeHtml(h.target || 'Unknown')} by ${escapeHtml(h.sender || 'Unknown')}</div></div>`).join('');
    const debugHtml = state.debugLog.map((x) => `<div style="padding:2px 0;border-top:1px solid rgba(255,255,255,.04);color:#90a7cc;">${escapeHtml(x)}</div>`).join('');
    if (!threat) {
      ui.body.innerHTML = `<div style="font-weight:700;margin-bottom:6px;">Standby</div><div style="color:#b9c7df;">Watching GeoFS chat for sender-matched <code>lock (weapon) (target)</code>, then <code>away</code>, then <code>hit</code> or <code>miss</code>.</div><div style="margin-top:8px;color:#8ca0c7;">Rules loaded: ${WEAPON_RULES.length} + custom aliases</div><div style="margin-top:10px;font-size:11px;color:#9db0d3;">Recent outcomes</div><div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px;">${historyHtml || '<div style="color:#8ca0c7;">No completed shots yet.</div>'}</div><div style="margin-top:10px;font-size:11px;color:#9db0d3;">Debug</div><div style="margin-top:4px;max-height:120px;overflow:auto;padding-right:4px;">${debugHtml || '<div style="color:#8ca0c7;">No debug lines yet.</div>'}</div>`;
      return;
    }
    const age = Date.now() - threat.time;
    const stale = age > CONFIG.staleThreatMs;
    const isHit = threat.phase === 'hit';
    const isMiss = threat.phase === 'miss';
    const phaseColor = isHit ? '#ff9c9c' : isMiss ? '#8fe3a1' : stale ? '#f3caa4' : '#89d0a6';
    const counterColor = isHit ? '#ff8d8d' : isMiss ? '#8fe3a1' : threat.counter.includes('FLARE') ? '#ffb27d' : threat.counter.includes('CHAFF') ? '#9ec8ff' : '#f7e28f';
    const phaseLabel = isHit ? 'HIT' : isMiss ? 'MISS' : threat.phase.toUpperCase();
    const panelGlow = isHit ? '0 0 0 1px rgba(255,120,120,.18) inset, 0 0 22px rgba(255,80,80,.10)' : isMiss ? '0 0 0 1px rgba(120,255,160,.16) inset, 0 0 22px rgba(80,255,120,.08)' : 'none';
    ui.body.innerHTML = `<div style="padding:${isHit || isMiss ? '8px' : '0'};border-radius:12px;box-shadow:${panelGlow};"><div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:start;"><div><div style="font-size:16px;color:${phaseColor};font-weight:800;letter-spacing:.08em;">${escapeHtml(phaseLabel)}</div><div style="margin-top:8px;font-size:30px;font-weight:800;color:${counterColor};line-height:1.1;">${escapeHtml(threat.counter)}</div></div><div style="font-size:11px;color:#9db0d3;">${Math.floor(age / 1000)}s ago</div></div><div style="margin-top:10px;display:grid;grid-template-columns:78px 1fr;gap:6px;"><div style="color:#8ca0c7;">Sender</div><div>${escapeHtml(threat.sender || 'Unknown')}</div><div style="color:#8ca0c7;">Weapon</div><div>${escapeHtml(threat.weapon || 'Unspecified')}</div><div style="color:#8ca0c7;">Target</div><div>${escapeHtml(threat.target || 'Unknown')}</div><div style="color:#8ca0c7;">Rule</div><div>${escapeHtml(threat.ruleLabel)}</div><div style="color:#8ca0c7;">Status</div><div>${escapeHtml(threat.statusText)}</div></div><div style="margin-top:10px;padding:8px 9px;border:1px solid rgba(255,255,255,.09);border-radius:9px;background:rgba(255,255,255,.03);"><div style="font-size:11px;color:#9db0d3;margin-bottom:4px;">Tactic</div><div>${escapeHtml(threat.tactic)}</div></div><div style="margin-top:10px;font-size:11px;color:#9db0d3;">Recent outcomes</div><div style="margin-top:4px;max-height:150px;overflow:auto;padding-right:4px;">${historyHtml || '<div style="color:#8ca0c7;">No completed shots yet.</div>'}</div><div style="margin-top:10px;font-size:11px;color:#9db0d3;">Debug</div><div style="margin-top:4px;max-height:120px;overflow:auto;padding-right:4px;">${debugHtml || '<div style="color:#8ca0c7;">No debug lines yet.</div>'}</div><div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);color:#9db0d3;font-size:11px;">${escapeHtml(threat.raw)}</div></div>`;
  }
  function render() {
    ui.body.style.display = state.minimized ? 'none' : 'block';
    if (state.minimized) return;
    if (state.settingsOpen) renderSettings(); else renderMain();
  }
  function currentOwnName() { return CONFIG.ownName ? resolveName(CONFIG.ownName) : ''; }
  function shouldTrackTarget(target) {
    const own = currentOwnName();
    if (!own) return true;
    return normalizeName(own) === normalizeName(resolveName(target));
  }
  function getSenderQueue(sender) {
    const key = normalizeName(sender) || sender;
    if (!state.pendingLocksBySender.has(key)) state.pendingLocksBySender.set(key, []);
    return state.pendingLocksBySender.get(key);
  }
  function pruneSenderQueue(sender) {
    const key = normalizeName(sender) || sender;
    const queue = getSenderQueue(sender).filter(isFresh);
    state.pendingLocksBySender.set(key, queue);
    return queue;
  }
  function attachLock(evt) {
    const target = resolveName(evt.target);
    const rule = detectRule(`${evt.weapon} ${evt.raw}`);
    const own = currentOwnName();
    const lock = { type: 'lock', phase: 'lock', sender: evt.sender, weapon: evt.weapon, target, ruleLabel: rule.label, counter: rule.counter, tactic: rule.tactic, raw: evt.raw, time: Date.now(), awayTime: 0, statusText: own && normalizeName(own) !== normalizeName(target) ? `Lock on ${target}` : 'Lock on you' };
    const queue = getSenderQueue(evt.sender);
    queue.unshift(lock);
    if (queue.length > CONFIG.historySize) queue.length = CONFIG.historySize;
    state.lastThreat = lock;
    render();
  }
  function completeForSender(sender, result) {
    const queue = pruneSenderQueue(sender);
    if (!queue.length) return;
    const now = Date.now();
    if (result === 'away') {
      const shot = queue[0];
      if (!shot) return;
      shot.awayTime = now;
      const completed = { ...shot, phase: result, time: now, statusText: 'MISSILE AWAY', raw: `${shot.raw} -> away` };
      completed.counter = shot.counter;
      completed.tactic = `Shot is in the air. ${shot.tactic}`;
      state.lastThreat = completed;
      render();
      return;
    }
    const idx = queue.findIndex((item) => item.awayTime && (now - item.awayTime) <= RESULT_EXPIRY_MS);
    if (idx === -1) { pushDebug(`Result ignored for ${sender}: no active away-armed shot`); return; }
    const shot = queue[idx];
    queue.splice(idx, 1);
    const completed = { ...shot, phase: result, time: now, statusText: result.toUpperCase(), raw: `${shot.raw} -> ${result}` };
    pushHistory({ sender: shot.sender, weapon: shot.weapon, target: shot.target, result });
    completed.ruleLabel = shot.ruleLabel || 'Resolved shot';
    completed.weapon = shot.weapon || 'Unspecified';
    completed.target = shot.target || 'Unknown';
    completed.sender = shot.sender || sender;
    completed.counter = result === 'hit' ? 'IMPACT' : 'SAFE FOR NOW';
    completed.tactic = result === 'hit' ? 'Shot reported as a hit; break the event chain and reassess immediately.' : 'Shot reported as a miss; reset awareness for a likely follow-up lock.';
    state.lastThreat = { ...completed };
    pushDebug(`Transitioned to ${result.toUpperCase()} screen for ${completed.sender}`);
    render();
  }
  function processChatEvent(chatEvt) {
    const evt = parseThreatMessage(chatEvt.message);
    if (!evt) return;
    if (evt.type === 'lock') {
      if (!shouldTrackTarget(evt.target)) return;
      attachLock({ ...evt, sender: chatEvt.sender });
      return;
    }
    if (evt.type === 'away' || evt.type === 'hit' || evt.type === 'miss') completeForSender(chatEvt.sender, evt.type);
  }
  function processMessageRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (!row.matches('.geofs-chat-message')) return;
    if (row.dataset.mrpHandled === '1') return;
    const chatEvt = parseChatNode(row);
    if (!chatEvt || !chatEvt.message) return;
    row.dataset.mrpHandled = '1';
    const evt = parseThreatMessage(chatEvt.message);
    pushDebug(`${chatEvt.sender}: ${chatEvt.message} => ${evt ? evt.type : 'ignored'}`);
    if (!evt) return;
    if (evt.type === 'lock') {
      if (!shouldTrackTarget(evt.target)) return;
      attachLock({ ...evt, sender: chatEvt.sender });
      return;
    }
    if (evt.type === 'away' || evt.type === 'hit' || evt.type === 'miss') completeForSender(chatEvt.sender, evt.type);
  }
  function processChatNodeElement(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const parentRow = node.parentElement && node.parentElement.closest('.geofs-chat-message');
      if (parentRow) processMessageRow(parentRow);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches('.geofs-chat-message')) processMessageRow(node);
    node.querySelectorAll && node.querySelectorAll('.geofs-chat-message').forEach(processMessageRow);
    const nearestRow = node.closest && node.closest('.geofs-chat-message');
    if (nearestRow) processMessageRow(nearestRow);
  }
  function bootstrapExistingChat() {
    document.querySelectorAll('.geofs-chat-message').forEach((row) => {
      row.dataset.mrpHandled = '1';
    });
  }
  function rescanRecentChatForUnprocessed() {
    const rows = Array.from(document.querySelectorAll('.geofs-chat-message')).slice(-80);
    rows.forEach((row) => {
      if (!(row instanceof HTMLElement)) return;
      if (row.dataset.mrpHandled === '1') return;
      const chatEvt = parseChatNode(row);
      if (!chatEvt || !chatEvt.message) return;
      const evt = parseThreatMessage(chatEvt.message);
      if (!evt) return;
      processMessageRow(row);
    });
  }
  function attachObserver() {
    const chatRoot = document.querySelector('.geofs-chat-messages');
    if (!chatRoot) return false;
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver((records) => {
      collectPlayers();
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) processChatNodeElement(node);
          continue;
        }
        if (record.type === 'characterData') {
          processChatNodeElement(record.target);
        }
      }
      if (!state.settingsOpen) render();
    });
    state.observer.observe(chatRoot, { childList: true, subtree: true, characterData: true });
      return true;
  }
  function tick() {
    collectPlayers();
    if (!state.observer) {
      if (attachObserver()) bootstrapExistingChat();
    }
    rescanRecentChatForUnprocessed();
    if (!state.settingsOpen) render();
  }
  render();
  tick();
  window.__mrpThreatHelperInterval && clearInterval(window.__mrpThreatHelperInterval);
  window.__mrpThreatHelperObserver && window.__mrpThreatHelperObserver.disconnect && window.__mrpThreatHelperObserver.disconnect();
  window.__mrpThreatHelperInterval = setInterval(tick, CONFIG.scanIntervalMs);
  console.log('[MRP Threat Helper] Loaded. Reading GeoFS chat directly with sender-matched lock/away/hit/miss and MutationObserver.');
})();

})();
