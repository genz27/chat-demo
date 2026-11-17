import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(repository, 'package.json'))
const { rspack } = require('@rspack/core')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimimi-access-test-'))
const entry = path.join(temp, 'entry.js')
fs.writeFileSync(
  entry,
  `export {authHeaders,verifyApiKey} from ${JSON.stringify(path.join(repository, 'src/services/api/client.ts'))};
export {transcribe,synthesize} from ${JSON.stringify(path.join(repository, 'src/services/api/speech.ts'))};`
)

try {
  for (const [name, origin] of [
    ['same-origin', ''],
    ['direct-upstream', 'https://fixture.invalid'],
  ]) {
    const output = path.join(temp, name)
    const compiler = rspack({
      mode: 'development',
      target: 'node',
      devtool: false,
      entry,
      output: { path: output, filename: 'api.cjs', library: { type: 'commonjs2' } },
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
          __API_ORIGIN__: JSON.stringify(origin),
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
    const api = require(path.join(output, 'api.cjs'))
    assert.deepEqual(api.authHeaders('__CHAT_API_KEY__'), {})
    const expected = origin ? { Authorization: 'Bearer stale-browser-key' } : {}
    assert.deepEqual(api.authHeaders('stale-browser-key'), expected)
    const calls = []
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({ url, headers: new Headers(init.headers) })
        return new Response(url.endsWith('/asr') ? '{"text":"cat"}' : 'OK')
      }
      await api.verifyApiKey('stale-browser-key')
      assert.equal(await api.transcribe('stale-browser-key', new Blob(['audio'])), 'cat')
      await api.synthesize('stale-browser-key', 'cat', 'stella', new AbortController().signal)
      assert.equal(calls.length, 3)
      for (const call of calls) {
        assert.equal(call.headers.get('Authorization'), expected.Authorization ?? null)
        assert.ok(call.url.startsWith(`${origin}/v1/`))
      }
      assert.equal(calls[2].headers.get('Content-Type'), 'application/json')
    } finally {
      globalThis.fetch = originalFetch
    }
    console.log(`PASS ${name}: models, ASR, TTS preserve the correct authentication headers`)
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
