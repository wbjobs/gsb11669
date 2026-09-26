/*
 * worker.js — 在 Worker 中执行 wasm trap，避免阻塞主线程。
 * 协议: {id, cmd, ...} -> {id, cmd:'result', ...}
 */
importScripts('wasm-gen.js', 'trap-core.js');

const features = TrapCore.detectFeatures();

self.onmessage = function (ev) {
  const msg = ev.data;
  try {
    if (msg.cmd === 'features') {
      self.postMessage({ id: msg.id, cmd: 'result', features });
      return;
    }
    if (msg.cmd === 'run') {
      // mode: 'wasm' 真跑 wasm；'js' 降级 JS 模拟
      const report = msg.mode === 'js'
        ? TrapCore.runJsSimulatedTrap(msg.type, msg.opts)
        : TrapCore.runWasmTrap(msg.type, msg.opts);
      self.postMessage({ id: msg.id, cmd: 'result', report });
      return;
    }
    if (msg.cmd === 'propagate') {
      // 跨 Worker 传播：重建错误 -> 抛出 -> 捕获 -> 追加 hop
      const report = TrapCore.propagateTrap(msg.report, msg.hopName || 'worker');
      self.postMessage({ id: msg.id, cmd: 'result', report });
      return;
    }
    if (msg.cmd === 'clone-check') {
      // 验证 Error 能否经 postMessage 结构化克隆
      const e = msg.error;
      self.postMessage({
        id: msg.id, cmd: 'result',
        cloneOk: e instanceof Error, name: e && e.name, message: e && e.message,
      });
      return;
    }
    self.postMessage({ id: msg.id, cmd: 'result', error: 'unknown cmd: ' + msg.cmd });
  } catch (err) {
    self.postMessage({ id: msg.id, cmd: 'result', error: String(err && err.stack || err) });
  }
};
