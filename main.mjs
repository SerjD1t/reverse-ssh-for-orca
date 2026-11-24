import { readTunnelSettings, Tunnel } from './tunnel.mjs'

const views = {
  idle: { text: 'SSH: idle', icon: 'pause', tone: 'neutral' },
  starting: { text: 'SSH: connecting', icon: 'activity', tone: 'neutral' },
  connected: { text: 'SSH: connected', icon: 'check', tone: 'success' },
  retrying: { text: 'SSH: retrying', icon: 'refresh', tone: 'warning' },
  error: { text: 'SSH: error', icon: 'warning', tone: 'danger' }
}

let dispose

export default async function activate(orca) {
  let disposed = false
  let startedManually = false
  let status = { ...views.starting, tooltip: 'Starting the reverse SSH tunnel.' }
  let actions = Promise.resolve()
  let updates = Promise.resolve()
  let lastProblem

  function publish(state, tooltip) {
    status = { ...views[state], tooltip }
    if (state === 'error' && tooltip !== lastProblem) {
      console.error(tooltip)
      lastProblem = tooltip
    } else if (state === 'connected') {
      lastProblem = undefined
    }
    const update = status
    updates = updates.then(async () => {
      if (!disposed && update === status) {
        await orca.host.call('statusBar.update', { id: 'tunnel', ...update })
      }
    }).catch(error => {
      if (!disposed) console.error(`Could not update the SSH status item: ${error.message}`)
    })
  }

  const tunnel = new Tunnel({ onStatus: publish })
  const start = (manual = false) => {
    actions = actions.then(async () => {
      await tunnel.stop()
      if (disposed) return
      if (process.platform !== 'win32') {
        publish('error', 'Reverse SSH for Orca runs on the Windows host.')
        return
      }
      const settings = await orca.settings.get()
      if (disposed) return
      if (settings.autoStart !== true && !manual && !startedManually) {
        publish('idle', 'Configure the SSH server in plugin settings, then restart the tunnel from the command palette.')
        return
      }
      const config = readTunnelSettings(settings)
      startedManually = !config.autoStart
      tunnel.start(config)
    }).catch(error => {
      if (!disposed) publish('error', error.message)
    })
    return actions
  }

  orca.commands.register('showStatus', async () => {
    await orca.host.call('notifications.show', { title: status.text, body: status.tooltip })
    return status.tooltip
  })
  orca.commands.register('restart', async () => {
    await start(true)
    return status.tooltip
  })
  const settingsSubscription = orca.settings.onDidChange(() => { void start() })
  dispose = async () => {
    disposed = true
    settingsSubscription.dispose()
    await actions
    await tunnel.stop()
  }
  await start()
}

export async function deactivate() {
  await dispose?.()
  dispose = undefined
}
