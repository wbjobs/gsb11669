import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WasmGen = require('../js/wasm-gen.js');

const { bytes, funcMeta, wat } = WasmGen.build();
console.log('module bytes:', bytes.length);
console.log('--- WAT ---\n' + wat.text);

const mod = new WebAssembly.Module(bytes);
const inst = new WebAssembly.Instance(mod);
const ex = inst.exports;

for (const name of ['run_oob', 'run_div', 'run_cvt', 'run_rec']) {
  try {
    ex[name]();
    console.log(name, ': NO TRAP (unexpected)');
  } catch (e) {
    console.log('===', name, '===');
    console.log('name:', e.constructor.name, '| msg:', e.message);
    console.log(e.stack.split('\n').slice(0, 6).join('\n'));
  }
}

// 状态检查：先写内存再 trap
try { ex.write_then_trap(); } catch (e) { console.log('write_then_trap:', e.message); }
console.log('mem0 after trap (expect 42):', ex.read_mem0());
console.log('instance reusable after traps:', ex.run_oob !== undefined);
try { ex.run_oob(); } catch { console.log('re-run run_oob still traps: ok'); }

// 偏移语义：打印每个函数指令的文件偏移，便于对照栈里的 0x..
for (const f of funcMeta) {
  console.log(`func[${f.index}] ${f.name} bodyStart=0x${f.bodyStart.toString(16)} instrs=[${f.instrs.map(i=>'0x'+i.offset.toString(16)+'@L'+i.watLine).join(',')}]`);
}
