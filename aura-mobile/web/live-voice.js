/* AURA opt-in live voice. Provider keys stay on the Python backend. */
(() => {
  'use strict';

  function encodePcm(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  class Resampler {
    constructor(inputRate, outputRate = 16000) {
      this.ratio = inputRate / outputRate;
      this.pending = new Float32Array(0);
      this.position = 0;
    }

    process(input) {
      const samples = new Float32Array(this.pending.length + input.length);
      samples.set(this.pending);
      samples.set(input, this.pending.length);
      const output = [];
      while (this.position + 1 < samples.length) {
        const left = Math.floor(this.position);
        const fraction = this.position - left;
        output.push(samples[left] * (1 - fraction) + samples[left + 1] * fraction);
        this.position += this.ratio;
      }
      const consumed = Math.min(Math.floor(this.position), Math.max(0, samples.length - 1));
      this.pending = samples.slice(consumed);
      this.position -= consumed;
      return new Float32Array(output);
    }
  }

  class AuraLiveVoice {
    constructor({ serverUrl, token, onEvent } = {}) {
      this.serverUrl = serverUrl || location.origin;
      this.token = token || '';
      this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
      this.active = false;
      this.starting = false;
      this._generation = 0;
      this._sources = new Set();
      this._playhead = 0;
      this._stream = null;
      this._context = null;
      this._processor = null;
      this._input = null;
      this._silence = null;
      this._socket = null;
      this._fetch = null;
      this._readyReject = null;
      this._readyTimer = null;
      this._nativeListener = event => {
        const detail = event.detail || {};
        if (detail.type === 'audio_stop' || (detail.type === 'state' && detail.state?.aiMode === false)) this.stop();
      };
      this._visibilityListener = () => { if (document.hidden) this.stop(); };
    }

    _emit(event) {
      try { this.onEvent(event); } catch (_) { /* A UI callback cannot hold the mic open. */ }
    }

    async start() {
      if (this.active || this.starting) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live voice needs microphone support in a secure browser or the Android app.');
      if (!this.token) throw new Error('Connect your backend and access token before starting Live voice.');
      const base = new URL(this.serverUrl);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Enter a valid HTTP or HTTPS backend URL.');
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('This browser does not support Live voice audio.');
      const generation = ++this._generation;
      this.starting = true;
      window.addEventListener('aura-native', this._nativeListener);
      document.addEventListener('visibilitychange', this._visibilityListener);
      try {
        // AudioContext is created in the user's click gesture so mobile browsers
        // can unlock playback before the first network response arrives.
        this._context = new Audio();
        await this._context.resume();
        if (generation !== this._generation) return;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (generation !== this._generation) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        this._stream = stream;
        stream.getAudioTracks().forEach(track => {
          track.onended = () => {
            if (generation === this._generation) {
              this._emit({ type: 'error', message: 'Microphone access ended. Live voice has stopped.' });
              this.stop();
            }
          };
        });
        this._fetch = new AbortController();
        const ticketResponse = await fetch(new URL('/v1/voice-session', base), {
          method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, signal: this._fetch.signal,
        });
        const ticket = await ticketResponse.json();
        if (!ticketResponse.ok) {
          const detail = ticket.error?.message || ticket.detail || ticket.message;
          throw new Error(typeof detail === 'string' ? detail : 'The backend could not start Live voice.');
        }
        if (generation !== this._generation) return;
        if (typeof ticket.websocket_path !== 'string' || !ticket.websocket_path.startsWith('/v1/live?ticket=')) throw new Error('The backend returned an invalid voice session.');
        const endpoint = new URL(ticket.websocket_path, base);
        endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(endpoint.toString());
        this._socket = socket;
        await new Promise((resolve, reject) => {
          this._readyReject = reject;
          const timer = setTimeout(() => reject(new Error('Live voice connection timed out. Check model access and backend connectivity.')), 25000);
          this._readyTimer = timer;
          let ready = false;
          socket.onmessage = event => {
            if (generation !== this._generation) return;
            let message;
            try { message = JSON.parse(event.data); } catch (_) { return; }
            if (message.type === 'ready' && !ready) {
              ready = true;
              clearTimeout(timer);
              this._readyReject = null;
              resolve();
            }
            if (message.type === 'error') {
              if (!ready) {
                clearTimeout(timer);
                reject(new Error(message.message || 'Live voice is unavailable.'));
              } else {
                this._emit(message);
                this.stop();
              }
              return;
            }
            if (message.type === 'audio') {
              try { this._playAudio(message.data, message.mime_type); }
              catch (_) { this._emit({ type: 'error', message: 'Could not play the voice response.' }); this.stop(); }
            } else if (message.type === 'interrupted') {
              this._clearPlayback();
            }
            this._emit(message);
          };
          socket.onerror = () => {
            clearTimeout(timer);
            if (!ready) reject(new Error('Live voice could not connect to your backend.'));
            else { this._emit({ type: 'error', message: 'Live voice connection was lost.' }); this.stop(); }
          };
          socket.onclose = () => {
            clearTimeout(timer);
            if (!ready) reject(new Error('Live voice session was rejected or closed.'));
            else if (generation === this._generation) this.stop();
          };
        });
        if (generation !== this._generation) return;
        const context = this._context;
        const resampler = new Resampler(context.sampleRate);
        this._input = context.createMediaStreamSource(stream);
        // ScriptProcessor remains supported in Android WebView; an AudioWorklet
        // can replace this without changing the backend PCM16 protocol.
        this._processor = context.createScriptProcessor(4096, 1, 1);
        this._silence = context.createGain();
        this._silence.gain.value = 0;
        this._processor.onaudioprocess = event => {
          if (!this.active || generation !== this._generation || socket.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 256000) {
            this._emit({ type: 'error', message: 'Network is too slow for Live voice. The microphone has been stopped.' });
            this.stop();
            return;
          }
          const pcm = resampler.process(event.inputBuffer.getChannelData(0));
          if (pcm.length) socket.send(JSON.stringify({ type: 'audio', data: encodePcm(pcm) }));
        };
        this._input.connect(this._processor);
        this._processor.connect(this._silence);
        this._silence.connect(context.destination);
        this.active = true;
        this.starting = false;
        this._emit({ type: 'listening', model: ticket.model });
      } catch (error) {
        if (generation !== this._generation) return;
        this.stop();
        throw error;
      }
    }

    sendText(text) {
      if (!this.active || this._socket?.readyState !== WebSocket.OPEN) throw new Error('Start Live voice first.');
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Enter 1–4000 characters.');
      this._socket.send(JSON.stringify({ type: 'text', text }));
    }

    _playAudio(encoded, mime) {
      const context = this._context;
      if (!context || typeof encoded !== 'string' || encoded.length > 350000) return;
      const binary = atob(encoded);
      if (!binary.length || binary.length % 2) throw new Error('Invalid PCM audio.');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const rateMatch = /(?:^|;)rate=(\d+)/.exec(mime || '');
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('Unsupported voice sample rate.');
      const buffer = context.createBuffer(1, binary.length / 2, sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      if (this._playhead - context.currentTime > 15) throw new Error('Voice playback buffer exceeded its limit.');
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => this._sources.delete(source);
      this._sources.add(source);
      const at = Math.max(context.currentTime + 0.02, this._playhead);
      source.start(at);
      this._playhead = at + buffer.duration;
    }

    _clearPlayback() {
      for (const source of this._sources) {
        try { source.stop(); source.disconnect(); } catch (_) { /* Already ended. */ }
      }
      this._sources.clear();
      this._playhead = this._context?.currentTime || 0;
    }

    stop() {
      const hadSession = this.active || this.starting;
      ++this._generation;
      this.active = false;
      this.starting = false;
      window.removeEventListener('aura-native', this._nativeListener);
      document.removeEventListener('visibilitychange', this._visibilityListener);
      if (this._readyReject) {
        this._readyReject(new Error('Live voice stopped.'));
        this._readyReject = null;
      }
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
      this._fetch?.abort();
      this._fetch = null;
      if (this._socket) {
        if (this._socket.readyState === WebSocket.OPEN) {
          try { this._socket.send(JSON.stringify({ type: 'stop' })); } catch (_) { /* Closing. */ }
        }
        this._socket.onmessage = null;
        this._socket.onerror = null;
        this._socket.onclose = null;
        try { this._socket.close(); } catch (_) { /* Already closed. */ }
        this._socket = null;
      }
      this._stream?.getTracks().forEach(track => track.stop());
      this._stream = null;
      if (this._processor) this._processor.onaudioprocess = null;
      for (const node of [this._input, this._processor, this._silence]) {
        try { node?.disconnect(); } catch (_) { /* Already disconnected. */ }
      }
      this._input = this._processor = this._silence = null;
      this._clearPlayback();
      const context = this._context;
      this._context = null;
      if (context) context.close().catch(() => {});
      if (hadSession) this._emit({ type: 'stopped' });
    }
  }

  // Small pure helpers are exposed for deterministic resampling/PCM tests.
  AuraLiveVoice.Resampler = Resampler;
  AuraLiveVoice.encodePcm = encodePcm;
  window.AuraLiveVoice = AuraLiveVoice;
})();
