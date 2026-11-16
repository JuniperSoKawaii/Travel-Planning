// Talks to Claude from the browser with the user's own Anthropic API key and
// runs the tool loop that lets Claude edit the trip.

import Anthropic from './vendor/anthropic.js';
import { TOOLS, describeTrip, executeTool, validateInput } from './assistant-tools.js';

export const MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'travel-planning:anthropic-key';
const MAX_STEPS = 30;

// The key is kept only in this browser, separately from trip data, so it is
// never part of an exported backup.
export function loadKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function saveKey(key) {
  localStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Nothing stored.
  }
}

const SYSTEM_PROMPT = `You are the planning assistant inside Travel Planning, a personal web app where the user builds trip itineraries. The app shows the trip's stops on a map and on an hourly timeline, and it flags two kinds of conflicts: stops whose times overlap, and consecutive stops with too little time to travel between them (a rough estimate from straight-line distance).

You change the itinerary with your tools, and the user watches the map and timeline update as you do. Each user message begins with a <trip_state> block holding today's date and the current stops and conflicts; the user can also edit the trip by hand between messages, so trust that block over your memory of earlier turns.

How to work:
- When the request is clear enough to act on, make the changes rather than describing what you could do. If something essential is missing, such as which city or which dates, ask one short question first.
- Build days a person would enjoy: realistic visit lengths, time for meals, and travel time between stops that are far apart. Group nearby places together.
- Every result from adding or changing a stop lists the conflicts that stop is now part of. Resolve the ones you caused before you finish, unless the user asked for that overlap.
- Give each stop an address a map search can find, including the city. For a place that find_nearby returned, pass its coordinates instead.
- Use web search when the answer depends on current facts, such as opening hours, closures, ticket rules or events on the travel dates. Do not use it for things you already know well.
- Do not remove or rewrite stops the user did not ask you to touch.

Your replies appear in a narrow chat panel that shows plain text only, so write short plain sentences without Markdown, headings or tables. Say what you changed and mention anything the user should double-check; the itinerary itself is already on screen, so there is no need to list it back.`;

const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 };

function stateBlock(trip) {
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `<trip_state>\nToday: ${today} (${weekday})\n${JSON.stringify(describeTrip(trip), null, 1)}\n</trip_state>`;
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key. Check it in the Claude Console, then use "Remove API key" below and enter a new one.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not allowed to do that: ${err.message}`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limit reached on your Anthropic account. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check your internet connection and try again.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic returned an error${err.status ? ` (${err.status})` : ''}: ${err.message}`;
  }
  return `Something went wrong: ${err.message}`;
}

// One conversation with Claude about one trip.
//   getTrip()  -> the trip object to read and edit
//   services   -> { geocode, findSuggestions, newId }
export function createConversation({ apiKey, getTrip, services }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let messages = [];
  let activeStream = null;
  let stopped = false;
  // If a refused request can be re-run on another model by the API. Turned
  // off for the rest of the conversation if the API rejects the option.
  let useFallbacks = true;

  // Sends one user message and runs until Claude finishes its turn.
  // handlers: { onText(delta), onActivity(line), onChange() }
  // Resolves to { status: 'done' | 'stopped' | 'refused' | 'truncated' | 'limit' }.
  async function send(text, handlers) {
    const checkpoint = messages.length;
    stopped = false;
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: stateBlock(getTrip()) },
        { type: 'text', text },
      ],
    });

    try {
      let jsonRetries = 0;
      for (let step = 0; step < MAX_STEPS; step++) {
        if (stopped) return rollback(checkpoint, 'stopped');

        activeStream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 64000,
          system: SYSTEM_PROMPT,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          tools: [...TOOLS, WEB_SEARCH_TOOL],
          messages,
          ...(useFallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
        });
        activeStream.on('text', (delta) => handlers.onText(delta));
        activeStream.on('streamEvent', (event) => {
          if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
            handlers.onActivity('Searching the web…');
          }
        });

        let message;
        try {
          message = await activeStream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          if (err instanceof Anthropic.APIUserAbortError) return rollback(checkpoint, 'stopped');
          if (err instanceof Anthropic.BadRequestError && useFallbacks) {
            // The account or region may not accept the fallback option.
            useFallbacks = false;
            continue;
          }
          // With eager input streaming, a tool input that is not parseable
          // JSON rejects here; re-issue the turn a couple of times.
          if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
          continue;
        } finally {
          activeStream = null;
        }

        if (message.stop_reason === 'refusal') return rollback(checkpoint, 'refused');

        // Keep the full content: thinking and tool blocks must be replayed as is.
        messages.push({ role: 'assistant', content: message.content });

        if (message.stop_reason === 'pause_turn') continue; // server tool still running
        const toolUses = message.content.filter((block) => block.type === 'tool_use');
        if (message.stop_reason === 'max_tokens') {
          // A cut-off tool call may hold partial input, so never run it.
          if (toolUses.length) return rollback(checkpoint, 'truncated');
          return { status: 'truncated' };
        }
        if (!toolUses.length) return { status: 'done' };

        const results = [];
        for (const call of toolUses) {
          if (stopped) return rollback(checkpoint, 'stopped');
          const problem = validateInput(call.name, call.input);
          if (problem) {
            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), problem }),
            });
            continue;
          }
          const outcome = await executeTool(call.name, call.input, getTrip(), services);
          if (outcome.summary) handlers.onActivity(outcome.summary);
          if (outcome.changed) handlers.onChange();
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: outcome.isError,
            content: JSON.stringify(outcome.result),
          });
        }
        messages.push({ role: 'user', content: results });
      }
      return { status: 'limit' };
    } catch (err) {
      messages.length = checkpoint;
      throw err;
    }
  }

  // Drops an unfinished exchange so the history stays valid for the next
  // request. Changes already made to the trip are kept.
  function rollback(checkpoint, status) {
    messages.length = checkpoint;
    return { status };
  }

  return {
    send,
    stop() {
      stopped = true;
      activeStream?.abort();
    },
    reset() {
      messages = [];
    },
  };
}
