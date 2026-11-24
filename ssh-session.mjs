import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export function parseSshLine(line, { forwardConfirmation }) {
  if (line.endsWith(forwardConfirmation)) return 'connected'
  if (/remote port forwarding failed|remote forward failure for:/i.test(line)) return 'port'
  if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(line)) {
    return 'hostKey'
  }
  if (/permission denied|bad permissions|incorrect passphrase/i.test(line)) return 'auth'
  if (/connection timed out|connection refused|could not resolve hostname|no route to host/i.test(line)) {
    return 'network'
  }
}

function runSession() {
  let ssh
  const stop = () => {
    if (ssh && ssh.exitCode === null && ssh.signalCode === null) ssh.kill()
  }
  // Windows does not automatically stop an SSH child when its parent plugin
  // worker dies. Closing the IPC channel makes this helper stop its own child.
  process.once('disconnect', stop)
  process.once('exit', stop)
  process.once('message', config => {
    const send = kind => {
      if (process.connected) process.send(kind, () => {})
    }
    try {
      ssh = spawn(config.executable, config.args, {
        windowsHide: true,
        env: { ...process.env, ProgramData: config.programData || process.env.ProgramData },
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch {
      send('launch')
      process.disconnect?.()
      return
    }
    const lines = createInterface({ input: ssh.stderr, crlfDelay: Infinity })
    lines.on('line', line => {
      const kind = parseSshLine(line, config)
      if (kind) send(kind)
    })
    ssh.once('error', () => send('launch'))
    ssh.once('close', () => {
      if (process.connected) process.disconnect()
    })
  })
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) runSession()
