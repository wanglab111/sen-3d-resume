// 作品集数据（双语）。4 大板块 → 每行 hover / 点按弹出「链接浮层」或「照片浮层」。
// 纯数据驱动：增删板块 / 作品只改本文件，Works.tsx 仅负责渲染。
//
// ⚠️ 2026-09-17 起：作品行**不再能点开全屏详情**（详情组件已挪到 ./WorkDetail.tsx）。
//    现在唯一的交互是「行下方（footer 行是上方）弹出一个浮层」，浮层里放外链或照片。
//
// 板块字段：
//   id          唯一标识（关联 public/works/covers/<id>.jpg 的封面图，改名会一起断掉）
//   no          编号 '01'…'04'
//   title       板块标题
//   tagline     索引行右侧一句话
//   items[]     扁平作品列表
//   groups[]    分组作品（与 items 二选一）：{ heading, items: string[] }
//   awards[]    奖项 chip（可选）
//   footer      底部一行小字（可选）
//   footerLinks 给了它，footer 那行就变成「可弹浮层的行」（链接挂在浮层里）
//
// 作品条目字段：
//   name    作品名
//   meta    右侧数据（播放量 / 涨粉量 …）
//   tags    右侧标签
//   slug    指向 src/content/works/<slug>.md（详情页已下线，暂时没人读）
//   links   多条外链 → hover / 点按弹出按平台分组的链接浮层
//   photos  照片 → hover / 点按弹出照片浮层（图片放 public/works/photos/）

// ---------- 外链 ----------

export interface WorkLink {
  label: string
  url: string
}

// 平台由 URL 反推，不写进数据 —— 少一个字段就少一处改漏的地方。
export type WorkPlatform = 'bilibili' | 'douyin' | 'xiaohongshu' | 'tiktok' | 'web'

// ⚠️ 必须取 hostname 再比，别拿整串 URL 去 test：短链是 b23.tv / v.douyin.com / xhslink.com，
//    前面永远跟着 "https://"，用 /(^|\.)b23\.tv/ 这种写法根本匹配不到（"b23.tv" 前面是 "/"），
//    三文鱼那三条 B 站链接会被判成 web、浮层标题写成「产品官网」。踩过一次。
export function platformOf(url: string): WorkPlatform {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    host = url.toLowerCase()
  }
  if (/(^|\.)b23\.tv$/.test(host) || /(^|\.)bilibili\.com$/.test(host)) return 'bilibili'
  if (/(^|\.)douyin\.com$/.test(host)) return 'douyin'
  // ⚠️ 两个后缀都要收：小红书分享短链现在是 `xhslink.com` **和 `xhslink.cn` 两种**，
  //    2026-09-19 加的这条（AI 证件照提示词）落在 .cn 上 —— 漏了 .cn 会被判成 web，
  //    浮层小标题写成「产品官网」，行内提示也从「N 个链接」变成别的口径。
  if (/(^|\.)xhslink\.(com|cn)$/.test(host) || /(^|\.)xiaohongshu\.com$/.test(host)) {
    return 'xiaohongshu'
  }
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok'
  return 'web'
}

/** 按平台把链接分组，组间顺序 = 首次出现顺序（数据里怎么排，浮层就怎么显示）。 */
export function groupLinks(links: WorkLink[]): { platform: WorkPlatform; links: WorkLink[] }[] {
  const order: WorkPlatform[] = []
  const bucket = new Map<WorkPlatform, WorkLink[]>()
  for (const l of links) {
    const p = platformOf(l.url)
    const arr = bucket.get(p)
    if (arr) arr.push(l)
    else {
      bucket.set(p, [l])
      order.push(p)
    }
  }
  return order.map((platform) => ({ platform, links: bucket.get(platform)! }))
}

// ---------- 照片 ----------

export interface WorkPhoto {
  src: string
  /** 原图尺寸，写死给 <img> 当宽高比用 —— 浮层是绝对定位的，不写会先塌成 0 高再跳一下 */
  w: number
  h: number
  alt: string
}

export interface WorkListItem {
  name: string
  meta?: string
  tags?: string[]
  /** 单条链接（暂时没有条目用到，留着给「整条就是一个链接」的情况） */
  link?: string
  slug?: string
  /** 多条外链：hover / 点按弹出，按平台分组 */
  links?: WorkLink[]
  /** 照片：hover / 点按弹出 */
  photos?: WorkPhoto[]
}

export interface WorkGroup {
  heading: string
  items: string[]
}

export interface WorkSection {
  id: string
  no: string
  title: string
  tagline: string
  items?: WorkListItem[]
  groups?: WorkGroup[]
  awards?: string[]
  footer?: string
  footerLinks?: WorkLink[]
}

export interface WorksLang {
  title: string
  closeLabel: string
  openLabel: string
  hint: string
  awardsLabel: string
  visitLabel: string
  detailPlaceholder: string
  phImageLabel: string
  phButtonLabel: string
  countLabel: (n: number) => string
  /** 详情页里外链小节的标题（WorkDetail.tsx 用） */
  linksLabel: string
  /** 浮层里按平台分组的小标题 */
  platformTitles: Record<WorkPlatform, string>
  /** 行内常显提示：全是视频平台时用这个 */
  videosLabel: (n: number) => string
  /** 行内常显提示：混了非视频链接（产品官网等）时用这个 */
  linksCountLabel: (n: number) => string
  /** 行内常显提示：照片 */
  photosLabel: (n: number) => string
  /** 照片浮层的标题 */
  photoTitle: string
  /** 宽屏右侧预览栏的空态提示（悬停 / 聚焦作品行时，右栏换成那一行的链接与照片） */
  paneHint: string
  sections: WorkSection[]
}

// 照片路径统一从这里拼，改目录只改这一行。
// 履历区（Resume.tsx 里 GCC 那两张）也 import 这个，别在那边再拼一份 BASE_URL。
export const photo = (file: string, w: number, h: number, alt: string): WorkPhoto => ({
  src: `${import.meta.env.BASE_URL}works/photos/${file}`,
  w,
  h,
  alt,
})

// ============================================================================
// 作品集内容 —— 2026-09-17 按「修改要求.docx」补外链 / 照片、改名、删文案。
//    · 行内的数字全部来自简历原文（5w+ / 10w+ / 9k+ / 700w+ / TOP2 …），没有编。
//    · 每个 item 的 slug 指向 src/content/works/<slug>.md（详情页已下线，暂无入口）。
// ============================================================================
export const WORKS: Record<'zh' | 'en', WorksLang> = {
  zh: {
    title: '作品',
    closeLabel: '返回',
    openLabel: '展开作品',
    hint: '继续下滑',
    awardsLabel: '成果',
    visitLabel: '查看合集',
    detailPlaceholder: '这个作品的介绍还没写——在 src/content/works/ 下加同名 md 就会显示在这里。',
    phImageLabel: '图片 / 视频',
    phButtonLabel: '跳转按钮',
    countLabel: (n) => `${n} 件作品`,
    linksLabel: '链接',
    platformTitles: {
      bilibili: 'B 站 · 视频',
      douyin: '抖音 · 视频',
      xiaohongshu: '小红书 · 笔记',
      tiktok: 'TikTok · 视频',
      web: '产品官网',
    },
    videosLabel: (n) => `${n} 支视频`,
    linksCountLabel: (n) => `${n} 个链接`,
    photosLabel: (n) => `${n} 张照片`,
    photoTitle: '照片',
    paneHint: '指到某件作品上，这里会换成它的链接和照片',
    sections: [
      {
        id: 'maker',
        no: '01',
        title: '内容 · 增长实战',
        tagline: '从 0 到 1 的账号、IP 与私域',
        items: [
          {
            name: '黄浦江三文鱼',
            meta: 'B 站 10w+ 粉丝',
            tags: ['爆款 IP'],
            slug: 'content-salmon',
            // 视频标题是中文原名，不翻译（改了就对不上平台上的视频了）
            links: [
              { label: 'B站首届 AI 春晚！', url: 'https://b23.tv/Kel90DB' },
              { label: '把远古沧龙做成六道菜（上）', url: 'https://b23.tv/NTATNK3' },
              { label: '把远古沧龙做成六道菜（下）', url: 'https://b23.tv/MyrdLdA' },
            ],
          },
          {
            name: '抖音账号冷启动',
            meta: '3 个月涨粉 5w+',
            tags: ['抖音'],
            slug: 'content-douyin',
            links: [{ label: '四川大学表白墙', url: 'https://v.douyin.com/C6-zgnG_nZs/' }],
          },
          {
            name: '私域流量池',
            meta: '好友 9k+ · 变现 1.2w+',
            tags: ['私域'],
            slug: 'content-private',
            links: [{ label: '四川大学表白墙', url: 'https://v.douyin.com/C6-zgnG_nZs/' }],
          },
          {
            name: '双账号全流程运营',
            meta: '700w+ / 9.7w+ 粉',
            tags: ['代运营'],
            slug: 'content-accounts',
            links: [
              { label: '歪果仁在太原', url: 'https://v.douyin.com/wioYJ7OVK9s/' },
              { label: '樊晓丁', url: 'https://v.douyin.com/YjRgzq5maB4/' },
            ],
          },
        ],
        footer: '视频剪辑 · 视觉内容输出 · 广告商务对接 · 引流话术设计',
        // 这一行挂的是「剪辑作品」，不是自己的账号 —— 抖音 4 条 + 小红书 2 条，浮层里分两组
        footerLinks: [
          { label: '咪有自己的地球转场 · 坦克一斤半', url: 'https://v.douyin.com/bDRAJZEGK6I/' },
          { label: '乱七八糟的印尼之旅 · GEZE', url: 'https://v.douyin.com/HZCjoF3f2eE/' },
          { label: '独属于无耻之徒的转场 · 炜神.Elvisual', url: 'https://v.douyin.com/l-ALu_W40BQ/' },
          { label: '尊重每一只青蛙和它的井 · 在无人区看超市', url: 'https://v.douyin.com/r62ziCQb3h4/' },
          { label: '中式养发太牛了！3 个巨简单的懒人养发思路', url: 'http://xhslink.com/o/AbKmQsc6FEz' },
          { label: '长痘必看！章若楠 3R 祛痘法', url: 'http://xhslink.com/o/69q2VqSAXWW' },
        ],
      },
      {
        id: 'product',
        no: '02',
        title: 'AI · AIGC / Agent',
        tagline: '把 AI 用成能复用的工作流',
        items: [
          {
            name: 'Agent 工作流搭建',
            meta: 'CC · Codex · Gemini · GPT',
            tags: ['Agent'],
            slug: 'ai-agent',
            // 2026-09-19 补：同一篇「GPT 领英证件照提示词」发了两个平台。
            // 抖音那条是图文（不是视频），所以 hint 走「N 个链接」而不是「N 支视频」
            // （判定改在 Works.tsx：混了小红书笔记 / 抖音图文就不算纯视频）。
            links: [
              { label: 'GPT 领英证件照提示词', url: 'https://v.douyin.com/q7kwaZ5yGTY/' },
              { label: '试过很多提示词，这个最让我满意', url: 'https://xhslink.cn/o/33zakvMDfd1' },
            ],
          },
          {
            name: 'AI 产品海外增长',
            meta: 'Genshot · Gizmo · X-polit',
            tags: ['北美'],
            slug: 'ai-growth',
            links: [
              { label: 'GenShot · 智能视频创作平台', url: 'https://genshot.ai/zh' },
              { label: 'Gizmo · Android 版 APK 下载', url: 'https://gizmo-make-gizmos.en.uptodown.com/android' },
              { label: 'X-Pilot · 面向课程与培训的 AI 视频生产', url: 'https://www.x-pilot.ai/' },
            ],
          },
          {
            name: 'AIGC 内容与视频',
            meta: 'Veo3 · 即梦 · 可灵',
            tags: ['AIGC'],
            slug: 'ai-aigc',
            // 2026-09-17 追加：抖音那条 AI 短片（「谁可以当主角」）
            links: [
              { label: '谁可以当主角 · 丧尸 / AI / AIGC', url: 'https://v.douyin.com/XHV54WeHqsc/' },
              { label: '@pokemon_master07', url: 'https://www.tiktok.com/@pokemon_master07' },
              { label: '@ronoinoo', url: 'https://www.tiktok.com/@ronoinoo' },
            ],
          },
        ],
        footer: '市场调研 · 竞品分析 · 脚本生成 · 素材优化 · 数据复盘',
      },
      {
        id: 'ad',
        no: '03',
        title: '影像 · 参演',
        tagline: '上海新天地 · 三角洲行动 TVC',
        items: [
          {
            name: '上海新天地 TVC',
            meta: '出镜参演',
            slug: 'ad-xintiandi',
            photos: [photo('ad-xintiandi-1.jpg', 1098, 1100, '上海新天地 TVC 拍摄现场')],
          },
          {
            name: '《三角洲行动》TVC',
            meta: '出镜参演',
            slug: 'ad-delta-force',
            links: [{ label: '二周年 · 我来同你玩', url: 'https://v.douyin.com/qGLjIt0PAZE/' }],
          },
        ],
      },
      {
        id: 'graphics',
        no: '04',
        title: '旅途 · 数字游民',
        tagline: '一个人去的三个国家',
        items: [
          {
            name: '阿联酋',
            slug: 'travel-uae',
            photos: [photo('travel-uae-1.jpg', 1100, 825, '阿联酋 · 迪拜夜晚的草坪聚会')],
          },
          {
            name: '埃及',
            slug: 'travel-egypt',
            photos: [
              photo('travel-egypt-1.jpg', 1100, 825, '埃及 · 红海边'),
              photo('travel-egypt-2.jpg', 1100, 967, '埃及 · 金字塔前'),
            ],
          },
          {
            name: '泰国',
            slug: 'travel-thailand',
            photos: [
              photo('travel-thailand-1.jpg', 1100, 777, '泰国 · 靶场'),
              photo('travel-thailand-2.jpg', 825, 1100, '泰国 · ATV 越野'),
            ],
          },
        ],
      },
    ],
  },
  en: {
    title: 'Works',
    closeLabel: 'Back',
    openLabel: 'Explore',
    hint: 'Keep scrolling',
    awardsLabel: 'Results',
    visitLabel: 'View collection',
    detailPlaceholder:
      'No write-up for this one yet — add a matching md under src/content/works/ and it shows up here.',
    phImageLabel: 'Image / Video',
    phButtonLabel: 'Link button',
    countLabel: (n) => `${n} works`,
    linksLabel: 'Links',
    platformTitles: {
      bilibili: 'On Bilibili',
      douyin: 'On Douyin',
      xiaohongshu: 'On Xiaohongshu',
      tiktok: 'On TikTok',
      web: 'Product site',
    },
    videosLabel: (n) => `${n} videos`,
    linksCountLabel: (n) => `${n} links`,
    photosLabel: (n) => `${n} photos`,
    photoTitle: 'Photos',
    paneHint: 'Point at a work to see its links and photos here',
    sections: [
      {
        id: 'maker',
        no: '01',
        title: 'Content · Growth',
        tagline: 'Accounts, IP and owned audiences, built from zero',
        items: [
          {
            name: 'Huangpu River Salmon',
            meta: '100k+ followers on Bilibili',
            tags: ['Viral IP'],
            slug: 'content-salmon',
            links: [
              { label: 'B站首届 AI 春晚！', url: 'https://b23.tv/Kel90DB' },
              { label: '把远古沧龙做成六道菜（上）', url: 'https://b23.tv/NTATNK3' },
              { label: '把远古沧龙做成六道菜（下）', url: 'https://b23.tv/MyrdLdA' },
            ],
          },
          {
            name: 'Douyin cold start',
            meta: '50k+ followers in 3 months',
            tags: ['Douyin'],
            slug: 'content-douyin',
            links: [{ label: '四川大学表白墙', url: 'https://v.douyin.com/C6-zgnG_nZs/' }],
          },
          {
            name: 'Owned-audience pool',
            meta: '9k+ contacts · 12k+ RMB',
            tags: ['Private domain'],
            slug: 'content-private',
            links: [{ label: '四川大学表白墙', url: 'https://v.douyin.com/C6-zgnG_nZs/' }],
          },
          {
            name: 'Two accounts, run end to end',
            meta: '7M+ / 97k+ followers',
            tags: ['Ops'],
            slug: 'content-accounts',
            links: [
              { label: '歪果仁在太原', url: 'https://v.douyin.com/wioYJ7OVK9s/' },
              { label: '樊晓丁', url: 'https://v.douyin.com/YjRgzq5maB4/' },
            ],
          },
        ],
        footer: 'Video editing · Visual production · Advertiser deals · Funnel copywriting',
        footerLinks: [
          { label: '咪有自己的地球转场 · 坦克一斤半', url: 'https://v.douyin.com/bDRAJZEGK6I/' },
          { label: '乱七八糟的印尼之旅 · GEZE', url: 'https://v.douyin.com/HZCjoF3f2eE/' },
          { label: '独属于无耻之徒的转场 · 炜神.Elvisual', url: 'https://v.douyin.com/l-ALu_W40BQ/' },
          { label: '尊重每一只青蛙和它的井 · 在无人区看超市', url: 'https://v.douyin.com/r62ziCQb3h4/' },
          { label: '中式养发太牛了！3 个巨简单的懒人养发思路', url: 'http://xhslink.com/o/AbKmQsc6FEz' },
          { label: '长痘必看！章若楠 3R 祛痘法', url: 'http://xhslink.com/o/69q2VqSAXWW' },
        ],
      },
      {
        id: 'product',
        no: '02',
        title: 'AI · AIGC / Agents',
        tagline: 'Turning AI into reusable workflows',
        items: [
          {
            name: 'Agent workflow building',
            meta: 'CC · Codex · Gemini · GPT',
            tags: ['Agents'],
            slug: 'ai-agent',
            links: [
              { label: 'LinkedIn headshot prompt for GPT', url: 'https://v.douyin.com/q7kwaZ5yGTY/' },
              { label: 'Tried dozens of prompts — this one stuck', url: 'https://xhslink.cn/o/33zakvMDfd1' },
            ],
          },
          {
            name: 'Overseas growth for AI products',
            meta: 'Genshot · Gizmo · X-polit',
            tags: ['North America'],
            slug: 'ai-growth',
            links: [
              { label: 'GenShot · AI video creation platform', url: 'https://genshot.ai/zh' },
              { label: 'Gizmo · Android APK download', url: 'https://gizmo-make-gizmos.en.uptodown.com/android' },
              { label: 'X-Pilot · AI video for courses & training', url: 'https://www.x-pilot.ai/' },
            ],
          },
          {
            name: 'AIGC content & video',
            meta: 'Veo3 · Jimeng · Kling',
            tags: ['AIGC'],
            slug: 'ai-aigc',
            links: [
              { label: '谁可以当主角 · 丧尸 / AI / AIGC', url: 'https://v.douyin.com/XHV54WeHqsc/' },
              { label: '@pokemon_master07', url: 'https://www.tiktok.com/@pokemon_master07' },
              { label: '@ronoinoo', url: 'https://www.tiktok.com/@ronoinoo' },
            ],
          },
        ],
        footer: 'Market research · Competitive analysis · Scripting · Asset ops · Data review',
      },
      {
        id: 'ad',
        no: '03',
        title: 'Film · On Camera',
        tagline: 'TVCs: Shanghai Xintiandi · Delta Force',
        items: [
          {
            name: 'Shanghai Xintiandi TVC',
            meta: 'On camera',
            slug: 'ad-xintiandi',
            photos: [photo('ad-xintiandi-1.jpg', 1098, 1100, 'On the set of the Shanghai Xintiandi TVC')],
          },
          {
            name: 'Delta Force TVC',
            meta: 'On camera',
            slug: 'ad-delta-force',
            links: [{ label: '二周年 · 我来同你玩', url: 'https://v.douyin.com/qGLjIt0PAZE/' }],
          },
        ],
      },
      {
        id: 'graphics',
        no: '04',
        title: 'Travel · Digital Nomad',
        tagline: 'Three countries, travelling solo',
        items: [
          {
            name: 'UAE',
            slug: 'travel-uae',
            photos: [photo('travel-uae-1.jpg', 1100, 825, 'UAE · a night gathering on the lawn in Dubai')],
          },
          {
            name: 'Egypt',
            slug: 'travel-egypt',
            photos: [
              photo('travel-egypt-1.jpg', 1100, 825, 'Egypt · by the Red Sea'),
              photo('travel-egypt-2.jpg', 1100, 967, 'Egypt · in front of the pyramids'),
            ],
          },
          {
            name: 'Thailand',
            slug: 'travel-thailand',
            photos: [
              photo('travel-thailand-1.jpg', 1100, 777, 'Thailand · at the shooting range'),
              photo('travel-thailand-2.jpg', 825, 1100, 'Thailand · ATV trail riding'),
            ],
          },
        ],
      },
    ],
  },
}

// 板块配图（横向画廊每张卡片左侧的整高封面）。放到 public/works/covers/ 下。
// 缺图时左栏用大编号渐变占位，放入图片后自动点亮。
export const SECTION_COVERS: Record<string, string> = {
  ad: `${import.meta.env.BASE_URL}works/covers/ad.jpg`,
  maker: `${import.meta.env.BASE_URL}works/covers/maker.jpg`,
  product: `${import.meta.env.BASE_URL}works/covers/product.jpg`,
  graphics: `${import.meta.env.BASE_URL}works/covers/graphics.jpg`,
}

// 统计一个板块的作品数（items 或 groups 求和），用于索引行 hover 显示
export function sectionCount(section: WorkSection): number {
  if (section.items) return section.items.length
  if (section.groups) return section.groups.reduce((n, g) => n + g.items.length, 0)
  return 0
}
