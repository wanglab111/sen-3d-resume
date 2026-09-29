// 作品「全屏沉浸详情」面板 —— 2026-09-17 起**已从作品区摘除**。
//
// 用户要求：作品区的所有条目都不再能点开，最多只弹出外链浮层。
// 所以 Works.tsx 不再 import 这个文件，它也就不会进打包产物
// （顺带把 react-markdown / remark-gfm / rehype-raw 一起从产物里摘掉了，首屏更轻）。
//
// 组件本身一行没改，连同 styles.css 里的 .wk-detail-* 样式一起留着。
// 要恢复详情页：
//   1) Works.tsx 里 import WorkDetail（默认导出）；
//   2) 加回 active 状态 + 把 onOpen={setActive} 一路传下去 + <AnimatePresence> 那段渲染；
//   3) 把 WorkLine 的行元素换回 <button>（详情要靠整行点击触发）。
import { useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import type { WorkListItem, WorksLang } from '../data/works'
import { getWorkDoc } from '../data/workDocs'
import { BilibiliIcon } from './SocialIcons'

const EASE = [0.22, 1, 0.36, 1]

// 全屏沉浸详情：渲染该作品的 md（banner + 标题 + markdown 正文 + 外链）；
// 无 md 时回退到占位 banner + meta/标签简介
function WorkDetail({
  item,
  data,
  onClose,
}: {
  item: WorkListItem
  data: WorksLang
  onClose: () => void
}) {
  const [bannerError, setBannerError] = useState(false)
  const doc = getWorkDoc(item.slug)
  const title = (doc && doc.title) || item.name
  const banner = doc && doc.banner
  // 有 md 详情时展示完整信息；无 md 时详情页只保留标题 + 统一占位文案
  const link = doc ? doc.link || item.link : null
  const links = item.links && item.links.length ? item.links : null
  const tags = doc ? doc.tags || item.tags : null
  // 副标题不含年份；标签单独做 badge 展示
  const sub = doc ? [item.meta, doc.role].filter(Boolean).join('  ·  ') : ''

  return (
    <>
      <motion.div
        className="wk-detail-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        onClick={onClose}
      />
      <motion.div
        className="wk-detail"
        initial={{ opacity: 0, scale: 0.985, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.99, y: 6 }}
        transition={{ duration: 0.42, ease: EASE }}
      >
        <button className="wk-detail-close" onClick={onClose} aria-label={data.closeLabel}>
          ✕
        </button>

        {banner && !bannerError ? (
          <div className="wk-detail-banner">
            <img src={banner} alt={title} onError={() => setBannerError(true)} />
          </div>
        ) : (
          <div className="wk-detail-banner is-ph" aria-hidden="true">
            <span className="wk-detail-ph-text">{title}</span>
          </div>
        )}

        <article className="wk-detail-article">
          <header className="wk-detail-head">
            <h3 className="wk-detail-title">{title}</h3>
            {sub && <div className="wk-detail-sub">{sub}</div>}
            {tags && tags.length > 0 && (
              <div className="wk-detail-tags">
                {tags.map((t, i) => (
                  <span key={i} className="wk-badge">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </header>

          {links && (
            <div className="wk-detail-links">
              <span className="wk-detail-links-title">
                <BilibiliIcon className="wk-pop-title-ico" />
                {data.linksLabel}
              </span>
              <ul className="wk-pop-list">
                {links.map((l) => (
                  <li key={l.url}>
                    <a
                      className="wk-pop-link"
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="wk-pop-link-label">{l.label}</span>
                      <span className="wk-pop-link-ico" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {doc && doc.body ? (
            <div className="wk-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                {doc.body}
              </ReactMarkdown>
            </div>
          ) : (
            <>
              <p className="wk-detail-desc">{data.detailPlaceholder}</p>
              <div className="wk-detail-ph-img" aria-hidden="true">
                <span className="wk-detail-ph-img-label">{data.phImageLabel}</span>
              </div>
              <span className="wk-detail-link is-ph" role="button" aria-disabled="true">
                {data.phButtonLabel} <span aria-hidden="true">↗</span>
              </span>
            </>
          )}

          {link && (
            <a
              className="wk-detail-link"
              href={link}
              target="_blank"
              rel="noopener noreferrer"
            >
              {data.visitLabel} <span aria-hidden="true">↗</span>
            </a>
          )}
        </article>
      </motion.div>
    </>
  )
}

export default WorkDetail
