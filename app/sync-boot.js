/* ChordBuddy 同步启动引导
 * 单机 App 打开即接通点对点调号同步通道：
 *  - 默认启用"本机通道"(BroadcastChannel)：同一个网页/多窗口间即时同步调号，用于开发自测。
 *  - WebRTC 入口：真机局域网两两连接。先复制 host 连接码发给对方，再粘贴对方 answer。
 * 进入方式：页面右下角 "♩ 同步" 圆点。
 */
(function(){
  'use strict';
  const SC = window.ChordSync || (window.ChordSync = {});
  const $ = sel => document.querySelector('#' + sel);
  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<style>' +
    '#__cbsync{position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:13px/1.4 -apple-system,"PingFang SC",sans-serif}' +
    '#__cbsync .dot{width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;background:#0FA578;color:#fff;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,.25)}' +
    '#__cbsync .panel{width:230px;background:#fff;border:1px solid #e2e8e6;border-radius:12px;padding:12px;box-shadow:0 4px 18px rgba(0,0,0,.12);display:none}' +
    '#__cbsync .panel.open{display:block}' +
    '#__cbsync .row{display:flex;align-items:center;gap:6px;margin:6px 0}' +
    '#__cbsync .lbl{color:#5a6b66;font-size:12px}' +
    '#__cbsync .st{flex:1;font-weight:600;color:#1c2b27}' +
    '#__cbsync .btn{flex:1;padding:6px 8px;border:1px solid #c7d5d0;border-radius:8px;background:#f4faf7;color:#0c5a44;cursor:pointer}' +
    '#__cbsync .btn.primary{background:#0FA578;border-color:#0FA578;color:#fff}' +
    '#__cbsync code{display:block;width:100%;height:52px;font-size:10px;word-break:break-all;border:1px dashed #c7d5d0;border-radius:6px;padding:4px;background:#f7faf9}' +
    '</style>' +
    '<div class="panel" id="__cbsyncPanel">' +
      '<div class="row"><span class="lbl">点对点同步</span><span class="st" id="__cbsyncSt">本机通道</span></div>' +
      '<div class="row"><span class="lbl">当前调</span><span class="st" id="__cbsyncKey">—</span></div>' +
      '<div class="row"><span class="lbl">传输方式</span>' +
        '<select id="__cbsyncMode" style="flex:1;padding:5px 6px;border:1px solid #c7d5d0;border-radius:8px;background:#f4faf7;color:#0c5a44;font:12px sans-serif">' +
          '<option value="local">本机通道（自测）</option>' +
          '<option value="webrtc">局域网（WebRTC）</option>' +
          '<option value="bluetooth">蓝牙（BLE 占位）</option>' +
        '</select>' +
      '</div>' +
      '<div class="row"><span class="lbl" id="__cbsyncPhase">—</span><span class="st" id="__cbsyncStatus">—</span></div>' +
      '<div class="row" id="__cbsyncCtrl">' +
        '<button class="btn" id="__cbsyncStartConnect">开始同步</button>' +
        '<button class="btn" id="__cbsyncStopConnect">断开</button>' +
      '</div>' +
      '<div class="row"><button class="btn" id="__cbsyncHost">生成连接码（webRTC）</button></div>' +
      '<textarea id="__cbsyncCode" placeholder="粘贴对方连接码"></textarea>' +
      '<div class="row"><button class="btn" id="__cbsyncJoin">连接真机</button></div>' +
      '<div class="row" style="margin-top:2px"><span class="lbl">本机通道默认开启；局域网/蓝牙选占位或真机</span></div>' +
    '</div>' +
    '<button class="dot" id="__cbsyncOpen">♩</button>';
  wrap.id = 'cbSyncRoot';
  document.body.appendChild(wrap.firstChild); // style
  document.body.appendChild(wrap);

  const panel = $('__cbsyncPanel');
  const st = $('__cbsyncSt');
  const keyEl = $('__cbsyncKey');
  const codeEl = $('__cbsyncCode');
  const api = window.__cbApi || null;

  let backend = null;
  let hosting = true;

  function refreshKey(){ if (api) keyEl.textContent = api.getKey(); }
  if (api && api.onKeyChanged) api.onKeyChanged(refreshKey);
  refreshKey();

  // 启动本机通道(BroadcastChannel)
  let session = null; // 当前主动建立的会话(局域网/蓝牙)
  const phaseEl = $('__cbsyncPhase');
  const statusEl = $('__cbsyncStatus');
  SC.on('status', s => { if (s && s.phase) { phaseEl.textContent = s.label || s.phase; } });

  function stopSession() {
    if (session) { try { session.stop(); } catch (e) {} session = null; }
    statusEl.textContent = '—';
    phaseEl.textContent = '—';
    st.textContent = '本机通道';
  }
  $('__cbsyncStopConnect').addEventListener('click', stopSession);

  $('__cbsyncStartConnect').addEventListener('click', async () => {
    const mode = $('__cbsyncMode').value;
    stopSession();
    if (mode === 'local') {
      backend = SC.createTransport('local');
      try { backend.start('host'); } catch (e) {}
      st.textContent = '本机通道';
      statusEl.textContent = '开';
      phaseEl.textContent = '多窗口即时同步';
      return;
    }
    try {
      session = SC.createTransport(mode);          // 'webrtc' | 'bluetooth'
      // 蓝牙占位会自动播报 scan/pairing/connected 状态
      await session.start('host');
      st.textContent = session.kind === 'bluetooth' ? '蓝牙·' + (session.available ? '真机' : '模拟') : '局域网 (WebRTC)';
      statusEl.textContent = '已连接';
    } catch (e) {
      statusEl.textContent = '失败';
      phaseEl.textContent = String(e && e.message || e);
    }
  });

  // WebRTC 真机局域网
  let webrtc = null;
  $('__cbsyncOpen').addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    if (!open && webrtc) { webrtc.stop(); webrtc = null; st.textContent = '本机通道'; }
  });

  $('__cbsyncHost').addEventListener('click', async () => {
    if (typeof RTCPeerConnection === 'undefined') { codeEl.value = '当前环境不支持 WebRTC，请用 Chromium 或真机浏览器'; return; }
    if (!webrtc) { webrtc = SC.createTransport('webrtc'); await webrtc.start('host'); }
    const code = await webrtc.hostCode();
    codeEl.value = 'HOST:' + code;
    st.textContent = '等待对方粘贴 answer…';
    webrtc._accept = (answer) => webrtc.accept(answer);
  });

  $('__cbsyncJoin').addEventListener('click', async () => {
    if (typeof RTCPeerConnection === 'undefined') { codeEl.value = '当前环境不支持 WebRTC'; return; }
    if (!webrtc) { webrtc = SC.createTransport('webrtc'); await webrtc.start('peer'); }
    const raw = (codeEl.value || '').trim();
    const j = raw.startsWith('HOST:') ? raw.slice(5) : raw;
    const ans = await webrtc.connect(j);
    if (ans) { codeEl.value = 'ANSWER:' + ans; st.textContent = '把此回执粘给对方'; webrtc._answer = ans; }
  });

  // 本地调号变化即广播(由 conn 内部处理)，此处无需额外动作
})();