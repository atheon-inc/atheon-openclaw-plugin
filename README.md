# Atheon OpenClaw Plugin

## Why This Plugin

[Atheon](https://atheon-inc.com) is a purpose-build modern analytics platform for LLM agents.

`@atheon-inc/openclaw-plugin` adds native Atheon analytics capabilities to OpenClaw runs:

- LLM request and response traces with token usage
- Sub-agent lifecycle nested under their parent trace
- Tool call traces with latency, inputs, and errors
- Automatic cleanup of abandoned or timed-out interactions
- Payload sanitization — internal OpenClaw metadata is stripped before leaving the gateway

The plugin runs inside the OpenClaw Gateway process. If your gateway is remote, install and configure the plugin on that host.

## Install and first run

Prerequisites:

- OpenClaw `>=2026.3.2`
- Node.js `>=22.12.0`
- npm `>=10`

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install clawhub:@atheon-inc/openclaw-plugin
```

For older versions of OpenClaw `<2026.3.23` install directly from npm:

```bash
openclaw plugins install @atheon-inc/openclaw-plugin
```

If the gateway is already running, restart it after install.

### 2. Set your API key

```bash
export ATHEON_API_KEY=arc_...
```

Or pass it via the plugin config block — see [Configuration](#configuration) below.

### 3. Check effective settings

```bash
openclaw plugins status atheon-openclaw
```

### 4. Send a test message

```bash
openclaw gateway run
openclaw message send "hello from openclaw"
```

Then confirm traces appear in your Atheon Codex project.

## Configuration

### Recommended config shape

```json
{
  "plugins": {
    "entries": {
      "atheon-openclaw": {
        "enabled": true,
        "config": {
          "apiKey": "arc_...",
          "uploadSize": 100,
          "uploadInterval": 5000
        }
      }
    }
  }
}
```

### Config reference

| Option           | Environment variable | Type     | Required | Description                                                     |
|------------------|----------------------|----------|-----------|-----------------------------------------------------------------|
| `apiKey`         | `ATHEON_API_KEY`     | `string` | ✅        | Atheon Codex API key.                                           |
| `uploadSize`     | —                    | `number` | —         | Number of spans to batch before uploading.                      |
| `uploadInterval` | —                    | `number` | —         | Maximum milliseconds between uploads, regardless of batch size. |

`apiKey` is required. The plugin will fail to start at startup if it is absent from both the config block and `ATHEON_API_KEY`.

### Plugin trust allowlist

OpenClaw warns when `plugins.allow` is empty and a community plugin is discovered. Pin trusted plugins explicitly:

```json
{
  "plugins": {
    "allow": ["atheon-openclaw"]
  }
}
```

## Event mapping

| OpenClaw event      | Atheon Codex entity          | Notes                                                                  |
|---------------------|------------------------------|------------------------------------------------------------------------|
| `llm_input`         | root interaction start       | Opens a new interaction; updates provider/model on an existing child.  |
| `llm_output`        | root interaction finish      | Records output text and token usage; deferred if tools are in flight.  |
| `before_tool_call`  | tool span start              | Captures tool name and start timestamp.                                |
| `after_tool_call`   | tool span finish             | Records latency and error, then closes the span.                       |
| `subagent_spawning` | child interaction start      | Spawns a child interaction nested under the parent.                    |
| `subagent_spawned`  | child interaction update     | Enriches child with run ID and thread metadata.                        |
| `subagent_ended`    | child interaction finish     | Finalizes child with outcome and error.                                |
| `session_end`       | root interaction force-close | Closes any interaction still open when the session ends.               |

## Trace structure

Each session produces one root interaction. Subagents produce child interactions nested underneath it. Tool calls are recorded as spans on whichever interaction made the call.

```
Session
└── Root interaction  (llm_input → llm_output)
    ├── Tool span     (before_tool_call → after_tool_call)
    ├── Tool span
    └── Child interaction  (subagent_spawning → subagent_ended)
        ├── Tool span
        └── Tool span
```

If a session ends while tool calls or subagents are still in flight, the plugin records them as abandoned with an error message and closes the tree cleanly.

A background reaper runs every **5 minutes** and closes interactions idle for more than **1 hour**, preventing unbounded memory growth from sessions that end without a clean `session_end` event.

## Supported providers

Provider strings from the gateway are normalized before being sent to Atheon Codex:

| Raw string (case-insensitive, substring match) | Normalized       |
|------------------------------------------------|------------------|
| `anthropic`                                    | `anthropic`      |
| `openai`                                       | `openai`         |
| `google`, `gemini`                             | `google`         |
| `mistral`                                      | `mistral`        |
| `cohere`                                       | `cohere`         |
| anything else                                  | lowercased as-is |

## Known limitations

- No OpenClaw core changes are required or included. The plugin relies entirely on the native hook lifecycle exposed by the OpenClaw Plugin SDK.

## Development

Prerequisites:

- Node.js `>=22.12.0`
- npm `>=10`

```bash
npm ci
npm run lint
npm run typecheck
npm run test
```

Log lines from the plugin are prefixed with `[atheon-openclaw]` for easy filtering:

```bash
openclaw gateway run 2>&1 | grep '\[atheon-openclaw\]'
```

## License

This SDK is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE) for details.

## Links

  - [Atheon Documentation](https://docs.atheon.ad)
  - [Gateway Dashboard](https://gateway.atheon.ad)
