import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../js/wasm-gen.js');
const TrapCore = require('../js/trap-core.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.log('  FAIL -', name); }
}

console.log('== 特性检测 ==');
const f = TrapCore.detectFeatures();
console.log(' ', JSON.stringify(f));
ok(f.wasm, 'wasm 可用');
ok(f.stackTraces, 'V8 提供 wasm 栈回溯');

console.log('== 四类 trap（wasm 真跑） ==');
for (const type of ['oob', 'div', 'cvt', 'rec']) {
  const r = TrapCore.runWasmTrap(type, {});
  ok(r.caught, `${type}: 已捕获`);
  ok(r.errorName === TrapCore.TRAP_TYPES[type].expectName, `${type}: 错误类型 ${r.errorName}`);
  ok(TrapCore.TRAP_TYPES[type].expectMsg.test(r.message), `${type}: 消息 "${r.message}"`);
  ok(r.framesParsed && r.frames.length >= 2, `${type}: 栈回溯 ${r.frames.length} 帧`);
  ok(r.frames.every((fr) => fr.funcName), `${type}: 函数名可读`);
  ok(r.frames.every((fr) => fr.source && fr.source.line > 0), `${type}: 源码映射到 WAT 行`);
  console.log(`    frames: ${r.frames.slice(0,3).map(fr=>`${fr.funcName}@${fr.offsetHex}->L${fr.source&&fr.source.line}`).join(' | ')}`);
}

console.log('== 实例状态（trap 后） ==');
{
  const r = TrapCore.runWasmTrap('oob', {});
  ok(r.instanceState.mem0After === 42, 'trap 前部分写入保留 (mem0=42)');
  ok(r.instanceState.reusable === true, 'trap 后实例仍可调用');
}

console.log('== 降级：栈回溯缺失 ==');
{
  const r = TrapCore.runWasmTrap('div', { stripStack: true });
  ok(r.frames.length === 0 && !r.framesParsed, 'stripStack 后无帧，走降级');
}

console.log('== 降级：源码映射缺失 ==');
{
  const r = TrapCore.runWasmTrap('div', { stripSourceMap: true });
  ok(r.sourceMapped === false, '标记为无源码映射');
  ok(r.frames.length > 0 && r.frames.every((fr) => fr.funcIndex >= 0), '仍有函数索引与偏移');
}

console.log('== 降级：JS 模拟 trap ==');
for (const type of ['oob', 'div', 'cvt', 'rec']) {
  const r = TrapCore.runJsSimulatedTrap(type, {});
  ok(r.caught && r.simulated, `${type}: JS 模拟捕获`);
  ok(r.errorName === TrapCore.TRAP_TYPES[type].expectName, `${type}: 模拟错误类型一致 (${r.errorName})`);
}

console.log('== 跨 Worker 传播（模拟两跳） ==');
{
  let r = TrapCore.runWasmTrap('cvt', {});
  r = TrapCore.propagateTrap(r, 'worker-a');
  r = TrapCore.propagateTrap(r, 'worker-b');
  ok(r.hops.length === 2, '两跳记录');
  ok(r.hops.every((h) => h.caught && h.preserved), '每跳均捕获且类型/消息保留');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
