import { spawnSync } from 'node:child_process'

const args = ['exec', 'rspack', 'build', '-c', 'rspack.config.ts']
const result = process.platform === 'win32'
  ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${args.join(' ')}`], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
    })
  : spawnSync('pnpm', args, {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
    })
if (result.error) {
  console.error(result.error)
}
process.exit(result.status ?? 1)
