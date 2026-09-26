// wasm-module.js — 手工编码的 WASM 模块构建器
// 构建一个包含多种 trap 触发函数的模块，同时生成：
//   1. name section（让引擎栈回溯中显示函数名）
//   2. 自定义源码映射（wasm 代码偏移 -> WAT 源码行/列），模拟 source map 的角色
// 该文件同时被浏览器（ES module）和 Node 测试脚本使用。

// ---------- LEB128 ----------
export function lebU(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

export function lebS(n) {
  const out = [];
  let v = n | 0;
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

function str(s) {
  const bytes = new TextEncoder().encode(s);
  return [...lebU(bytes.length), ...bytes];
}

function section(id, payload) {
  return [id, ...lebU(payload.length), ...payload];
}

function vec(items) {
  return [...lebU(items.length), ...items.flat()];
}

// ---------- 模块定义 ----------
// 每个函数：WAT 源码行（用于源码映射展示）+ 指令序列。
// 指令在编码时记录其字节偏移，从而生成 offset -> 源码位置 的映射。

const VAL = { i32: 0x7f, f32: 0x7d };
const OP = {
  local_get: 0x20,
  i32_load: 0x28,
  i32_store: 0x36,
  i32_add: 0x6a,
  i32_div_s: 0x6d,
  i32_trunc_f32_s: 0xa8,
  call: 0x10,
  end: 0x0b,
};

// wat: [行号(从1), 文本]；instrs: { bytes: [...], watLine } 列表在构建时生成
export const FUNCS = [
  {
    name: 'oob_load',
    type: 0, // (i32)->i32
    wat: [
      '(func $oob_load (param $addr i32) (result i32)',
      '  local.get $addr',
      '  i32.load          ;; 越界时 trap: out of bounds memory access',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'i32_load', memarg: [0, 0], watLine: 3 },
    ],
  },
  {
    name: 'div_zero',
    type: 1, // (i32,i32)->i32
    wat: [
      '(func $div_zero (param $a i32) (param $b i32) (result i32)',
      '  local.get $a',
      '  local.get $b',
      '  i32.div_s         ;; b=0 除零 / INT_MIN/-1 溢出',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'local_get', args: [1], watLine: 3 },
      { op: 'i32_div_s', watLine: 4 },
    ],
  },
  {
    name: 'invalid_convert',
    type: 2, // (f32)->i32
    wat: [
      '(func $invalid_convert (param $x f32) (result i32)',
      '  local.get $x',
      '  i32.trunc_f32_s   ;; NaN/Inf/超范围时 trap: invalid conversion',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'i32_trunc_f32_s', watLine: 3 },
    ],
  },
  {
    name: 'recurse',
    type: 0, // (i32)->i32
    wat: [
      '(func $recurse (param $n i32) (result i32)',
      '  local.get $n',
      '  call $recurse     ;; 无限递归 -> 调用栈耗尽',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'call', args: [3], watLine: 3 }, // 自递归，func index 3
    ],
  },
  {
    name: 'safe_add',
    type: 1,
    wat: [
      '(func $safe_add (param $a i32) (param $b i32) (result i32)',
      '  local.get $a',
      '  local.get $b',
      '  i32.add           ;; 不 trap，用于验证 trap 后实例仍可用',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'local_get', args: [1], watLine: 3 },
      { op: 'i32_add', watLine: 4 },
    ],
  },
  {
    name: 'mem_read',
    type: 0,
    wat: [
      '(func $mem_read (param $addr i32) (result i32)',
      '  local.get $addr',
      '  i32.load',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'i32_load', memarg: [0, 0], watLine: 3 },
    ],
  },
  {
    name: 'mem_write',
    type: 3, // (i32,i32)->()
    wat: [
      '(func $mem_write (param $addr i32) (param $val i32)',
      '  local.get $addr',
      '  local.get $val',
      '  i32.store',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'local_get', args: [1], watLine: 3 },
      { op: 'i32_store', memarg: [0, 0], watLine: 4 },
    ],
  },
  {
    name: 'wrapper_oob',
    type: 0,
    wat: [
      '(func $wrapper_oob (param $addr i32) (result i32)',
      '  local.get $addr',
      '  call $oob_load    ;; 间接调用，制造多帧 wasm 栈回溯',
      ')',
    ],
    body: [
      { op: 'local_get', args: [0], watLine: 2 },
      { op: 'call', args: [0], watLine: 3 },
    ],
  },
];

// 类型签名表
const TYPES = [
  { params: [VAL.i32], results: [VAL.i32] },            // 0 (i32)->i32
  { params: [VAL.i32, VAL.i32], results: [VAL.i32] },   // 1 (i32,i32)->i32
  { params: [VAL.f32], results: [VAL.i32] },            // 2 (f32)->i32
  { params: [VAL.i32, VAL.i32], results: [] },          // 3 (i32,i32)->()
];

function encodeInstr(ins) {
  const op = OP[ins.op];
  let operand = [];
  if (ins.op === 'local_get' || ins.op === 'call') operand = lebU(ins.args[0]);
  if (ins.memarg) operand = [...lebU(ins.memarg[0]), ...lebU(ins.memarg[1])];
  return [op, ...operand];
}

// 构建模块，返回 { bytes, sourceMap, wat }
// sourceMap: { [funcIndex]: { name, entries: [{ offset, watLine, watText }] } }
// offset 为「函数代码起始处（含 body size 前缀）到模块起始」的绝对偏移之外的
// 相对 code-section 内容偏移，具体基准在 Node 测试中校准（见 node-check）。
export function buildModule() {
  const watLines = ['(module'];
  FUNCS.forEach((f) => f.wat.forEach((l) => watLines.push('  ' + l)));
  watLines.push('  (memory (export "memory") 1)');
  watLines.push(')');
  const wat = watLines.join('\n');

  // ---- code section + source map ----
  const funcBodies = [];
  const sourceMap = {};
  let codeCursor = 0; // 相对 code section payload 起始（含 vec 长度前缀之后）

  // vec 长度前缀先占位计算：函数数量
  const funcCountBytes = lebU(FUNCS.length);
  codeCursor = funcCountBytes.length;

  FUNCS.forEach((f, fi) => {
    const locals = [0x00]; // 0 组局部变量
    const instrBytes = [];
    const entries = [];
    let cursorInBody = 0;
    f.body.forEach((ins) => {
      const enc = encodeInstr(ins);
      entries.push({
        // body 内偏移 = locals 长度 + 之前指令长度；最终再加上 body size 前缀与 code 起始
        offsetInBody: locals.length + cursorInBody,
        watLine: f.wat[ins.watLine - 1] ? ins.watLine : 1,
        watText: f.wat[ins.watLine - 1] || '',
        op: ins.op,
      });
      instrBytes.push(...enc);
      cursorInBody += enc.length;
    });
    const body = [...locals, ...instrBytes, OP.end];
    const bodyWithSize = [...lebU(body.length), ...body];
    const sizePrefixLen = lebU(body.length).length;
    sourceMap[fi] = {
      name: f.name,
      // 该函数在 code section 中的起始偏移（相对 code section payload 起点）
      codeStart: codeCursor,
      bodyOffsetInFunc: sizePrefixLen, // 指令相对函数记录起点的偏移
      entries: entries.map((e) => ({
        ...e,
        // 相对 code section payload 起点的绝对偏移
        codeOffset: codeCursor + sizePrefixLen + e.offsetInBody,
      })),
    };
    funcBodies.push(bodyWithSize);
    codeCursor += bodyWithSize.length;
  });

  const codePayload = [...funcCountBytes, ...funcBodies.flat()];
  const codeSection = section(10, codePayload);

  // ---- 其余 section ----
  const typeSection = section(
    1,
    vec(
      TYPES.map((t) => [
        0x60,
        ...vec(t.params.map((p) => [p])),
        ...vec(t.results.map((r) => [r])),
      ])
    )
  );
  const funcSection = section(3, vec(FUNCS.map((f) => lebU(f.type))));
  const memSection = section(5, [0x01, 0x00, 0x01]); // 1 个内存，min=1 页
  const exportSection = section(
    7,
    vec([
      ...FUNCS.map((f, i) => [...str(f.name), 0x00, ...lebU(i)]),
      [...str('memory'), 0x02, 0x00],
    ])
  );

  // ---- name section（自定义 section，id=0，name="name"）----
  const nameSubsection = [
    0x01, // function names subsection
    ...(() => {
      const payload = vec(FUNCS.map((f, i) => [...lebU(i), ...str(f.name)]));
      return [...lebU(payload.length), ...payload];
    })(),
  ];
  const nameSection = section(0, [...str('name'), ...nameSubsection]);

  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const bytes = new Uint8Array([
    ...header,
    ...typeSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
    ...codeSection,
    ...nameSection,
  ]);

  // 计算 code section 在模块中的绝对偏移，便于把引擎报告的偏移换算回来
  const codeSectionStart =
    header.length +
    typeSection.length +
    funcSection.length +
    memSection.length +
    exportSection.length;
  // code section payload（vec 之后）的绝对偏移
  const codePayloadStart = codeSectionStart + 1 + lebU(codePayload.length).length;

  return {
    bytes,
    wat,
    sourceMap,
    meta: {
      codeSectionStart,
      codePayloadStart,
      funcNames: FUNCS.map((f) => f.name),
    },
  };
}

// 根据引擎报告的偏移，在源码映射中查找对应的 WAT 行。
// 引擎报告的偏移基准因实现而异（常见为相对 code section 内容起点），
// 这里按 codeOffset（相对 code payload 起点）匹配，调用方负责换算。
export function resolveOffset(sourceMap, funcIndex, codeOffset) {
  const fn = sourceMap[funcIndex];
  if (!fn) return null;
  let best = null;
  for (const e of fn.entries) {
    if (e.codeOffset <= codeOffset && (!best || e.codeOffset > best.codeOffset)) {
      best = e;
    }
  }
  // 引擎报告的偏移可能落在函数体起始处（如栈溢出在函数入口触发），
  // 此时没有「不大于它」的指令，回退到该函数的第一条指令。
  if (!best && fn.entries.length > 0 && codeOffset >= fn.codeStart) {
    best = fn.entries[0];
  }
  return best
    ? { funcName: fn.name, watLine: best.watLine, watText: best.watText.trim(), op: best.op }
    : null;
}
