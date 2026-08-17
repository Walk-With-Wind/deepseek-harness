import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachmentRef, ImageReadPurpose } from '@deepseek-ai/dsh-attachment'
import { ImageLightbox } from './ImageLightbox.tsx'
import type { ImageLightboxLabels } from './ImageLightbox.tsx'
import css from './MessageImage.module.css'

/** 历史图片读取用途；列表只保留缩略图，灯箱按需读取原图。 */
export type ImageLoadPurpose = ImageReadPurpose

/** 读取一条经会话授权的持久图片 URL。 */
export type ImageLoader = (attachment: ImageAttachmentRef, purpose: ImageLoadPurpose) => Promise<string>

/** 持有方从自身 locale 命名空间解析的消息图片文案。 */
export interface MessageImageLabels {
  /** Fallback display name for an unnamed image. */
  image: string
  /** Thumbnail tooltip inviting the original-image preview. */
  open: string
  /** Accessible thumbnail label; receives the image's display name. */
  openNamed: (label: string) => string
  /** Loading placeholder shown until bytes resolve. */
  loading: string
  /** Retry-control label shown when the load fails. */
  loadFailed: string
  /** Lightbox strings forwarded to the opened preview. */
  lightbox: ImageLightboxLabels
}

/** 单图展示框：长边 240px，显示比例限制在 [0.25, 4]，不放大超过原始尺寸；
 * 超长图保留顶部，超宽图保留左侧，其余居中裁切。 */
function singleFit(attachment: ImageAttachmentRef): { width: number; height: number; objectPosition: string } {
  const natural = attachment.width / attachment.height
  const ratio = Math.min(4, Math.max(0.25, natural))
  const box = ratio >= 1 ? { width: 240, height: 240 / ratio } : { width: 240 * ratio, height: 240 }
  const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height)
  return {
    width: Math.max(1, Math.round(box.width * scale)),
    height: Math.max(1, Math.round(box.height * scale)),
    objectPosition: natural < 0.25 ? 'center top' : natural > 4 ? 'left center' : 'center',
  }
}

/**
 * 按可见性读取历史缩略图，并在用户打开灯箱时按需读取原图。
 * 单图使用 `singleFit` 尺寸，多图中的每张固定为 64px 方块。
 *
 * @param props.attachment - 需要读取并约束尺寸的持久图片引用。
 * @param props.load - 经会话授权的 URL 加载器。
 * @param props.variant - 消息仅一张图片时为 `single`，否则为 `tile`。
 * @param props.labels - 已解析的提示、加载、重试与灯箱文案。
 * @returns 有界缩略图按钮，或读取失败后的重试控件。
 */
export function MessageImage({ attachment, load, variant, labels }: {
  attachment: ImageAttachmentRef
  load: ImageLoader
  variant: 'single' | 'tile'
  labels: MessageImageLabels
}) {
  const frameRef = useRef<HTMLButtonElement | null>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [src, setSrc] = useState<string | null>(null)
  const [originalSrc, setOriginalSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  // Retry re-arms the one load effect below, so every attempt — first load or
  // retry — runs under the same liveness guard and the same reset.
  const [attempt, setAttempt] = useState(0)
  const request = useCallback(() => { setAttempt(a => a + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])
  const fit = useMemo(
    () => (variant === 'single' ? singleFit(attachment) : undefined),
    [attachment, variant],
  )

  useEffect(() => {
    if (visible) return
    const frame = frameRef.current
    if (frame === null) return
    // 提前一个小视口触发缩略图，既避免滚动到空白卡片，也不读取远离可见区的历史原图。
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      setVisible(true)
    }, { rootMargin: '256px 0px' })
    observer.observe(frame)
    return () => { observer.disconnect() }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let live = true
    setError(false)
    setSrc(null)
    setOriginalSrc(null)
    setOpen(false)
    void load(attachment, 'thumbnail')
      .then((url) => { if (live) setSrc(url) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [attachment, load, attempt, visible])

  useEffect(() => {
    if (!open || src === null || originalSrc !== null) return
    let live = true
    // 灯箱先展示已就绪缩略图，再无闪烁地替换为按需读取的原图。
    void load(attachment, 'original')
      .then((url) => { if (live) setOriginalSrc(url) })
      .catch(() => {
        // 原图读取失败时保留可用缩略图；关闭后再次打开会重新尝试。
      })
    return () => { live = false }
  }, [attachment, load, open, originalSrc, src])

  const label = attachment.name ?? labels.image
  if (error) return <button type="button" className={css.error} data-variant={variant} onClick={request}>{labels.loadFailed}</button>
  return (
    <>
      <button
        ref={frameRef}
        type="button"
        className={css.frame}
        data-variant={variant}
        style={fit === undefined ? undefined : { width: fit.width, height: fit.height }}
        title={labels.open}
        aria-label={labels.openNamed(label)}
        onClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null
          ? <span className={css.loading}>{labels.loading}</span>
          : <img loading="lazy" decoding="async" src={src} alt={label} style={fit === undefined ? undefined : { objectPosition: fit.objectPosition }} />}
      </button>
      {open && src !== null && <ImageLightbox src={originalSrc ?? src} alt={label} labels={labels.lightbox} onClose={close} />}
    </>
  )
}

/** 用户与助手历史共用的换行图片组：单图放大，多图使用 64px 方块。 */
export function ImageGallery({ images, load, align, labels }: {
  images: readonly { attachment: ImageAttachmentRef }[]
  load: ImageLoader
  align: 'start' | 'end'
  labels: MessageImageLabels
}) {
  if (images.length === 0) return null
  const variant = images.length === 1 ? 'single' : 'tile'
  return (
    <div className={css.gallery} data-align={align}>
      {images.map((image, index) => (
        <MessageImage key={`${image.attachment.attachmentId}:${index}`} {...image} load={load} variant={variant} labels={labels} />
      ))}
    </div>
  )
}
