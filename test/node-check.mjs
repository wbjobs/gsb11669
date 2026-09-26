// node-check.mjs — 无浏览器环境下验证 trap 管线（Node 的 V8 与 Chrome 同源）
// 运行: node test/node-check.mjs
import { buildModule, resolveOffset } from '../js/wasm-module.js';
import {
  TRAP_DEFS,
  normalizeTrap,
  parseWasmStack,
  classifyTrap,
  detectFeatures,
} from '../js/trap-core.js';

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
}

const { bytes, sourceMap, meta, wat } = buildModule();
check('模块可编译', (() => { try { new WebAssembly.Module(bytes); return true; } catch { return false; } })());
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
const MAGIC = 0x5afe1234;
inst.exports.mem_write(0, MAGIC);

// --- 特性探测 ---
const features = detectFeatures();
console.log('features:', JSON.stringify(features));
check('特性探测: wasm 可用', features.wasm);
check('特性探测: wasm 栈回溯存在', features.wasmStackTrace);
check('特性探测: name section 生效', features.nameSection);

// --- 真实 trap ---
const expectCategory = {
  oob: 'out_of_bounds',
  divzero: 'divide_by_zero',
  divoverflow: 'integer_overflow',
  badconvert: 'invalid_conversion',
  stackoverflow: 'stack_overflow',
};

for (const def of TRAP_DEFS) {
  let err = null;
  try { def.invoke(inst.exports); } catch (e) { err = e; }
  check(`${def.id}: 触发 trap`, err !== null);
  if (!err) continue;
  const report = normalizeTrap(err, { trapId: def.id, sourceMap, meta });
  check(`${def.id}: 分类正确 (${report.category})`, report.category === expectCategory[def.id], report.category);
  check(`${def.id}: 有 wasm 栈帧 (${report.frameCount})`, report.hasWasmFrames && report.frameCount > 0);
  check(`${def.id}: 帧含函数索引与偏移`,
    report.frames.every((f) => Number.isInteger(f.funcIndex) && f.offset > 0));
  const resolved = report.frames.filter((f) => f.source);
  check(`${def.id}: 源码映射解析 (${resolved.length}/${report.frameCount} 帧)`, resolved.length > 0);
  if (resolved.length > 0) {
    console.log(`      栈顶: ${resolved[0].funcName} -> WAT 第 ${resolved[0].source.watLine} 行: ${resolved[0].source.watText}`);
  }
  check(`${def.id}: 不可恢复`, report.resumable === false);
  // trap 后实例状态
  const memOk = (inst.exports.mem_read(0) >>> 0) === (MAGIC >>> 0);
  const callOk = inst.exports.safe_add(20, 22) === 42;
  check(`${def.id}: trap 后实例存活（内存保持=${memOk}, 可调用=${callOk}）`, memOk && callOk);
}

// --- 多帧栈（wrapper） ---
{
  let err = null;
  try { inst.exports.wrapper_oob(0x1fff0); } catch (e) { err = e; }
  const { frames } = parseWasmStack(err.stack);
  check('wrapper_oob: 多帧栈（>=2 帧）', frames.length >= 2, `frames=${frames.length}`);
  check('wrapper_oob: 栈顶是 oob_load(func 0)', frames[0].funcIndex === 0);
  check('wrapper_oob: 调用者是 wrapper_oob(func 7)', frames[1].funcIndex === 7);
}

// --- 源码映射缺失降级 ---
{
  let err = null;
  try { inst.exports.div_zero(1, 0); } catch (e) { err = e; }
  const report = normalizeTrap(err, { trapId: 'divzero', sourceMap, meta, noSourceMap: true });
  check('源码映射缺失: sourceMapAvailable=false', report.sourceMapAvailable === false);
  check('源码映射缺失: 帧仍保留原始偏移', report.frames.length > 0 && report.frames[0].offsetHex.startsWith('0x'));
  check('源码映射缺失: source 为 null（降级）', report.frames.every((f) => f.source === null));
}

// --- 栈回溯缺失降级（模拟无 wasm 帧的引擎，如 JavaScriptCore） ---
{
  const fakeErr = new Error('memory access out of bounds');
  fakeErr.name = 'RuntimeError';
  fakeErr.stack = 'RuntimeError: memory access out of bounds\n    at foo (http://x/a.js:1:1)';
  const report = normalizeTrap(fakeErr, { trapId: 'oob', sourceMap, meta });
  check('栈回溯缺失: hasWasmFrames=false', report.hasWasmFrames === false);
  check('栈回溯缺失: 仍保留错误名/消息', report.errorName === 'RuntimeError' && report.message.includes('out of bounds'));
}

// --- JS 模拟 trap 降级 ---
for (const def of TRAP_DEFS) {
  let err = null;
  try { def.simulate(); } catch (e) { err = e; }
  check(`simulate ${def.id}: 抛出合成 trap`, err !== null);
  const report = normalizeTrap(err, { trapId: def.id, simulated: true, sourceMap, meta });
  check(`simulate ${def.id}: 分类一致`, report.category === expectCategory[def.id], report.category);
  check(`simulate ${def.id}: 标记 simulated`, report.simulated === true);
}

// --- 结构化克隆可行性（跨 Worker 传播的前提：报告必须是纯数据） ---
{
  let err = null;
  try { inst.exports.recurse(1); } catch (e) { err = e; }
  const report = normalizeTrap(err, { trapId: 'stackoverflow', sourceMap, meta });
  const clone = structuredClone(report);
  check('报告可结构化克隆（跨 Worker 传播）', JSON.stringify(clone) === JSON.stringify(report));
}

// --- 分类器边界 ---
check('classify: 空消息 -> unknown', classifyTrap('') === 'unknown');
check('classify: Firefox 风格 too much recursion', classifyTrap('too much recursion') === 'stack_overflow');

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
