# Reverse SSH for Orca

Reach a Windows Orca runtime from another desktop through an SSH server you control. The Windows host opens an outbound SSH connection and forwards a loopback port on the server to the Orca runtime. The client desktop connects through Orca's built-in SSH access.

```text
Remote Orca desktop ── SSH ──► SSH server ◄── reverse SSH ── Windows Orca desktop
                               127.0.0.1:17680             127.0.0.1:6768
```

## Requirements

- Orca 1.4.272 or later and OpenSSH Client on the Windows host.
- An SSH server you administer that permits both directions of TCP forwarding for the required accounts. Keep `GatewayPorts no` on the server to enforce loopback-only listeners.
- A Windows SSH identity usable without an interactive prompt, and the verified SSH server host key in the Windows OpenSSH `known_hosts` file.

## Setup

1. Install the plugin in Orca on the Windows host. Orca asks for approval because the plugin runs OpenSSH as a trusted worker under the Windows user account. The plugin reads its own settings and can show desktop notifications.
2. In Orca, open **Settings → Plugins** and select **Reverse SSH for Orca**. Set the SSH server address, SSH username and absolute path to the identity file. Adjust the SSH port, the loopback listener port on the server and the actual Orca runtime port if they differ from your setup.
3. Run **Reverse SSH — Restart tunnel** from the command palette. The status bar shows **SSH: connected** after the SSH server confirms the forward. Enable **Start the tunnel with Orca** if you want it to start each time Orca opens.
4. On the client desktop, add the Windows runtime using its Orca access link. In the runtime's menu choose **Connect through SSH**. Select your SSH server and set the server port to the tunnel port configured in step 2. Use the IPv4 loopback listener for this setup.

To install from GitHub with the Orca CLI, run the following on the Windows host.

```text
orca plugin install SerjD1t/reverse-ssh-for-orca
```

The plugin starts idle on a fresh install. It requires host key verification and offers only loopback listener addresses on the SSH server. Settings changes restart an active tunnel. The tunnel closes when the plugin or Orca stops. The plugin sends no telemetry. Keep SSH keys and Orca access links private.

## Development

```text
orca plugin validate .
orca plugin test .
```
