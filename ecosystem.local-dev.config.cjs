const path = require("node:path");

const root = __dirname;
const powershell = "powershell.exe";
const commonArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];

function psScript(script) {
  return path.join(root, "scripts", "dev", script);
}

module.exports = {
  apps: [
    {
      name: "msh-memurai",
      script: powershell,
      args: [...commonArgs, psScript("run-memurai.ps1")],
      cwd: root,
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-backend",
      script: powershell,
      args: [...commonArgs, psScript("run-backend.ps1")],
      cwd: root,
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-frontend",
      script: powershell,
      args: [...commonArgs, psScript("run-frontend.ps1")],
      cwd: root,
      autorestart: true,
      max_restarts: 5,
    },
    {
      name: "msh-devtunnel",
      script: powershell,
      args: [...commonArgs, psScript("run-devtunnel.ps1")],
      cwd: root,
      autorestart: true,
      max_restarts: 5,
    },
  ],
};
