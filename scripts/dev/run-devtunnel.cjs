const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const stateDirectory = path.join(root, ".local-dev");
const tunnelProfiles = {
  frontend: {
    description: "maimai-score-hub-local-frontend",
    displayName: "frontend",
    port: 3001,
    statePath: path.join(stateDirectory, "devtunnel.json"),
    urlPath: "/",
  },
  admin: {
    description: "maimai-score-hub-local-admin",
    displayName: "admin portal",
    port: 3002,
    tunnelId: "maiscorehub-admin-dev.jpe1",
    urlPath: "/admin/",
  },
};

const profileName = process.argv[2] || "frontend";
const profile = tunnelProfiles[profileName];

if (!profile) {
  console.error(
    `Unknown dev tunnel profile "${profileName}". Expected one of: ${Object.keys(tunnelProfiles).join(", ")}`,
  );
  process.exit(1);
}

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
  if (!profile.statePath || !fs.existsSync(profile.statePath)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(profile.statePath, "utf8"));
    return typeof state.tunnelId === "string" && state.tunnelId.trim()
      ? state.tunnelId.trim()
      : null;
  } catch (error) {
    console.warn(
      `Unable to read ${profile.statePath}; a new tunnel will be created. ${error.message}`,
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
      `Dev tunnel ${tunnelId} does not exist; creating it.`,
    );
    return false;
  }
  throw commandError(`inspect stored dev tunnel ${tunnelId}`, result);
}

function saveTunnelState(tunnelId) {
  if (!profile.statePath) {
    return;
  }
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(
    profile.statePath,
    `${JSON.stringify(
      {
        tunnelId,
        port: profile.port,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createPersistentTunnel() {
  const createTunnelId = profile.tunnelId?.split(".", 1)[0];
  const result = runDevTunnel([
    "create",
    ...(createTunnelId ? [createTunnelId] : []),
    "--allow-anonymous",
    "--description",
    profile.description,
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

  if (profile.tunnelId && tunnelId !== profile.tunnelId) {
    throw new Error(
      `devtunnel created ${tunnelId}, expected fixed tunnel ID ${profile.tunnelId}`,
    );
  }

  saveTunnelState(tunnelId);
  console.log(
    profile.statePath
      ? `Created persistent dev tunnel ${tunnelId}; state saved to ${profile.statePath}`
      : `Created fixed dev tunnel ${tunnelId}`,
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
    (candidate) => Number(candidate.portNumber) === profile.port,
  );
  if (matchingPort) {
    return;
  }

  const createResult = runDevTunnel([
    "port",
    "create",
    tunnelId,
    "--port-number",
    String(profile.port),
    "--protocol",
    "http",
    "--description",
    profile.description,
    "--json",
  ]);
  if (createResult.status !== 0) {
    throw commandError(
      `create port ${profile.port} for dev tunnel ${tunnelId}`,
      createResult,
    );
  }
  console.log(`Added HTTP port ${profile.port} to dev tunnel ${tunnelId}`);
}

function printPublicUrl(tunnelId) {
  const result = runDevTunnel(["show", tunnelId, "--json"]);
  if (result.status !== 0) {
    console.warn(commandError(`show dev tunnel ${tunnelId}`, result).message);
    return false;
  }

  const response = parseJson("show", result);
  const tunnelPort = (response.tunnel?.ports ?? []).find(
    (candidate) => Number(candidate.portNumber) === profile.port,
  );
  if (typeof tunnelPort?.portUri !== "string") {
    return false;
  }

  const publicUrl = new URL(profile.urlPath, tunnelPort.portUri).toString();
  console.log(`${profile.displayName} URL: ${publicUrl}`);
  return true;
}

function printPublicUrlWhenReady(tunnelId, attemptsRemaining = 5) {
  setTimeout(() => {
    if (!printPublicUrl(tunnelId) && attemptsRemaining > 1) {
      printPublicUrlWhenReady(tunnelId, attemptsRemaining - 1);
    }
  }, 1000);
}

function main() {
  let tunnelId = profile.tunnelId || readStoredTunnelId();
  if (tunnelId && storedTunnelExists(tunnelId)) {
    console.log(
      profile.tunnelId
        ? `Reusing fixed dev tunnel ${tunnelId}`
        : `Reusing persistent dev tunnel ${tunnelId} from ${profile.statePath}`,
    );
  } else {
    tunnelId = createPersistentTunnel();
  }

  ensureTunnelPort(tunnelId);
  console.log(
    `Hosting dev tunnel ${tunnelId} for ${profile.displayName} port ${profile.port}`,
  );

  const host = spawn("devtunnel", ["host", tunnelId], {
    stdio: "inherit",
    windowsHide: true,
  });
  printPublicUrlWhenReady(tunnelId);
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
