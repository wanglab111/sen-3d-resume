// 时间轴节点名单 —— 「履历条数 / 相机停靠点数」的唯一真源。
// Scene.tsx 与 Resume.tsx 都从这里取，增删履历时只改这里 + Resume.tsx 的 entries，
// 其余（节点数 M、帧区间、作品区帧段）由 Scene.tsx 自动推导，不用手算。
//
// ⚠️ 名字只是「第几个节点」的标签，**不需要去 glb 里找同名空对象**：
//    本项目的 me.glb 是图片→3D 生成的**静态网格**（`animations: []`、`cameras: 0`），
//    相机运镜完全由 data/cameraShots.ts 里的机位数组按帧插值出来。
//    名字的用途只有两个：① 长度 = 节点数 M；② 渲染成履历条目的 `data-point` 属性，
//    供 Scene.tsx 用 querySelector 反查每个条目在文档里的位置。
//
// 帧约定（Scene.tsx 按此把滚动位置换算成"连续节点索引" s）：
//   s = 0          首屏机位
//   s = k          第 k 个节点（k = 1…M，对应 FOCUS_POINTS[k-1] 与 SHOTS[k]）
//   s = M+1        作品区机位（SHOTS[M+1]）
//
// 当前为 7 节点（focus-1…7），对应简历内容：
//   1 教育背景+技能 / 2 洛希极限 / 3 接力科创 / 4 DeVries Global / 5 阿里巴巴 / 6 南昌唐宁 / 7 校青媒
// 改条数时三处同步：这里 + Resume.tsx 的 entries + data/cameraShots.ts 的机位（长度 = 条数 + 2）。
export const FOCUS_POINTS = [
  'focus-1',
  'focus-2',
  'focus-3',
  'focus-4',
  'focus-5',
  'focus-6',
  'focus-7',
] as const

// 每个时间轴节点在相机动画里占的帧数（节点 k 落在第 k·FRAMES_PER_NODE 帧）。
export const FRAMES_PER_NODE = 50
