/*
 * trap-core.js — trap 触发 / 捕获 / 栈解析 / 源码映射 / JS 降级模拟。
 * 共享于主线程、Worker 与 Node 测试。
 */
(function (global) {
  'use strict';

  const TRAP_TYPES = {
    oob: {
      exportName: 'run_oob', label: '越界访问 (OOB)',
      expectName: 'RuntimeError', expectMsg: /out of bounds/i,
      desc: 'i32.load 访问 0x10000，超出 1 页内存 (0..0xFFFF)',
    },
    div: {
      exportName: 'run_div', label: '除零 (div by zero)',
      expectName: 'RuntimeError', expectMsg: /divide by zero/i,
      desc: 'i32.div_s 1 / 0，整数除零立即 trap',
    },
    cvt: {
      exportName: 'run_cvt', label: '非法转换 (bad convert)',
      expectName: 'RuntimeError', expectMsg: /unrepresentable|invalid conversion/i,
      desc: 'i32.trunc_f64_s 截断 NaN，浮点不可表示为整数',
    },
    rec: {
      exportName: 'run_rec', label: '栈溢出 (stack overflow)',
      expectName: 'RangeError', expectMsg: /call stack|stack/i,
      desc: 'leaf_rec 无限自递归，耗尽调用栈',
    },
  };

  // ---------- 特性检测 ----------
  function detectFeatures() {
    const f = {
      wasm: typeof WebAssembly === 'object',
      ehProposal: false,   // 异常处理提案（wasm 内部 try/catch）
      stackTraces: false,  // 引擎是否给出 wasm 栈回溯
      errorClone: false,   // postMessage 能否结构化克隆 Error
    };
    if (!f.wasm) return f;
    f.ehProposal = typeof WebAssembly.Tag === 'function' &&
                   typeof WebAssembly.Exception === 'function';
    try {
      const { bytes } = global.WasmGen.build();
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
      try { inst.exports.run_oob(); } catch (e) {
        f.stackTraces = /wasm-function\[\d+\]/.test(e.stack || '');
      }
    } catch (_) { /* ignore */ }
    return f;
  }

  // ---------- 栈解析 ----------
  // V8:    at leaf_oob (wasm://wasm/160e4a56:wasm-function[0]:0x7f)
  // 兼容:  wasm-function[3]:0x93  / 裸 <WASM>[idx]+0xoff 等变体
  function parseWasmStack(stack) {
    const frames = [];
    if (!stack) return frames;
    for (const line of String(stack).split('\n')) {
      const m = line.match(/wasm-function\[(\d+)\]:0x([0-9a-f]+)/i);
      if (m) {
        let funcName = null;
        const nm = line.match(/^\s*at\s+([$\w]+)\s*\(/);
        if (nm && nm[1] !== 'wasm-function') funcName = nm[1];
        frames.push({
          raw: line.trim(),
          funcIndex: parseInt(m[1], 10),
          offset: parseInt(m[2], 16),
          offsetHex: '0x' + m[2],
          funcName,
          source: null, // 由 applySourceMap 填充
        });
      }
    }
    return frames;
  }

  // ---------- 源码映射 ----------
  // lookup 限定在帧自身的函数内：偏移 < 首条指令时钳到首条（V8 首帧可能指向 locals 字节）
  function applySourceMap(frames, funcMeta) {
    for (const fr of frames) {
      const meta = funcMeta[fr.funcIndex];
      if (!meta) continue;
      if (!fr.funcName) fr.funcName = meta.name;
      let hit = null;
      for (const ins of meta.instrs) {
        if (ins.offset <= fr.offset) hit = ins; else break;
      }
      if (!hit && meta.instrs.length) hit = meta.instrs[0];
      if (hit) fr.source = { file: 'trap_demo.wat', line: hit.watLine + 1, column: 0 };
    }
    return frames;
  }

  // ---------- 在 wasm 中触发并捕获 ----------
  function runWasmTrap(type, opts) {
    const cfg = TRAP_TYPES[type];
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const report = {
      kind: 'trap-report', type, label: cfg.label, desc: cfg.desc,
      simulated: false, caught: false, errorName: null, message: null,
      rawStack: null, frames: [], framesParsed: false,
      instanceState: {}, timestamp: Date.now(), durationMs: 0,
    };
    const { bytes, funcMeta } = global.WasmGen.build();
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    const ex = inst.exports;
    const mem0 = () => new DataView(ex.memory.buffer).getInt32(0, true);

    if (type === 'oob') {
      // 先跑 run_oob 拿到 leaf/mid/run 三级调用链栈回溯
      try { ex.run_oob(); } catch (e) { fillCaught(report, e, cfg); }
      // 再用 write_then_trap 演示 trap 前部分写入是否保留（同一实例）
      report.instanceState.mem0Before = mem0();
      try {
        ex.write_then_trap();
      } catch (e) {
        // 状态探测的第二次 trap，不覆盖报告主栈
      }
      report.instanceState.mem0After = mem0();
      report.instanceState.partialWritePersisted = report.instanceState.mem0After === 42;
    } else {
      try { ex[cfg.exportName](); } catch (e) { fillCaught(report, e, cfg); }
    }

    // trap 后实例是否仍可调用（trap 只终止当前执行，不损坏实例）
    try {
      ex.read_mem0();
      report.instanceState.reusable = true;
    } catch (_) {
      report.instanceState.reusable = false;
    }

    report.frames = parseWasmStack(report.rawStack);
    report.framesParsed = report.frames.length > 0;
    if (!opts || !opts.stripSourceMap) {
      applySourceMap(report.frames, funcMeta);
      report.sourceMapped = true;
    } else {
      report.sourceMapped = false;
    }
    if (opts && opts.stripStack) {
      report.rawStack = null;
      report.frames = [];
      report.framesParsed = false;
    }
    report.durationMs = +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2));
    return report;
  }

  function fillCaught(report, e, cfg) {
    report.caught = true;
    report.errorName = (e && e.constructor && e.constructor.name) || 'Error';
    report.message = e && e.message;
    report.rawStack = e && e.stack;
    report.expectMatch = report.errorName === cfg.expectName && cfg.expectMsg.test(report.message || '');
  }

  // ---------- JS 降级模拟（无 wasm / 无 EH 提案时） ----------
  // 用纯 JS 复现四类 trap 的可观察行为：同名错误类型 + 伪造的 wasm 风格栈帧
  function runJsSimulatedTrap(type, opts) {
    const cfg = TRAP_TYPES[type];
    const report = {
      kind: 'trap-report', type, label: cfg.label + ' [JS 模拟]', desc: cfg.desc,
      simulated: true, caught: false, errorName: null, message: null,
      rawStack: null, frames: [], framesParsed: false,
      instanceState: {}, timestamp: Date.now(), durationMs: 0,
    };
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mem = new Int32Array(16384); // 1 页
    report.instanceState.mem0Before = mem[0];
    try {
      if (type === 'oob') {
        mem[0] = 42; // 部分写入
        const addr = 0x10000;
        if (addr >= mem.byteLength) throwSim('RuntimeError', 'memory access out of bounds');
      } else if (type === 'div') {
        const d = 0;
        if (d === 0) throwSim('RuntimeError', 'divide by zero');
      } else if (type === 'cvt') {
        const v = NaN;
        if (!Number.isFinite(v)) throwSim('RuntimeError', 'float unrepresentable in integer range');
      } else {
        (function recur() { return recur(); })();
      }
    } catch (e) {
      fillCaught(report, e, cfg);
    }
    report.instanceState.mem0After = mem[0];
    report.instanceState.partialWritePersisted = type !== 'oob' ? undefined : mem[0] === 42;
    report.instanceState.reusable = true; // JS 模拟天然可重入
    report.frames = parseWasmStack(report.rawStack);
    report.framesParsed = report.frames.length > 0;
    if (!opts || !opts.stripSourceMap) {
      const { funcMeta } = global.WasmGen.build();
      applySourceMap(report.frames, funcMeta);
      report.sourceMapped = true;
    } else {
      report.sourceMapped = false;
    }
    report.durationMs = +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2));
    return report;
  }

  function throwSim(name, msg) {
    let e;
    if (name === 'RuntimeError' && typeof WebAssembly === 'object' && WebAssembly.RuntimeError) {
      e = new WebAssembly.RuntimeError(msg);
    } else if (name === 'RangeError') {
      e = new RangeError(msg);
    } else {
      e = new Error(msg); e.name = name;
    }
    throw e;
  }

  // ---------- 跨 Worker 传播 ----------
  // 把报告里的错误重新物化、抛出、再捕获，追加一跳传播记录
  function propagateTrap(report, hopName) {
    const err = throwSimCapture(report.errorName, report.message);
    const hop = {
      hop: hopName, caught: true,
      errorName: err.name, message: err.message,
      preserved: err.name === report.errorName && err.message === report.message,
      at: Date.now(),
    };
    const out = Object.assign({}, report);
    out.hops = (report.hops || []).concat([hop]);
    return out;
  }
  function throwSimCapture(name, msg) {
    try { throwSim(name, msg); } catch (e) { return e; }
    return new Error('unreachable');
  }

  const api = {
    TRAP_TYPES, detectFeatures, parseWasmStack, applySourceMap,
    runWasmTrap, runJsSimulatedTrap, propagateTrap,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TrapCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
