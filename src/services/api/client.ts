import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readServerSentEvents } from './sse.js'
import { createId } from '../../utils/id.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  TextCitation,
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

type ResponseAnnotation = { type?: string; url?: string; title?: string }
type ResponseOutput = {
  type?: string
  content?: { type?: string; text?: string; annotations?: ResponseAnnotation[] }[]
}
type ResponseState = {
  status?: string
  output?: ResponseOutput[]
  error?: { message?: string } | null
  incomplete_details?: { reason?: string } | null
}
type ResponseEvent = {
  type?: string
  delta?: string
  text?: string
  message?: string
  output_index?: number
  content_index?: number
  annotation?: ResponseAnnotation
  response?: ResponseState
  error?: { message?: string }
}

/** Grok 默认声明 Web/X 搜索，使用 Responses SSE；不把推理摘要或工具过程当作回答。 */
async function* streamGrokResponse(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const effort = body.reasoning?.effort
  const response = await request(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: body.model,
      input: toOpenAiMessages(body),
      stream: true,
      store: false,
      reasoning: { summary: 'auto', ...(effort && effort !== 'auto' ? { effort } : {}) },
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
    }),
    signal,
  })
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', 'Expected a Responses event stream.')
  }

  yield { type: 'message_start', message: { id: createId(), model: body.model } }
  let started = false
  let answer = ''
  const parts = new Map<string, string>()
  const citations = new Map<string, TextCitation>()
  function* appendText(text: string): Generator<MessageStreamEvent> {
    if (!text) {
      return
    }
    if (!started) {
      started = true
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    }
    answer += text
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  }
  const addCitation = (annotation: ResponseAnnotation) => {
    if (annotation.type !== 'url_citation' || !annotation.url?.match(/^https?:\/\//i)) {
      return
    }
    citations.set(annotation.url, {
      type: 'web_search_result_location',
      url: annotation.url,
      title: annotation.title ?? null,
      cited_text: answer,
      encrypted_index: '',
    })
  }

  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
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
    if (typeof payload !== 'object' || payload === null) {
      continue
    }
    const event = payload as ResponseEvent
    const type = event.type ?? eventName
    if (type === 'error' || type === 'response.failed') {
      throw new ApiError(
        'stream',
        event.response?.error?.message ?? event.message ?? 'Grok request failed.'
      )
    }
    const key = `${event.output_index ?? 0}:${event.content_index ?? 0}`
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      parts.set(key, (parts.get(key) ?? '') + event.delta)
      yield* appendText(event.delta)
    } else if (type === 'response.output_text.done' && typeof event.text === 'string') {
      const previous = parts.get(key) ?? ''
      if (event.text.startsWith(previous)) {
        yield* appendText(event.text.slice(previous.length))
      }
      parts.set(key, event.text)
    } else if (type === 'response.output_text.annotation.added' && event.annotation) {
      addCitation(event.annotation)
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const state = event.response
      if (state?.error || state?.status === 'failed' || state?.status === 'cancelled') {
        throw new ApiError('stream', state.error?.message ?? 'Grok request failed.')
      }
      // Some providers only deliver the final output rather than text deltas.
      for (const [outputIndex, item] of (state?.output ?? []).entries()) {
        for (const [contentIndex, content] of (item.content ?? []).entries()) {
          if (content.type !== 'output_text' || typeof content.text !== 'string') {
            continue
          }
          const partKey = `${outputIndex}:${contentIndex}`
          const previous = parts.get(partKey) ?? ''
          if (content.text.startsWith(previous)) {
            yield* appendText(content.text.slice(previous.length))
          }
          parts.set(partKey, content.text)
          for (const annotation of content.annotations ?? []) {
            addCitation(annotation)
          }
        }
      }
      if (!started) {
        throw new ApiError('protocol', 'Grok returned no text response.')
      }
      for (const citation of citations.values()) {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'citations_delta', citation },
        }
      }
      yield { type: 'content_block_stop', index: 0 }
      const incomplete = type === 'response.incomplete' || state?.status === 'incomplete'
      if (incomplete && state?.incomplete_details?.reason !== 'max_output_tokens') {
        throw new ApiError('interrupted', 'Grok response is incomplete.')
      }
      yield {
        type: 'message_delta',
        delta: { stop_reason: incomplete ? 'max_tokens' : 'end_turn', stop_sequence: null },
      }
      yield { type: 'message_stop' }
      return
    }
  }
  signal.throwIfAborted()
  throw new ApiError('interrupted', '')
}

/** Grok 使用 Responses + 默认搜索工具；DeepSeek 继续使用 Chat Completions。 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  if (body.model === 'grok-4.7') {
    yield* streamGrokResponse(apiKey, body, signal)
    return
  }
  const response = await request(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
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
