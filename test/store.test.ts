import { describe, expect, it } from 'vitest';
import { EsignStore, StoreError } from '../src/store';

const signers = [{ name: 'Ada', email: 'ada@example.com' }];
const draft = (s: EsignStore) => s.createDraft({ templateId: 'tpl_nda', title: 'NDA', signers });

describe('EsignStore', () => {
  it('creates drafts and rejects unknown templates', () => {
    const s = new EsignStore();
    expect(draft(s)).toMatchObject({ status: 'draft', signers: [{ status: 'pending' }] });
    expect(() => s.createDraft({ templateId: 'nope', title: 'x', signers })).toThrow(StoreError);
  });

  it('only sends drafts, and caps sends per session', () => {
    const s = new EsignStore({ maxSends: 1 });
    const a = draft(s);
    s.send(a.id);
    expect(() => s.send(a.id)).toThrow(/only drafts/);
    expect(() => s.send(draft(s).id)).toThrow(/send limit/);
  });

  it('caps the number of envelopes', () => {
    const s = new EsignStore({ maxEnvelopes: 1 });
    draft(s);
    expect(() => draft(s)).toThrow(/limit/);
  });

  it('issues single-use codes that expire', () => {
    let t = 0;
    const s = new EsignStore({ now: () => t, codeTtlMs: 1000 });
    const code = s.issueCode('send_envelope', 'e1');
    expect(s.checkCode('send_envelope', 'e1', 'wrong')).toBe(false);
    expect(s.checkCode('send_envelope', 'other', code)).toBe(false);
    expect(s.checkCode('send_envelope', 'e1', code)).toBe(true);
    expect(s.checkCode('send_envelope', 'e1', code)).toBe(false); // used
    const second = s.issueCode('send_envelope', 'e1');
    t = 1001;
    expect(s.checkCode('send_envelope', 'e1', second)).toBe(false); // expired
  });

  it('completes an envelope when every signer has signed', () => {
    const s = new EsignStore();
    const env = s.createDraft({ templateId: 'tpl_nda', title: 'NDA', signers: [...signers, { name: 'Bo', email: 'bo@example.com' }] });
    s.send(env.id);
    expect(s.simulateSigned(env.id, 'ada@example.com').status).toBe('sent');
    expect(s.simulateSigned(env.id, 'bo@example.com').status).toBe('completed');
    expect(() => s.cancel(env.id)).toThrow(/already completed/);
  });
});
