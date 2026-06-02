#!/usr/bin/env node
import { startBroker } from "./broker/server.js";
import { runMcpServer } from "./mcp/server.js";

const DEFAULT_PORT = 7531;

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === "serve") {
    const port = parsePort(rest);
    const { url } = await startBroker({
      port,
      onAllRoomsEmpty: () => {
        // Phase 4 adds the 30s grace exit timer.
      },
    });
    console.log(`group-chat-mcp broker listening on ${url}`);
    return;
  }

  if (subcommand === "mcp") {
    const port = parsePort(rest);
    await runMcpServer({
      preferredPort: port,
      brokerUrlOverride: process.env.GROUP_CHAT_URL,
    });
    return;
  }

  console.error(`unknown subcommand: ${subcommand}`);
  printUsage();
  process.exit(1);
}

function parsePort(args: string[]): number {
  const portFromFlag = args.find((a, i) => a === "--port" && i + 1 < args.length);
  if (portFromFlag) {
    const idx = args.indexOf("--port");
    const n = Number(args[idx + 1]);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const env = process.env.GROUP_CHAT_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_PORT;
}

function printUsage() {
  console.log(`Usage:
  group-chat-mcp serve [--port <port>]   Start the broker
  group-chat-mcp mcp [--port <port>]     Start the MCP stdio server (spawned by Claude Code)
  group-chat-mcp help                    Show this message

Env:
  GROUP_CHAT_PORT   Broker port (default ${DEFAULT_PORT})
  GROUP_CHAT_URL    Full broker URL override for the MCP server
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
