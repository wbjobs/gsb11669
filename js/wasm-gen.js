/*
 * wasm-gen.js — 手工汇编一个包含多种 trap 的 wasm 模块，并同步生成
 * 虚拟 WAT 源码与 source-map v3 映射（指令级：文件偏移 -> WAT 行号）。
 * 无依赖，可同时用于主线程、Worker（importScripts）与 Node（require）。
 */
(function (global) {
  'use strict';

  // ---------- LEB128 ----------
  function uleb(n) {
    const out = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      out.push(b);
    } while (n !== 0);
    return out;
  }
  function sleb(n) {
    const out = [];
    let more = true;
    while (more) {
      let b = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      out.push(b);
    }
    return out;
  }
  function str(s) {
    const bytes = Array.from(s).map((c) => c.charCodeAt(0));
    return uleb(bytes.length).concat(bytes);
  }
  function section(id, payload) {
    return [id].concat(uleb(payload.length), payload);
  }
  function vec(items) {
    let out = uleb(items.length);
    for (const it of items) out = out.concat(it);
    return out;
  }

  // ---------- 指令构造（记录每条指令，便于生成源码映射） ----------
  // op 形如 { bytes:[...], wat:'i32.const 65536' }
  function i32const(v) { return { bytes: [0x41].concat(sleb(v)), wat: 'i32.const ' + v }; }
  function f64constNan() {
    return { bytes: [0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x7f], wat: 'f64.const nan' };
  }
  function i32load() { return { bytes: [0x28, 0x00, 0x00], wat: 'i32.load' }; }
  function i32store() { return { bytes: [0x36, 0x00, 0x00], wat: 'i32.store' }; }
  function i32divs() { return { bytes: [0x6d], wat: 'i32.div_s' }; }
  function truncF64s() { return { bytes: [0xaa], wat: 'i32.trunc_f64_s' }; }
  function call(idx) { return { bytes: [0x10].concat(uleb(idx)), wat: 'call $f' + idx }; }
  function end() { return { bytes: [0x0b], wat: 'end' }; }

  // ---------- 模块定义 ----------
  // 所有函数类型均为 () -> i32。通过 leaf/mid/run 三级调用制造可读栈回溯。
  const FUNCS = [
    { name: 'leaf_oob',    ops: [i32const(0x10000), i32load(), end()] },              // 0
    { name: 'mid_oob',     ops: [call(0), end()] },                                    // 1
    { name: 'run_oob',     ops: [call(1), end()],        export: 'run_oob' },          // 2
    { name: 'leaf_div',    ops: [i32const(1), i32const(0), i32divs(), end()] },        // 3
    { name: 'mid_div',     ops: [call(3), end()] },                                    // 4
    { name: 'run_div',     ops: [call(4), end()],        export: 'run_div' },          // 5
    { name: 'leaf_cvt',    ops: [f64constNan(), truncF64s(), end()] },                 // 6
    { name: 'mid_cvt',     ops: [call(6), end()] },                                    // 7
    { name: 'run_cvt',     ops: [call(7), end()],        export: 'run_cvt' },          // 8
    { name: 'leaf_rec',    ops: [call(9), end()] },                                    // 9 自递归 -> 栈溢出
    { name: 'run_rec',     ops: [call(9), end()],        export: 'run_rec' },          // 10
    { name: 'write_then_trap', ops: [i32const(0), i32const(42), i32store(),            // 11 先写内存再越界
                                     i32const(0x10000), i32load(), end()], export: 'write_then_trap' },
    { name: 'read_mem0',   ops: [i32const(0), i32load(), end()], export: 'read_mem0' },// 12
  ];

  // ---------- 生成虚拟 WAT 源码（每行一条指令，记录行号） ----------
  function buildWat() {
    const lines = [];
    const funcLines = []; // funcLines[i] = { start, instrLines: [行号...] }
    lines.push('(module');
    lines.push('  (memory (export "memory") 1)');
    FUNCS.forEach((f, i) => {
      const start = lines.length;
      const instrLines = [];
      const exp = f.export ? ` (export "${f.export}")` : '';
      lines.push(`  (func $${f.name}${exp} (result i32)`);
      f.ops.forEach((op) => {
        instrLines.push(lines.length);
        lines.push('    ' + op.wat);
      });
      lines.push('  )');
      funcLines.push({ start, instrLines });
    });
    lines.push(')');
    return { text: lines.join('\n'), funcLines };
  }

  // ---------- 汇编 ----------
  function build() {
    const wat = buildWat();

    // 各 section（code 之前），用于计算函数体的文件偏移
    const typeSec = section(1, vec([[0x60, 0x00, 0x01, 0x7f]])); // () -> i32
    const funcSec = section(3, vec(FUNCS.map(() => [0x00])));
    const memSec = section(5, vec([[0x00, 0x01]])); // min=1 page
    const exports = [['memory', 0x02, 0]];
    FUNCS.forEach((f, i) => { if (f.export) exports.push([f.export, 0x00, i]); });
    const exportSec = section(7, vec(exports.map(([nm, kind, idx]) =>
      str(nm).concat([kind]).concat(uleb(idx)))));

    const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const prefix = header.concat(typeSec, funcSec, memSec, exportSec);

    // code section：逐个函数编码，记录每条指令的文件偏移
    const funcMeta = []; // { name, export, bodyStart, instrs: [{offset, watLine}] }
    let bodies = [];
    let cursor = prefix.length + 1; // +1: section id（size 字段长度最后统一修正）
    const bodyEncs = FUNCS.map((f, fi) => {
      // 先算 locals 声明（0 组）+ 指令字节
      let instrBytes = [];
      const instrOffsetsRel = [];
      for (const op of f.ops) {
        instrOffsetsRel.push(1 + instrBytes.length); // 相对 body 起始（含 locals 字节）
        instrBytes = instrBytes.concat(op.bytes);
      }
      const body = [0x00].concat(instrBytes); // 0 组局部变量
      return { body, instrOffsetsRel };
    });

    // 迭代计算：size 字段长度会影响后续偏移，做两轮不动点
    let codeSec = [];
    for (let pass = 0; pass < 3; pass++) {
      const countBytes = uleb(FUNCS.length);
      let payloadLen = countBytes.length;
      const sizes = bodyEncs.map((e) => e.body.length);
      for (const s of sizes) payloadLen += uleb(s).length + s;
      codeSec = [10].concat(uleb(payloadLen), countBytes);
      cursor = prefix.length + codeSec.length;
      funcMeta.length = 0;
      bodies = [];
      FUNCS.forEach((f, fi) => {
        const enc = bodyEncs[fi];
        const sizeBytes = uleb(enc.body.length);
        const bodyStart = cursor + sizeBytes.length; // locals 字节位置
        const instrs = enc.instrOffsetsRel.map((rel, k) => ({
          offset: bodyStart + rel,
          watLine: wat.funcLines[fi].instrLines[k],
        }));
        funcMeta.push({
          index: fi, name: f.name, export: f.export || null,
          bodyStart, instrs,
        });
        bodies = bodies.concat(sizeBytes, enc.body);
        cursor += sizeBytes.length + enc.body.length;
      });
    }
    codeSec = codeSec.concat(bodies);

    // name section（自定义段，帮助部分引擎显示函数名）
    const nameSubsec = [0x01].concat((() => {
      const payload = vec(FUNCS.map((f, i) => uleb(i).concat(str(f.name))));
      return uleb(payload.length).concat(payload);
    })());
    const nameSec = [0x00].concat((() => {
      const payload = str('name').concat(nameSubsec);
      return uleb(payload.length).concat(payload);
    })());

    const bytes = new Uint8Array(prefix.concat(codeSec, nameSec));
    return { bytes, funcMeta, wat };
  }

  // ---------- source-map v3 生成 ----------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function vlq(v) {
    let x = v < 0 ? ((-v) << 1) | 1 : v << 1;
    let out = '';
    do {
      let d = x & 31;
      x >>>= 5;
      if (x) d |= 32;
      out += B64[d];
    } while (x);
    return out;
  }
  // 每个指令偏移一个 segment：[genColumn, srcIndex, origLine, origColumn]
  function buildSourceMap(funcMeta) {
    const entries = [];
    for (const f of funcMeta) {
      for (const ins of f.instrs) entries.push({ col: ins.offset, line: ins.watLine });
    }
    entries.sort((a, b) => a.col - b.col);
    let prevCol = 0, prevLine = 0;
    const segs = entries.map((e) => {
      const s = vlq(e.col - prevCol) + vlq(0) + vlq(e.line - prevLine) + vlq(0);
      prevCol = e.col; prevLine = e.line;
      return s;
    });
    return {
      version: 3,
      file: 'trap_demo.wasm',
      sources: ['trap_demo.wat'],
      sourcesContent: [buildWat().text],
      names: [],
      mappings: segs.join(','),
    };
  }

  // ---------- source-map 查询（偏移 -> 行号） ----------
  function createOffsetLookup(funcMeta) {
    const all = [];
    for (const f of funcMeta) {
      for (const ins of f.instrs) all.push({ offset: ins.offset, line: ins.watLine, func: f.name, funcIndex: f.index });
    }
    all.sort((a, b) => a.offset - b.offset);
    return function lookup(fileOffset) {
      // 找 <= fileOffset 的最后一条指令
      let lo = 0, hi = all.length - 1, ans = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (all[mid].offset <= fileOffset) { ans = all[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      return ans;
    };
  }

  const api = { build, buildWat, buildSourceMap, createOffsetLookup, FUNCS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WasmGen = api;
})(typeof self !== 'undefined' ? self : globalThis);
