/* ChordBuddy 局域网点对点调号同步层
 * 目标：单机 App，无任何后端/中央服务器。
 * 任一台设备发起会话(host)，同一局域网内的其它设备以连接码加入(peer)，
 * 任一端临时切调，全部分发调号广播，各端保持单机独立、仅同步调号。
 *
 * ============================================================================
 * 统一 Transport 接口契约（每种后端都必须实现，供上层无差异调用）：
 *   kind   : 'local' | 'webrtc' | 'bluetooth'
 *   start(role): 发起会话(role='host')或加入(role='peer')，返回 boolean/Promise。
 *                成功后通过事件 on('state') 上报 {connected, host}。
 *   stop() : 断开并重置，上报 on('state') {connected:false}。
 *   事件中继（统一经 window.ChordSync.on/emit 收发，不分后端）：
 *     on('key')    : 调号同步。连接层负责"本地切调→广播 / 远端调号→applyRemoteKey"，
 *                    后端只管把收到的 key 上行、把远端 key 下行。
 *     on('state')  : {connected, host} 连接状态。
 *     on('status') : {phase, label}  传输层过程状态(扫描/配对/连接中…)，前端用于进度 UI。
 *   createTransport(kind) 按可用性自动回退到可用后端。
 *
 * 后端选择(按可用性自动回退)：
 *  - BroadcastChannel : 本机/同源浏览器多窗口即可跑通完整同步协议，用于开发自测
 *  - WebRTC DataChannel: 真机局域网点对点。因无需信令服务器，靠手动粘贴连接码交换 SDP。
 *    注意：Android/iOS 原生 WebView 对 RTCPeerConnection 支持依赖系统版本，真机联调时需确认
 *        可用后再启用；在浏览器(https/localhost)中可直接试用。
 *  - 蓝牙BLE: 真实实现=接入 Capacitor 原生 BLE 插件(如 @capacitor-community/bluetooth-le)。
 *    当前为"占位后端"：接口契约先行，adapter 做可替换插槽。未装插件时返回 available=false，
 *    并提供一条模拟链路(simulate)让连接流程/UI/协议可先联调，接真机时替换 adapter 即可。
 */
(function(){
  'use strict';
  const noop = () => {};
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let api = (window.__cbApi && typeof window.__cbApi === 'object') ? window.__cbApi : null;

  // ---------- 调号 <-> 消息 事件中枢 ----------
  const listeners = { 'key': [], 'state': [] };
  const on = (ev, cb) => (listeners[ev] || (listeners[ev] = [])).push(cb);
  const emit = (ev, data) => (listeners[ev] || []).forEach(cb => { try { cb(data); } catch(e){} });
  const suppress = { v: false }; // 收到远端广播后抑制本地再广播，避免回环

  // 本地调号变化 -> 上游广播
  function hookLocalKey() {
    if (api && api.onKeyChanged) {
      api.onKeyChanged(key => {
        if (suppress.v) { suppress.v = false; return; }
        emit('key', key);
      });
    }
    if (!api) emit('key', window.__cbLastKey || 'C');
  }

  // 收到远端调号 -> 落地到本地界面
  function applyRemoteKey(key) {
    if (api && api.setKey && key && key !== api.getKey()) {
      suppress.v = true;
      api.setKey(key);
    }
    emit('key', key);
  }

  // ---------- 本地同步后端(BroadcastChannel) ----------
  function createLocalBackend() {
    let ch = null, host = false;
    const chan = 'chordbuddy-sync';
    function ensure() {
      if (ch) return ch;
      try { ch = new BroadcastChannel(chan); } catch(e) { ch = null; }
      if (ch) ch.onmessage = (ev) => { const m = ev.data; if (m && m.src !== id) applyRemoteKey(m.key); };
      return ch;
    }
    return {
      kind: 'local',
      start(role) { host = role === 'host'; ensure(); emit('state', { connected: true, host }); on('key', k => { const chn = ensure(); if (chn) chn.postMessage({ src: id, key: k }); }); return true; },
      stop() { try { if (ch) ch.close(); } catch(e){} ch = null; emit('state', { connected: false, host: false }); },
    };
  }

  // ---------- WebRTC 点对点后端(真机局域网) ----------
  // 真实浏览器/支持RTCPeerConnection的WebView内可用。Signaling 走"手动连接码"：
  //   1) host.createCode() 返回含 offer SDP 的连接码，复制给 peer
  //   2) peer.connect(code) 求得自己的 answer SDP 再回给 host
  //   3) 链路建立后调号走 DataChannel。
  function createWebRTCBackend() {
    let pc = null, dc = null, role = null, makingOffer = false;
    const cfg = { iceServers: [] }; // 局域网内仅用 host candidate，无需公共 STUN
    function setupDc() {
      dc.onopen = () => emit('state', { connected: true, host: role === 'host' });
      dc.onmessage = (ev) => { try { applyRemoteKey(JSON.parse(ev.data).key); } catch(e){} };
    }
    function br(k) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ key: k })); }
    on('key', k => br(k));
    return {
      kind: 'webrtc',
      async start(r) {
        role = r;
        pc = new RTCPeerConnection(cfg);
        pc.onicecandidate = () => {}; // 局域网 host candidate 自动协商
        pc.ondatachannel = (e) => { dc = e.channel; setupDc(); };
        if (role === 'host') { dc = pc.createDataChannel('key'); setupDc(); }
        return true;
      },
      async hostCode() {
        const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
        makingOffer = true; await pc.setLocalDescription(offer);
        return btoa(JSON.stringify(pc.localDescription)).split('/').join('_').split('+').join('-');
      },
      async connect(code) {
        try {
          const j = JSON.parse(atob(code.split('-').join('+').split('_').join('/')));
          await pc.setRemoteDescription(j);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          return btoa(JSON.stringify(pc.localDescription)).split('/').join('_').split('+').join('-');
        } catch(e) { return null; }
      },
      async accept(code) { if (makingOffer) { const j = JSON.parse(atob(code.split('-').join('+').split('_').join('/'))); await pc.setRemoteDescription(j); } },
      stop() { [pc, dc].forEach(x => { try { x && x.close(); } catch(e){} }); pc = dc = null; emit('state', { connected: false, host: false }); },
    };
  }

  // ---------- 蓝牙 BLE 占位后端 ----------
  // 接口契约同其它后端(kind/start/stop + 经 on/emit 中继 state/status/key)。
  // 真实接法：把下方 adapter 替换为 Capacitor BLE 插件(如 @capacitor-community/bluetooth-le)：
  //   1) init():      await BluetoothLE.initialize({}) 并返回 {available:true, name}
  //   2) scan():      await BluetoothLE.requestLEScan({services}) → 收集发现的 device
  //   3) connect():   await BluetoothLE.connect({deviceId}) → 建立 GATT
  //   4) onMessage(): BluetoothLE.addListener('characteristicValueChanged', cb)
  //   5) send():      写 characteristic / writeRequest 发送 JSON
  //   6) close():     disconnect + stopLEScan
  // 未装插件时 available=false，simulate 提供一条"模拟链路"(复用本机内存事件)跑通流程。
  function createBluetoothBackend() {
    // --- 可替换适配器插槽（TODO 真机时整体换成 Capacitor BLE adapter）---
    const adapter = {
      name: 'BLE(占位)',
      async init() {
        // TODO(真机): return { available: true, name: ... } 若 Capacitor 已装蓝牙插件
        return { available: false, name: this.name };
      },
      async scan() { throw new Error('BLE adapter 未接（占位）'); },
      async connect(deviceId) { throw new Error('BLE adapter 未接（占位）'); },
      onMessage(cb) { /* TODO: characteristicValueChanged 订阅 */ },
      send(data) { /* TODO: 写 GATT characteristic */ },
      close() {},
    };

    let st = { connected: false, host: false, simulating: false };
    // 模拟链路：无插件时用一个独立 BroadcastChannel 频道取代蓝牙链路，UI/协议可先联调
    let sim = null;
    function ensureSim() {
      if (sim) return sim;
      try { sim = new BroadcastChannel('chordbuddy-ble'); }
      catch (e) { sim = null; }
      if (sim) sim.onmessage = (ev) => { const m = ev.data; if (m && m.src !== id && m.key) applyRemoteKey(m.key); };
      return sim;
    }
    function broadcastKey(k) { const s = ensureSim(); if (s) s.postMessage({ src: id, key: k }); }

    return {
      kind: 'bluetooth',
      available: false,  // 由 init() 在 start 时刷新
      simulate: true,    // 占位阶段走模拟链路
      async start(role) {
        const init = await adapter.init().catch(() => ({ available: false }));
        this.available = !!init.available;
        st = { connected: true, host: role === 'host', simulating: !this.available };
        const isSim = !this.available;
        // 先播报过程状态（给前端进度 UI）：扫描 → 配对 → 已连接
        emit('status', { phase: 'scan',    label: isSim ? '蓝牙（模拟）扫描中…' : '蓝牙扫描中…' });
        emit('status', { phase: 'pairing', label: isSim ? '蓝牙（模拟）配对中…' : '蓝牙配对中…' });
        await new Promise(res => setTimeout(res, 50)); // 占位：极短的扫描/配对节奏
        if (isSim) ensureSim();                        // 模拟链路接入
        // 本端切调 → 经蓝牙/模拟链路广播
        on('key', k => { if (this.available) adapter.send(k); else broadcastKey(k); });
        emit('status', { phase: 'connected', label: isSim ? '蓝牙（模拟）已连接' : '蓝牙已连接' });
        emit('state', { connected: true, host: role === 'host' });
        return true;
      },
      stop() {
        adapter.close();
        if (sim) { try { sim.close(); } catch (e) {} sim = null; }
        st.connected = false; st.host = false;
        emit('state', { connected: false, host: false });
      },
    };
  }

  // ---------- 传输工厂 ----------
  // kind: 'local' | 'webrtc' | 'bluetooth'；按可用性自动回退：
  //   pywebrtc 无 RTCPeerConnection → 回退 local
  //   蓝牙未接插件(占位) → 仍返回蓝牙后端(内部走模拟链路)
  function createTransport(kind) {
    kind = kind || 'local';
    if (kind === 'webrtc' && typeof RTCPeerConnection === 'undefined') kind = 'local';
    if (kind === 'bluetooth') return createBluetoothBackend();
    return kind === 'webrtc' ? createWebRTCBackend() : createLocalBackend();
  }

  hookLocalKey();

  // 暴露对外 API
  const ChordSync = { id, on, emit, applyRemoteKey, createTransport };
  window.ChordSync = ChordSync;
})();