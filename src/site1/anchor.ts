import { motionValue, useScroll, useTransform, type MotionValue } from 'framer-motion'

/* ==================================================================
   网站1 ↔ 网站2 的「滚动原点」修正
   ------------------------------------------------------------------
   网站2（原来的简历站）所有滚动阈值写的都是**绝对 window.scrollY**：
     App.tsx   [0, 520] / [0, 160] / [0, 240] / [vh*0.5, vh*1.1] / [0, 280]
     Scene.tsx scrollFade = [0, 180]，以及 heroScroll = tops[0] - 0.3vh
   这些值都隐含一个前提：**页面是从网站2 的顶部开始的**。

   在它前面接上 720vh 的网站1 之后，这个前提就没了。症状很具体：
   等用户滑到简历站时 window.scrollY 已经有好几千，
   → 首屏 About Me 直接是 blur(16px) + opacity 0，**那一屏文字整个看不见**；
   → 3D 也早就跳过了首屏机位、跑到履历节点上去了。

   所以网站2 读到的滚动量必须减去网站1 占掉的高度，让它以为页面还是从自己顶部开始。
   这不是改网站2 的设计，只是把它的「0 点」接回去。

   ⚠️⚠️ 这个高度必须以**参数**形式传进来（来自 App 的 useState），
      不能藏在模块变量里让 transform 自己去读。原因是实测踩到的：
        · useTransform 只在**输入变了**时才重算 —— 模块变量改了不触发；
        · 更隐蔽的是**父子的 effect 顺序**：Site1（子）的 useLayoutEffect 先跑，
          它把高度写进模块变量的那一刻，App（父）那些 transform 的订阅还没挂上
          （订阅是在父自己的 layout effect 里注册的，父在子之后），
          于是首次那个值（0）被一直沿用到用户第一次滚动为止。
        症状：「一进页面，网站2 那圈画框（z-index 12，压在所有内容之上）盖在影片上；
        手一滑就自己好了」—— 特别容易被当成偶发。
        改成走 React state 之后，App 因为高度变化重渲染一次，
        而 useTransform 在**每次 render 都会同步重算**（framer 内部就是
        render 期调一次 updateValue），所以那一帧拿到的就是正确的值，不用等滚动。

   下面这两个 hook 就按「高度由外面传进来」写了。
   ================================================================== */

/** 给「非 React 的读者」用（Scene 的 useFrame、SceneStage 的滚动判断）。
    React 侧请用传参形式，见上面的说明。 */
export const site1Height = motionValue(0)
export const setSite1Height = (v: number) => site1Height.set(Math.max(0, v || 0))
export const getSite1Height = () => site1Height.get()

/** 网站2 用的滚动量：把网站1 那段减掉，钳在 0 */
export function useSite2Scroll(h: number): MotionValue<number> {
  const { scrollY } = useScroll()
  return useTransform(scrollY, (s) => Math.max(0, s - h))
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (x: number) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** 交接段进度 e：0 = 还在末站（光环），1 = 网站1 的底边贴住视口顶（= 网站2 首屏）。
    Site1.tsx 的 tick 里用的是同一个公式（只是它从 DOM 量 top，这里用 h —— 两者恒等：
    track 高 = N*vh = h，末站 = h - vh）。⚠️ 改一边就要改另一边。 */
export function handoffE(s: number, h: number): number {
  if (h <= 0) return 1
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const start = Math.max(0, h - vh)
  if (h - start < 1) return 0
  return clamp01((s - start) / (h - start))
}

/* 2026-09-18：原来这里还有一个 `useSceneReveal`（= handoffE，3D 场景按 e 线性淡入）。
   它和 emerge 相乘会让网站2 在中段比白光褪得慢，空出一段"什么都没有"的过渡 ——
   用户看到的那条「分明的分界线」有一半来自它。现在 3D 场景的可见度直接用 emerge
   （= 1 - 白光，份额守恒），网站1 期间它之所以看不见，靠的是舞台那块不透明底色挡着。 */

/* ── 交接段的白光 flash(e)（0→1→0）—— **唯一定义**在这里 ──────────
   2026-09-18 用户：「光环砰的一下，网页二隐隐出现，会更加自然」，随后又指出
   「能看到一条分明的分界线，不丝滑，真正的自然过渡，让网页2 从光里渐渐显出」。

   原来这里有**两处**在描述同一次交接：Site1.tsx 里算白光、emergeAt 里算浮现，
   两条曲线各写各的（白光 0.30→0.58 主散，浮现 0.30→0.88）—— 中段会出现
   「白光已经淡得差不多了、网站2 才出来一半」的空档，那就是"分界线"的观感来源之一。
   现在把曲线收到这里，谁也别再抄第二遍：

     burst 0.06→0.18  白光冲顶（正常滚速下约 150ms，一眨眼；拉长就成了"蒙了层白雾"）
     main  0.26→0.66  主散（光从糊满整屏退到薄薄一层）
     glow  0.66→1.00  余晖（那层薄雾慢慢褪干净）
   峰值 = main(1)×0.86 + glow(1)×0.14 = 1.0 —— 峰值仍是纯白，不打折。
   舞台（影片 + 它那块不透明底色）的退场是 0.22→0.46，整个窗口都在白光底下。 */
export function flashAt(e: number): number {
  if (e <= 0) return 0
  const burst = sstep((e - 0.06) / 0.12)
  const main = 1 - sstep((e - 0.26) / 0.4)
  const glow = 1 - sstep((e - 0.66) / 0.34)
  return burst * (main * 0.86 + glow * 0.14)
}
/** 白光冲顶的那一点：这之前网站2 一点都不许露头（露了就是"先亮了一下再被盖住"） */
export const HANDOFF_PEAK = 0.18

/* ── 网站2 的「浮现」进度 emerge（0→1）────────────────────────────
   ⚠️ 核心：emerge = 1 - flash **严格互补**，不是"另一条差不多的曲线"。
      两者相加恒为 1 → 从白光冲顶到余晖褪尽，画面上"白"与"网站2"的份额始终守恒，
      读起来就是**同一张画面在散雾**，结构上不可能出现任何可辨的分界线。
      （互补还有一个好处：不需要再去调两个曲线的相位，改 flash 一处就够。）

   浮现的具体质感（3D 场景从「暗 + 略大」聚焦回原位、首屏文字淡入 + 去模糊、
   画框角标一起跟进来）用 emerge 这个 0→1 的数在各组件里再映射一次。
   ⚠️ 必须**早于** e=1 完成：交接段结束时网站2 要已经是最终状态，不能有残留。 */
export function emergeAt(e: number): number {
  if (e < HANDOFF_PEAK) return 0
  return 1 - flashAt(e)
}

export function useSite2Emerge(h: number): MotionValue<number> {
  const { scrollY } = useScroll()
  return useTransform(scrollY, (s) => emergeAt(handoffE(s, h)))
}

/** 网站2 首屏那圈装饰画框（z-index 12）在网站1 期间必须是 0。
    ⚠️ 淡入走 emerge（和白光余晖同步），不能在白光底下就悄悄 = 1 —— 那样白光一散
       就是一整圈画框硬生生出现在眼前，正是用户说的「单纯的滑动」。 */
export function chromeOpacityAt(s: number, h: number): number {
  if (h <= 0) return 1 - clamp01(s / 280)
  const fadeIn = emergeAt(handoffE(s, h))
  const fadeOut = 1 - clamp01((s - h) / 280)
  return Math.min(fadeIn, fadeOut)
}
