#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { TextDecoder } = require("util");
const { Proxy } = require("http-mitm-proxy");

const proxy = new Proxy();
const stateDir =
  process.env.SLATE_RANDOMLABS_PROXY_DIR ||
  path.join(os.homedir(), ".local", "share", "slate-randomlabs-proxy");
const dumpDir = path.join(stateDir, "dumps");
const logPath = path.join(stateDir, "traffic.jsonl");
const sslCaDir = path.join(stateDir, "ca");
const localServerDir = path.join(stateDir, "local-server");
const localServerCertPath = path.join(localServerDir, "cert.pem");
const localServerKeyPath = path.join(localServerDir, "key.pem");
const port = Number(process.env.SLATE_RANDOMLABS_PROXY_PORT || "8899");
const host = process.env.SLATE_RANDOMLABS_PROXY_HOST || "127.0.0.1";
const localServerPort = Number(process.env.SLATE_RANDOMLABS_PROXY_LOCAL_PORT || "8898");
const maxBodyBytes = Number(process.env.SLATE_RANDOMLABS_PROXY_MAX_BODY || String(2 * 1024 * 1024));
const defaultSlateConfigPath = path.join(os.homedir(), ".config", "slate", "slate.json");
const localHttpsAgent = new https.Agent({ rejectUnauthorized: false });

fs.mkdirSync(dumpDir, { recursive: true });
fs.mkdirSync(localServerDir, { recursive: true });

let seq = 0;

function now() {
  return new Date().toISOString();
}

function normalizeHost(value) {
  if (!value) return "";
  return String(value).replace(/:\d+$/, "").toLowerCase();
}

function interestingHost(hostname) {
  return (
    hostname === "api.randomlabs.ai" ||
    hostname.endsWith(".randomlabs.ai") ||
    hostname === "agent-worker-prod.randomlabs.workers.dev" ||
    hostname.endsWith(".randomlabs.workers.dev")
  );
}

function appendJson(record) {
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
}

function stripJsonComments(input) {
  return String(input)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function expandHome(value) {
  if (!value) return value;
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseFileTemplate(value) {
  const match = String(value || "").match(/^\{file:(.+)\}$/);
  return match ? expandHome(match[1]) : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeSlotOverride(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return { reasoning: { effort: value } };
  }
  if (!isPlainObject(value)) {
    return null;
  }
  if (typeof value.effort === "string") {
    const { effort, ...rest } = value;
    return deepMerge(rest, { reasoning: { effort } });
  }
  return value;
}

function buildSlotRequestOverrides(rawOverrides, rawThinking) {
  const slotIds = ["main", "subagent", "search", "reasoning", "vision", "image_gen"];
  const overrides = {};
  for (const slotId of slotIds) {
    const requestOverride = normalizeSlotOverride(rawOverrides?.[slotId]);
    const thinkingOverride = normalizeSlotOverride(rawThinking?.[slotId]);
    if (requestOverride && thinkingOverride) {
      overrides[slotId] = deepMerge(requestOverride, thinkingOverride);
    } else if (requestOverride || thinkingOverride) {
      overrides[slotId] = requestOverride || thinkingOverride;
    }
  }
  return overrides;
}

function loadSlateConfig() {
  const configPath = process.env.SLATE_CONFIG || defaultSlateConfigPath;
  try {
    const raw = readText(configPath);
    return JSON.parse(stripJsonComments(raw));
  } catch (error) {
    appendJson({
      time: now(),
      type: "config-warning",
      message: error && error.message ? error.message : String(error),
      path: configPath,
    });
    return {};
  }
}

function getSlateRuntimeConfig() {
  const config = loadSlateConfig();
  const provider = config.provider?.cliproxyapi || {};
  const models = config.models || {};
  const providerOptions = provider.options || {};
  const proxyOptions = providerOptions.slateProxy || {};
  const apiKeyFile =
    parseFileTemplate(providerOptions.apiKey) ||
    path.join(os.homedir(), ".config", "slate", "cliproxyapi-key");
  let apiKey = "";
  try {
    apiKey = readText(apiKeyFile).trim();
  } catch (error) {
    appendJson({
      time: now(),
      type: "config-warning",
      message: error && error.message ? error.message : String(error),
      path: apiKeyFile,
    });
  }

  return {
    providerModels: provider.models || {},
    baseURL: String(providerOptions.baseURL || "http://127.0.0.1:8317/v1").replace(/\/$/, ""),
    apiKey,
    slotDefaults: {
      main: models.main?.default || config.model || "cliproxyapi/gpt-5.4",
      subagent: models.subagent?.default || config.small_model || "cliproxyapi/gpt-5.4-mini",
      search: models.search?.default || "cliproxyapi/glm-5-ali",
      reasoning: models.reasoning?.default || models.main?.default || "cliproxyapi/gpt-5.4",
      vision: models.vision?.default || models.main?.default || "cliproxyapi/gpt-5.4-mini",
      image_gen: models.image_gen?.default || models.subagent?.default || "cliproxyapi/gpt-5.4-mini",
    },
    slotRequestOverrides: buildSlotRequestOverrides(
      proxyOptions.requestOverrides || {},
      proxyOptions.thinking || {}
    ),
  };
}

function localModelId(modelId) {
  if (!modelId) return "";
  return String(modelId).replace(/^cliproxyapi\//, "");
}

function modelDisplayName(modelId, providerModels) {
  const cleanId = localModelId(modelId);
  return providerModels?.[cleanId]?.name || cleanId;
}

function buildLocalModelConfig() {
  const runtime = getSlateRuntimeConfig();
  const slots = {};
  for (const slotId of Object.keys(runtime.slotDefaults)) {
    const defaultModel = runtime.slotDefaults[slotId];
    slots[slotId] = {
      available: [
        {
          id: defaultModel,
          name: modelDisplayName(defaultModel, runtime.providerModels),
          recommended: true,
          speed: 4,
          cost: 0,
          quality: 4,
          bestFor: "Local CLIProxyAPI route",
        },
      ],
      default: defaultModel,
    };
  }
  return { slots };
}

function ensureLocalServerCertificate() {
  if (fs.existsSync(localServerKeyPath) && fs.existsSync(localServerCertPath)) {
    return;
  }
  childProcess.execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    localServerKeyPath,
    "-out",
    localServerCertPath,
    "-days",
    "3650",
    "-subj",
    "/CN=127.0.0.1",
  ]);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "object") return JSON.stringify(part.content || {});
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function parseBalancedJsonObject(input, startIndex) {
  if (input[startIndex] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: input.slice(startIndex, index + 1),
          endIndex: index + 1,
        };
      }
    }
  }
  return null;
}

function extractInlineToolCalls(input) {
  const text = String(input || "");
  const calls = [];
  let cleaned = "";
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = text.indexOf("to=", cursor);
    if (matchIndex === -1) {
      cleaned += text.slice(cursor);
      break;
    }

    cleaned += text.slice(cursor, matchIndex);
    let index = matchIndex + 3;
    while (index < text.length && /[A-Za-z0-9_.-]/.test(text[index])) {
      index += 1;
    }
    const toolName = text.slice(matchIndex + 3, index);
    const codePrefix = " code=";
    if (!toolName || text.slice(index, index + codePrefix.length) !== codePrefix) {
      cleaned += text.slice(matchIndex, index);
      cursor = index;
      continue;
    }

    const payloadStart = index + codePrefix.length;
    const parsed = parseBalancedJsonObject(text, payloadStart);
    if (!parsed) {
      cleaned += text.slice(matchIndex);
      break;
    }

    try {
      calls.push({
        raw: text.slice(matchIndex, parsed.endIndex),
        toolName,
        payload: JSON.parse(parsed.text),
      });
    } catch (error) {
      cleaned += text.slice(matchIndex, parsed.endIndex);
    }
    cursor = parsed.endIndex;
  }

  return {
    calls,
    cleanedText: cleaned.trim(),
  };
}

function sanitizeAssistantContent(content) {
  const { cleanedText } = extractInlineToolCalls(content);
  return cleanedText;
}

function translateMessages(messages) {
  return (messages || [])
    .filter((message) => ["system", "user", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role,
      content:
        message.role === "assistant"
          ? sanitizeAssistantContent(normalizeMessageContent(message.content))
          : normalizeMessageContent(message.content),
    }))
    .filter((message) => message.content);
}

function extractWorkingDirectory(requestBody) {
  const sources = [];
  for (const message of requestBody.messages || []) {
    sources.push(normalizeMessageContent(message.content));
  }
  if (typeof requestBody.context === "string") {
    sources.push(requestBody.context);
  }
  const combined = sources.join("\n");
  const match = combined.match(/<working_directory>([^<]+)<\/working_directory>/);
  return match ? match[1].trim() : process.cwd();
}

function localToolSystemPrompt(cwd) {
  return [
    "You are running behind a local compatibility layer that provides real filesystem and shell tools.",
    "Use the provided function tools whenever you need to inspect files, search code, run commands, or edit files.",
    'Never print raw tool invocations like `to=container.exec code=...` in normal text.',
    "If tools are needed, call the function tools directly instead of describing the call.",
    `Current working directory: ${cwd}`,
  ].join("\n");
}

function withLocalToolPrompt(messages, cwd) {
  const prompt = { role: "system", content: localToolSystemPrompt(cwd) };
  return [prompt, ...messages];
}

function localToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command in the current workspace with bash -lc.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutMs: { type: "number" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "exec_process",
        description: "Run a process with an explicit command and argument array.",
        parameters: {
          type: "object",
          properties: {
            cmd: {
              oneOf: [
                { type: "string" },
                {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                },
              ],
            },
            timeoutMs: { type: "number" },
          },
          required: ["cmd"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file. Optionally limit by line range.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and directories under a path.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            depth: { type: "number" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep_files",
        description: "Search for a regex pattern in files under a path.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            caseSensitive: { type: "boolean" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write full text content to a file, creating parent directories if needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "Replace text in a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
  ];
}

function finishUsage(usage) {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
  };
}

function mergeUsageTotals(base, usage) {
  if (!usage) {
    return base;
  }
  const current = base || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: {},
    completion_tokens_details: {},
  };
  current.prompt_tokens += usage.prompt_tokens || 0;
  current.completion_tokens += usage.completion_tokens || 0;
  current.total_tokens += usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  return current;
}

function resolvePath(cwd, targetPath) {
  const expanded = expandHome(String(targetPath || ""));
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timeoutMs = Number(options.timeoutMs || 120000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: signal || null,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: error && error.message ? error.message : String(error),
      });
    });
  });
}

function readFileRange(filePath, startLine, endLine) {
  const content = fs.readFileSync(filePath, "utf8");
  if (!startLine && !endLine) {
    return content;
  }
  const lines = content.split("\n");
  const from = Math.max(1, Number(startLine || 1));
  const to = Math.min(lines.length, Number(endLine || lines.length));
  return lines.slice(from - 1, to).join("\n");
}

function listFilesTree(targetPath, depth) {
  const results = [];
  function visit(currentPath, currentDepth) {
    if (currentDepth > depth) {
      return;
    }
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      results.push({
        path: fullPath,
        type: entry.isDirectory() ? "directory" : "file",
      });
      if (entry.isDirectory()) {
        visit(fullPath, currentDepth + 1);
      }
    }
  }
  visit(targetPath, 1);
  return results;
}

async function executeLocalTool(name, args, cwd) {
  try {
    switch (name) {
      case "bash": {
        return await runProcess("bash", ["-lc", String(args.command || "")], {
          cwd,
          timeoutMs: args.timeoutMs,
        });
      }
      case "exec_process": {
        const commandValue = args.cmd;
        if (Array.isArray(commandValue) && commandValue.length > 0) {
          const [command, ...rest] = commandValue.map(String);
          return await runProcess(command, rest, { cwd, timeoutMs: args.timeoutMs });
        }
        if (typeof commandValue === "string" && commandValue) {
          return await runProcess("bash", ["-lc", commandValue], { cwd, timeoutMs: args.timeoutMs });
        }
        return { ok: false, stderr: "Invalid exec_process cmd", stdout: "", exitCode: null, signal: null, timedOut: false };
      }
      case "read_file": {
        const filePath = resolvePath(cwd, args.path);
        return {
          ok: true,
          path: filePath,
          content: readFileRange(filePath, args.startLine, args.endLine),
        };
      }
      case "list_files": {
        const targetPath = resolvePath(cwd, args.path || ".");
        return {
          ok: true,
          path: targetPath,
          entries: listFilesTree(targetPath, Math.max(1, Number(args.depth || 2))),
        };
      }
      case "grep_files": {
        const targetPath = resolvePath(cwd, args.path || ".");
        const rgArgs = ["-n"];
        if (!args.caseSensitive) {
          rgArgs.push("-i");
        }
        rgArgs.push(String(args.pattern), targetPath);
        return await runProcess("rg", rgArgs, { cwd, timeoutMs: 120000 });
      }
      case "write_file": {
        const filePath = resolvePath(cwd, args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(args.content || ""), "utf8");
        return { ok: true, path: filePath, bytes: Buffer.byteLength(String(args.content || ""), "utf8") };
      }
      case "replace_in_file": {
        const filePath = resolvePath(cwd, args.path);
        const source = fs.readFileSync(filePath, "utf8");
        const search = String(args.search || "");
        const replace = String(args.replace || "");
        if (!search) {
          return { ok: false, path: filePath, error: "Empty search string" };
        }
        const replaced = args.replaceAll ? source.split(search).join(replace) : source.replace(search, replace);
        if (replaced === source) {
          return { ok: false, path: filePath, error: "Search string not found" };
        }
        fs.writeFileSync(filePath, replaced, "utf8");
        return { ok: true, path: filePath, changed: true };
      }
      default:
        return { ok: false, error: `Unknown local tool: ${name}` };
    }
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

function emitTextChunks(res, text) {
  if (!text) {
    return;
  }
  emitSse(res, "text", { chunk: text });
}

function compactToolResultForSse(result) {
  const maxLength = 12000;
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else {
    try {
      text = JSON.stringify(result);
    } catch (error) {
      text = JSON.stringify({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function emitToolLifecycle(res, toolCallId, toolName, args, result) {
  emitSse(res, "tool_call_streaming_start", { toolCallId, toolName });
  emitSse(res, "tool_call_delta", { toolCallId, argsTextDelta: JSON.stringify(args) });
  emitSse(res, "tool_result", {
    toolCallId,
    result: compactToolResultForSse(result),
  });
}

function nativeToolCallsFromMessage(message) {
  if (!Array.isArray(message?.tool_calls)) {
    return [];
  }
  return message.tool_calls
    .map((toolCall) => {
      const functionName = toolCall?.function?.name;
      const argumentsText = toolCall?.function?.arguments || "{}";
      try {
        return {
          toolCallId: toolCall.id || `call_${Date.now()}`,
          toolName: functionName,
          args: JSON.parse(argumentsText),
        };
      } catch (error) {
        return {
          toolCallId: toolCall.id || `call_${Date.now()}`,
          toolName: functionName,
          args: {},
          parseError: error && error.message ? error.message : String(error),
        };
      }
    })
    .filter((toolCall) => toolCall.toolName);
}

function fallbackToolCallsFromText(text) {
  const parsed = extractInlineToolCalls(text);
  return {
    cleanedText: parsed.cleanedText,
    calls: parsed.calls.map((toolCall, index) => {
      if (toolCall.toolName === "container.exec") {
        return {
          toolCallId: `fallback_${Date.now()}_${index}`,
          toolName: "exec_process",
          args: {
            cmd: toolCall.payload.cmd,
            timeoutMs: toolCall.payload.timeout,
          },
        };
      }
      return {
        toolCallId: `fallback_${Date.now()}_${index}`,
        toolName: toolCall.toolName,
        args: toolCall.payload,
      };
    }),
  };
}

async function callCliProxyChat(runtime, payload) {
  const upstreamResponse = await fetch(`${runtime.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    throw new Error(errorBody || `CLIProxyAPI upstream failed (${upstreamResponse.status})`);
  }

  return upstreamResponse.json();
}

function buildToolPayload(route, messages, slotOverride) {
  let payload = {
    model: route.model,
    stream: false,
    messages,
    tools: localToolDefinitions(),
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
  if (slotOverride) {
    payload = deepMerge(payload, slotOverride);
    payload.model = route.model;
    payload.stream = false;
    payload.messages = messages;
    payload.tools = localToolDefinitions();
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = false;
  }
  return payload;
}

async function proxyWorkerWithLocalTools(res, requestBody, runtime, route, slotOverride) {
  const cwd = extractWorkingDirectory(requestBody);
  let messages = withLocalToolPrompt(translateMessages(requestBody.messages), cwd);
  let totalUsage = null;

  for (let step = 0; step < 8; step += 1) {
    const responseJson = await callCliProxyChat(runtime, buildToolPayload(route, messages, slotOverride));
    const choice = responseJson?.choices?.[0] || {};
    const assistantMessage = choice.message || {};
    const rawText = normalizeMessageContent(assistantMessage.content);
    const nativeCalls = nativeToolCallsFromMessage(assistantMessage);
    const fallback = nativeCalls.length === 0 ? fallbackToolCallsFromText(rawText) : { cleanedText: rawText, calls: [] };
    const visibleText = sanitizeAssistantContent(fallback.cleanedText || rawText);
    totalUsage = mergeUsageTotals(totalUsage, responseJson.usage);

    if (assistantMessage.reasoning_content) {
      emitSse(res, "reasoning", {
        details: [
          {
            type: "reasoning.text",
            text: String(assistantMessage.reasoning_content),
            format: "openai-compatible-v1",
            index: 0,
          },
        ],
      });
    }

    const calls = nativeCalls.length > 0 ? nativeCalls : fallback.calls;
    if (calls.length > 0) {
      if (nativeCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: visibleText || "",
          tool_calls: assistantMessage.tool_calls,
        });
      }
      if (nativeCalls.length === 0) {
        const syntheticCalls = calls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: {
            name: call.toolName,
            arguments: JSON.stringify(call.args),
          },
        }));
        messages.push({
          role: "assistant",
          content: visibleText || "",
          tool_calls: syntheticCalls,
        });
      }
      emitTextChunks(res, visibleText);

      for (const call of calls) {
        const result = call.parseError
          ? { ok: false, error: call.parseError }
          : await executeLocalTool(call.toolName, call.args, cwd);
        emitToolLifecycle(res, call.toolCallId, call.toolName, call.args, result);
        messages.push({
          role: "tool",
          tool_call_id: call.toolCallId,
          content: JSON.stringify(result),
        });
      }

      emitSse(res, "finish_step", {
        finishReason: "tool_call",
        isContinued: true,
        usage: finishUsage(responseJson.usage),
      });
      continue;
    }

    emitTextChunks(res, visibleText || rawText);
    emitSse(res, "finish_message", {
      finishReason: choice.finish_reason || "stop",
      usage: finishUsage(responseJson.usage),
    });
    if (totalUsage) {
      emitSse(res, "usage", slateUsage(route.model, totalUsage));
    }
    return;
  }

  emitSse(res, "text", {
    chunk: "Local proxy stopped after too many tool iterations.",
  });
  emitSse(res, "finish_message", {
    finishReason: "length",
    usage: finishUsage(totalUsage),
  });
  if (totalUsage) {
    emitSse(res, "usage", slateUsage(route.model, totalUsage));
  }
}

function chooseLocalRoute(requestBody) {
  const runtime = getSlateRuntimeConfig();
  const requested = String(requestBody.model || "");
  if (requested.startsWith("cliproxyapi/")) {
    const matchedSlot = Object.entries(runtime.slotDefaults).find(
      ([, modelId]) => String(modelId) === requested
    )?.[0];
    return {
      slot: matchedSlot || "main",
      model: localModelId(requested),
    };
  }
  if ((requestBody.sessionId || "").startsWith("title-")) {
    return {
      slot: "subagent",
      model: localModelId(runtime.slotDefaults.subagent),
    };
  }
  const explicitMap = {
    "randomlabs/fast-default-alpha": "subagent",
    "anthropic/claude-haiku-4.5": "search",
    "anthropic/claude-sonnet-4.6": "main",
    "anthropic/claude-opus-4.6": "main",
    "openai/gpt-5.3-codex": "reasoning",
    "openai/gpt-5.4": "main",
    "z-ai/glm-5": "search",
    "google/gemini-flash-3": "vision",
    "google/nano-banana": "image_gen",
  };
  if (explicitMap[requested]) {
    const slot = explicitMap[requested];
    return {
      slot,
      model: localModelId(runtime.slotDefaults[slot]),
    };
  }
  if (requested.includes("glm")) {
    return {
      slot: "search",
      model: localModelId(runtime.slotDefaults.search),
    };
  }
  if (requested.includes("codex")) {
    return {
      slot: "reasoning",
      model: localModelId(runtime.slotDefaults.reasoning),
    };
  }
  return {
    slot: "main",
    model: localModelId(runtime.slotDefaults.main),
  };
}

function emitSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function slateUsage(localModel, usage) {
  return {
    model: `cliproxyapi/${localModel}`,
    usage: {
      prompt_tokens: usage?.prompt_tokens || 0,
      completion_tokens: usage?.completion_tokens || 0,
      total_tokens:
        usage?.total_tokens ||
        (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
      cost: 0,
      prompt_tokens_details: {
        cached_tokens: usage?.prompt_tokens_details?.cached_tokens || 0,
        cache_write_tokens: usage?.prompt_tokens_details?.cache_write_tokens || 0,
        audio_tokens: usage?.prompt_tokens_details?.audio_tokens || 0,
        video_tokens: usage?.prompt_tokens_details?.video_tokens || 0,
      },
      completion_tokens_details: {
        reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens || 0,
        image_tokens: usage?.completion_tokens_details?.image_tokens || 0,
        audio_tokens: usage?.completion_tokens_details?.audio_tokens || 0,
      },
    },
  };
}

async function proxyWorkerStream(req, res, rawBody) {
  const requestBody = JSON.parse(rawBody.toString("utf8") || "{}");
  const runtime = getSlateRuntimeConfig();
  if (!runtime.apiKey) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Missing CLIProxyAPI key");
    return;
  }

  const route = chooseLocalRoute(requestBody);
  const slotOverride = runtime.slotRequestOverrides[route.slot] || null;
  let upstreamPayload = {
    model: route.model,
    stream: true,
    messages: translateMessages(requestBody.messages),
  };
  if (slotOverride) {
    upstreamPayload = deepMerge(upstreamPayload, slotOverride);
    upstreamPayload.model = route.model;
    upstreamPayload.stream = true;
    upstreamPayload.messages = translateMessages(requestBody.messages);
  }

  appendJson({
    time: now(),
    type: "local-worker-request",
    slot: route.slot,
    requestedModel: requestBody.model || null,
    localModel: route.model,
    sessionId: requestBody.sessionId || null,
    reasoningBudget: requestBody.reasoningBudget ?? null,
    slotOverride,
    messageCount: upstreamPayload.messages.length,
  });

  if (Array.isArray(requestBody.toolNames) && requestBody.toolNames.length > 0) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    await proxyWorkerWithLocalTools(res, requestBody, runtime, route, slotOverride);
    res.end();
    return;
  }

  const upstreamResponse = await fetch(`${runtime.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(upstreamPayload),
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errorBody = await upstreamResponse.text();
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(errorBody || `CLIProxyAPI upstream failed (${upstreamResponse.status})`);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!dataLine || dataLine === "[DONE]") {
        continue;
      }
      const chunk = JSON.parse(dataLine);
      const choice = chunk.choices?.[0] || {};
      const delta = choice.delta || {};

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emitSse(res, "reasoning", {
          details: [
            {
              type: "reasoning.text",
              text: delta.reasoning_content,
              format: "openai-compatible-v1",
              index: 0,
            },
          ],
        });
      }

      if (typeof delta.content === "string" && delta.content) {
        emitSse(res, "text", { chunk: delta.content });
      }

      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
    }
  }

  if (lastUsage) {
    emitSse(res, "usage", slateUsage(route.model, lastUsage));
  }

  emitSse(res, "finish_message", {
    finishReason: "stop",
    usage: finishUsage(lastUsage),
  });
  res.end();
}

async function handleLocalServerRequest(req, res) {
  const body = await collectRequestBody(req);
  appendJson({
    time: now(),
    type: "local-server-hit",
    method: req.method,
    url: req.url,
    bytes: body.length,
    originalHost: req.headers["x-slate-original-host"] || null,
  });

  if (req.method === "GET" && req.url === "/model-config") {
    const responseBody = Buffer.from(JSON.stringify(buildLocalModelConfig()));
    res.writeHead(200, {
      "content-type": "application/json;charset=utf-8",
      "content-length": responseBody.length,
      "access-control-allow-origin": "*",
    });
    res.end(responseBody);
    return;
  }

  if (req.method === "POST" && req.url === "/v3/stream") {
    await proxyWorkerStream(req, res, body);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function startLocalServer() {
  ensureLocalServerCertificate();
  const server = https.createServer(
    {
      key: fs.readFileSync(localServerKeyPath),
      cert: fs.readFileSync(localServerCertPath),
    },
    (req, res) => {
      handleLocalServerRequest(req, res).catch((error) => {
        appendJson({
          time: now(),
          type: "local-server-error",
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? error.stack : null,
          url: req.url,
        });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end("Local Slate proxy failed");
      });
    }
  );

  server.listen(localServerPort, "127.0.0.1");
  appendJson({
    time: now(),
    type: "local-server-startup",
    host: "127.0.0.1",
    port: localServerPort,
  });
  return server;
}

function writeBodyFile(id, prefix, body) {
  const file = path.join(dumpDir, `${id}.${prefix}.bin`);
  fs.writeFileSync(file, body);
  return file;
}

proxy.onError((ctx, err, errorKind) => {
  appendJson({
    time: now(),
    type: "error",
    errorKind,
    message: err && err.message ? err.message : String(err),
    host: normalizeHost(ctx?.clientToProxyRequest?.headers?.host),
    url: ctx?.clientToProxyRequest?.url || null,
  });
});

proxy.onRequest((ctx, callback) => {
  const reqHost = normalizeHost(ctx.clientToProxyRequest.headers.host);
  const id = `${Date.now()}-${++seq}`;
  const reqUrl = ctx.clientToProxyRequest.url;
  ctx.__slateProxy = {
    id,
    host: reqHost,
    url: reqUrl,
    interesting: interestingHost(reqHost),
    reqChunks: [],
    reqBytes: 0,
    resChunks: [],
    resBytes: 0,
    startedAt: now(),
  };

  appendJson({
    time: ctx.__slateProxy.startedAt,
    type: "request-start",
    id,
    method: ctx.clientToProxyRequest.method,
    host: reqHost,
    url: reqUrl,
    headers: ctx.clientToProxyRequest.headers,
  });

  const shouldRewrite =
    (reqHost === "api.randomlabs.ai" && reqUrl === "/model-config") ||
    (reqHost === "agent-worker-prod.randomlabs.workers.dev" && reqUrl === "/v3/stream");

  if (shouldRewrite) {
    ctx.proxyToServerRequestOptions.host = "127.0.0.1";
    ctx.proxyToServerRequestOptions.port = localServerPort;
    ctx.proxyToServerRequestOptions.agent = localHttpsAgent;
    ctx.proxyToServerRequestOptions.headers = {
      ...ctx.proxyToServerRequestOptions.headers,
      host: `127.0.0.1:${localServerPort}`,
      "x-slate-original-host": reqHost,
      "x-slate-original-url": reqUrl,
    };
    appendJson({
      time: now(),
      type: "rewrite",
      id,
      host: reqHost,
      url: reqUrl,
      target: `https://127.0.0.1:${localServerPort}${reqUrl}`,
    });
  }
  callback();
});

proxy.onRequestData((ctx, chunk, callback) => {
  const meta = ctx.__slateProxy;
  if (meta && meta.interesting && meta.reqBytes < maxBodyBytes) {
    meta.reqChunks.push(chunk);
    meta.reqBytes += chunk.length;
  }
  callback(null, chunk);
});

proxy.onRequestEnd((ctx, callback) => {
  const meta = ctx.__slateProxy;
  if (meta && meta.interesting && meta.reqChunks.length > 0) {
    const body = Buffer.concat(meta.reqChunks);
    meta.requestBodyFile = writeBodyFile(meta.id, "request", body);
    appendJson({
      time: now(),
      type: "request-body",
      id: meta.id,
      host: meta.host,
      bytes: body.length,
      file: meta.requestBodyFile,
    });
  }
  callback();
});

proxy.onResponse((ctx, callback) => {
  const meta = ctx.__slateProxy;
  if (meta) {
    appendJson({
      time: now(),
      type: "response-start",
      id: meta.id,
      host: meta.host,
      statusCode: ctx.serverToProxyResponse.statusCode,
      headers: ctx.serverToProxyResponse.headers,
    });
  }
  callback();
});

proxy.onResponseData((ctx, chunk, callback) => {
  const meta = ctx.__slateProxy;
  if (meta && meta.interesting && meta.resBytes < maxBodyBytes) {
    meta.resChunks.push(chunk);
    meta.resBytes += chunk.length;
  }
  callback(null, chunk);
});

proxy.onResponseEnd((ctx, callback) => {
  const meta = ctx.__slateProxy;
  if (meta && meta.interesting && meta.resChunks.length > 0) {
    const body = Buffer.concat(meta.resChunks);
    meta.responseBodyFile = writeBodyFile(meta.id, "response", body);
    appendJson({
      time: now(),
      type: "response-body",
      id: meta.id,
      host: meta.host,
      bytes: body.length,
      file: meta.responseBodyFile,
    });
  }
  appendJson({
    time: now(),
    type: "request-end",
    id: meta?.id || null,
    host: meta?.host || null,
  });
  callback();
});

const localServer = startLocalServer();

proxy.listen({
  port,
  host,
  sslCaDir,
  forceSNI: true,
});

appendJson({
  time: now(),
  type: "startup",
  port,
  host,
  stateDir,
  sslCaDir,
});

process.on("SIGINT", () => {
  appendJson({ time: now(), type: "shutdown", signal: "SIGINT" });
  localServer.close();
  proxy.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  appendJson({ time: now(), type: "shutdown", signal: "SIGTERM" });
  localServer.close();
  proxy.close();
  process.exit(0);
});
