/* AURA: no provider keys or automatic phone actions in the browser. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const bridge = window.AuraAndroid || null;
  const native = Boolean(bridge && typeof bridge.getState === 'function');
  const state = {
    aiMode: false, serverUrl: native ? '' : /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8787', accessToken: '',
    connected: false, config: null, nativeState: {}, listening: false,
    busy: false, history: [], context: null, proposals: new Map(),
    controller: null, generation: 0, connectionGeneration: 0,
    recognition: null, speechGranted: false, live: null, liveActive: false,
    memories: [], toastTimer: null, speaking: false, liveBubbles: {},
  };
  const icons = {mic: '#i-mic', stop: '#i-stop', send: '#i-send'};

  function storageGet(storage, key, fallback = null) {
    try { return storage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function storageSet(storage, key, value) {
    try { storage.setItem(key, value); return true; } catch { return false; }
  }
  function toast(message, error = false) {
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }
  function nativeCall(method, ...args) {
    if (!native || typeof bridge[method] !== 'function') throw new Error('This action requires the Android app.');
    const value = bridge[method](...args);
    return value;
  }
  function parseBridge(value) {
    if (typeof value === 'string') return JSON.parse(value);
    if (value && typeof value === 'object') return value;
    return {};
  }
  function checkedNative(method, ...args) {
    const result = parseBridge(nativeCall(method, ...args));
    if (result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || 'Android could not complete the request.');
    return result;
  }
  function openDialog(id) {
    if (id !== 'menu-dialog' && $('menu-dialog').open) $('menu-dialog').close();
    const element = $(id);
    if (id === 'settings-dialog') {
      $('server-url').value = state.serverUrl;
      $('access-token').value = state.accessToken;
    }
    if (id === 'permissions-dialog') refreshPermissions();
    if (id === 'memory-dialog') renderMemories();
    if (!element.open) element.showModal();
  }
  function status(element, text, error = false) {
    $(element).textContent = text;
    $(element).classList.toggle('error', error);
  }
  function normalizeServerUrl(raw) {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an http:// or https:// server address without credentials, a query, or a fragment.');
    }
    return url.href.replace(/\/+$/, '');
  }
  function safeWebUrl(raw) {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only ordinary HTTP or HTTPS links can be opened.');
    return url.href;
  }
  function configSupports(name) {
    const caps = state.config?.capabilities;
    return Array.isArray(caps) ? caps.includes(name) : Boolean(caps && caps[name]);
  }
  function setConnection(connected, label, note) {
    state.connected = connected;
    $('connection-button').classList.toggle('connected', connected);
    $('connection-short').textContent = label;
    $('connection-button').setAttribute('aria-label', 'Connection settings: ' + label);
    if (note) status('settings-status', note, !connected);
    renderPresence();
    renderLiveAvailability();
  }
  function renderPresence() {
    $('ai-mode').setAttribute('aria-checked', String(state.aiMode));
    $('mode-caption').textContent = state.aiMode ? 'On' : 'Off';
    $('orb-stage').classList.toggle('mode-off', !state.aiMode);
    $('orb-stage').classList.toggle('thinking', state.busy || (state.liveActive && !state.listening));
    $('orb-stage').classList.toggle('listening', state.listening);
    $('voice-wave').classList.toggle('active', state.listening || state.speaking);
    $('composer-mic').classList.toggle('listening', state.listening);
    $('composer-mic').setAttribute('aria-label', state.listening ? 'Stop dictation' : 'Dictate a message');
    $('composer-mic').querySelector('use').setAttribute('href', state.listening ? icons.stop : icons.mic);
    $('send-button').querySelector('use').setAttribute('href', state.busy ? icons.stop : icons.send);
    $('send-button').setAttribute('aria-label', state.busy ? 'Stop reply' : 'Send message');
    $('stop-speaking').hidden = !state.speaking;
    let title = 'Ready when you are.';
    let note = state.connected ? 'A thought, a question, a place to begin.' : 'Connect your AI server to begin.';
    if (!state.aiMode) { title = 'A moment of quiet.'; note = 'Turn on AI mode when you’re ready.'; }
    else if (state.liveActive) { title = 'A conversation, in the moment.'; note = 'Live voice is active. Tap Talk to end the session.'; }
    else if (state.listening) { title = 'I’m listening.'; note = 'Your words will appear below. Review, then send.'; }
    else if (state.busy) { title = 'Making a little sense of it.'; note = 'You can stop the reply at any time.'; }
    $('presence-title').textContent = title;
    $('presence-note').textContent = note;
    $('composer-status').textContent = !state.aiMode ? 'AI mode is off.' : state.connected ? `${state.config?.model || 'AI connected'} · your next step starts here.` : 'Connection setup needed.';
  }
  function updateClock() {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
    $('clock').dateTime = now.toISOString();
    $('date').textContent = now.toLocaleDateString([], {weekday: 'long', month: 'short', day: 'numeric'});
  }
  function loadNativeState() {
    if (!native) return;
    try { applyNativeState(parseBridge(nativeCall('getState'))); }
    catch { toast('Could not read Android connection state.', true); }
  }
  function applyNativeState(next) {
    if (!next || typeof next !== 'object') return;
    const wasOn = state.aiMode;
    state.nativeState = {...state.nativeState, ...next};
    if (typeof next.aiMode === 'boolean') state.aiMode = next.aiMode;
    if (typeof next.serverUrl === 'string') state.serverUrl = next.serverUrl;
    if (typeof next.accessToken === 'string') state.accessToken = next.accessToken;
    if (wasOn && !state.aiMode) stopEverything();
    refreshPermissions();
    renderPresence();
  }
  function toggleMode() {
    const next = !state.aiMode;
    if (native) {
      try {
        const actual = checkedNative('setAiMode', next);
        if (typeof actual.aiMode !== 'boolean') throw new Error('Android did not confirm the AI-mode state.');
        applyNativeState(actual);
        if (!actual.aiMode && !next) toast('AI mode is off. Listening and pending context have stopped.');
      } catch (error) { toast(error.message, true); }
      return;
    }
    storageSet(sessionStorage, 'aura.aiMode', String(next));
    state.aiMode = next;
    if (!next) {
      stopEverything();
      toast('AI mode is off. Listening and pending context have stopped.');
    }
    renderPresence();
  }
  function stopEverything() {
    state.generation += 1;
    state.controller?.abort();
    state.controller = null;
    state.busy = false;
    stopDictation();
    stopSpeaking();
    stopLive();
    clearContext();
    state.proposals.clear();
    renderProposals();
    document.querySelectorAll('.message.thinking').forEach(item => item.remove());
  }
  function abortReply() {
    state.generation += 1;
    state.controller?.abort();
    state.controller = null;
    state.busy = false;
    document.querySelectorAll('.message.thinking').forEach(item => item.remove());
    renderPresence();
    appendMessage('Reply stopped.', 'notice');
  }
  async function fetchJson(path, options = {}, auth = true) {
    const headers = new Headers(options.headers || {});
    if (auth && state.accessToken) headers.set('Authorization', 'Bearer ' + state.accessToken);
    const response = await fetch(state.serverUrl + path, {...options, headers, credentials: 'omit', referrerPolicy: 'no-referrer'});
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const error = result.error;
      const detail = typeof result.detail === 'string' ? result.detail : typeof error === 'string' ? error : error?.message;
      let message = detail || `Request failed (${response.status}).`;
      if (response.status === 401 || response.status === 403) message = 'Access was denied. Check the AURA access token in Connection settings.';
      throw new Error(message);
    }
    return result;
  }
  async function connect() {
    const generation = ++state.connectionGeneration;
    setConnection(false, 'Connecting', null);
    status('settings-status', 'Checking your server…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      await fetchJson('/health', {signal: controller.signal}, false);
      if (!state.accessToken) throw new Error('Server is reachable. Add its AURA access token to connect.');
      const config = await fetchJson('/v1/config', {signal: controller.signal});
      if (generation !== state.connectionGeneration) return;
      state.config = config;
      const configured = config.configured ?? config.provider_configured ?? config.ready;
      if (configured === false) {
        setConnection(false, 'Key needed', 'Server is reachable, but its AI provider is not configured. Add the provider key on the server.');
      } else {
        setConnection(true, 'Connected', `Connected${config.provider ? ' to ' + config.provider : ''}${config.model ? ' · ' + config.model : ''}.`);
      }
    } catch (error) {
      if (generation !== state.connectionGeneration) return;
      state.config = null;
      let message = error.name === 'AbortError' ? 'The server did not respond in time. Check its address and that it is running.' : error.message;
      if (error instanceof TypeError) message = 'Could not reach your server. Check its address, network connection, and browser CORS or HTTPS settings.';
      setConnection(false, 'Set up', message);
    } finally { clearTimeout(timeout); }
  }
  async function saveSettings(event) {
    event.preventDefault();
    try {
      const url = normalizeServerUrl($('server-url').value);
      const token = $('access-token').value.trim();
      if (token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Enter a valid AURA access token.');
      if (native) {
        const actual = checkedNative('configure', url, token);
        if (typeof actual.serverUrl !== 'string' || typeof actual.accessToken !== 'string') throw new Error('Android did not confirm the connection settings.');
        stopEverything();
        applyNativeState(actual);
      } else {
        if (!storageSet(sessionStorage, 'aura.accessToken', token)) throw new Error('Session storage is unavailable. The token could not be saved.');
        storageSet(localStorage, 'aura.serverUrl', url);
        stopEverything();
        state.serverUrl = url;
        state.accessToken = token;
      }
      state.config = null;
      renderPresence();
      await connect();
    } catch (error) { status('settings-status', error.message, true); }
  }
  function appendMessage(text, role = 'assistant', temporary = false) {
    $('conversation').hidden = false;
    const item = document.createElement('div');
    item.className = 'message ' + role + (temporary ? ' thinking' : '');
    item.textContent = text;
    $('messages').append(item);
    if (role !== 'notice') item.setAttribute('aria-label', role === 'user' ? 'Your message' : 'AURA reply');
    return item;
  }
  function scrollToReply() {
    $('conversation').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end'});
  }
  async function sendMessage(event) {
    event?.preventDefault();
    if (state.busy) { abortReply(); return; }
    const text = $('message-input').value.trim();
    if (!text) return;
    if (!state.aiMode) { toast('Turn on AI mode to send a message.'); return; }
    if (state.liveActive) { toast('End the live conversation before sending a chat message.'); return; }
    if (!state.accessToken) { openDialog('settings-dialog'); status('settings-status', 'Add your server address and AURA access token first.', true); return; }
    stopDictation();
    stopSpeaking();
    state.proposals.clear();
    renderProposals();
    const context = state.context;
    clearContext();
    appendMessage(text, 'user');
    if (context) appendMessage('One text snapshot was attached to this message.', 'notice');
    $('message-input').value = '';
    resizeComposer();
    const thinking = appendMessage('Finding a little clarity…', 'assistant', true);
    const generation = ++state.generation;
    const controller = new AbortController();
    state.controller = controller;
    state.busy = true;
    renderPresence();
    scrollToReply();
    const messages = [...state.history, {role: 'user', content: text}].slice(-29);
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const payload = {messages, ai_mode: true};
      if (context) payload.context = context;
      const result = await fetchJson('/v1/chat', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal: controller.signal});
      if (generation !== state.generation || !state.aiMode) return;
      if (typeof result.reply !== 'string') throw new Error('The server returned an invalid reply.');
      thinking.remove();
      appendMessage(result.reply);
      state.history = [...messages, {role: 'assistant', content: result.reply}].slice(-28);
      state.proposals.clear();
      for (const proposal of Array.isArray(result.proposals) ? result.proposals.slice(0, 10) : []) {
        if (proposal && typeof proposal.id === 'string' && typeof proposal.type === 'string' && typeof proposal.label === 'string') {
          state.proposals.set(proposal.id, {...proposal, clientStatus: 'proposed'});
        }
      }
      renderProposals();
      if ($('speak-replies').checked) speak(result.reply);
      scrollToReply();
    } catch (error) {
      if (generation !== state.generation || !state.aiMode) return;
      thinking.remove();
      const message = error.name === 'AbortError' ? 'The reply timed out. Please try again.' : error instanceof TypeError ? 'Could not reach the AI server. Check your connection settings.' : error.message;
      appendMessage(message, 'notice');
      toast(message, true);
    } finally {
      clearTimeout(timeout);
      if (generation === state.generation) {
        state.busy = false;
        state.controller = null;
        renderPresence();
      }
    }
  }
  function renderProposals() {
    $('proposals').replaceChildren();
    $('proposals').hidden = state.proposals.size === 0;
    for (const proposal of state.proposals.values()) {
      const card = document.createElement('article'); card.className = 'proposal';
      const label = document.createElement('p'); label.className = 'proposal-label'; label.textContent = proposal.label;
      const type = document.createElement('p'); type.className = 'proposal-type'; type.textContent = 'Suggested action · ' + proposal.type.replace(/_/g, ' ');
      const actions = document.createElement('div'); actions.className = 'proposal-actions';
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'primary-button'; approve.textContent = 'Approve action';
      approve.disabled = proposal.clientStatus !== 'proposed' || !state.aiMode;
      approve.addEventListener('click', () => approveAction(proposal.id));
      const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'secondary-button'; dismiss.textContent = 'Dismiss';
      dismiss.disabled = proposal.clientStatus === 'pending';
      dismiss.addEventListener('click', () => { state.proposals.delete(proposal.id); renderProposals(); });
      actions.append(approve, dismiss);
      const note = document.createElement('p'); note.className = 'proposal-status';
      note.textContent = proposal.clientMessage || 'Nothing happens until you approve.';
      card.append(label, type, actions, note);
      $('proposals').append(card);
    }
  }
  function approveAction(id) {
    const proposal = state.proposals.get(id);
    if (!proposal || proposal.clientStatus !== 'proposed' || !state.aiMode) return;
    try {
      if (native) {
        proposal.clientStatus = 'pending';
        proposal.clientMessage = 'Action requested. Waiting for the device result…';
        renderProposals();
        const {clientStatus, clientMessage, ...action} = proposal;
        const result = checkedNative('executeAction', JSON.stringify(action));
        if (result.status === 'awaiting_approval') proposal.clientMessage = 'Review the Android confirmation dialog to continue.';
        else if (typeof result.status === 'string') { proposal.clientStatus = result.status; proposal.clientMessage = result.message || 'Device returned status: ' + result.status; }
        else throw new Error('Android did not confirm the action request.');
      } else if (proposal.type === 'open_url') {
        const url = safeWebUrl(proposal.arguments?.url);
        window.open(url, '_blank', 'noopener,noreferrer');
        proposal.clientStatus = 'requested';
        proposal.clientMessage = 'Open requested. Check your browser for the new page.';
      } else {
        proposal.clientStatus = 'unavailable';
        proposal.clientMessage = 'This action requires the Android app. Nothing was executed.';
      }
    } catch (error) {
      proposal.clientStatus = 'proposed'; proposal.clientMessage = 'Not executed: ' + error.message;
    }
    renderProposals();
  }
  function setContext(context) {
    if (!state.aiMode) throw new Error('Turn on AI mode before attaching context.');
    if (!context || typeof context.text !== 'string' || !context.text.trim()) throw new Error('There is no readable text to attach.');
    state.context = {text: context.text.trim().slice(0, 16000), source: context.source === 'accessibility' ? 'accessibility' : 'manual', captured_at: context.captured_at || new Date().toISOString()};
    $('context-label').textContent = state.context.source === 'accessibility' ? 'Screen text attached · next message only' : 'Pasted text attached · next message only';
    $('context-preview').hidden = false;
    toast('Text attached. Add your question and send when ready.');
  }
  function clearContext() {
    state.context = null;
    $('context-preview').hidden = true;
    $('manual-context').value = '';
    status('screen-status', '');
  }
  function captureScreen() {
    if (!state.aiMode) { status('screen-status', 'Turn on AI mode before attaching screen text.', true); return; }
    if (!native) { status('screen-status', 'Phone screen access requires the Android app. You can paste text below instead.', true); return; }
    try {
      loadNativeState();
      if (!state.nativeState.accessibilityEnabled) {
        status('screen-status', 'Enable Accessibility in the permission center, then return to the screen you want help with.', true);
        openDialog('permissions-dialog'); return;
      }
      const context = parseBridge(nativeCall('getScreenContext'));
      if (context.error) throw new Error(typeof context.error === 'string' ? context.error : context.error.message || 'Screen text could not be read.');
      setContext(context);
      $('manual-context').value = state.context.text;
      status('screen-status', 'Snapshot attached. Review the text above, then close this panel and send your question.');
    } catch (error) { status('screen-status', error.message, true); }
  }
  function refreshPermissions() {
    $('platform-description').textContent = native ? 'Android app · permissions are granted through your device settings.' : 'Browser preview · phone screen access and phone actions require the Android app.';
    $('microphone-state').textContent = native ? state.nativeState.microphoneGranted ? 'Allowed by Android' : 'Not granted' : state.speechGranted ? 'Dictation available this session' : 'Permission requested when you start dictation';
    $('accessibility-state').textContent = native ? state.nativeState.accessibilityEnabled ? 'Enabled · capture only on request' : 'Not enabled' : 'Android app required';
    $('notifications-state').textContent = native ? state.nativeState.notificationsGranted ? 'Allowed by Android' : 'Not granted' : 'Android app required';
    $('notifications-badge').textContent = native ? state.nativeState.notificationsGranted ? 'Allowed' : 'Not granted' : 'Unavailable';
    $('accessibility-permission').disabled = !native;
    $('microphone-permission').textContent = native && state.nativeState.microphoneGranted ? 'Allowed' : 'Enable';
    $('microphone-permission').disabled = native && Boolean(state.nativeState.microphoneGranted);
    $('accessibility-permission').textContent = state.nativeState.accessibilityEnabled ? 'Settings' : 'Enable';
    $('capture-screen').disabled = !native;
    $('screen-support').textContent = native ? 'To share another app: open it, tap Read screen in the AURA notification, return here, then attach the snapshot. It expires after 60 seconds. No screenshot is uploaded.' : 'Phone screen access is available in the Android app. Paste text here in browser mode.';
    $('token-storage-note').textContent = native ? 'Saved privately by the Android app.' : 'Held for this browser session only.';
    $('server-url').placeholder = native ? 'https://your-aura-server.example' : 'http://127.0.0.1:8787';
  }
  function requestMicrophone() {
    if (native) {
      try { applyNativeState(checkedNative('requestMicrophone')); } catch (error) { toast(error.message, true); }
    } else {
      if (!state.aiMode) { toast('Turn on AI mode, then tap Talk to request microphone access.'); return; }
      toggleDictation();
    }
  }
  function stopDictation() {
    if (native) { try { nativeCall('stopListening'); } catch {} }
    if (state.recognition) { try { state.recognition.abort(); } catch {} state.recognition = null; }
    state.listening = false;
    renderPresence();
  }
  function toggleDictation() {
    if (state.listening) { stopDictation(); return; }
    if (!state.aiMode) { toast('Turn on AI mode before using voice.'); return; }
    if (state.liveActive) { toast('End live voice before using dictation.'); return; }
    stopSpeaking();
    if (native) {
      try {
        loadNativeState();
        if (!state.nativeState.microphoneGranted) { applyNativeState(checkedNative('requestMicrophone')); toast('Allow microphone access, then tap the microphone again.'); return; }
        checkedNative('startListening');
        state.listening = true;
      } catch (error) { toast(error.message, true); }
      renderPresence(); return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { toast('Dictation is unavailable in this browser. Type your message or use the Android app.', true); return; }
    try {
      const recognition = new Recognition();
      state.recognition = recognition;
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onstart = () => { state.listening = true; state.speechGranted = true; refreshPermissions(); renderPresence(); };
      recognition.onresult = event => {
        if (!state.aiMode) return;
        $('message-input').value = event.results[0][0].transcript;
        resizeComposer();
        toast('Transcript ready. Review it, then tap Send.');
      };
      recognition.onerror = event => { if (event.error !== 'aborted') toast(event.error === 'not-allowed' ? 'Microphone access was denied. You can type your message instead.' : 'Dictation stopped: ' + event.error, true); };
      recognition.onend = () => { if (state.recognition === recognition) { state.listening = false; state.recognition = null; renderPresence(); } };
      recognition.start();
    } catch (error) { state.recognition = null; state.listening = false; toast('Could not start dictation. ' + error.message, true); renderPresence(); }
  }
  function speak(text) {
    if (!state.aiMode || !text) return;
    stopSpeaking();
    try {
      if (native) {
        checkedNative('speak', text);
        state.speaking = true;
      } else if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onstart = () => { state.speaking = true; renderPresence(); };
        utterance.onend = utterance.onerror = () => { state.speaking = false; renderPresence(); };
        speechSynthesis.speak(utterance);
      } else toast('Spoken replies are unavailable on this device.');
    } catch (error) { toast('Could not read the reply aloud.', true); }
    renderPresence();
  }
  function stopSpeaking() {
    if (native) { try { nativeCall('stopSpeaking'); } catch {} }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    state.speaking = false;
    renderPresence();
  }
  function renderLiveAvailability() {
    const supported = Boolean(window.AuraLiveVoice) && configSupports('live_voice');
    $('start-live').disabled = !supported || !state.connected || state.liveActive;
    $('start-live').hidden = state.liveActive;
    $('stop-live').hidden = !state.liveActive;
    if (!state.liveActive) status('live-status', !state.connected ? 'Connect your server to check live voice availability.' : !supported ? 'Live voice is not available on this server. You can still dictate a message.' : 'Live voice is available. Start it when you’re ready.');
  }
  async function startLive() {
    if (state.liveActive) return;
    if (!state.aiMode) { toast('Turn on AI mode before starting live voice.'); return; }
    if (!state.connected || !configSupports('live_voice') || !window.AuraLiveVoice) { status('live-status', 'Live voice is not available on this connection.', true); return; }
    if (state.busy) { toast('Stop the current reply before starting live voice.'); return; }
    if (native && !state.nativeState.microphoneGranted) {
      try { applyNativeState(checkedNative('requestMicrophone')); } catch (error) { toast(error.message, true); }
      status('live-status', 'Allow microphone access, then tap Start live conversation again.'); return;
    }
    stopDictation(); stopSpeaking(); clearContext();
    const live = new window.AuraLiveVoice({serverUrl: state.serverUrl, token: state.accessToken, onEvent: event => onLiveEvent(live, event)});
    state.live = live;
    state.liveBubbles = {};
    state.liveActive = true;
    renderLiveAvailability(); renderPresence();
    status('live-status', 'Connecting live voice…');
    try { await live.start(); }
    catch (error) { if (state.live === live) { stopLive(); status('live-status', error.message || 'Could not start live voice.', true); } }
  }
  function onLiveEvent(live, event) {
    if (state.live !== live || !event) return;
    if (!state.aiMode) { stopLive(); return; }
    if (event.type === 'ready' || event.type === 'listening') status('live-status', 'Live voice is connected. Speak naturally; end the session when you’re done.');
    else if (event.type === 'transcript' && typeof event.text === 'string') {
      const role = event.role === 'user' ? 'user' : 'assistant';
      if (!state.liveBubbles[role]) state.liveBubbles[role] = appendMessage('', role);
      state.liveBubbles[role].textContent += event.text;
      scrollToReply();
    } else if (event.type === 'interrupted') { state.liveBubbles = {}; status('live-status', 'Reply interrupted. You can keep speaking.'); }
    else if (event.type === 'turn_complete') { state.liveBubbles = {}; status('live-status', 'Listening for your next thought…'); }
    else if (event.type === 'error') { const message = event.message || 'Live voice stopped unexpectedly.'; stopLive(); status('live-status', message, true); toast(message, true); }
    else if (event.type === 'stopped') stopLive();
  }
  function stopLive() {
    const live = state.live;
    state.live = null;
    state.liveBubbles = {};
    state.liveActive = false;
    if (live) { try { live.stop(); } catch {} }
    renderLiveAvailability(); renderPresence();
  }
  function loadMemories() {
    try {
      const records = JSON.parse(storageGet(localStorage, 'aura.memories', '[]'));
      state.memories = Array.isArray(records) ? records.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string').slice(0, 100) : [];
    } catch { state.memories = []; }
  }
  function renderMemories() {
    $('memory-list').replaceChildren();
    if (!state.memories.length) {
      const empty = document.createElement('p'); empty.className = 'memory-empty'; empty.textContent = 'A clear page. Save your first thought above.'; $('memory-list').append(empty); return;
    }
    for (const memory of state.memories) {
      const item = document.createElement('article'); item.className = 'memory-item';
      const title = document.createElement('h3'); title.textContent = memory.title;
      const body = document.createElement('p'); body.textContent = memory.body;
      const buttons = document.createElement('div'); buttons.className = 'button-row';
      const attach = document.createElement('button'); attach.type = 'button'; attach.className = 'small-button'; attach.textContent = 'Attach to next message';
      attach.addEventListener('click', () => { try { setContext({text: memory.title + '\n' + memory.body, source: 'manual'}); $('memory-dialog').close(); $('message-input').focus(); } catch (error) { toast(error.message, true); } });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-button'; remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        if (!confirm('Delete this saved memory?')) return;
        const remaining = state.memories.filter(record => record.id !== memory.id);
        if (!storageSet(localStorage, 'aura.memories', JSON.stringify(remaining))) { toast('Could not update local memory storage.', true); return; }
        state.memories = remaining; renderMemories();
      });
      buttons.append(attach, remove); item.append(title, body, buttons); $('memory-list').append(item);
    }
  }
  function saveMemory(event) {
    event.preventDefault();
    const title = $('memory-title').value.trim(); const body = $('memory-body').value.trim();
    if (!title || !body) return;
    if (state.memories.length >= 100) { toast('You have 100 saved memories. Delete one before saving another.', true); return; }
    const memory = {id: window.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2), title, body, created_at: new Date().toISOString()};
    const records = [memory, ...state.memories];
    if (!storageSet(localStorage, 'aura.memories', JSON.stringify(records))) { toast('Memory storage is unavailable or full. Your thought was not saved.', true); return; }
    state.memories = records;
    $('memory-form').reset(); renderMemories(); toast('Memory saved on this device.');
  }
  function resizeComposer() { $('message-input').style.height = 'auto'; $('message-input').style.height = Math.min($('message-input').scrollHeight, 130) + 'px'; }

  // Event bindings: no permission is requested during page load.
  $('menu-button').addEventListener('click', () => openDialog('menu-dialog'));
  $('connection-button').addEventListener('click', () => openDialog('settings-dialog'));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openDialog(button.dataset.open)));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
  $('ai-mode').addEventListener('click', toggleMode);
  $('settings-form').addEventListener('submit', saveSettings);
  $('test-connection').addEventListener('click', async () => {
    if ($('server-url').value.trim().replace(/\/+$/, '') !== state.serverUrl || $('access-token').value.trim() !== state.accessToken) { status('settings-status', 'Save these settings first so the test uses the address and token shown above.'); return; }
    await connect();
  });
  $('chat-form').addEventListener('submit', sendMessage);
  $('message-input').addEventListener('input', resizeComposer);
  $('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
  $('new-chat').addEventListener('click', () => { if (state.busy || state.liveActive) { toast('Stop the active conversation before starting a new chat.'); return; } stopSpeaking(); state.history = []; state.proposals.clear(); renderProposals(); clearContext(); $('messages').replaceChildren(); $('conversation').hidden = true; toast('A fresh start.'); });
  $('talk-button').addEventListener('click', () => openDialog('voice-dialog'));
  $('dictate-button').addEventListener('click', () => { $('voice-dialog').close(); toggleDictation(); });
  $('composer-mic').addEventListener('click', toggleDictation);
  $('start-live').addEventListener('click', startLive);
  $('stop-live').addEventListener('click', stopLive);
  $('screen-button').addEventListener('click', () => openDialog('screen-dialog'));
  $('capture-screen').addEventListener('click', captureScreen);
  $('attach-manual-context').addEventListener('click', () => { try { setContext({text: $('manual-context').value, source: 'manual'}); $('screen-dialog').close(); $('message-input').focus(); } catch (error) { status('screen-status', error.message, true); } });
  $('remove-context').addEventListener('click', clearContext);
  $('microphone-permission').addEventListener('click', requestMicrophone);
  $('accessibility-permission').addEventListener('click', () => { try { checkedNative('requestAccessibility'); } catch (error) { toast(error.message, true); } });
  $('memory-button').addEventListener('click', () => openDialog('memory-dialog'));
  $('memory-form').addEventListener('submit', saveMemory);
  $('stop-speaking').addEventListener('click', stopSpeaking);
  $('speak-replies').checked = storageGet(localStorage, 'aura.speakReplies', 'false') === 'true';
  $('speak-replies').addEventListener('change', () => { storageSet(localStorage, 'aura.speakReplies', String($('speak-replies').checked)); if (!$('speak-replies').checked) stopSpeaking(); });
  window.addEventListener('aura-native', event => {
    const detail = event.detail || {};
    if (detail.type === 'state') applyNativeState(detail.state || {});
    else if (detail.type === 'audio_stop') { stopLive(); stopDictation(); stopSpeaking(); }
    else if (detail.type === 'speech_result') {
      state.listening = false;
      if (state.aiMode && typeof detail.text === 'string') { $('message-input').value = detail.text; resizeComposer(); toast('Transcript ready. Review it, then tap Send.'); }
      renderPresence();
    } else if (detail.type === 'error') { state.listening = false; state.speaking = false; renderPresence(); toast(detail.message || 'The device could not complete that request.', true); }
    else if (detail.type === 'speech_end' || detail.type === 'speaking_stopped') { state.speaking = false; renderPresence(); }
    else if (detail.type === 'action_result') {
      const proposal = state.proposals.get(detail.id);
      if (proposal) { proposal.clientStatus = detail.status || 'unknown'; proposal.clientMessage = detail.message || 'Device returned status: ' + proposal.clientStatus; renderProposals(); }
      else toast(detail.message || 'Device action status: ' + (detail.status || 'unknown'));
    }
  });
  window.addEventListener('pagehide', stopEverything);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopLive(); stopDictation(); stopSpeaking(); }
    else if (native) loadNativeState();
  });

  if (native) loadNativeState();
  else {
    try { state.serverUrl = normalizeServerUrl(storageGet(localStorage, 'aura.serverUrl', state.serverUrl)); } catch {}
    state.accessToken = storageGet(sessionStorage, 'aura.accessToken', '');
    state.aiMode = storageGet(sessionStorage, 'aura.aiMode', 'false') === 'true';
  }
  updateClock(); setInterval(updateClock, 1000);
  loadMemories(); refreshPermissions(); renderPresence(); renderLiveAvailability();
  if (state.accessToken) connect();
})();
