import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/index.ts'
import type {
  ImageAttachmentRef,
  SaveImageAttachment,
  StreamImageAttachment,
  StoredImageAttachment,
} from '../src/types.ts'

function chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values
    },
  }
}

class MemoryAttachmentStore extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 4,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 6,
    maxImagePixels: 4,
    mediaTypes: ['image/png'] as const,
  }

  readonly validateImage = vi.fn(async (_input: SaveImageAttachment): Promise<void> => {})
  readonly saveImage = vi.fn(async (input: SaveImageAttachment): Promise<ImageAttachmentRef> => ({
    attachmentId: `att-${String(input.data[0])}` as never,
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }))

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('测试不读取附件'))
  }
}

function source(data: readonly number[], name?: string): StreamImageAttachment {
  const bytes = Uint8Array.from(data)
  return {
    chunks: chunks(bytes.subarray(0, 1), bytes.subarray(1)),
    bytes: bytes.byteLength,
    mediaType: 'image/png',
    ...name === undefined ? {} : { name },
  }
}

describe('AttachmentStore.prepareImages', () => {
  it('先完整校验批次，提交时才按原顺序发布对象', async () => {
    const store = new MemoryAttachmentStore(new Context())

    const prepared = await store.prepareImages([
      source([1, 2], 'first.png'),
      source([3]),
    ])

    expect(store.validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1, 2], [3]])
    expect(store.saveImage).not.toHaveBeenCalled()
    await expect(prepared.commit()).resolves.toEqual([
      expect.objectContaining({ attachmentId: 'att-1', name: 'first.png' }),
      expect.objectContaining({ attachmentId: 'att-3' }),
    ])
    expect(store.saveImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1, 2], [3]])
    await prepared.dispose()
  })

  it('拒绝声明长度不符、单图超限、总量超限和数量超限的批次', async () => {
    const store = new MemoryAttachmentStore(new Context())
    const mismatch: StreamImageAttachment = {
      chunks: chunks(Uint8Array.of(1, 2)),
      bytes: 1,
      mediaType: 'image/png',
    }

    await expect(store.prepareImages([mismatch]))
      .rejects.toMatchObject({ code: 'IMAGE_LENGTH_MISMATCH' })
    await expect(store.prepareImages([source([1, 2, 3, 4, 5])]))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await expect(store.prepareImages([source([1, 2, 3]), source([4, 5, 6, 7])]))
      .rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    await expect(store.prepareImages([source([1]), source([2]), source([3])]))
      .rejects.toMatchObject({ code: 'TOO_MANY_IMAGES' })
    expect(store.validateImage).not.toHaveBeenCalled()
    expect(store.saveImage).not.toHaveBeenCalled()
  })
})

describe('AttachmentStore.readImagePreview', () => {
  it('默认 Provider 复用已核验原图，允许本地 Provider 覆盖为缩略图', async () => {
    const store = new MemoryAttachmentStore(new Context())
    const ref = {
      attachmentId: 'att-preview' as never,
      mediaType: 'image/png' as const,
      bytes: 2,
      width: 1,
      height: 1,
    }
    store.readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))

    await expect(store.readImagePreview(ref, 480)).resolves.toEqual({
      mediaType: 'image/png',
      data: Uint8Array.of(1, 2),
    })
  })
})
