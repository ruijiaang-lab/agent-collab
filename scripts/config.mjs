// config.mjs — read/write data/config.yaml (no external deps)
// Simple YAML parser/writer for flat nested objects (string/number/boolean).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  storage: {
    base_path: "./data",
    tasks_dir: "tasks"
  },
  providers: {
    hermes: {
      mode: "cli",         // cli | api
      cli_path: "hermes",
      base_url: "",
      api_key: "",
      model: "",
      api_format: "anthropic",  // anthropic | openai
      timeout: 180
    },
    claude_code: {
      mode: "cli",
      cli_path: "claude",
      base_url: "",
      api_key: "",
      model: "",
      api_format: "anthropic",
      timeout: 180
    },
    codex: {
      mode: "cli",
      cli_path: "codex",
      base_url: "",
      api_key: "",
      model: "",
      api_format: "openai",
      timeout: 180,
      enabled: false
    }
  },
  defaults: {
    review_required: false,
    auto_synthesize: true,
    max_rounds: 3
  }
};

let _configPath = null;
let _config = null;

export function init(configPath) {
  _configPath = configPath || path.join(
    process.env.AGENT_COLLAB_DATA_DIR || path.join(import.meta.dirname, "..", "data"),
    "config.yaml"
  );
  _config = load();
  return _config;
}

export function getConfig() {
  if (!_config) init();
  return _config;
}

export function getConfigPath() {
  return _configPath;
}

export function updateConfig(patch) {
  const current = getConfig();
  deepMerge(current, patch);
  save(current);
  return current;
}

// ---------------------------------------------------------------------------
// YAML parser — handles our specific format only (nested objects, no arrays)
// ---------------------------------------------------------------------------

export function parseYaml(text) {
  const lines = text.split("\n");
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const match = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[2];
    let value = match[3].trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (value === "") {
      // Nested object
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else {
      parent[key] = parseYamlValue(value);
    }
  }

  return root;
}

function parseYamlValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // Strip quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export function serializeYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${pad}${k}: `);
    } else if (typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${pad}${k}:`);
      lines.push(serializeYaml(v, indent + 1));
    } else {
      lines.push(`${pad}${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function load() {
  if (!existsSync(_configPath)) {
    const dir = path.dirname(_configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    save(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const text = readFileSync(_configPath, "utf8");
    const parsed = parseYaml(text);
    return deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function save(config) {
  const dir = path.dirname(_configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(_configPath, serializeYaml(config) + "\n", "utf8");
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
