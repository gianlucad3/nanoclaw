/**
 * MLX MCP Server for NanoClaw
 * Exposes a local MLX model as a tool for the container agent.
 * Connects to an OpenAI-compatible API endpoint on the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MLX_HOST = process.env.MLX_HOST;
const MLX_MODEL = process.env.MLX_MODEL || 'mlx-community/Nemotron-Cascade-2-30B-A3B-4bit';

function log(msg: string): void {
  console.error(`[MLX] ${msg}`);
}

async function mlxFetch(path: string, options?: RequestInit): Promise<Response> {
  if (!MLX_HOST) {
    throw new Error('MLX_HOST is not set. Add MLX_HOST=http://192.168.64.1:11435 to .env');
  }
  return await fetch(`${MLX_HOST}${path}`, options);
}

const server = new McpServer({
  name: 'mlx',
  version: '1.0.0',
});

server.tool(
  'mlx_generate',
  `Send a prompt to the local MLX model (${MLX_MODEL}) and get a response. Good for tasks that benefit from a large-context capable model running locally. Supports system prompts and multi-turn messages.`,
  {
    prompt: z.string().describe('The user message to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
    max_tokens: z.number().int().optional().describe('Maximum tokens to generate (default: 2048)'),
    temperature: z.number().optional().describe('Sampling temperature 0–2 (default: 0.7)'),
  },
  async (args) => {
    const maxTokens = args.max_tokens ?? 2048;
    const temperature = args.temperature ?? 0.7;
    log(`>>> Generating (${args.prompt.length} chars, max_tokens=${maxTokens})...`);

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (args.system) {
        messages.push({ role: 'system', content: args.system });
      }
      messages.push({ role: 'user', content: args.prompt });

      const body = {
        model: MLX_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      };

      const res = await mlxFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `MLX error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage;
      let meta = '';
      if (usage) {
        meta = `\n\n[${MLX_MODEL} | ${usage.completion_tokens} tokens out / ${usage.total_tokens} total]`;
        log(`<<< Done: ${usage.completion_tokens} tokens out, ${usage.total_tokens} total`);
      } else {
        log(`<<< Done: ${text.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: text + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to MLX at ${MLX_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'mlx_chat',
  `Send a multi-turn conversation to the local MLX model (${MLX_MODEL}). Use this when you need to pass a full conversation history rather than a single prompt.`,
  {
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })).describe('Conversation history as an array of {role, content} objects'),
    max_tokens: z.number().int().optional().describe('Maximum tokens to generate (default: 2048)'),
    temperature: z.number().optional().describe('Sampling temperature 0–2 (default: 0.7)'),
  },
  async (args) => {
    const maxTokens = args.max_tokens ?? 2048;
    const temperature = args.temperature ?? 0.7;
    log(`>>> Chat (${args.messages.length} messages, max_tokens=${maxTokens})...`);

    try {
      const body = {
        model: MLX_MODEL,
        messages: args.messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      };

      const res = await mlxFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `MLX error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage;
      let meta = '';
      if (usage) {
        meta = `\n\n[${MLX_MODEL} | ${usage.completion_tokens} tokens out / ${usage.total_tokens} total]`;
        log(`<<< Done: ${usage.completion_tokens} tokens out`);
      } else {
        log(`<<< Done: ${text.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: text + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to MLX at ${MLX_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
