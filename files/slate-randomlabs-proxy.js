#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { TextDecoder } = require("util");

let ProxyImpl;
try {
  ({ Proxy: ProxyImpl } = require("http-mitm-proxy"));
} catch (error) {
  if (require.main === module) {
    throw error;
  }
  ProxyImpl = class ProxyStub {
    onError() {}
    onRequest() {}
    onRequestData() {}
    onRequestEnd() {}
    onResponse() {}
    onResponseData() {}
    onResponseEnd() {}
    listen() {}
    close() {}
  };
}

const proxy = new ProxyImpl();
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
const maxBodyBytes = Number(process.env.SLATE_RANDOMLABS_PROXY_MAX_BODY || String(8 * 1024 * 1024));
const maxUpstreamPayloadChars = Number(
  process.env.SLATE_RANDOMLABS_PROXY_MAX_UPSTREAM_CHARS || "450000"
);
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
  return String(cleanedText || "")
    .replace(/Local proxy stopped after too many tool iterations\.?/g, "")
    .trim();
}

function contentParts(content) {
  if (Array.isArray(content)) {
    return content.filter((part) => part && typeof part === "object");
  }
  if (typeof content === "string" && content) {
    return [{ type: "text", text: content }];
  }
  return [];
}

function textPartText(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "object" && isPlainObject(part.content)) {
    return JSON.stringify(part.content);
  }
  return "";
}

function limitText(text, maxChars, label) {
  if (typeof text !== "string") {
    return "";
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const headChars = Math.max(0, maxChars - 96);
  const suffix = `\n\n[${label || "content"} truncated to keep Slate transport within limits]`;
  return `${text.slice(0, headChars)}${suffix}`;
}

function truncateTranslatedContent(content, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return content;
  }

  if (typeof content === "string") {
    return limitText(content, maxChars, "message");
  }

  if (!Array.isArray(content)) {
    return content;
  }

  let remaining = maxChars;
  const truncated = [];

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type !== "text" || typeof part.text !== "string") {
      truncated.push(part);
      continue;
    }
    if (remaining <= 0) {
      break;
    }
    const limitedText = limitText(part.text, remaining, "message");
    truncated.push({ ...part, text: limitedText });
    remaining -= limitedText.length;
  }

  return truncated;
}

function translateUserFacingContent(content, options) {
  const parts = contentParts(content);
  if (parts.length === 0) {
    return truncateTranslatedContent(normalizeMessageContent(content), options?.textMaxChars);
  }

  const translated = [];
  let hasRichParts = false;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      translated.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" && isPlainObject(part.image_url) && typeof part.image_url.url === "string") {
      hasRichParts = true;
      translated.push({ type: "image_url", image_url: part.image_url });
      continue;
    }
    const fallbackText = textPartText(part);
    if (fallbackText) {
      translated.push({ type: "text", text: fallbackText });
    }
  }

  if (translated.length === 0) {
    return truncateTranslatedContent(normalizeMessageContent(content), options?.textMaxChars);
  }
  if (!hasRichParts) {
    return truncateTranslatedContent(
      translated.map((part) => part.text).join("\n"),
      options?.textMaxChars
    );
  }
  return truncateTranslatedContent(translated, options?.textMaxChars);
}

function assistantToolCallsFromContent(content) {
  const toolCalls = [];

  for (const part of contentParts(content)) {
    if (part.type === "tool_call" && part.id && part.tool) {
      toolCalls.push({
        id: String(part.id),
        type: "function",
        function: {
          name: String(part.tool),
          arguments: JSON.stringify(part.args || {}),
        },
      });
      continue;
    }

    if (part.type === "object" && part.id && isPlainObject(part.content)) {
      const inner = part.content.tool && isPlainObject(part.content.tool)
        ? part.content.tool
        : part.content;
      if (inner.tool) {
        toolCalls.push({
          id: String(part.id),
          type: "function",
          function: {
            name: String(inner.tool),
            arguments: JSON.stringify(inner.args || {}),
          },
        });
      }
    }
  }

  return toolCalls;
}

function assistantTextFromSlateMessage(message, options) {
  const content = sanitizeAssistantContent(
    contentParts(message.content).map(textPartText).filter(Boolean).join("\n")
  );
  return limitText(content, options?.textMaxChars, "assistant message");
}

function toolMessagesFromSlateMessage(message, options) {
  const translated = [];

  for (const part of contentParts(message.content)) {
    if (part.type !== "tool_response" || !part.tool_call_id) {
      continue;
    }
    const result = part.result == null
      ? ""
      : typeof part.result === "string"
        ? part.result
        : JSON.stringify(part.result);
    translated.push({
      role: "tool",
      tool_call_id: String(part.tool_call_id),
      content: limitText(result, options?.toolResultMaxChars, "tool result"),
    });
  }

  return translated;
}

function translateMessages(messages, options) {
  const translated = [];

  for (const message of messages || []) {
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "system" || message.role === "user") {
      const content = translateUserFacingContent(message.content, options);
      if (Array.isArray(content) ? content.length > 0 : Boolean(content)) {
        translated.push({ role: message.role, content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = assistantTextFromSlateMessage(message, options);
      const toolCalls = assistantToolCallsFromContent(message.content);
      if (content || toolCalls.length > 0) {
        const assistantMessage = { role: "assistant" };
        if (content) {
          assistantMessage.content = content;
        }
        if (toolCalls.length > 0 && !options?.dropAssistantToolCalls) {
          assistantMessage.tool_calls = toolCalls;
        }
        translated.push(assistantMessage);
      }
      continue;
    }

    if (message.role === "tool_response") {
      if (!options?.dropToolResponses) {
        translated.push(...toolMessagesFromSlateMessage(message, options));
      }
    }
  }

  return translated;
}

function recentWindowStart(messages, keepRecentMessages) {
  let start = Math.max(0, (messages || []).length - Math.max(1, keepRecentMessages || 1));
  while (start > 0 && messages[start]?.role === "tool_response") {
    start -= 1;
  }
  return start;
}

function compactSlateMessages(messages, options) {
  const start = recentWindowStart(messages || [], options?.keepRecentMessages || 12);
  const compacted = [];
  let omittedToolTraffic = false;
  let omittedCount = 0;

  for (const message of (messages || []).slice(0, start)) {
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "system" || message.role === "user") {
      const content = translateUserFacingContent(message.content, {
        textMaxChars: options?.oldTextMaxChars,
      });
      if (Array.isArray(content) ? content.length > 0 : Boolean(content)) {
        compacted.push({ role: message.role, content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = assistantTextFromSlateMessage(message, {
        textMaxChars: options?.oldTextMaxChars,
      });
      if (content) {
        compacted.push({ role: "assistant", content });
      }
      if (assistantToolCallsFromContent(message.content).length > 0) {
        omittedToolTraffic = true;
      }
      continue;
    }

    if (message.role === "tool_response") {
      omittedToolTraffic = true;
      omittedCount += 1;
    }
  }

  if (omittedToolTraffic) {
    compacted.push({
      role: "system",
      content:
        "Earlier intermediate Slate tool calls and tool outputs were compacted for transport. Use the recent messages as the canonical working state.",
    });
  }

  const recent = translateMessages((messages || []).slice(start), {
    textMaxChars: options?.recentTextMaxChars,
    toolResultMaxChars: options?.recentToolResultMaxChars,
  });
  compacted.push(...recent);

  return {
    messages: compacted,
    meta: {
      recentStart: start,
      omittedToolTraffic,
      omittedCount,
    },
  };
}

function transportCandidates(messages, options) {
  const strategies = [
    {
      name: "full",
      mode: "exact",
    },
    {
      name: "trimmed-full",
      mode: "exact",
      textMaxChars: 24000,
      toolResultMaxChars: 24000,
    },
    {
      name: "compact-18",
      mode: "compact",
      keepRecentMessages: 18,
      oldTextMaxChars: 2000,
      recentTextMaxChars: 12000,
      recentToolResultMaxChars: 16000,
    },
    {
      name: "compact-12",
      mode: "compact",
      keepRecentMessages: 12,
      oldTextMaxChars: 1200,
      recentTextMaxChars: 8000,
      recentToolResultMaxChars: 10000,
    },
    {
      name: "compact-8",
      mode: "compact",
      keepRecentMessages: 8,
      oldTextMaxChars: 800,
      recentTextMaxChars: 4000,
      recentToolResultMaxChars: 6000,
    },
  ];

  return strategies.map((strategy) => {
    const built =
      strategy.mode === "compact"
        ? compactSlateMessages(messages, strategy)
        : { messages: translateMessages(messages, strategy), meta: {} };
    const payloadChars = JSON.stringify({ messages: built.messages }).length;
    return {
      ...strategy,
      messages: built.messages,
      payloadChars,
      withinLimit: payloadChars <= (options?.maxPayloadChars || maxUpstreamPayloadChars),
      meta: built.meta || {},
    };
  });
}

function shouldRetryUpstreamRequest(status, errorBody) {
  if (status === 401 || status === 403) {
    return false;
  }

  const body = String(errorBody || "").toLowerCase();
  if (status === 408 || status === 413 || status === 429 || status >= 500) {
    return true;
  }

  return /empty_stream|context|payload|too large|length|timeout|server_error/.test(body);
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

function appendStreamToolCallDelta(toolCalls, deltaToolCalls) {
  for (const deltaToolCall of deltaToolCalls || []) {
    const index =
      Number.isInteger(deltaToolCall?.index) && deltaToolCall.index >= 0
        ? deltaToolCall.index
        : toolCalls.length;
    const current =
      toolCalls[index] || {
        id: "",
        toolName: "",
        argsText: "",
      };

    if (deltaToolCall?.id) {
      current.id = String(deltaToolCall.id);
    }
    if (deltaToolCall?.function?.name) {
      current.toolName = String(deltaToolCall.function.name);
    }
    if (typeof deltaToolCall?.function?.arguments === "string") {
      current.argsText += deltaToolCall.function.arguments;
    }

    toolCalls[index] = current;
  }
}

function collectLiveToolCallEvents(toolCalls, state) {
  const events = [];
  const startedIndexes = state?.startedIndexes || new Set();
  const emittedArgLengths = state?.emittedArgLengths || new Map();

  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index];
    if (!toolCall || !toolCall.id) {
      continue;
    }

    if (toolCall.toolName && !startedIndexes.has(index)) {
      events.push({
        event: "tool_call_streaming_start",
        payload: {
          toolCallId: String(toolCall.id),
          toolName: String(toolCall.toolName),
        },
      });
      startedIndexes.add(index);
    }

    const argsText = typeof toolCall.argsText === "string" ? toolCall.argsText : "";
    const emittedArgLength = emittedArgLengths.get(index) || 0;
    if (argsText.length > emittedArgLength) {
      events.push({
        event: "tool_call_delta",
        payload: {
          toolCallId: String(toolCall.id),
          argsTextDelta: argsText.slice(emittedArgLength),
        },
      });
      emittedArgLengths.set(index, argsText.length);
    }
  }

  return events;
}

function normalizeSlateToolCall(toolCall, options) {
  if (!toolCall || !toolCall.toolName) {
    return null;
  }

  let args = {};
  const rawArgs = String(toolCall.argsText || "").trim();
  if (!rawArgs && options?.requireArgsText) {
    return null;
  }
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      if (options?.logParseWarning) {
        appendJson({
          time: now(),
          type: "tool-call-parse-warning",
          toolCallId: toolCall.id || null,
          toolName: toolCall.toolName,
          argsText: rawArgs,
          message: error && error.message ? error.message : String(error),
        });
      }
      return null;
    }
  }

  return {
    id: toolCall.id || null,
    tool: toolCall.toolName,
    args,
  };
}

function normalizeSlateToolCalls(toolCalls, options) {
  const normalized = [];
  for (const toolCall of toolCalls) {
    const parsed = normalizeSlateToolCall(toolCall, options);
    if (parsed) {
      normalized.push(parsed);
    }
  }

  return normalized;
}

function terminalToolMessage(toolCalls) {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (!toolCall) {
      continue;
    }
    if (toolCall.tool !== "end_turn" && toolCall.tool !== "message") {
      continue;
    }
    if (typeof toolCall.args?.message === "string" && toolCall.args.message) {
      return toolCall.args.message;
    }
  }

  return "";
}

function emitSlateToolCalls(res, toolCalls) {
  let emitted = 0;

  for (const toolCall of toolCalls) {
    emitSse(res, "tool_call", {
      id: toolCall.id || `call_${Date.now()}_${emitted}`,
      tool: toolCall.tool,
      args: toolCall.args,
    });
    emitted += 1;
  }

  return emitted;
}

function emitReadySlateToolCalls(res, toolCalls, emittedIndexes) {
  let emitted = 0;

  for (let index = 0; index < toolCalls.length; index += 1) {
    if (emittedIndexes.has(index)) {
      continue;
    }
    const normalized = normalizeSlateToolCall(toolCalls[index], {
      logParseWarning: false,
      requireArgsText: true,
    });
    if (!normalized) {
      continue;
    }
    emitSse(res, "tool_call", {
      id: normalized.id || `call_${Date.now()}_${index}`,
      tool: normalized.tool,
      args: normalized.args,
    });
    emittedIndexes.add(index);
    emitted += 1;
  }

  return emitted;
}

function slateAgentToolDefinitions(toolNames) {
  const names = new Set(toolNames || []);
  const tools = [];

  if (names.has("orchestrate")) {
    tools.push({
      type: "function",
      function: {
        name: "orchestrate",
        description:
          "Execute native Slate orchestration JavaScript for a focused subtask. Pass a `code` string that uses the provided `system` helpers rather than a natural-language task description.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string" },
          },
          required: ["code"],
        },
      },
    });
  }

  if (names.has("view_tool_call")) {
    tools.push({
      type: "function",
      function: {
        name: "view_tool_call",
        description: "Inspect the stored result of a previous tool call by tool_call_id.",
        parameters: {
          type: "object",
          properties: {
            tool_call_id: { type: "string" },
          },
          required: ["tool_call_id"],
        },
      },
    });
  }

  if (names.has("end_turn")) {
    tools.push({
      type: "function",
      function: {
        name: "end_turn",
        description: "Finish the turn and send the final user-facing response.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" },
          },
          required: ["message"],
        },
      },
    });
  }

  return tools;
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

function buildUpstreamPayload(route, runtime, slateTools, candidate) {
  let upstreamPayload = {
    model: route.model,
    stream: true,
    messages: candidate.messages,
  };

  const slotOverride = runtime.slotRequestOverrides[route.slot] || null;
  if (slotOverride) {
    upstreamPayload = deepMerge(upstreamPayload, slotOverride);
    upstreamPayload.model = route.model;
    upstreamPayload.stream = true;
    upstreamPayload.messages = candidate.messages;
  }

  if (slateTools.length > 0) {
    upstreamPayload.tools = slateTools;
    upstreamPayload.tool_choice = "auto";
    upstreamPayload.parallel_tool_calls = false;
  }

  return { upstreamPayload, slotOverride };
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
  const slateTools = slateAgentToolDefinitions(requestBody.toolNames);
  const candidates = transportCandidates(requestBody.messages, {
    maxPayloadChars: maxUpstreamPayloadChars,
  });
  const firstWithinLimit = candidates.findIndex((candidate) => candidate.withinLimit);
  const startIndex = firstWithinLimit === -1 ? candidates.length - 1 : firstWithinLimit;
  let upstreamResponse = null;
  let upstreamFailure = null;

  appendJson({
    time: now(),
    type: "local-worker-request",
    slot: route.slot,
    requestedModel: requestBody.model || null,
    localModel: route.model,
    sessionId: requestBody.sessionId || null,
    reasoningBudget: requestBody.reasoningBudget ?? null,
    toolNames: requestBody.toolNames || [],
    sourceMessageCount: (requestBody.messages || []).length,
    transportCandidates: candidates.map((candidate) => ({
      name: candidate.name,
      mode: candidate.mode,
      payloadChars: candidate.payloadChars,
      withinLimit: candidate.withinLimit,
      messageCount: candidate.messages.length,
      meta: candidate.meta,
    })),
  });

  for (let index = startIndex; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const built = buildUpstreamPayload(route, runtime, slateTools, candidate);

    appendJson({
      time: now(),
      type: "upstream-attempt",
      slot: route.slot,
      strategy: candidate.name,
      mode: candidate.mode,
      payloadChars: candidate.payloadChars,
      messageCount: candidate.messages.length,
      slotOverride: built.slotOverride,
    });

    upstreamResponse = await fetch(`${runtime.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(built.upstreamPayload),
    });

    if (upstreamResponse.ok && upstreamResponse.body) {
      upstreamFailure = null;
      break;
    }

    const errorBody = upstreamResponse ? await upstreamResponse.text() : "";
    upstreamFailure = {
      status: upstreamResponse?.status || 502,
      body: errorBody,
    };
    appendJson({
      time: now(),
      type: "upstream-attempt-failed",
      slot: route.slot,
      strategy: candidate.name,
      mode: candidate.mode,
      status: upstreamFailure.status,
      body: limitText(errorBody, 4000, "upstream error"),
    });

    if (index === candidates.length - 1 || !shouldRetryUpstreamRequest(upstreamFailure.status, errorBody)) {
      break;
    }
  }

  if (!upstreamResponse || !upstreamResponse.ok || !upstreamResponse.body) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      (upstreamFailure && upstreamFailure.body) ||
        `CLIProxyAPI upstream failed (${upstreamFailure?.status || upstreamResponse?.status || 502})`
    );
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
  let finishReason = "stop";
  const toolCalls = [];
  const liveToolCallState = {
    startedIndexes: new Set(),
    emittedArgLengths: new Map(),
  };
  const emittedToolCallIndexes = new Set();
  let emittedToolCallCount = 0;
  let sawVisibleText = false;

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
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

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

      const textChunk =
        typeof delta.content === "string"
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content
                .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
                .join("")
            : "";
      if (textChunk) {
        emitSse(res, "text", { chunk: textChunk });
        if (textChunk.trim()) {
          sawVisibleText = true;
        }
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        appendStreamToolCallDelta(toolCalls, delta.tool_calls);
        for (const event of collectLiveToolCallEvents(toolCalls, liveToolCallState)) {
          emitSse(res, event.event, event.payload);
        }
        emittedToolCallCount += emitReadySlateToolCalls(res, toolCalls, emittedToolCallIndexes);
      }

      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
    }
  }

  const normalizedToolCalls = normalizeSlateToolCalls(toolCalls, { logParseWarning: true });
  const terminalMessage = terminalToolMessage(normalizedToolCalls);

  // Slate's UI hides end_turn/message tool payloads, so surface the final
  // answer as assistant text only when the model did not stream visible text.
  if (!sawVisibleText && terminalMessage) {
    emitSse(res, "text", { chunk: terminalMessage });
  }

  const remainingToolCalls = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    if (emittedToolCallIndexes.has(index)) {
      continue;
    }
    const normalized = normalizeSlateToolCall(toolCalls[index], { logParseWarning: true });
    if (normalized) {
      remainingToolCalls.push(normalized);
    }
  }
  emittedToolCallCount += emitSlateToolCalls(res, remainingToolCalls);

  if (lastUsage) {
    emitSse(res, "usage", slateUsage(route.model, lastUsage));
  }

  emitSse(res, "finish_message", {
    finishReason:
      emittedToolCallCount > 0
        ? "tool_call"
        : finishReason === "tool_calls"
          ? "tool_call"
          : finishReason || "stop",
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

function main() {
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
}

if (require.main === module) {
  main();
}

module.exports = {
  appendStreamToolCallDelta,
  assistantTextFromSlateMessage,
  collectLiveToolCallEvents,
  compactSlateMessages,
  limitText,
  normalizeSlateToolCall,
  recentWindowStart,
  shouldRetryUpstreamRequest,
  terminalToolMessage,
  translateMessages,
  transportCandidates,
};
