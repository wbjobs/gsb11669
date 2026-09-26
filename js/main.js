/*
 * main.js — UI 装配：Worker RPC、特性检测、降级开关、跨 Worker 传播、
 * IndexedDB 持久化、Canvas 可视化、FPS 监测。
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TRAP_TYPES = TrapCore.TRAP_TYPES;

  // ---------- Worker RPC ----------
  let workerA = null, workerB = null, seq = 0;
  const pending = new Map();
  function makeWorker() {
    const w = new Worker('js/worker.js');
    w.onmessage = (ev) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); }
    };
    w.onerror = (e) => console.error('worker error', e);
    return w;
  }
  function rpc(worker, msg) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg));
    });
  }

  // ---------- 状态 ----------
  const latestByType = {};   // type -> report
  let currentReport = null;
  let features = null;

  // ---------- 特性检测 ----------
  async function initFeatures() {
    features = TrapCore.detectFeatures();
    let workerFeatures = null;
    try {
      workerA = makeWorker();
      workerB = makeWorker();
      workerFeatures = (await rpc(workerA, { cmd: 'features' })).features;
    } catch (e) {
      log('Worker 启动失败（file:// 下浏览器会拦截 Worker，请用 http 服务打开）：' + e.message);
    }
    const wf = workerFeatures || {};
    setBadge('feat-wasm', features.wasm, 'WebAssembly');
    setBadge('feat-eh', features.ehProposal, '异常处理提案 (EH)');
    setBadge('feat-stack', features.stackTraces, 'wasm 栈回溯');
    setBadge('feat-worker-stack', wf.stackTraces, 'Worker 栈回溯');
    setBadge('feat-srcmap', true, '源码映射(内置合成)');
    if (!features.ehProposal) {
      log('当前引擎不支持异常处理提案：wasm 内部无 try/catch，trap 只能穿透到 JS 捕获（本演示正是如此）。');
    }
  }
  function setBadge(id, ok, label) {
    const el = $(id);
    el.textContent = (ok ? '✓ ' : '✗ ') + label;
    el.className = 'badge ' + (ok ? 'ok' : 'bad');
  }

  // ---------- 选项 ----------
  function currentOpts() {
    return {
      stripSourceMap: $('opt-no-srcmap').checked,   // 模拟源码映射缺失
      stripStack: $('opt-no-stack').checked,        // 模拟栈回溯缺失
    };
  }
  function useJsFallback() { return $('opt-js-fallback').checked; } // 模拟无 EH/wasm，JS 模拟 trap
  function runOnMain() { return $('opt-main-thread').checked; }

  // ---------- 执行 trap ----------
  async function runTrap(type) {
    const opts = currentOpts();
    let report;
    if (runOnMain()) {
      report = useJsFallback()
        ? TrapCore.runJsSimulatedTrap(type, opts)
        : TrapCore.runWasmTrap(type, opts);
      report.ranIn = 'main';
    } else {
      const res = await rpc(workerA, { cmd: 'run', type, mode: useJsFallback() ? 'js' : 'wasm', opts });
      report = res.report;
      report.ranIn = 'worker-a';
    }

    // 跨 Worker 传播：worker A -> 主线程 -> worker B
    if ($('opt-propagate').checked) {
      const res = await rpc(workerB, { cmd: 'propagate', report, hopName: 'worker-b' });
      report = res.report;
      report.propagated = true;
    }

    latestByType[type] = report;
    currentReport = report;
    await TrapDB.addReport(report);
    renderReport(report);
    refreshViz();
    return report;
  }

  async function runAll() {
    for (const t of Object.keys(TRAP_TYPES)) {
      await runTrap(t); // 串行，保证时间线有序
    }
    log('四类 trap 对比完成。');
  }

  // ---------- Error 结构化克隆探测 ----------
  async function checkErrorClone() {
    try {
      const err = new WebAssembly.RuntimeError('clone probe');
      const res = await rpc(workerB, { cmd: 'clone-check', error: err });
      log(`Error 结构化克隆: ${res.cloneOk ? '支持' : '不支持'} (name=${res.name}, message=${res.message})`);
    } catch (e) {
      log('Error 结构化克隆失败: ' + e.message);
    }
  }

  // ---------- 渲染 ----------
  function renderReport(r) {
    const el = $('report');
    const lines = [];
    lines.push(`【${r.label}】${r.simulated ? '（JS 模拟降级）' : ''} 运行于 ${r.ranIn || '?'}`);
    lines.push(`捕获: ${r.caught ? '是' : '否'}   错误类型: ${r.errorName}   耗时: ${r.durationMs}ms`);
    lines.push(`消息: ${r.message}`);
    if (r.framesParsed && r.frames.length) {
      lines.push(`栈回溯 (${r.frames.length} 帧):`);
      r.frames.slice(0, 8).forEach((f, i) => {
        const src = f.source ? `  → ${f.source.file}:${f.source.line}` : (r.sourceMapped === false ? '  → (无源码映射)' : '');
        lines.push(`  #${i} func[${f.funcIndex}] ${f.funcName || '?'} @ ${f.offsetHex}${src}`);
      });
      if (r.frames.length > 8) lines.push(`  … 共 ${r.frames.length} 帧`);
    } else {
      lines.push('栈回溯: 不可用（引擎未提供 / 已模拟禁用）— 降级为错误名+消息');
    }
    if (r.instanceState && Object.keys(r.instanceState).length) {
      const s = r.instanceState;
      lines.push(`实例状态: mem[0] ${s.mem0Before} → ${s.mem0After}` +
        (s.partialWritePersisted !== undefined ? ` (trap 前部分写入${s.partialWritePersisted ? '已保留' : '未保留'})` : '') +
        (s.reusable !== undefined ? `, 实例可继续调用: ${s.reusable}` : ''));
      lines.push('注: trap 不可恢复——执行在 trap 点中止，无法从断点续跑；已产生的内存副作用保留，实例本身未损坏。');
    }
    if (r.hops && r.hops.length) {
      lines.push('传播链: main → worker-a → ' + r.hops.map((h) =>
        `${h.hop}(捕获:${h.caught ? '✓' : '✗'} 类型保留:${h.preserved ? '✓' : '✗'})`).join(' → '));
    }
    el.textContent = lines.join('\n');
  }

  async function refreshViz() {
    TrapViz.drawComparison($('cmp-canvas'), latestByType, TRAP_TYPES);
    TrapViz.drawStackWaterfall($('stack-canvas'), currentReport);
    const all = await TrapDB.getReports();
    TrapViz.drawTimeline($('timeline-canvas'), all);
    renderHistory(all);
  }
  function renderHistory(all) {
    const el = $('history');
    el.innerHTML = '';
    all.slice(-12).reverse().forEach((r) => {
      const li = document.createElement('li');
      li.textContent = `${new Date(r.timestamp).toLocaleTimeString()}  ${r.label}${r.simulated ? ' [JS模拟]' : ''}  ${r.errorName}: ${r.message}`;
      el.appendChild(li);
    });
  }
  function log(msg) {
    const el = $('log');
    el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
  }

  // ---------- FPS 计（证明主线程不卡） ----------
  function startFps() {
    let frames = 0, last = performance.now();
    (function loop() {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        $('fps').textContent = `主线程 FPS: ${frames}`;
        frames = 0; last = now;
      }
      requestAnimationFrame(loop);
    })();
  }

  // ---------- 事件绑定 ----------
  function bind() {
    document.querySelectorAll('[data-trap]').forEach((btn) => {
      btn.addEventListener('click', () => runTrap(btn.dataset.trap).catch((e) => log('运行失败: ' + e.message)));
    });
    $('btn-all').addEventListener('click', () => runAll().catch((e) => log(e.message)));
    $('btn-clone').addEventListener('click', checkErrorClone);
    $('btn-clear').addEventListener('click', async () => { await TrapDB.clear(); refreshViz(); });
    window.addEventListener('resize', refreshViz);
  }

  bind();
  initFeatures().then(refreshViz);
  startFps();
})();
