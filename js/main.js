// main.js — 主线程编排：UI、Worker 通信、IndexedDB 持久化、Canvas 渲染
// 所有 wasm trap 触发都在 Worker 中执行，主线程只渲染，保证页面不卡。

import { saveReport, listReports, clearReports } from './db.js';
import { drawMemory, drawCallStack, drawComparison, drawTimeline, CATEGORY_COLOR } from './viz.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  worker: null,
  features: null,
  generation: 0,
  latestByTrapId: {}, // trapId -> 最新报告（用于对比视图）
  currentReport: null,
  history: [],
  view: 'memory',
  busy: false,
};

// ---------- Worker ----------
function initWorker() {
  state.worker = new Worker('./js/worker.js', { type: 'module' });
  state.worker.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      state.features = msg.features;
      state.generation = msg.generation;
      renderFeatures();
      log(`Worker 就绪，wasm 实例 #${msg.generation}`);
    } else if (msg.type === 'report') {
      await onReport(msg.report);
    } else if (msg.type === 'done') {
      state.busy = false;
      updateButtons();
      refreshView();
    } else if (msg.type === 'reinstantiated') {
      state.generation = msg.generation;
      log(`已重新实例化，当前实例 #${msg.generation}（旧实例的 trap 历史不影响新实例）`);
      renderFeatures();
    } else if (msg.type === 'fatal') {
      log('Worker 初始化失败: ' + msg.error, 'err');
    }
  };
  state.worker.postMessage({ type: 'init' });
}

function runTraps(trapIds) {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  const options = {
    simulateJs: $('#opt-simulate').checked,
    noSourceMap: $('#opt-nosourcemap').checked,
  };
  state.worker.postMessage({ type: 'run', trapIds, options });
}

// ---------- 报告处理 ----------
async function onReport(report) {
  state.currentReport = report;
  if (report.trapId) state.latestByTrapId[report.trapId] = report;
  // 跨 Worker 传播落点：Worker 内捕获的 trap 以纯数据形式到达主线程
  try {
    await saveReport(report);
    state.history = await listReports();
  } catch (e) {
    log('IndexedDB 保存失败: ' + e, 'err');
  }
  renderReport(report);
  refreshView();
}

function renderReport(r) {
  const el = $('#report-detail');
  if (r.error) {
    el.innerHTML = `<div class="err">${escapeHtml(r.error)}</div>`;
    return;
  }
  const color = CATEGORY_COLOR[r.category] || '#888';
  const frameRows = r.frames.map((f, i) => `
    <tr>
      <td>#${i}</td>
      <td>${escapeHtml(f.funcName || '<匿名>')}</td>
      <td>${f.funcIndex}</td>
      <td>${f.offsetHex}</td>
      <td>${f.source ? `WAT 第 ${f.source.watLine} 行 <code>${escapeHtml(f.source.watText)}</code>`
                     : (r.sourceMapAvailable ? '—' : '<span class="warn">源码映射不可用</span>')}</td>
    </tr>`).join('');
  const st = r.instanceState || {};
  el.innerHTML = `
    <div class="report-head" style="border-color:${color}">
      <span class="badge" style="background:${color}">${escapeHtml(r.title || r.categoryLabel)}</span>
      <code>${escapeHtml(r.call || '')}</code>
      ${r.simulated ? '<span class="badge warn-bg">JS 模拟</span>' : ''}
    </div>
    <table class="kv">
      <tr><td>错误类型</td><td><code>${escapeHtml(r.errorName)}</code></td></tr>
      <tr><td>trap 消息</td><td>${escapeHtml(r.message)}</td></tr>
      <tr><td>分类</td><td>${escapeHtml(r.categoryLabel)}（${r.category}）</td></tr>
      <tr><td>wasm 栈帧</td><td>${r.hasWasmFrames ? `${r.frameCount} 帧` : '<span class="warn">缺失（引擎不提供）</span>'}</td></tr>
      <tr><td>源码映射</td><td>${r.sourceMapAvailable ? '可用' : '<span class="warn">不可用（已降级为原始偏移）</span>'}</td></tr>
      <tr><td>可恢复</td><td><span class="warn">否 —— wasm 执行在 trap 点中止，无法从 trap 点继续</span></td></tr>
      <tr><td>实例状态</td><td>${st.alive === null || st.alive === undefined
          ? escapeHtml(st.note || '—')
          : `存活=${st.alive}，内存保持=${st.memoryPreserved}，导出可调用=${st.exportsCallable}，实例 #${st.generation}`}</td></tr>
      <tr><td>传播路径</td><td>${escapeHtml(r.propagation || '')}</td></tr>
    </table>
    ${r.hasWasmFrames ? `<table class="frames">
      <thead><tr><th>帧</th><th>函数名</th><th>函数索引</th><th>偏移</th><th>源码映射</th></tr></thead>
      <tbody>${frameRows}</tbody></table>` : ''}
    <details><summary>原始 stack 文本</summary><pre>${escapeHtml(r.rawStack)}</pre></details>
  `;
}

// ---------- 视图 ----------
function refreshView() {
  const canvas = $('#viz');
  switch (state.view) {
    case 'memory': drawMemory(canvas, state.currentReport); break;
    case 'callstack': drawCallStack(canvas, state.currentReport); break;
    case 'compare': drawComparison(canvas, state.latestByTrapId); break;
    case 'timeline': drawTimeline(canvas, state.history); break;
  }
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === state.view));
}

function renderFeatures() {
  const f = state.features || {};
  const items = [
    ['WebAssembly', f.wasm],
    ['异常处理提案 (Tag/Exception)', f.ehProposal],
    ['wasm 栈回溯', f.wasmStackTrace],
    ['name section 函数名', f.nameSection],
    ['流式编译', f.streaming],
  ];
  $('#features').innerHTML = items
    .map(([label, ok]) =>
      `<span class="feat ${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${label}</span>`)
    .join('') + `<span class="feat">实例 #${state.generation}</span>`;
}

// ---------- 日志 ----------
function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  line.className = 'log-line ' + cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.children.length > 60) el.lastChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateButtons() {
  document.querySelectorAll('button[data-trap], #btn-run-all').forEach((b) => {
    b.disabled = state.busy;
  });
}

// ---------- 启动 ----------
async function boot() {
  initWorker();
  try {
    state.history = await listReports();
  } catch (e) {
    log('IndexedDB 不可用: ' + e, 'err');
  }

  document.querySelectorAll('button[data-trap]').forEach((b) => {
    b.addEventListener('click', () => runTraps([b.dataset.trap]));
  });
  $('#btn-run-all').addEventListener('click', () =>
    runTraps(['oob', 'divzero', 'divoverflow', 'badconvert', 'stackoverflow']));
  $('#btn-reinstantiate').addEventListener('click', () =>
    state.worker.postMessage({ type: 'reinstantiate' }));
  $('#btn-clear-history').addEventListener('click', async () => {
    await clearReports();
    state.history = [];
    state.latestByTrapId = {};
    log('历史已清空');
    refreshView();
  });
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => { state.view = t.dataset.view; refreshView(); });
  });

  // 主线程活性指示：证明 trap 期间主线程不被阻塞
  setInterval(() => {
    $('#heartbeat').textContent = '主线程心跳 ' + new Date().toLocaleTimeString();
  }, 500);

  refreshView();
}

boot();
