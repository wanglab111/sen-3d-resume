import { motion } from 'framer-motion'
import { CONTACT_CARD, IS_NATIVE_DOMAIN } from '../chat/config'
import { openChat } from '../chat/open'

// ============================================================================
// 收尾板块：个人总结 + 联系方式
//
// 为什么要有这一块 —— 这个站点是给面试官点开看的，他们滑到底之后想知道：怎么联系到她。
//
// 2026-09-17 按「修改要求.docx」删掉了两块：
//   · 开场那句「每周到岗 5 天，可实习 6 个月。」—— 招聘口径的自我推销，删。
//   · 「这一页是怎么做的」整块（原来列了用到哪些技术）—— 连标题带下面那串技术清单一起删。
//     ⚠️ 别顺手加回来：那是她早期的诉求（"先让他们知道我的网站搭建能力"），
//        后来自己觉得没必要说了（"去掉这一页是怎么做的，以及后面的"）。
// 标题也不叫「联系我」了（说太土），改成「保持联系」。
// ============================================================================

const CONTACTS = [
  // 2026-09-20：按用户要求换回 3134562057@qq.com（2026-09-17 曾按「修改要求.docx」换成 outlook）。
  { id: 'mail', label: '邮箱', value: '3134562057@qq.com', href: 'mailto:3134562057@qq.com' },
  { id: 'tel', label: '电话', value: '+86 176 3590 0067', href: 'tel:+8617635900067' },
  {
    id: 'works',
    label: '作品合集',
    value: '账号与视频 ↗',
    href: 'https://www.kdocs.cn/l/ch7qExbZyDpg',
    external: true,
  },
]

// 简历「个人总结」四句，原样搬过来（只做了断句，没改措辞）。
// 放这里而不是首屏：首屏 About 那条有「最多两行」的硬约束（见 App.tsx），塞不下四句。
const SUMMARY = [
  '应数理学学士，具备极强的数理逻辑推理基础，复合型增长实战背景。',
  // 2026-09-18 用户：「不要写海外 AI 增长，改成全球 AI 增长」——
  // 站内所有**描述她方向**的话统一用「全球」；只有履历里那个真实岗位名
  // （Resume.tsx 的「海外 AI 产品增长实习生」）保持原样，那是职位全称。
  '深耕 AI 全球用户增长，熟练使用 AI Agent 工具搭建自动化内容工作流。',
  '兼具跨境数据分析、公私域 IP 运营、品牌社媒传播及科创政企活动执行能力，打造多平台万粉 IP。',
  '雅思 7.0，拥有独自旅居多国的经历，具有极强的学习、环境适应和解决突发问题的能力。',
]

const EASE = [0.22, 1, 0.36, 1]

export default function Contact() {
  return (
    <section className="contact" lang="zh">
      <motion.div
        className="contact-inner"
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-14% 0px' }}
        transition={{ duration: 0.8, ease: EASE }}
      >
        <h2 className="contact-title">保持联系</h2>

        <div className="contact-summary">
          <span className="contact-summary-label">个人总结</span>
          <ol className="contact-summary-list">
            {SUMMARY.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>

        <div className="contact-grid">
          {CONTACTS.map((c) => (
            <a
              key={c.id}
              className="contact-card"
              href={c.href}
              {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              <span className="ct-k">{c.label}</span>
              <span className="ct-v">{c.value}</span>
            </a>
          ))}
          <div className="contact-card is-static">
            <span className="ct-k">现在在</span>
            <span className="ct-v">上海</span>
          </div>
          {/* AI 分身的第二个入口（见 chat/open.ts）。
              非原生域名（GitHub Pages / 自有域名）下分身不可用，整块不渲染，
              避免访客点开看到「这个页面要在它自己的域名下打开才管用」。 */}
          {IS_NATIVE_DOMAIN && (
            <button type="button" className="contact-card contact-card--chat" onClick={openChat}>
              <span className="ct-k">{CONTACT_CARD.label}</span>
              <span className="ct-v">{CONTACT_CARD.value}</span>
            </button>
          )}
        </div>
      </motion.div>
    </section>
  )
}
