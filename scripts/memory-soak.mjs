/* Memory soak test: launch installed app, identify Electron process roles,
 * run start/stop session cycles, track total memory of the process tree. */
import { execSync } from "node:child_process";

const ps = (script) => execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { encoding: "utf8" });

function tree() {
  const out = ps(
    "Get-CimInstance Win32_Process -Filter \"Name like '%Callout%'\" | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }; $p = Get-Process -Id $_.ProcessId; '{0}|{1}|{2}|{3}' -f $t, $_.ProcessId, [math]::Round($p.WorkingSet64/1MB,1), $p.StartTime.ToString('HHmmss') }",
  );
  return out.trim().split(/\r?\n/).filter(Boolean);
}

const totalMB = () => tree().reduce((s, l) => s + Number(l.split("|")[2] || 0), 0);

const control = (path, method = "GET") =>
  fetch(`http://127.0.0.1:47477${path}`, {
    method,
    headers: { "x-callout-relay-client": "soak" },
  }).then((r) => r.json());

console.log("=== process roles at idle ===");
for (const l of tree()) console.log("  " + l.replace(/\|/g, "  "));

for (let cycle = 1; cycle <= 3; cycle += 1) {
  await control("/start", "POST");
  await new Promise((r) => setTimeout(r, 15000));
  const live = await control("/status");
  await control("/stop", "POST");
  await new Promise((r) => setTimeout(r, 8000));
  const mem = totalMB();
  console.log(`cycle ${cycle}: state=${live.session.state} after-stop, tree=${mem} MB, procs=${tree().length}`);
}

console.log("\n=== final process roles ===");
for (const l of tree()) console.log("  " + l.replace(/\|/g, "  "));

// shut the app down cleanly
execSync('powershell -NoProfile -Command "Get-Process \'Callout Relay\' -ErrorAction SilentlyContinue | Stop-Process -Force"');
console.log("done");
