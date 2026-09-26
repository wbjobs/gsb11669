// trap-core.js — trap 定义、栈回溯解析、trap 归一化、JS 模拟降级
// 同时被 Web Worker、主线程和 Node 测试使用（纯 ES module，无环境依赖）。

import { buildModule, resolveOffset } from './wasm-module.js';

// ---------- trap 用例定义 ----------
// invoke: 在真实 wasm 实例上触发；simulate: 无 wasm 时的 JS 降级模拟。
export const TRAP_DEFS = [
  {
    id: 'oob',
    title: '越界内存访问',
    call: 'wrapper_oob(0x1FFF0)',
    describe: 'i32.load 访问 0x1FFF0（页大小 64KiB），经 wrapper 间接调用以产生多帧栈',
    invoke: (e) => e.wrapper_oob(0x1fff0),
    simulate: () => {
      const mem = new Int32Array(16384); // 64KiB
      const addr = 0x1fff0;
      if (addr + 4 > mem.byteLength) {
        throw syntheticTrap('RuntimeError', 'memory access out of bounds', [
          ['oob_load', 0, 'i32_load'],
          ['wrapper_oob', 7, 'call'],
        ]);
      }
      return mem[addr >> 2];
    },
  },
  {
    id: 'divzero',
    title: '整数除零',
    call: 'div_zero(1, 0)',
    describe: 'i32.div_s 除数为 0',
    invoke: (e) => e.div_zero(1, 0),
    simulate: () => {
      const b = 0;
      if (b === 0) {
        throw syntheticTrap('RuntimeError', 'divide by zero', [['div_zero', 1, 'i32_div_s']]);
      }
      return 0;
    },
  },
  {
    id: 'divoverflow',
    title: '除法溢出 (INT_MIN / -1)',
    call: 'div_zero(-2147483648, -1)',
    describe: 'i32.div_s 结果不可表示（有符号溢出）',
    invoke: (e) => e.div_zero(-2147483648, -1),
    simulate: () => {
      throw syntheticTrap('RuntimeError', 'divide result unrepresentable', [
        ['div_zero', 1, 'i32_div_s'],
      ]);
    },
  },
  {
    id: 'badconvert',
    title: '非法浮点转整数',
    call: 'invalid_convert(NaN)',
    describe: 'i32.trunc_f32_s 对 NaN/Inf/超范围值截断',
    invoke: (e) => e.invalid_convert(NaN),
    simulate: () => {
      const x = NaN;
      if (!Number.isFinite(x) || x >= 2 ** 31 || x < -(2 ** 31)) {
        throw syntheticTrap('RuntimeError', 'float unrepresentable in integer range', [
          ['invalid_convert', 2, 'i32_trunc_f32_s'],
        ]);
      }
      return x | 0;
    },
  },
  {
    id: 'stackoverflow',
    title: '栈溢出（无限递归）',
    call: 'recurse(1)',
    describe: 'recurse 自递归直到引擎调用栈耗尽（RangeError，非 RuntimeError）',
    invoke: (e) => e.recurse(1),
    simulate: () => {
      const frames = [];
      for (let i = 0; i < 8; i++) frames.push(['recurse', 3, i === 0 ? 'local_get' : 'call']);
      throw syntheticTrap('RangeError', 'Maximum call stack size exceeded', frames);
    },
  },
];

// 生成一个「长得像 wasm trap」的合成错误，用于 JS 模拟降级路径。
// 栈文本伪造为 V8 wasm 格式，验证解析器与真实 trap 走同一条管线。
function syntheticTrap(name, message, frames) {
  const err = new Error(message);
  err.name = name;
  const lines = frames.map(
    ([fn, idx]) => `    at ${fn} (wasm://simulated:wasm-function[${idx}]:0x0)`
  );
  err.stack = `${name}: ${message}\n${lines.join('\n')}\n    at simulate (<js-sim>:1:1)`;
  err.__simulated = true;
  return err;
}

// ---------- 栈回溯解析 ----------
// 兼容 V8（Chrome/Node）：at fn (wasm://hash:wasm-function[3]:0xbb)
// 兼容 Firefox 风格：fn@...wasm-function[3]:0xbb 或裸 wasm-function[3]:0xbb
// 均不匹配时（如 JavaScriptCore 不含 wasm 帧）返回空 frames —— 走「栈回溯缺失」降级。
const V8_FRAME_RE =
  /at\s+(?:([\w$.]+)\s+)?\(?wasm:\/\/[^\s)]+:wasm-function\[(\d+)\]:0x([0-9a-f]+)\)?/g;
const LOOSE_FRAME_RE =
  /(?:([\w$.]+)[@ ].*)?wasm-function\[(\d+)\]:0x([0-9a-f]+)/g;

export function parseWasmStack(stack) {
  const frames = [];
  if (!stack || typeof stack !== 'string') return { frames, hasWasmFrames: false };
  let m;
  V8_FRAME_RE.lastIndex = 0;
  while ((m = V8_FRAME_RE.exec(stack)) !== null) {
    frames.push({
      funcName: m[1] || null,
      funcIndex: Number(m[2]),
      offset: parseInt(m[3], 16),
      offsetHex: '0x' + m[3],
    });
  }
  if (frames.length === 0) {
    LOOSE_FRAME_RE.lastIndex = 0;
    while ((m = LOOSE_FRAME_RE.exec(stack)) !== null) {
      frames.push({
        funcName: m[1] || null,
        funcIndex: Number(m[2]),
        offset: parseInt(m[3], 16),
        offsetHex: '0x' + m[3],
      });
    }
  }
  return { frames, hasWasmFrames: frames.length > 0 };
}

// ---------- trap 分类 ----------
export function classifyTrap(message) {
  const msg = String(message || '');
  if (/out of bounds/i.test(msg)) return 'out_of_bounds';
  if (/divide by zero|division by zero/i.test(msg)) return 'divide_by_zero';
  if (/divide result unrepresentable|integer overflow/i.test(msg)) return 'integer_overflow';
  if (/float unrepresentable|invalid conversion|not a finite|cannot convert/i.test(msg))
    return 'invalid_conversion';
  if (/maximum call stack|too much recursion|stack overflow|call stack size/i.test(msg))
    return 'stack_overflow';
  return 'unknown';
}

export const CATEGORY_LABEL = {
  out_of_bounds: '越界访问',
  divide_by_zero: '除零',
  integer_overflow: '整数溢出',
  invalid_conversion: '非法转换',
  stack_overflow: '栈溢出',
  unknown: '未知',
};

// ---------- 归一化 ----------
// 把任意引擎的 trap 错误归一化为统一报告结构（可结构化克隆、可存 IndexedDB）。
// options: { trapId, simulated, sourceMap, meta, noSourceMap, instanceState }
export function normalizeTrap(err, options = {}) {
  const { trapId, simulated = false, sourceMap = null, meta = null, noSourceMap = false } = options;
  const parsed = parseWasmStack(err && err.stack);
  const category = classifyTrap(err && err.message);

  // 源码映射解析：把引擎报告的模块内偏移换算为 code 偏移后查表。
  // V8 报告的是「指令内位置」（指令起始+1），resolveOffset 取不大于它的最近指令。
  const sourceMapAvailable = !!sourceMap && !!meta && !noSourceMap;
  const frames = parsed.frames.map((f) => {
    const frame = { ...f, source: null };
    if (sourceMapAvailable) {
      const codeOffset = f.offset - meta.codePayloadStart;
      frame.source = resolveOffset(sourceMap, f.funcIndex, codeOffset);
    }
    return frame;
  });

  return {
    trapId: trapId || null,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    errorName: (err && err.name) || 'Error',
    message: (err && err.message) || String(err),
    rawStack: (err && err.stack) || '',
    frames,
    frameCount: frames.length,
    hasWasmFrames: parsed.hasWasmFrames,
    sourceMapAvailable,
    simulated,
    // trap 不可恢复：wasm 执行在 trap 点中止并展开到 JS，无法从 trap 点继续
    resumable: false,
    instanceState: options.instanceState || null,
    timestamp: Date.now(),
  };
}

// ---------- 特性探测 ----------
export function detectFeatures() {
  const f = {
    wasm: typeof WebAssembly === 'object',
    ehProposal: false, // 异常处理提案（WebAssembly.Tag/Exception）
    wasmStackTrace: false, // 引擎是否在 Error.stack 中给出 wasm 帧
    nameSection: false, // 引擎是否使用 name section 显示函数名
    streaming: typeof WebAssembly !== 'undefined' && !!WebAssembly.compileStreaming,
  };
  if (!f.wasm) return f;
  f.ehProposal =
    typeof WebAssembly.Tag === 'function' && typeof WebAssembly.Exception === 'function';
  try {
    const { bytes } = buildModule();
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
    inst.exports.oob_load(0x10000);
  } catch (err) {
    const { frames } = parseWasmStack(err.stack);
    f.wasmStackTrace = frames.length > 0;
    f.nameSection = frames.some((fr) => fr.funcName === 'oob_load');
  }
  return f;
}
