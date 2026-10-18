import { z } from 'zod'

export const CHAT_LIMITS = {
  sessions: 200,
  active: 4,
  textChars: 200_000,
  imageCount: 4,
  imageBytes: 5 * 1024 * 1024,
  totalImageBytes: 12 * 1024 * 1024,
  transcriptBytes: 128 * 1024 * 1024,
  historyMessages: 1000,
} as const

export const chatThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const chatIdSchema = z.string().uuid()
export const chatTitleSchema = z.string().trim().min(1).max(160)
export const chatModelSchema = z.string().min(3).max(512).refine((value) => {
  const slash = value.indexOf('/')
  return slash > 0 && slash < value.length - 1 && !/[\s\x00-\x1f\x7f]/.test(value)
}, 'Expected provider/modelId')
export function splitChatModel(value: string): [string, string] {
  chatModelSchema.parse(value)
  const slash = value.indexOf('/')
  return [value.slice(0, slash), value.slice(slash + 1)]
}

export const chatImageSchema = z.object({
  data: z.string().min(4).max(Math.ceil(CHAT_LIMITS.imageBytes / 3) * 4)
    .refine((data) => data.length <= Math.ceil(CHAT_LIMITS.imageBytes / 3) * 4 && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data) && Buffer.from(data, 'base64').toString('base64') === data, 'Invalid base64')
    .refine((data) => Buffer.byteLength(data, 'base64') <= CHAT_LIMITS.imageBytes, 'Image too large'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
}).strict().refine(({ data, mimeType }) => {
  const bytes = Buffer.from(data.slice(0, 32), 'base64')
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
}, 'Image signature does not match MIME type')

export const chatSchemas = {
  list: z.object({}).strict().default({}),
  models: z.object({}).strict().default({}),
  create: z.object({ title: chatTitleSchema.optional(), model: chatModelSchema.optional(), thinkingLevel: chatThinkingLevelSchema.optional() }).strict().default({}),
  setThinking: z.object({ id: chatIdSchema, level: chatThinkingLevelSchema }).strict(),
  open: z.object({ id: chatIdSchema }).strict(),
  abort: z.object({ id: chatIdSchema }).strict(),
  delete: z.object({ id: chatIdSchema }).strict(),
  rename: z.object({ id: chatIdSchema, title: chatTitleSchema }).strict(),
  send: z.object({
    id: chatIdSchema,
    text: z.string().max(CHAT_LIMITS.textChars),
    images: z.array(chatImageSchema).max(CHAT_LIMITS.imageCount).optional(),
  }).strict().refine(({ text, images }) => text.trim().length > 0 || !!images?.length, 'Empty message')
    .refine(({ images }) => (images ?? []).reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0) <= CHAT_LIMITS.totalImageBytes, 'Images too large'),
}
