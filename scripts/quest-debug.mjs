#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);
const DEFAULT_ADB =
  "/Applications/Meta Quest Developer Hub.app/Contents/Resources/bin/adb";
const adbBinary = process.env.PAS_DE_GEANT_ADB ?? DEFAULT_ADB;
const devToolsPort = Number(process.env.PAS_DE_GEANT_DEVTOOLS_PORT ?? "9222");

async function adb(...args) {
  const { stdout } = await execFile(adbBinary, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function numberFrom(text, pattern, divisor = 1) {
  const value = Number(pattern.exec(text)?.[1]);
  return Number.isFinite(value) ? value / divisor : null;
}

function parseBattery(text) {
  return {
    levelPercent: numberFrom(text, /^\s*level:\s*(\d+)/m),
    temperatureC: numberFrom(text, /^\s*temperature:\s*(\d+)/m, 10),
    acPowered: /^\s*AC powered:\s*true/m.test(text),
    usbPowered: /^\s*USB powered:\s*true/m.test(text),
  };
}

function parseThermals(text) {
  const valuesByType = {
    cpu: [],
    gpu: [],
    battery: [],
    surface: [],
  };
  for (const match of text.matchAll(
    /Temperature\{mValue=([\d.]+),\s*mType=(\d+),\s*mName=([^,}]+)/g,
  )) {
    const value = Number(match[1]);
    const type = Number(match[2]);
    const name = match[3].toLowerCase();
    if (!Number.isFinite(value)) continue;
    if (type === 0) valuesByType.cpu.push(value);
    if (type === 1) valuesByType.gpu.push(value);
    if (type === 2 && (name === "battery" || name.includes("batt-virt"))) {
      valuesByType.battery.push(value);
    }
    if (type === 3 && name.includes("surf")) {
      valuesByType.surface.push(value);
    }
  }
  const maximum = (values) => values.length > 0 ? Math.max(...values) : null;
  return {
    status: numberFrom(text, /Thermal Status:\s*(\d+)/),
    maxCpuC: maximum(valuesByType.cpu),
    maxGpuC: maximum(valuesByType.gpu),
    maxBatteryC: maximum(valuesByType.battery),
    maxSurfaceC: maximum(valuesByType.surface),
  };
}

function parseGpuBusy(text) {
  const [busy, total] = text.trim().split(/\s+/).map(Number);
  return Number.isFinite(busy) && Number.isFinite(total) && total > 0
    ? Math.round(busy / total * 10_000) / 100
    : null;
}

function parseBrowserMemory(text) {
  return {
    totalPssMiB: numberFrom(text, /TOTAL PSS:\s*(\d+)/, 1024),
    totalRssMiB: numberFrom(text, /TOTAL RSS:\s*(\d+)/, 1024),
    graphicsPssMiB: numberFrom(text, /^\s*Graphics:\s*(\d+)/m, 1024),
  };
}

async function deviceSnapshot() {
  const [
    battery,
    thermal,
    gpuClock,
    gpuBusy,
    cpuLittle,
    cpuBig,
    browserMemory,
  ] = await Promise.all([
    adb("shell", "dumpsys", "battery"),
    adb("shell", "dumpsys", "thermalservice"),
    adb("shell", "cat", "/sys/class/kgsl/kgsl-3d0/gpuclk"),
    adb("shell", "cat", "/sys/class/kgsl/kgsl-3d0/gpubusy"),
    adb("shell", "cat", "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"),
    adb("shell", "cat", "/sys/devices/system/cpu/cpu4/cpufreq/scaling_cur_freq"),
    adb("shell", "dumpsys", "meminfo", "com.oculus.browser"),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    battery: parseBattery(battery),
    thermal: parseThermals(thermal),
    gpu: {
      clockMHz: Number(gpuClock) / 1_000_000,
      busyPercent: parseGpuBusy(gpuBusy),
    },
    cpu: {
      littleClusterMHz: Number(cpuLittle) / 1_000,
      bigClusterMHz: Number(cpuBig) / 1_000,
    },
    browserMemory: parseBrowserMemory(browserMemory),
  };
}

async function connectToApp() {
  await adb("forward", `tcp:${devToolsPort}`, "localabstract:chrome_devtools_remote");
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${devToolsPort}`,
  );
  const pages = browser.contexts().flatMap((context) => context.pages());
  const httpPages = pages.filter((candidate) =>
    candidate.url().startsWith("http") &&
    !candidate.url().startsWith(`http://127.0.0.1:${devToolsPort}`)
  );
  const page = httpPages.find((candidate) => candidate.url().includes("geant"))
    ?? httpPages[0];
  if (!page) {
    await browser.close();
    throw new Error("No HTTP page is open in Quest Browser.");
  }
  return { browser, page };
}

async function callDebugApi(method, args = []) {
  const { browser, page } = await connectToApp();
  try {
    const value = await page.evaluate(({ methodName, methodArgs }) => {
      const api = window.pasDeGeantDebug;
      if (!api) {
        throw new Error(
          "Runtime controls are disabled. Use a development build or add ?debug=1 to the URL.",
        );
      }
      const selectedMethod = api[methodName];
      if (typeof selectedMethod !== "function") {
        throw new Error(`Unknown runtime method: ${methodName}.`);
      }
      return selectedMethod.apply(api, methodArgs);
    }, { methodName: method, methodArgs: args });
    return { url: page.url(), value };
  } finally {
    await browser.close();
  }
}

async function listTargets() {
  const { browser } = await connectToApp();
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    return await Promise.all(
      pages.map(async (page) => ({
        title: await page.title(),
        url: page.url(),
      })),
    );
  } finally {
    await browser.close();
  }
}

function usage() {
  return [
    "Quest runtime and device telemetry",
    "",
    "  npm run quest:debug -- snapshot",
    "  npm run quest:debug -- device",
    "  npm run quest:debug -- targets",
    "  npm run quest:debug -- call <method> '[arg1,arg2]'",
    "",
    "Examples:",
    "  npm run quest:debug -- call setLocation '[45.88,6.89]'",
    "  npm run quest:debug -- call setScale '[80]'",
    "  npm run quest:debug -- call setRadialMultiplier '[2]'",
    "  npm run quest:debug -- call setMaxZ '[\"textures\",14]'",
    "  npm run quest:debug -- call setRendering '[false]'",
  ].join("\n");
}

async function main() {
  const [command = "snapshot", method, jsonArgs = "[]"] = process.argv.slice(2);
  let result;
  switch (command) {
    case "snapshot": {
      const [app, device] = await Promise.all([
        callDebugApi("snapshot"),
        deviceSnapshot(),
      ]);
      result = { app, device };
      break;
    }
    case "device":
      result = await deviceSnapshot();
      break;
    case "targets":
      result = await listTargets();
      break;
    case "call":
      if (!method) throw new Error("call requires a runtime method name.");
      {
        const args = JSON.parse(jsonArgs);
        if (!Array.isArray(args)) {
          throw new Error("call arguments must be a JSON array.");
        }
        result = await callDebugApi(method, args);
      }
      break;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
