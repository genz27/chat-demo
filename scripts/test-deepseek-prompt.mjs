import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedBytes = 25273
const expectedSha256 = '3e1f3f21cbdd2051b2773ee55dea60450374b3722e47d46a17b19dd6258f33f3'
const require = createRequire(path.join(repository, 'package.json'))
const { rspack } = require('@rspack/core')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hajimimi-deepseek-prompt-'))
const compiler = rspack({
  mode: 'development',
  target: 'node',
  devtool: false,
  entry: path.join(repository, 'src/services/api/deepseekPrompt.ts'),
  output: { path: output, filename: 'prompt.cjs', library: { type: 'commonjs2' } },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript' } } },
      },
    ],
  },
})
try {
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) =>
      compiler.close((closeError) => {
        if (error || closeError || stats.hasErrors())
          reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    )
  )
  const { DEEPSEEK_DEFAULT_PROMPT, systemPromptForModel } = require(path.join(output, 'prompt.cjs'))
  const actual = Buffer.from(DEEPSEEK_DEFAULT_PROMPT)
  assert.equal(actual.length, expectedBytes)
  assert.equal(crypto.createHash('sha256').update(actual).digest('hex'), expectedSha256)
  assert.equal(systemPromptForModel('deepseek-v4.1-flash'), DEEPSEEK_DEFAULT_PROMPT)
  assert.equal(systemPromptForModel('grok-4.7'), 'You are a helpful assistant.')
  console.log(
    JSON.stringify({
      promptBytes: actual.length,
      sha256: crypto.createHash('sha256').update(actual).digest('hex'),
      deepseekUsesSuppliedPrompt: true,
      grokUsesCompactPrompt: true,
    })
  )
} finally {
  fs.rmSync(output, { recursive: true, force: true })
}
