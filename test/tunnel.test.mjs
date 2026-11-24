import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { test } from 'node:test'
import activate, { deactivate } from '../main.mjs'
import { parseSshLine } from '../ssh-session.mjs'
import { readTunnelSettings, Tunnel } from '../tunnel.mjs'

const settings = {
  host: 'vps.example.com', user: 'deploy', keyPath: 'C:\\My Keys\\id_ed25519',
  sshPort: 22, remotePort: 17680, localPort: 6768
}
const env = { WINDIR: 'C:\\Windows' }
const testConfig = readTunnelSettings(settings, env, () => true)

test('builds a loopback reverse forward with strict host verification', () => {
  const { executable, args } = readTunnelSettings(settings, env, () => true)
  assert.equal(executable, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')
  assert.equal(testConfig.programData, 'C:\\ProgramData')
  assert.equal(args[args.indexOf('-R') + 1], '127.0.0.1:17680:127.0.0.1:6768')
  assert.equal(args[args.indexOf('-i') + 1], settings.keyPath)
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('ExitOnForwardFailure=yes'))
  assert.ok(args.includes('ConnectTimeout=10'))
  assert.equal(testConfig.retryMs, 2000)
  assert.throws(() => readTunnelSettings({ ...settings, host: '-F' }, env, () => true))
  assert.throws(() => readTunnelSettings({ ...settings, remotePort: 65536 }, env, () => true))
})

test('a fresh install stays idle until explicitly configured', { skip: process.platform !== 'win32' }, async () => {
  const updates = []
  const orca = {
    commands: { register() {} },
    host: { call(method, status) { if (method === 'statusBar.update') updates.push(status.text) } },
    settings: { get: () => ({}), onDidChange: () => ({ dispose() {} }) }
  }
  try {
    await activate(orca)
    assert.deepEqual(updates, ['SSH: idle'])
    assert.throws(() => readTunnelSettings({}, env, () => true), /SSH server IP address/)
  } finally {
    await deactivate()
  }
})

test('applies edited paths, endpoints and delays and rejects public listener addresses', () => {
  const options = {
    ...settings,
    sshPath: 'C:\\SSH Tools\\ssh.exe', knownHostsPath: 'C:\\SSH Tools\\known_hosts',
    remoteHost: '::1', remotePort: 25000, localHost: '::1', localPort: 7000,
    autoStart: false, autoReconnect: false, retrySeconds: 4, maxRetrySeconds: 12,
    connectTimeoutSeconds: 5, forwardTimeoutSeconds: 14, keepAliveSeconds: 0, keepAliveMisses: 5
  }
  const config = readTunnelSettings(options, {}, () => true)
  assert.equal(config.executable, options.sshPath)
  assert.deepEqual(config.args.slice(config.args.indexOf('-R'), config.args.indexOf('-R') + 2), ['-R', '[::1]:25000:[::1]:7000'])
  assert.ok(config.args.includes('UserKnownHostsFile="C:/SSH Tools/known_hosts"'))
  for (const option of ['ConnectTimeout=5', 'ServerAliveInterval=0', 'ServerAliveCountMax=5', 'StrictHostKeyChecking=yes']) {
    assert.ok(config.args.includes(option))
  }
  assert.equal(config.autoStart, false)
  assert.equal(config.autoReconnect, false)
  assert.equal(config.retryMs, 4000)
  assert.equal(config.maxRetryMs, 12000)
  assert.equal(config.forwardTimeoutMs, 14000)
  assert.equal(parseSshLine('debug1: remote forward success for: listen ::1:25000, connect ::1:7000', config), 'connected')
  assert.throws(() => readTunnelSettings({ ...options, remoteHost: '0.0.0.0' }, {}, () => true))
  assert.throws(() => readTunnelSettings({ ...options, maxRetrySeconds: 1 }, {}, () => true))
})

test('recognizes only the requested forward and identifies common errors', () => {
  const success = 'debug1: remote forward success for: listen 127.0.0.1:17680, connect 127.0.0.1:6768'
  assert.equal(parseSshLine(success, testConfig), 'connected')
  assert.equal(parseSshLine(success.replace('17680', '17681'), testConfig), undefined)
  assert.equal(parseSshLine('debug1: Authenticated to vps.example.com', testConfig), undefined)
  assert.equal(parseSshLine('Error: remote port forwarding failed for listen port 17680', testConfig), 'port')
  assert.equal(parseSshLine('Host key verification failed.', testConfig), 'hostKey')
  assert.equal(parseSshLine('deploy@vps.example.com: Permission denied (publickey).', testConfig), 'auth')
})

test('retries on SSH loss and stops on a Windows worker exit', { timeout: 2000 }, async () => {
  const status = new EventEmitter()
  const states = []
  const workers = []
  const tunnel = new Tunnel({
    onStatus(state) {
      states.push(state)
      status.emit(state)
    },
    startSession() {
      const worker = new EventEmitter()
      worker.connected = true
      worker.disconnect = () => {
        assert.ok(worker.connected)
        worker.connected = false
        queueMicrotask(() => worker.emit('exit', 0))
      }
      workers.push(worker)
      return worker
    }
  })
  try {
    tunnel.start({ ...testConfig, retryMs: 5 })
    assert.deepEqual(states, ['starting'])
    workers[0].emit('message', 'connected')
    const nextAttempt = once(status, 'starting')
    workers[0].emit('exit', 255)
    await nextAttempt
    workers[1].emit('message', 'connected')
  } finally {
    await tunnel.stop()
  }
  assert.deepEqual(states, ['starting', 'connected', 'retrying', 'starting', 'connected'])
  assert.equal(workers[1].connected, false)
})

test('reports the failure and stays idle with automatic reconnect disabled', async () => {
  const states = []
  const tunnel = new Tunnel({
    onStatus: state => states.push(state),
    startSession() { throw new Error('test failure') }
  })
  tunnel.start({ ...testConfig, autoReconnect: false })
  assert.deepEqual(states, ['starting', 'error'])
  await tunnel.stop()
})
