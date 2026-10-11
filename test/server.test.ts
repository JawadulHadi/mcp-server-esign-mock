import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { ServerOptions, createServer } from '../src/server';
import { EsignStore } from '../src/store';

type Reply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

async function connect(opts: ServerOptions = {}, elicit?: () => Reply | Promise<Reply>) {
  const { server, store } = createServer(opts);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: elicit ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push((req.params as { message: string }).message);
      return elicit();
    });
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const body: string = r.content?.[0]?.text ?? '';
    let data: any = body;
    try { data = JSON.parse(body); } catch { /* plain text error */ }
    return { isError: !!r.isError, data, body };
  };
  return { client, store, prompts, call };
}

const signers = [{ name: 'Ada', email: 'ada@example.com' }, { name: 'Bo', email: 'bo@example.com' }];
const create = (call: Awaited<ReturnType<typeof connect>>['call']) =>
  call('create_envelope', { templateId: 'tpl_nda', title: 'Project NDA', signers });

describe('tool catalogue', () => {
  it('declares read-only and destructive hints, and hides dev tools by default', async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.list_templates.annotations?.readOnlyHint).toBe(true);
    expect(by.send_envelope.annotations?.destructiveHint).toBe(true);
    expect(by.simulate_signing).toBeUndefined();
    const dev = await connect({ devTools: true });
    expect((await dev.client.listTools()).tools.some((t) => t.name === 'simulate_signing')).toBe(true);
  });
});

describe('input validation and reads', () => {
  it('lists templates and creates a draft', async () => {
    const { call } = await connect();
    expect((await call('list_templates')).data).toHaveLength(2);
    const created = await create(call);
    expect(created.data).toMatchObject({ status: 'draft', title: 'Project NDA' });
    expect((await call('get_status', { envelopeId: created.data.id })).data.status).toBe('draft');
  });

  it('rejects bad emails, too many signers, unknown templates and unknown envelopes', async () => {
    const { call } = await connect();
    expect((await call('create_envelope', { templateId: 'tpl_nda', title: 'x', signers: [{ name: 'A', email: 'nope' }] })).isError).toBe(true);
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, email: `s${i}@example.com` }));
    expect((await call('create_envelope', { templateId: 'tpl_nda', title: 'x', signers: many })).isError).toBe(true);
    expect((await call('create_envelope', { templateId: 'zzz', title: 'x', signers })).isError).toBe(true);
    expect((await call('get_status', { envelopeId: 'env_missing' })).isError).toBe(true);
  });
});

describe('human approval via elicitation', () => {
  it('sends only after the human accepts, and shows them the recipients', async () => {
    const { call, prompts } = await connect({}, () => ({ action: 'accept', content: { confirm: true } }));
    const id = (await create(call)).data.id;
    const sent = await call('send_envelope', { envelopeId: id });
    expect(sent.data.status).toBe('sent');
    expect(prompts[0]).toContain('ada@example.com');
    expect(prompts[0]).toContain('bo@example.com');
  });

  it.each([
    ['declined', { action: 'decline' as const }],
    ['cancelled', { action: 'cancel' as const }],
    ['accepted without confirm', { action: 'accept' as const, content: { confirm: false } }],
  ])('does not send when the human %s', async (_label, reply) => {
    const { call } = await connect({}, () => reply);
    const id = (await create(call)).data.id;
    const res = await call('send_envelope', { envelopeId: id });
    expect(res.isError).toBe(true);
    expect((await call('get_status', { envelopeId: id })).data.status).toBe('draft');
  });

  it('fails closed if the approval prompt itself errors', async () => {
    const { call } = await connect({}, () => { throw new Error('ui crashed'); });
    const id = (await create(call)).data.id;
    expect((await call('send_envelope', { envelopeId: id })).isError).toBe(true);
    expect((await call('get_status', { envelopeId: id })).data.status).toBe('draft');
  });

  it('requires approval to cancel and then blocks sending a cancelled envelope', async () => {
    const { call } = await connect({}, () => ({ action: 'accept', content: { confirm: true } }));
    const id = (await create(call)).data.id;
    await call('send_envelope', { envelopeId: id });
    expect((await call('cancel_envelope', { envelopeId: id })).data.status).toBe('cancelled');
    expect((await call('send_envelope', { envelopeId: id })).isError).toBe(true);
  });

  it('enforces the per-session send cap even when the human approves', async () => {
    const { call } = await connect({ store: new EsignStore({ maxSends: 1 }) }, () => ({ action: 'accept', content: { confirm: true } }));
    const a = (await create(call)).data.id;
    const b = (await create(call)).data.id;
    expect((await call('send_envelope', { envelopeId: a })).isError).toBe(false);
    const blocked = await call('send_envelope', { envelopeId: b });
    expect(blocked.isError).toBe(true);
    expect(blocked.body).toContain('send limit');
  });
});

describe('fallback when the client cannot ask the human', () => {
  it('code mode: first call only returns a code, second call with it sends', async () => {
    const { call } = await connect();
    const id = (await create(call)).data.id;
    const first = await call('send_envelope', { envelopeId: id });
    expect(first.data.sent).toBe(false);
    expect((await call('get_status', { envelopeId: id })).data.status).toBe('draft');
    const code = /confirmationCode "([0-9a-f]+)"/.exec(first.data.instruction)![1];
    expect((await call('send_envelope', { envelopeId: id, confirmationCode: 'bad' })).isError).toBe(true);
    expect((await call('send_envelope', { envelopeId: id, confirmationCode: code })).data.status).toBe('sent');
  });

  it('deny mode: never sends, even with a code', async () => {
    const { call } = await connect({ fallback: 'deny' });
    const id = (await create(call)).data.id;
    expect((await call('send_envelope', { envelopeId: id })).isError).toBe(true);
    expect((await call('send_envelope', { envelopeId: id, confirmationCode: 'abc123' })).isError).toBe(true);
    expect((await call('get_status', { envelopeId: id })).data.status).toBe('draft');
  });
});

describe('dev tools', () => {
  it('simulate_signing completes the envelope', async () => {
    const { call } = await connect({ devTools: true }, () => ({ action: 'accept', content: { confirm: true } }));
    const id = (await create(call)).data.id;
    await call('send_envelope', { envelopeId: id });
    await call('simulate_signing', { envelopeId: id, email: 'ada@example.com' });
    expect((await call('simulate_signing', { envelopeId: id, email: 'bo@example.com' })).data.status).toBe('completed');
  });
});
