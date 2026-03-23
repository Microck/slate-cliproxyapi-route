const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendStreamToolCallDelta,
  collectLiveToolCallEvents,
  compactSlateMessages,
  normalizeSlateToolCall,
  recentWindowStart,
  shouldRetryUpstreamRequest,
  transportCandidates,
} = require("../files/slate-randomlabs-proxy.js");

function toolResponse(toolCallId, size) {
  return {
    role: "tool_response",
    content: [
      {
        id: `${toolCallId}_result`,
        type: "tool_response",
        tool: "orchestrate",
        tool_call_id: toolCallId,
        result: {
          ok: true,
          blob: "x".repeat(size),
        },
      },
    ],
  };
}

function buildLargeSlateHistory() {
  const messages = [];

  for (let index = 0; index < 8; index += 1) {
    const toolCallId = `call_old_${index}`;
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Old request ${index}` }],
    });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: toolCallId,
          tool: "orchestrate",
          args: { code: `return ${index};` },
        },
      ],
    });
    messages.push(toolResponse(toolCallId, 24000));
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `Old answer ${index}` }],
    });
  }

  messages.push({
    role: "user",
    content: [{ type: "text", text: "Latest request" }],
  });
  messages.push({
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id: "call_recent",
        tool: "orchestrate",
        args: { code: "return 'recent';" },
      },
    ],
  });
  messages.push(toolResponse("call_recent", 256));

  return messages;
}

test("recentWindowStart backs up to include the assistant tool call before a tool response", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "call_1", tool: "orchestrate", args: { code: "return 1;" } }],
    },
    toolResponse("call_1", 32),
  ];

  assert.equal(recentWindowStart(messages, 1), 1);
});

test("compactSlateMessages drops older tool traffic but preserves recent tool state", () => {
  const messages = buildLargeSlateHistory();
  const compacted = compactSlateMessages(messages, {
    keepRecentMessages: 8,
    oldTextMaxChars: 120,
    recentTextMaxChars: 1000,
    recentToolResultMaxChars: 1000,
  });

  const toolMessages = compacted.messages.filter((message) => message.role === "tool");
  assert.ok(compacted.meta.omittedToolTraffic);
  assert.ok(compacted.messages.some((message) => message.role === "system"));
  assert.ok(toolMessages.some((message) => message.tool_call_id === "call_recent"));
  assert.ok(!toolMessages.some((message) => message.tool_call_id === "call_old_0"));
});

test("transportCandidates finds an aggressive strategy that fits oversized history", () => {
  const candidates = transportCandidates(buildLargeSlateHistory(), {
    maxPayloadChars: 15000,
  });
  const chosen = candidates.find((candidate) => candidate.withinLimit);

  assert.ok(chosen);
  assert.notEqual(chosen.name, "full");
  assert.ok(chosen.payloadChars <= 15000);
});

test("shouldRetryUpstreamRequest retries empty-stream style failures", () => {
  assert.equal(
    shouldRetryUpstreamRequest(
      500,
      '{"error":{"message":"empty_stream: upstream stream closed before first payload"}}'
    ),
    true
  );
  assert.equal(shouldRetryUpstreamRequest(401, "unauthorized"), false);
});

test("collectLiveToolCallEvents emits streaming start and argument deltas", () => {
  const toolCalls = [];
  const state = {
    startedIndexes: new Set(),
    emittedArgLengths: new Map(),
  };

  appendStreamToolCallDelta(toolCalls, [
    {
      index: 0,
      id: "call_1",
      function: {
        name: "orchestrate",
        arguments: '{"code":"con',
      },
    },
  ]);

  assert.deepEqual(collectLiveToolCallEvents(toolCalls, state), [
    {
      event: "tool_call_streaming_start",
      payload: { toolCallId: "call_1", toolName: "orchestrate" },
    },
    {
      event: "tool_call_delta",
      payload: { toolCallId: "call_1", argsTextDelta: '{"code":"con' },
    },
  ]);

  appendStreamToolCallDelta(toolCalls, [
    {
      index: 0,
      function: {
        arguments: 'sole.log(1)"}',
      },
    },
  ]);

  assert.deepEqual(collectLiveToolCallEvents(toolCalls, state), [
    {
      event: "tool_call_delta",
      payload: { toolCallId: "call_1", argsTextDelta: 'sole.log(1)"}' },
    },
  ]);
});

test("collectLiveToolCallEvents buffers argument text until a tool call id is known", () => {
  const toolCalls = [];
  const state = {
    startedIndexes: new Set(),
    emittedArgLengths: new Map(),
  };

  appendStreamToolCallDelta(toolCalls, [
    {
      index: 0,
      function: {
        arguments: '{"code":"pending"}',
      },
    },
  ]);

  assert.deepEqual(collectLiveToolCallEvents(toolCalls, state), []);

  appendStreamToolCallDelta(toolCalls, [
    {
      index: 0,
      id: "call_2",
      function: {
        name: "orchestrate",
      },
    },
  ]);

  assert.deepEqual(collectLiveToolCallEvents(toolCalls, state), [
    {
      event: "tool_call_streaming_start",
      payload: { toolCallId: "call_2", toolName: "orchestrate" },
    },
    {
      event: "tool_call_delta",
      payload: { toolCallId: "call_2", argsTextDelta: '{"code":"pending"}' },
    },
  ]);
});

test("normalizeSlateToolCall can require streamed argument text before emitting a final tool call", () => {
  assert.equal(
    normalizeSlateToolCall(
      {
        id: "call_3",
        toolName: "orchestrate",
        argsText: "",
      },
      { requireArgsText: true }
    ),
    null
  );

  assert.deepEqual(
    normalizeSlateToolCall(
      {
        id: "call_3",
        toolName: "orchestrate",
        argsText: '{"code":"return 1;"}',
      },
      { requireArgsText: true }
    ),
    {
      id: "call_3",
      tool: "orchestrate",
      args: { code: "return 1;" },
    }
  );
});
