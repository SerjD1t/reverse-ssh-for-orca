import { fork } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const { contributes: { settings: settingDefinitions } } = JSON.parse(
  readFileSync(new URL('./orca-plugin.json', import.meta.url), 'utf8')
)
const defaults = Object.fromEntries(settingDefinitions.map(definition => [definition.key, definition.default]))

const failureDetails = {
  port: 'The SSH server refused the forward. Check that forwarding is allowed and the port is free.',
  auth: 'The SSH server refused authentication. Check the username and identity file.',
  hostKey: 'SSH host key verification failed. Verify the server fingerprint and update known_hosts.',
  network: 'OpenSSH could not reach the server. Check the SSH address and port.',
  launch: 'Could not start the OpenSSH client.'
}

function isRegularFile(file) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

function isHost(value) {
  return typeof value === 'string' && (isIP(value) || /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(value))
}

function endpoint(host, port) {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
}

export function readTunnelSettings(saved, env = process.env, isFile = isRegularFile) {
  const settings = { ...defaults, ...saved }
  for (const { key, title, type, minimum, maximum, enum: allowed } of settingDefinitions) {
    const value = settings[key]
    if (type === 'integer') {
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`Enter an integer from ${minimum} to ${maximum} for “${title}”.`)
      }
    } else if (typeof value !== type || (allowed && !allowed.includes(value))) {
      throw new Error(`Check the value of “${title}”.`)
    }
  }

  const {
    host, user, keyPath, knownHostsPath, sshPath, sshPort, remoteHost, remotePort, localHost, localPort,
    autoStart, autoReconnect, retrySeconds, maxRetrySeconds, connectTimeoutSeconds, forwardTimeoutSeconds,
    keepAliveSeconds, keepAliveMisses
  } = settings
  if (!isHost(host)) {
    throw new Error('Enter the SSH server IP address or DNS name in plugin settings.')
  }
  if (!isHost(localHost)) throw new Error('Enter the Orca runtime IP address or DNS name.')
  if (!/^[a-z_][a-z0-9._-]{0,63}$/i.test(user)) {
    throw new Error('Enter the SSH username in plugin settings.')
  }
  if (maxRetrySeconds < retrySeconds) {
    throw new Error('The maximum retry delay must be at least the initial retry delay.')
  }
  if (!win32.isAbsolute(keyPath) || !isFile(keyPath)) {
    throw new Error('Enter an absolute path to an accessible SSH identity file.')
  }
  if (knownHostsPath && (!win32.isAbsolute(knownHostsPath) || !isFile(knownHostsPath))) {
    throw new Error('Enter an absolute path to an accessible known_hosts file.')
  }
  const windowsDirectory = env.WINDIR || env.SystemRoot
  const executable = sshPath || (windowsDirectory && win32.join(windowsDirectory, 'System32', 'OpenSSH', 'ssh.exe'))
  if (!executable || !win32.isAbsolute(executable) || !isFile(executable)) {
    throw new Error('OpenSSH was not found. Enter the absolute path to ssh.exe in plugin settings.')
  }
  const systemRoot = env.SystemDrive ? `${env.SystemDrive}\\` : win32.parse(windowsDirectory ?? '').root
  // Orca's worker environment omits ProgramData, which Windows OpenSSH needs.
  const programData = env.ProgramData || (systemRoot && win32.join(systemRoot, 'ProgramData'))

  const remoteEndpoint = endpoint(remoteHost, remotePort)
  const localEndpoint = endpoint(localHost, localPort)
  const knownHostsOption = knownHostsPath
    ? ['-o', `UserKnownHostsFile="${knownHostsPath.replaceAll('\\', '/').replaceAll('%', '%%')}"`]
    : []
  return {
    executable,
    programData,
    remoteEndpoint,
    localEndpoint,
    forwardConfirmation: `remote forward success for: listen ${remoteHost}:${remotePort}, connect ${localHost}:${localPort}`,
    autoStart,
    autoReconnect,
    retryMs: retrySeconds * 1000,
    maxRetryMs: maxRetrySeconds * 1000,
    forwardTimeoutMs: forwardTimeoutSeconds * 1000,
    args: [
      '-NTv',
      '-F', 'none',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
      '-o', `ServerAliveInterval=${keepAliveSeconds}`,
      '-o', `ServerAliveCountMax=${keepAliveMisses}`,
      ...knownHostsOption,
      '-i', keyPath,
      '-p', String(sshPort),
      '-R', `${remoteEndpoint}:${localEndpoint}`,
      '-l', user,
      host
    ]
  }
}

export function startSshSession(config) {
  const entry = fileURLToPath(new URL('./ssh-session.mjs', import.meta.url))
  const worker = fork(entry, [], {
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  worker.send(config, () => {})
  return worker
}

export class Tunnel {
  #attempt = null
  #retry = null
  #wanted = null
  #delay

  constructor({ onStatus, startSession = startSshSession }) {
    this.onStatus = onStatus
    this.startSession = startSession
  }

  start(config) {
    if (this.#wanted || this.#attempt) throw new Error('The tunnel is already running.')
    this.#wanted = config
    this.#delay = config.retryMs
    this.#connect()
  }

  async stop() {
    this.#wanted = null
    clearTimeout(this.#retry)
    this.#retry = null
    const attempt = this.#attempt
    if (!attempt) return
    clearTimeout(attempt.deadline)
    this.#disconnect(attempt)
    await attempt.closed
  }

  #disconnect(attempt) {
    if (attempt.worker.connected) attempt.worker.disconnect()
  }

  #connect() {
    const config = this.#wanted
    if (!config) return
    this.onStatus('starting', `Opening ${config.remoteEndpoint} on the SSH server.`)
    let worker
    try {
      worker = this.startSession(config)
    } catch {
      this.#handleFailure(config, failureDetails.launch)
      return
    }

    const attempt = { worker, detail: null, shuttingDown: false, deadline: null }
    this.#attempt = attempt
    attempt.deadline = setTimeout(() => {
      attempt.shuttingDown = true
      attempt.detail = 'The SSH server did not confirm the forward in time.'
      this.#disconnect(attempt)
    }, config.forwardTimeoutMs)

    worker.on('message', message => {
      if (this.#wanted !== config || attempt.shuttingDown) return
      if (message === 'connected') {
        clearTimeout(attempt.deadline)
        this.#delay = config.retryMs
        this.onStatus('connected', `SSH server ${config.remoteEndpoint} → Windows ${config.localEndpoint}`)
      } else if (Object.hasOwn(failureDetails, message)) {
        attempt.detail = failureDetails[message]
      }
    })
    attempt.closed = new Promise(resolve => {
      const finish = () => {
        if (this.#attempt !== attempt) return
        clearTimeout(attempt.deadline)
        this.#attempt = null
        resolve()
        if (this.#wanted === config) this.#handleFailure(config, attempt.detail ?? 'The SSH connection closed.')
      }
      // A parent-initiated IPC disconnect on Windows can emit exit without close.
      worker.once('exit', finish)
      worker.on('error', () => {
        attempt.detail = failureDetails.launch
        if (worker.pid === undefined) finish()
      })
    })
  }

  #handleFailure(config, detail) {
    if (!config.autoReconnect) {
      this.onStatus('error', detail)
      return
    }
    const delay = this.#delay
    this.#delay = Math.min(config.maxRetryMs, delay * 2)
    this.onStatus('retrying', `${detail} Retrying in ${Math.ceil(delay / 1000)} s.`)
    this.#retry = setTimeout(() => {
      this.#retry = null
      this.#connect()
    }, delay)
  }
}
