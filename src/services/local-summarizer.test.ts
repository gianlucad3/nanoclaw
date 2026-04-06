import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  OLLAMA_HOST: 'http://test-ollama:11434',
}));

import { summarizeMemoryFile } from './local-summarizer.js';

describe('local-summarizer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct request to Ollama and returns response', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ response: '- compacted bullet points' }),
      text: async () => '',
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockResponse as Response);

    const result = await summarizeMemoryFile(
      '# Memory\nSome long content here',
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://test-ollama:11434/api/generate');
    expect(options?.method).toBe('POST');

    const body = JSON.parse(options?.body as string);
    expect(body.model).toBe('mistral');
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain('CURRENT MEMORY:');
    expect(body.prompt).toContain('Some long content here');
    expect(body.options.temperature).toBe(0.3);
    expect(body.options.num_ctx).toBe(4096);

    expect(result).toBe('- compacted bullet points');
  });

  it('throws on non-OK HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    } as Response);

    await expect(summarizeMemoryFile('content')).rejects.toThrow(
      /Ollama generation failed with status 503/,
    );
  });

  it('throws on missing response field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ model: 'mistral' }),
    } as Response);

    await expect(summarizeMemoryFile('content')).rejects.toThrow(
      /Invalid response from Ollama/,
    );
  });

  it('throws on empty response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: '' }),
    } as Response);

    await expect(summarizeMemoryFile('content')).rejects.toThrow(
      /Invalid response from Ollama/,
    );
  });

  it('uses configured OLLAMA_HOST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'compacted' }),
    } as Response);

    await summarizeMemoryFile('content');

    const [url] = fetchSpy.mock.calls[0];
    // OLLAMA_HOST is mocked to 'http://test-ollama:11434'
    expect(url).toBe('http://test-ollama:11434/api/generate');
  });
});
