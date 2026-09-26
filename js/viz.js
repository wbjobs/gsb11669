// viz.js — Canvas 可视化：内存网格、调用栈、trap 类型对比、历史时间线

export const CATEGORY_COLOR = {
  out_of_bounds: '#e05252',
  divide_by_zero: '#e08a3c',
  integer_overflow: '#d4c03a',
  invalid_conversion: '#9a6ee0',
  stack_overflow: '#3c9ae0',
  unknown: '#888',
};

const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function clear(ctx, w, h, bg = '#14171c') {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
}

function text(ctx, str, x, y, color = '#cfd8e3', font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

// ---------- 1. 内存视图 ----------
// 1 页 = 65536 字节，画成 256x256 网格（每格 1 字节）。
export function drawMemory(canvas, report) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  clear(ctx, W, H);
  const grid = 256;
  const cell = Math.floor((Math.min(W, H) - 90) / grid) || 1;
  const ox = 16, oy = 40;

  text(ctx, '线性内存（1 页 = 64 KiB，每格 1 字节）', ox, 22, '#8fa3bf');

  // 网格（稀疏画线避免过密：每 4096 字节一条粗线）
  ctx.strokeStyle = '#232a35';
  ctx.lineWidth = 1;
  for (let i = 0; i <= grid; i += 16) {
    ctx.beginPath(); ctx.moveTo(ox + i * cell, oy); ctx.lineTo(ox + i * cell, oy + grid * cell); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, oy + i * cell); ctx.lineTo(ox + grid * cell, oy + i * cell); ctx.stroke();
  }
  ctx.strokeStyle = '#3a4657';
  ctx.strokeRect(ox - 1, oy - 1, grid * cell + 2, grid * cell + 2);

  // 哨兵字节（addr 0，trap 前后用于校验内存保持）
  ctx.fillStyle = '#4caf7d';
  ctx.fillRect(ox, oy, Math.max(cell, 2), Math.max(cell, 2));
  text(ctx, '哨兵 @0x0000', ox + 8, oy + grid * cell + 18, '#4caf7d');

  if (report && report.trapId) {
    const color = CATEGORY_COLOR[report.category] || CATEGORY_COLOR.unknown;
    if (report.category === 'out_of_bounds') {
      // 越界：目标地址在网格之外，画红色越界箭头
      const addr = 0x1fff0;
      const gx = (addr % grid) * cell + ox;
      const arrowY = oy + grid * cell + 34;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, oy + grid * cell + 26);
      ctx.lineTo(gx, arrowY + 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gx - 5, arrowY + 4); ctx.lineTo(gx, arrowY + 12); ctx.lineTo(gx + 5, arrowY + 4);
      ctx.stroke();
      text(ctx, `越界访问 @0x${addr.toString(16)}（超出 0xFFFF）→ trap`, ox + 120, arrowY + 14, color);
    } else {
      text(ctx, `本次 trap：${report.title || report.categoryLabel}（未涉及内存访问）`, ox + 120, oy + grid * cell + 44, color);
    }
    // 实例状态角标
    const st = report.instanceState;
    if (st && st.alive !== null && st.alive !== undefined) {
      text(ctx, `trap 后实例：${st.alive ? '存活 ✓（内存保持、导出可调用）' : '不可用 ✗'}  代数 #${st.generation}`,
        ox, H - 14, st.alive ? '#4caf7d' : '#e05252');
    } else if (st) {
      text(ctx, st.note || '', ox, H - 14, '#8fa3bf');
    }
  }
}

// ---------- 2. 调用栈视图 ----------
export function drawCallStack(canvas, report) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  clear(ctx, W, H);
  text(ctx, 'wasm 调用栈回溯（trap 时刻，栈顶在上）', 16, 22, '#8fa3bf');

  if (!report) { text(ctx, '尚未运行 trap', 16, 50); return; }
  if (!report.hasWasmFrames) {
    // 栈回溯缺失的降级展示
    text(ctx, '⚠ 引擎未提供 wasm 栈帧（栈回溯缺失）', 16, 54, '#e0a03c');
    text(ctx, '降级：仅展示错误名与消息 ——', 16, 76, '#8fa3bf');
    text(ctx, `${report.errorName}: ${report.message}`, 16, 98, '#cfd8e3');
    return;
  }

  const frames = report.frames.slice(0, 12);
  const boxW = Math.min(W - 60, 460);
  const boxH = 46;
  let y = 40;
  frames.forEach((f, i) => {
    const isTop = i === 0;
    const color = isTop ? (CATEGORY_COLOR[report.category] || '#e05252') : '#3a4657';
    ctx.fillStyle = isTop ? '#2a1f22' : '#1b212b';
    ctx.strokeStyle = color;
    ctx.lineWidth = isTop ? 2 : 1;
    ctx.fillRect(24, y, boxW, boxH);
    ctx.strokeRect(24, y, boxW, boxH);
    const name = f.funcName || `<匿名>`;
    text(ctx, `#${i}  ${name}  (func[${f.funcIndex}])  @${f.offsetHex}`, 34, y + 17,
      isTop ? '#ffd7d7' : '#cfd8e3');
    const src = f.source
      ? `WAT 第 ${f.source.watLine} 行: ${f.source.watText}`
      : (report.sourceMapAvailable ? '（无源码映射条目）' : '（源码映射不可用）');
    text(ctx, src, 34, y + 35, f.source ? '#7fb3e0' : '#6b7686');
    if (i < frames.length - 1) {
      ctx.strokeStyle = '#3a4657';
      ctx.beginPath(); ctx.moveTo(44, y + boxH); ctx.lineTo(44, y + boxH + 8); ctx.stroke();
    }
    y += boxH + 8;
  });
  if (report.frames.length > frames.length) {
    text(ctx, `… 省略 ${report.frames.length - frames.length} 帧（共 ${report.frameCount} 帧）`, 24, y + 14, '#8fa3bf');
  }
  text(ctx, `trap 不可恢复：wasm 执行已在 trap 点中止并展开到 JS（resumable=false）`, 16, H - 14, '#e0a03c');
}

// ---------- 3. 类型对比视图 ----------
export function drawComparison(canvas, reportsById) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  clear(ctx, W, H);
  text(ctx, 'trap 类型行为对比（每类取最近一次报告）', 16, 22, '#8fa3bf');

  const cols = ['类型', '错误类', 'wasm 帧', '源码映射', '实例存活', '可恢复', 'JS 模拟'];
  const rows = Object.values(reportsById);
  if (rows.length === 0) { text(ctx, '尚未运行 trap', 16, 50); return; }

  const colX = [16, 150, 250, 340, 430, 520, 610];
  const rowH = 30;
  let y = 44;
  ctx.fillStyle = '#1b212b';
  ctx.fillRect(12, y - 16, W - 24, rowH);
  cols.forEach((c, i) => text(ctx, c, colX[i], y + 4, '#8fa3bf'));
  y += rowH - 6;

  rows.forEach((r) => {
    const color = CATEGORY_COLOR[r.category] || CATEGORY_COLOR.unknown;
    ctx.strokeStyle = '#232a35';
    ctx.beginPath(); ctx.moveTo(12, y + 8); ctx.lineTo(W - 12, y + 8); ctx.stroke();
    text(ctx, r.title || r.categoryLabel, colX[0], y + 4, color);
    text(ctx, r.errorName, colX[1], y + 4);
    text(ctx, r.hasWasmFrames ? `${r.frameCount} 帧` : '缺失', colX[2], y + 4,
      r.hasWasmFrames ? '#cfd8e3' : '#e0a03c');
    const srcOk = r.sourceMapAvailable && r.frames.some((f) => f.source);
    text(ctx, !r.sourceMapAvailable ? '不可用' : (srcOk ? '已解析' : '部分'), colX[3], y + 4,
      srcOk ? '#4caf7d' : '#e0a03c');
    const alive = r.instanceState && r.instanceState.alive;
    text(ctx, alive === null || alive === undefined ? '—' : (alive ? '存活' : '失效'),
      colX[4], y + 4, alive ? '#4caf7d' : '#e05252');
    text(ctx, r.resumable ? '是' : '否', colX[5], y + 4, '#e0a03c');
    text(ctx, r.simulated ? '是' : '否', colX[6], y + 4, r.simulated ? '#e0a03c' : '#cfd8e3');
    y += rowH;
  });
}

// ---------- 4. 历史时间线视图 ----------
export function drawTimeline(canvas, history) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  clear(ctx, W, H);
  text(ctx, `trap 历史（IndexedDB，共 ${history.length} 条）`, 16, 22, '#8fa3bf');
  if (history.length === 0) { text(ctx, '暂无记录', 16, 50); return; }

  const t0 = history[0].timestamp;
  const t1 = Math.max(history[history.length - 1].timestamp, t0 + 1);
  const x0 = 40, x1 = W - 40, y0 = H - 60;
  ctx.strokeStyle = '#3a4657';
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
  text(ctx, new Date(t0).toLocaleTimeString(), x0 - 10, y0 + 18, '#8fa3bf');
  text(ctx, new Date(t1).toLocaleTimeString(), x1 - 60, y0 + 18, '#8fa3bf');

  history.forEach((r) => {
    const x = x0 + ((r.timestamp - t0) / (t1 - t0)) * (x1 - x0);
    const color = CATEGORY_COLOR[r.category] || CATEGORY_COLOR.unknown;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y0, 5, 0, Math.PI * 2); ctx.fill();
    if (r.simulated) {
      ctx.strokeStyle = '#e0a03c';
      ctx.beginPath(); ctx.arc(x, y0, 8, 0, Math.PI * 2); ctx.stroke();
    }
  });

  // 图例
  let lx = 40, ly = 44;
  const seen = new Set();
  history.forEach((r) => {
    if (seen.has(r.category)) return;
    seen.add(r.category);
    ctx.fillStyle = CATEGORY_COLOR[r.category] || '#888';
    ctx.fillRect(lx, ly - 8, 10, 10);
    text(ctx, r.categoryLabel || r.category, lx + 14, ly, '#cfd8e3');
    lx += 120;
  });
}
