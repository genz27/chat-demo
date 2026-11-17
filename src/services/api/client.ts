import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readServerSentEvents } from './sse.js'
import { createId } from '../../utils/id.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** haqimi.uk 的 OpenAI-compatible API 地址。 */
export const API_ORIGIN = __API_ORIGIN__
const OPENAI_BASE_URL = `${API_ORIGIN}/v1`

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文。
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey === '__CHAT_API_KEY__' ? {} : { Authorization: `Bearer ${apiKey}` }

/** 用 GET /v1/models 校验 API Key（不产生费用）。 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${OPENAI_BASE_URL}/models`, {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal,
  })
}

/** OpenAI Files API 上传附件。 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  form.append('purpose', purpose === 'rich_layout_recognition' ? 'assistants' : 'user_data')
  form.append('file', file)
  const response = await request(`${OPENAI_BASE_URL}/files`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /v1/files/{file_id}. */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${OPENAI_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  })
}

type OpenAiMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** 将本地历史结构转换成 OpenAI Chat Completions 消息。 */
const toOpenAiMessages = (body: CreateMessageRequest) => [
  { role: 'system' as const, content: body.system },
  ...body.messages.flatMap((message): OpenAiMessage[] => {
    if (message.role === 'latest_reminder') {
      return [{ role: 'system', content: message.content }]
    }
    if (typeof message.content === 'string') {
      return [{ role: message.role, content: message.content }]
    }
    const text = message.content
      .map((block) => ('text' in block ? block.text : `[${block.type}]`))
      .join('\n')
    return text ? [{ role: message.role, content: text }] : []
  }),
]

type OpenAiChunk = {
  id?: string
  choices?: Array<{
    delta?: { content?: string }
    finish_reason?: string | null
  }>
}

/** POST /v1/chat/completions，并翻译为现有消息状态机使用的事件。 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: body.model,
      messages: toOpenAiMessages(body),
      stream: true,
      ...(body.reasoning ? { reasoning: body.reasoning } : {}),
    }),
    signal,
  })
  if (!response.body) {
    throw await readErrorResponse(response, 'protocol', '')
  }

  let blockStarted = false
  const blockIndex = 0
  const messageId = createId()
  yield { type: 'message_start', message: { id: messageId, model: body.model } }

  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      if (blockStarted) {
        yield { type: 'content_block_stop', index: blockIndex }
      }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
      yield { type: 'message_stop' }
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    const chunk = payload as OpenAiChunk
    const choice = chunk.choices?.[0]
    const text = choice?.delta?.content
    if (text) {
      if (!blockStarted) {
        blockStarted = true
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } }
    }
    if (choice?.finish_reason) {
      if (blockStarted) {
        yield { type: 'content_block_stop', index: blockIndex }
      }
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
          stop_sequence: null,
        },
      }
      yield { type: 'message_stop' }
      return
    }
  }
  throw new ApiError('interrupted', '')
}
