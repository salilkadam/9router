// Legacy OpenAI text-completions shim.
//
// 9Router implements three LLM shapes -- chat completions, Anthropic messages
// and the Responses API -- but not the legacy /v1/completions body, which sends
// `prompt` instead of `messages` and returns `choices[].text` instead of
// `choices[].message.content`. gpu-ai does serve it, so anything still calling
// it could not be moved behind the router.
//
// This translates both directions and then hands off to the ordinary chat
// handler, so combos, tiering, account fallback, usage tracking and auth all
// behave exactly as they do for /v1/chat/completions. No routing logic is
// duplicated here.
//
// NOT supported, because chat completions cannot express them: `logprobs`,
// `best_of`, `suffix`, and multi-prompt arrays. The first three are ignored;
// multi-prompt is rejected explicitly rather than silently answering only the
// first, which would be a wrong answer rather than an error.
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS });
}

function bad(message, status = 400) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** Legacy `prompt` accepts string | string[] | token[] | token[][]. */
function resolvePrompt(prompt) {
  if (typeof prompt === "string") return { text: prompt };
  if (Array.isArray(prompt)) {
    if (prompt.length === 1 && typeof prompt[0] === "string") return { text: prompt[0] };
    if (prompt.every((p) => typeof p === "string")) {
      return { error: `Multi-prompt requests are not supported (received ${prompt.length} prompts). Send one request per prompt.` };
    }
    return { error: "Token-array prompts are not supported; send the prompt as a string." };
  }
  return { error: "`prompt` must be a string." };
}

export async function POST(request) {
  await ensureInitialized();

  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body");
  }

  if (!body?.model) return bad("Missing model");
  if (body.prompt === undefined || body.prompt === null) return bad("Missing prompt");

  const { text: promptText, error } = resolvePrompt(body.prompt);
  if (error) return bad(error);

  const echo = body.echo === true;
  const stream = body.stream === true;

  // Only forward params chat completions actually understands. `n` is passed
  // through; `logprobs`/`best_of`/`suffix` are dropped (see header).
  const chatBody = {
    model: body.model,
    messages: [{ role: "user", content: promptText }],
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.n !== undefined ? { n: body.n } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    ...(body.presence_penalty !== undefined ? { presence_penalty: body.presence_penalty } : {}),
    ...(body.frequency_penalty !== undefined ? { frequency_penalty: body.frequency_penalty } : {}),
    ...(body.seed !== undefined ? { seed: body.seed } : {}),
    ...(body.user !== undefined ? { user: body.user } : {}),
    stream,
  };

  // Rebuild the Request: handleChat calls request.json() itself, and a body can
  // only be read once. Headers are preserved so auth and logging are unchanged.
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("content-length");
  const chatRequest = new Request(request.url, { method: "POST", headers, body: JSON.stringify(chatBody) });

  const res = await handleChat(chatRequest);

  // Errors and anything non-JSON pass straight through, so the caller sees the
  // router's real status (401, 429, 503 from an exhausted combo, ...).
  if (!res.ok) return res;

  if (!stream) {
    let json;
    try {
      json = await res.clone().json();
    } catch {
      return res;
    }
    const out = {
      id: (json.id || "cmpl").replace(/^chatcmpl/, "cmpl"),
      object: "text_completion",
      created: json.created ?? Math.floor(Date.now() / 1000),
      model: json.model,
      choices: (json.choices || []).map((c, i) => ({
        text: (echo ? promptText : "") + (c.message?.content ?? ""),
        index: c.index ?? i,
        logprobs: null,
        finish_reason: c.finish_reason ?? null,
      })),
      ...(json.usage ? { usage: json.usage } : {}),
    };
    return new Response(JSON.stringify(out), {
      status: res.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  // Streaming: rewrite each SSE chunk's `delta.content` into `text`. Buffer by
  // line, because a chunk boundary can land mid-event.
  let echoPending = echo;
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) { controller.enqueue(encoder.encode(line + "\n")); continue; }
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n")); continue; }
        try {
          const j = JSON.parse(payload);
          const out = {
            id: (j.id || "cmpl").replace(/^chatcmpl/, "cmpl"),
            object: "text_completion",
            created: j.created ?? Math.floor(Date.now() / 1000),
            model: j.model,
            choices: (j.choices || []).map((c, i) => {
              let text = c.delta?.content ?? "";
              if (echoPending) { text = promptText + text; echoPending = false; }
              return { text, index: c.index ?? i, logprobs: null, finish_reason: c.finish_reason ?? null };
            }),
            ...(j.usage ? { usage: j.usage } : {}),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
        } catch {
          // Not JSON we recognise — forward untouched rather than dropping it.
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(buffer));
    },
  });

  return new Response(res.body.pipeThrough(transform), {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS,
    },
  });
}
