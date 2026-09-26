// worker.js — 在 Web Worker 中实例化 wasm、触发 trap、归一化后回传主线程。
// 跨 Worker 传播说明：Error 对象经 postMessage 结构化克隆会丢失/改变栈信息，
// 因此这里在 Worker 内完成解析，把「纯数据报告」传给主线程 —— 这是可靠的跨线程 trap 传播方式。

import { buildModule } from './wasm-module.js';
import { TRAP_DEFS, normalizeTrap, detectFeatures } from './trap-core.js';

let instance = null;
let moduleBytes = null;
let sourceMap = null;
let meta = null;
let generation = 0; // 实例代数：重新实例化次数

const MEMORY_MAGIC = 0x5afe1234;

function instantiate() {
  const built = buildModule();
  moduleBytes = built.bytes;
  sourceMap = built.sourceMap;
  meta = built.meta;
  const mod = new WebAssembly.Module(moduleBytes);
  instance = new WebAssembly.Instance(mod);
  generation += 1;
  // 写入哨兵值，用于验证 trap 后内存状态保持
  instance.exports.mem_write(0, MEMORY_MAGIC);
  return generation;
}

function checkInstanceState() {
  // trap 后实例状态检查：内存是否保持、导出函数是否仍可调用
  try {
    const memOk = (instance.exports.mem_read(0) >>> 0) === (MEMORY_MAGIC >>> 0);
    const callable = instance.exports.safe_add(20, 22) === 42;
    return { alive: memOk && callable, memoryPreserved: memOk, exportsCallable: callable, generation };
  } catch (e) {
    return { alive: false, memoryPreserved: false, exportsCallable: false, generation, error: String(e) };
  }
}

function runTrap(def, options) {
  const { simulateJs = false, noSourceMap = false } = options;
  let report;
  if (simulateJs) {
    // 降级路径：JS 模拟 trap（无 wasm 环境或用户手动开启）
    try {
      def.simulate();
      report = { trapId: def.id, error: '模拟未抛出异常' };
    } catch (err) {
      report = normalizeTrap(err, {
        trapId: def.id,
        simulated: true,
        sourceMap,
        meta,
        noSourceMap,
        instanceState: { alive: null, note: 'JS 模拟模式，无 wasm 实例' },
      });
    }
  } else {
    try {
      def.invoke(instance.exports);
      report = { trapId: def.id, error: '未触发 trap（异常！）' };
    } catch (err) {
      const instanceState = checkInstanceState();
      report = normalizeTrap(err, {
        trapId: def.id,
        simulated: false,
        sourceMap,
        meta,
        noSourceMap,
        instanceState,
      });
    }
  }
  report.title = def.title;
  report.call = def.call;
  report.describe = def.describe;
  report.propagation = 'worker → main（postMessage 结构化克隆的纯数据报告）';
  return report;
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    try {
      instantiate();
      const features = detectFeatures();
      self.postMessage({ type: 'ready', features, generation });
    } catch (err) {
      self.postMessage({ type: 'fatal', error: String(err && err.stack || err) });
    }
    return;
  }
  if (msg.type === 'reinstantiate') {
    const gen = instantiate();
    self.postMessage({ type: 'reinstantiated', generation: gen });
    return;
  }
  if (msg.type === 'run') {
    const options = msg.options || {};
    for (const id of msg.trapIds) {
      const def = TRAP_DEFS.find((d) => d.id === id);
      if (!def) continue;
      let report;
      try {
        report = runTrap(def, options);
      } catch (err) {
        report = { trapId: id, error: '运行器自身异常: ' + String(err) };
      }
      self.postMessage({ type: 'report', report });
    }
    self.postMessage({ type: 'done' });
  }
};
