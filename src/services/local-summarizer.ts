import { OLLAMA_HOST } from '../config.js';

export async function summarizeMemoryFile(content: string): Promise<string> {
  const model = process.env.OLLAMA_MODEL || 'mistral';
  // Use OLLAMA_HOST if available, but respect http(s) if provided.
  let baseUrl = 'http://localhost:11434';
  if (OLLAMA_HOST) {
    baseUrl = OLLAMA_HOST.startsWith('http')
      ? OLLAMA_HOST
      : `http://${OLLAMA_HOST}:11434`;
  }

  const endpoint = `${baseUrl}/api/generate`;

  const prompt = `You are a memory compaction engine. Take this agent memory and rewrite it into a dense, bulleted Markdown format. Keep it under 1,500 characters. Preserve all user preferences, technical configurations, and historical milestones. Remove conversational filler and redundant status updates.\n\nCURRENT MEMORY:\n${content}`;

  const requestBody = {
    model,
    prompt,
    stream: false,
    options: {
      num_ctx: 4096,
      temperature: 0.3,
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Ollama generation failed with status ${response.status}: ${errText}`,
    );
  }

  const data = (await response.json()) as any;
  if (!data || !data.response) {
    throw new Error('Invalid response from Ollama API');
  }

  return data.response;
}
