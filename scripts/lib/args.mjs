// Minimal CLI flag parser shared by the scripts/*.mjs data-pipeline tools.
// "--flag=value" -> { flag: "value" }; bare "--flag" -> { flag: true }.
// Non-flag argv entries are ignored. Pass process.argv (the leading node +
// script-path entries are skipped).
export function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}
