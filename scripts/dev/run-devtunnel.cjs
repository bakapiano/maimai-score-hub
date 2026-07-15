const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const description = "maimai-score-hub-local-frontend";
const port = 3001;
const root = path.resolve(__dirname, "..", "..");
const stateDirectory = path.join(root, ".local-dev");
const statePath = path.join(stateDirectory, "devtunnel.json");

function runDevTunnel(args) {
  return spawnSync("devtunnel", args, {
    encoding: "utf8",
    windowsHide: true,
  });
}

function commandError(operation, result) {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return new Error(
    `Unable to ${operation} (exit ${result.status ?? "unknown"}): ${output}`,
  );
}

function parseJson(operation, result) {
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`devtunnel ${operation} returned no JSON output`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Unable to parse devtunnel ${operation} output: ${output}`);
  }
}

function readStoredTunnelId() {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return typeof state.tunnelId === "string" && state.tunnelId.trim()
      ? state.tunnelId.trim()
      : null;
  } catch (error) {
    console.warn(
      `Unable to read ${statePath}; a new tunnel will be created. ${error.message}`,
    );
    return null;
  }
}

function storedTunnelExists(tunnelId) {
  const result = runDevTunnel(["show", tunnelId, "--json"]);
  if (result.status === 0) {
    return true;
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (/Tunnel not found/i.test(output)) {
    console.warn(
      `Stored dev tunnel ${tunnelId} no longer exists; creating a replacement.`,
    );
    return false;
  }
  throw commandError(`inspect stored dev tunnel ${tunnelId}`, result);
}

function saveTunnelState(tunnelId) {
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        tunnelId,
        port,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createPersistentTunnel() {
  const result = runDevTunnel([
    "create",
    "--allow-anonymous",
    "--description",
    description,
    "--json",
  ]);
  if (result.status !== 0) {
    throw commandError("create dev tunnel", result);
  }

  const response = parseJson("create", result);
  const tunnelId = response.tunnel?.tunnelId ?? response.tunnelId;
  if (typeof tunnelId !== "string" || !tunnelId.trim()) {
    throw new Error("devtunnel create did not return a tunnelId");
  }

  saveTunnelState(tunnelId);
  console.log(
    `Created persistent dev tunnel ${tunnelId}; state saved to ${statePath}`,
  );
  return tunnelId;
}

function ensureTunnelPort(tunnelId) {
  const listResult = runDevTunnel(["port", "list", tunnelId, "--json"]);
  if (listResult.status !== 0) {
    throw commandError(`list ports for dev tunnel ${tunnelId}`, listResult);
  }

  const response = parseJson("port list", listResult);
  const matchingPort = (response.ports ?? []).find(
    (candidate) => Number(candidate.portNumber) === port,
  );
  if (matchingPort) {
    return;
  }

  const createResult = runDevTunnel([
    "port",
    "create",
    tunnelId,
    "--port-number",
    String(port),
    "--protocol",
    "http",
    "--description",
    description,
    "--json",
  ]);
  if (createResult.status !== 0) {
    throw commandError(
      `create port ${port} for dev tunnel ${tunnelId}`,
      createResult,
    );
  }
  console.log(`Added HTTP port ${port} to dev tunnel ${tunnelId}`);
}

function main() {
  let tunnelId = readStoredTunnelId();
  if (tunnelId && storedTunnelExists(tunnelId)) {
    console.log(`Reusing persistent dev tunnel ${tunnelId} from ${statePath}`);
  } else {
    tunnelId = createPersistentTunnel();
  }

  ensureTunnelPort(tunnelId);
  console.log(`Hosting dev tunnel ${tunnelId} for frontend port ${port}`);

  const host = spawn("devtunnel", ["host", tunnelId], {
    stdio: "inherit",
    windowsHide: true,
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!host.killed) {
      host.kill();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  host.once("error", (error) => {
    console.error(`Unable to start devtunnel host: ${error.message}`);
    process.exit(1);
  });
  host.once("exit", (code, signal) => {
    if (signal && !shuttingDown) {
      console.error(`devtunnel host exited via ${signal}`);
    }
    process.exit(shuttingDown ? 0 : (code ?? 1));
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
