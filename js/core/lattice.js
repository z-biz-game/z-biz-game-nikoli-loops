// 点阵几何的纯函数：半格索引 ↔ 边/点 ↔ 格坐标。
// 视图与引擎都要用它，所以放在 core 里 —— 引擎绝不 import ui/，否则 node 里跑不动。

// 坐标系：把相邻两点之间的距离当最小步进（"半格"）。
//   (偶, 偶) = 点；(奇, 偶) = 横边；(偶, 奇) = 竖边；(奇, 奇) = 格心，不是落子目标。
export const isVertex = (hx, hy) => hx % 2 === 0 && hy % 2 === 0;
export const isHEdge = (hx, hy) => hx % 2 === 1 && hy % 2 === 0;
export const isVEdge = (hx, hy) => hx % 2 === 0 && hy % 2 === 1;
export const isEdge = (hx, hy) => isHEdge(hx, hy) || isVEdge(hx, hy);
// 格心：珍珠 / 箭头 / 数桥 的目标，与上面三类互斥
export const isCell = (hx, hy) => hx % 2 === 1 && hy % 2 === 1;
export const cellOf = (hx, hy) => [(hx - 1) / 2, (hy - 1) / 2];
export const cellAt = (i, j) => [2 * i + 1, 2 * j + 1];

export const hEdge = (i, j) => [2 * i + 1, 2 * j];   // 点 (i,j) → (i+1,j)
export const vEdge = (i, j) => [2 * i, 2 * j + 1];   // 点 (i,j) → (i,j+1)
export const edgeKey = (hx, hy) => hy * 1024 + hx;

// 这条边两侧的格（横边压在上下两格之间，竖边压在左右两格之间）；越界的一侧为 null。
export function edgeSides(hx, hy, cols, rows) {
  if (isHEdge(hx, hy)) {
    const i = (hx - 1) / 2, j = hy / 2;
    return [j > 0 ? [i, j - 1] : null, j < rows ? [i, j] : null];
  }
  const i = hx / 2, j = (hy - 1) / 2;
  return [i > 0 ? [i - 1, j] : null, i < cols ? [i, j] : null];
}

// 从一个点到它的四条出边（棋盘边界外没有边，所以最多四条）。
export function edgesAt(i, j, cols, rows) {
  const out = [];
  if (i > 0) out.push(vEdge(i - 1, j));
  if (j > 0) out.push(hEdge(i, j - 1));
  if (i < cols) out.push(vEdge(i, j));
  if (j < rows) out.push(hEdge(i, j));
  return out;
}

export const vertexOf = (hx, hy) => [hx / 2, hy / 2];
export const edgeEnds = (hx, hy) =>
  isHEdge(hx, hy) ? [[(hx - 1) / 2, hy / 2], [(hx + 1) / 2, hy / 2]] : [[hx / 2, (hy - 1) / 2], [hx / 2, (hy + 1) / 2]];

// 半格索引 → 画布像素中点（点、边、格心三种目标共用同一套算法）。
export function halfPoint(v, hx, hy) {
  return { x: v.ox + hx * v.sub, y: v.oy + hy * v.sub };
}

export const cellPoint = (v, i, j) => ({ x: v.ox + i * v.cell, y: v.oy + j * v.cell });
export const cellCenter = (v, i, j) => ({ x: v.ox + (i + 0.5) * v.cell, y: v.oy + (j + 0.5) * v.cell });
