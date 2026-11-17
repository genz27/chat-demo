import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = path.resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? repository
)
const require = createRequire(path.join(repository, 'package.json'))
const { rspack } = require('@rspack/core')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimimi-api-test-'))
const compiler = rspack({
  mode: 'development',
  target: 'node',
  devtool: false,
  entry: path.join(project, 'src/services/api/client.ts'),
  output: { path: output, filename: 'client.cjs', library: { type: 'commonjs2' } },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    modules: [path.join(repository, 'node_modules'), 'node_modules'],
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript', tsx: true } } },
      },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify('https://fixture.invalid'),
      __APP_API_KEY__: JSON.stringify('__CHAT_API_KEY__'),
    }),
  ],
})
await new Promise((resolve, reject) =>
  compiler.run((error, stats) =>
    compiler.close((closeError) => {
      if (error || closeError || stats.hasErrors())
        reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })))
      else resolve()
    })
  )
)
const { streamMessage } = require(path.join(output, 'client.cjs'))
const input = {
  model: 'grok-4.7',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: '搜一下猫猫' }],
  thinking: { type: 'disabled' },
  safety_check: { level: 'high' },
  tools: [],
  reasoning: { effort: 'auto', summary: 'auto' },
}
let calls = []
let fixture = 'normal'
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const completion = (answer = 'OK') => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: answer, annotations: [] }] }],
})
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) })
  if (fixture === 'non-sse') return new Response('<html>wrong endpoint</html>')
  let wire
  if (String(url).endsWith('/responses')) {
    const errorResponse = { status: 'failed', error: { message: 'upstream failed' } }
    if (fixture === 'normal')
      wire =
        frame('response.created', { response: { id: 'test-response' } }) +
        frame('response.reasoning_summary_text.delta', { delta: 'PRIVATE SUMMARY MUST NOT LEAK' }) +
        frame('response.web_search_call.in_progress', { item_id: 'search-1' }) +
        frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'O' }) +
        frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'K' }) +
        frame('response.output_text.done', { output_index: 0, content_index: 0, text: 'OK' }) +
        frame('response.completed', { response: completion() })
    else if (fixture === 'final-only')
      wire = frame('response.completed', { response: completion() })
    else if (fixture === 'done-only')
      wire =
        frame('response.output_text.done', { output_index: 0, content_index: 0, text: 'OK' }) +
        frame('response.completed', { response: completion() })
    else if (fixture === 'indexed-unicode')
      wire =
        frame('response.output_text.delta', { output_index: 2, content_index: 0, delta: '猫' }) +
        frame('response.output_text.delta', { output_index: 2, content_index: 0, delta: '🐱' }) +
        frame('response.output_text.done', { output_index: 2, content_index: 0, text: '猫🐱' }) +
        frame('response.completed', {
          response: {
            status: 'completed',
            output: [
              { type: 'reasoning' },
              { type: 'web_search_call' },
              { type: 'message', content: [{ type: 'output_text', text: '猫🐱' }] },
            ],
          },
        })
    else if (fixture === 'failure') wire = frame('response.failed', { response: errorResponse })
    else if (fixture === 'truncated')
      wire = frame('response.output_text.delta', {
        output_index: 0,
        content_index: 0,
        delta: 'partial',
      })
    else if (fixture === 'tool-only')
      wire = frame('response.completed', {
        response: {
          status: 'completed',
          output: [{ type: 'function_call', name: 'web_search', arguments: '{}' }],
        },
      })
    else if (fixture === 'incomplete')
      wire =
        frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'OK' }) +
        frame('response.incomplete', {
          response: {
            ...completion(),
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          },
        })
    else if (fixture === 'citation')
      wire =
        frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'OK' }) +
        frame('response.output_text.annotation.added', {
          annotation: { type: 'url_citation', url: 'https://example.org/cats', title: 'Cats' },
        }) +
        frame('response.completed', { response: completion() })
    else throw new Error('unknown fixture')
  } else {
    wire =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
      '\n\n'
  }
  // Deliberately split UTF-8/SSE frames across reads.
  const bytes = new TextEncoder().encode(wire)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
async function collect(body = input) {
  const result = []
  for await (const event of streamMessage('__CHAT_API_KEY__', body, new AbortController().signal))
    result.push(event)
  return result
}
const events = await collect()
assert.equal(
  events
    .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
    .map((e) => e.delta.text)
    .join(''),
  'OK'
)
assert.equal(events.at(-1).type, 'message_stop')
const grokCall = calls.at(-1)
console.log(
  JSON.stringify({
    input: '搜一下猫猫',
    model: input.model,
    endpoint: new URL(grokCall.url).pathname,
    tools: grokCall.body.tools?.map((t) => t.type) ?? [],
    store: grokCall.body.store ?? null,
    reasoning: grokCall.body.reasoning ?? null,
    answer: 'OK',
    terminal: events.at(-1).type,
  })
)
if (process.argv.includes('--check')) {
  assert.equal(new URL(grokCall.url).pathname, '/v1/responses')
  assert.deepEqual(grokCall.body.tools, [{ type: 'web_search' }, { type: 'x_search' }])
  assert.deepEqual(grokCall.body.input, [
    { role: 'system', content: input.system },
    ...input.messages,
  ])
  assert.equal(grokCall.body.store, false)
  assert.equal(grokCall.body.stream, true)
  assert.deepEqual(grokCall.body.reasoning, { summary: 'auto' })
  assert.ok(!JSON.stringify(events).includes('PRIVATE SUMMARY'))
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    await collect({ ...input, reasoning: { effort, summary: 'auto' } })
    assert.equal(calls.at(-1).body.reasoning.effort, effort)
  }
  await collect({ ...input, model: 'deepseek-v4.1-flash', reasoning: undefined })
  assert.equal(new URL(calls.at(-1).url).pathname, '/v1/chat/completions')
  assert.equal(calls.at(-1).body.tools, undefined)
  for (const test of ['final-only', 'done-only', 'citation', 'incomplete']) {
    fixture = test
    const result = await collect()
    assert.equal(
      result
        .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
        .map((e) => e.delta.text)
        .join(''),
      'OK'
    )
    assert.equal(result.at(-1).type, 'message_stop')
    if (test === 'citation')
      assert.equal(
        result.find((e) => e.delta?.type === 'citations_delta')?.delta.citation.url,
        'https://example.org/cats'
      )
    if (test === 'incomplete')
      assert.equal(result.find((e) => e.type === 'message_delta').delta.stop_reason, 'max_tokens')
  }
  fixture = 'indexed-unicode'
  const unicode = await collect()
  assert.equal(
    unicode
      .filter((e) => e.delta?.type === 'text_delta')
      .map((e) => e.delta.text)
      .join(''),
    '猫🐱'
  )
  for (const test of ['failure', 'truncated', 'tool-only', 'non-sse']) {
    fixture = test
    await assert.rejects(() => collect())
  }
  console.log(
    'PASS: default tools, Responses input/stream/store, auto and all four efforts, DeepSeek unchanged, SSE text/fallback/citations/length/error/truncation/tool-only handling'
  )
}
