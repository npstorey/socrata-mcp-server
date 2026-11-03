/**
 * The request-side log summaries (#81): a tool call, a protocol message, an error and zod issues,
 * each by its shape. Every case puts a marker where a reader's text could be and checks the line
 * names the shape and never the text. The end-to-end check, through the HTTP app, is
 * request-log-shape.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { z } from 'zod';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { summarizeArgs, summarizeCall, summarizeError, summarizeMessage, summarizeZodIssues, logName } from '../utils/log-summary.js';

const TEXT = 'M81TEXT';

describe('summarizeCall', () => {
  it('names the tool, portal and dataset, each text argument by length, limit and offset as numbers', () => {
    const line = summarizeCall('get_data', {
      type: 'query',
      domain: 'https://Portal.Example.test/',
      dataset_id: 'ABCD-1234',
      where: `name = '${TEXT}'`,
      limit: 5,
      offset: 10
    });
    expect(line).toBe(
      `tool=get_data portal=portal.example.test dataset=abcd-1234 args=type=query,domain:28,dataset_id:9,where:${`name = '${TEXT}'`.length},limit=5,offset=10`
    );
  });

  it('shows limit "all" and a numeric limit given as text as values, and anything else by length', () => {
    expect(summarizeArgs({ limit: 'all', offset: '20' })).toBe('limit=all,offset=20');
    expect(summarizeArgs({ limit: TEXT })).toBe(`limit:${TEXT.length}`);
  });

  it('shows a type outside the fixed set by its length', () => {
    expect(summarizeArgs({ type: TEXT })).toBe(`type:${TEXT.length}`);
    expect(summarizeArgs({ modality: 'web' })).toBe('modality=web');
  });

  it('shows a domain that is not a host by its length, and falls back to the default portal', () => {
    const line = summarizeCall('get_data', { domain: `${TEXT} street` }, 'default.example.test');
    expect(line).toContain('portal=default.example.test');
    expect(line).not.toContain(TEXT);
  });

  it('shows "none" when the call names no portal and none is configured', () => {
    expect(summarizeCall('search', { query: TEXT })).toBe(`tool=search portal=none args=query:${TEXT.length}`);
  });

  it('reads the portal and dataset from a fetch id, and the row id by length only', () => {
    const line = summarizeCall('fetch', { id: `record:portal.example.test:abcd-1234:${TEXT}` });
    expect(line).toBe(`tool=fetch portal=portal.example.test dataset=abcd-1234 args=id:${`record:portal.example.test:abcd-1234:${TEXT}`.length}`);
  });

  it('shows a tool or argument name that is not name-shaped by its length', () => {
    expect(summarizeCall(`${TEXT} please`, { [`${TEXT} key`]: 'x' })).not.toContain(TEXT);
    expect(logName(`${TEXT} name`)).toBe(`{name}:${`${TEXT} name`.length}`);
  });

  it('handles absent and odd-shaped arguments', () => {
    expect(summarizeArgs(undefined)).toBe('none');
    expect(summarizeArgs({})).toBe('none');
    expect(summarizeArgs([TEXT])).toBe('{args}:array');
    expect(summarizeArgs({ nested: { where: TEXT }, list: [TEXT], flag: true, gone: null })).toBe('nested:object,list:array,flag=true,gone:none');
  });
});

describe('summarizeMessage', () => {
  it('names the method, id and size of a request given as text', () => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: { where: TEXT } } });
    expect(summarizeMessage(text)).toBe(`method=tools/call id=7 bytes=${Buffer.byteLength(text)}`);
  });

  it('names a result, and an error by its code', () => {
    expect(summarizeMessage({ jsonrpc: '2.0', id: 'abc', result: { content: [{ text: TEXT }] } })).toMatch(/^id=abc result bytes=\d+$/);
    expect(summarizeMessage({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: TEXT } })).toMatch(/^id=3 error=-32602 bytes=\d+$/);
  });

  it('shows text that does not parse by its size alone, and a batch by its count', () => {
    expect(summarizeMessage(`{"where":"${TEXT}"`)).toBe(`unparsed bytes=${`{"where":"${TEXT}"`.length}`);
    expect(summarizeMessage([{ method: 'ping', id: 1 }, { method: 'ping', id: 2 }])).toMatch(/^batch=2 method=ping id=1; method=ping id=2 bytes=\d+$/);
  });

  it('shows a string id that is not name-shaped by its length', () => {
    expect(summarizeMessage({ id: `${TEXT} id`, method: 'ping' })).not.toContain(TEXT);
  });
});

function axiosRefusal(status: number, data: unknown): AxiosError {
  const config = { headers: {}, url: 'https://portal.example.test/x', data: JSON.stringify({ query: TEXT }) } as unknown as InternalAxiosRequestConfig;
  const response = { status, statusText: 'Bad Request', data, headers: {}, config } as AxiosResponse;
  return new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
}

describe('summarizeError', () => {
  it('logs an McpError by class, code and message length', () => {
    const error = new McpError(ErrorCode.InvalidParams, `Unsupported fetch identifier format: ${TEXT}`);
    const line = summarizeError(error);
    expect(line).toMatch(new RegExp(`^class=McpError mcp_code=-32602 message_chars=${error.message.length}( at=.+)?$`));
    expect(line).not.toContain(TEXT);
  });

  it("logs a portal refusal wrapped with its cause: the portal's status and axios's code, never the quoted query", () => {
    const cause = axiosRefusal(400, { message: `Could not parse SoQL query "${TEXT}"`, data: { query: TEXT } });
    const error = new Error(`API request failed: 400 - Bad Request\nData: ${JSON.stringify(cause.response?.data)}`, { cause });
    const line = summarizeError(error);
    expect(line).toMatch(/^class=Error status=400 code=ERR_BAD_REQUEST message_chars=\d+ cause=AxiosError/);
    expect(line).not.toContain(TEXT);
  });

  it("logs Node's own error code", () => {
    const error = Object.assign(new Error(`connect ECONNRESET ${TEXT}`), { code: 'ECONNRESET' });
    expect(summarizeError(error)).toMatch(/^class=Error code=ECONNRESET message_chars=\d+/);
  });

  it('never takes a line of the message for a stack frame', () => {
    const error = new Error(`first line\n    at ${TEXT} (forged.js:1:1)`);
    const line = summarizeError(error);
    expect(line).not.toContain(TEXT);
    expect(line).toMatch(/ at=.+request-log-summary\.test\.ts/);
  });

  it('logs a non-Error by its type', () => {
    expect(summarizeError(TEXT)).toBe(`class=string message_chars=${TEXT.length}`);
    expect(summarizeError({ message: TEXT })).toBe('class=object');
  });

  it("never logs a zod error's message, which quotes the value given", () => {
    const result = z.object({ type: z.enum(['catalog', 'query']) }).safeParse({ type: TEXT });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain(TEXT);
    expect(summarizeError(result.error)).not.toContain(TEXT);
    expect(summarizeZodIssues(result.error.issues)).toBe(`type:${result.error.issues[0].code}`);
  });
});
