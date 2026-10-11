import { randomBytes, randomUUID } from 'crypto';

export interface Template {
  id: string;
  name: string;
  description: string;
}

export interface Signer {
  name: string;
  email: string;
  status: 'pending' | 'signed';
}

export type EnvelopeStatus = 'draft' | 'sent' | 'completed' | 'cancelled';

export interface Envelope {
  id: string;
  title: string;
  templateId: string;
  signers: Signer[];
  status: EnvelopeStatus;
  createdAt: string;
  sentAt?: string;
}

export class StoreError extends Error {}

export interface StoreOptions {
  now?: () => number;
  maxEnvelopes?: number;
  maxSends?: number; // blast-radius cap: sends allowed per server process
  codeTtlMs?: number;
}

const TEMPLATES: Template[] = [
  { id: 'tpl_nda', name: 'Mutual NDA', description: 'Standard two-way confidentiality agreement' },
  { id: 'tpl_freelance', name: 'Freelance services agreement', description: 'Scope, payment terms and IP assignment' },
];

/** Mock e-signature backend. All state is in memory. */
export class EsignStore {
  private envelopes = new Map<string, Envelope>();
  private codes = new Map<string, { code: string; expires: number }>();
  private sends = 0;
  private now: () => number;
  private maxEnvelopes: number;
  private maxSends: number;
  private codeTtlMs: number;

  constructor(opts: StoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxEnvelopes = opts.maxEnvelopes ?? 100;
    this.maxSends = opts.maxSends ?? 5;
    this.codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000;
  }

  listTemplates(): Template[] {
    return TEMPLATES;
  }

  createDraft(input: { templateId: string; title: string; signers: { name: string; email: string }[] }): Envelope {
    if (!TEMPLATES.some((t) => t.id === input.templateId)) throw new StoreError(`unknown template ${input.templateId}`);
    if (this.envelopes.size >= this.maxEnvelopes) throw new StoreError('envelope limit reached');
    const env: Envelope = {
      id: `env_${randomUUID().slice(0, 8)}`,
      title: input.title,
      templateId: input.templateId,
      signers: input.signers.map((s) => ({ ...s, status: 'pending' as const })),
      status: 'draft',
      createdAt: new Date(this.now()).toISOString(),
    };
    this.envelopes.set(env.id, env);
    return env;
  }

  get(id: string): Envelope {
    const env = this.envelopes.get(id);
    if (!env) throw new StoreError(`no such envelope ${id}`);
    return env;
  }

  /** Fallback approval: issue a single-use code the human must hand back. */
  issueCode(action: string, envelopeId: string): string {
    const code = randomBytes(3).toString('hex');
    this.codes.set(`${action}:${envelopeId}`, { code, expires: this.now() + this.codeTtlMs });
    return code;
  }

  checkCode(action: string, envelopeId: string, code: string): boolean {
    const key = `${action}:${envelopeId}`;
    const entry = this.codes.get(key);
    if (!entry || entry.expires < this.now() || entry.code !== code) return false;
    this.codes.delete(key); // single use
    return true;
  }

  send(id: string): Envelope {
    const env = this.get(id);
    if (env.status !== 'draft') throw new StoreError(`envelope is ${env.status}, only drafts can be sent`);
    if (this.sends >= this.maxSends) throw new StoreError('send limit reached for this session');
    this.sends++;
    env.status = 'sent';
    env.sentAt = new Date(this.now()).toISOString();
    return env;
  }

  cancel(id: string): Envelope {
    const env = this.get(id);
    if (env.status === 'completed' || env.status === 'cancelled') throw new StoreError(`envelope is already ${env.status}`);
    env.status = 'cancelled';
    return env;
  }

  /** Dev helper: pretend a signer signed. */
  simulateSigned(id: string, email: string): Envelope {
    const env = this.get(id);
    if (env.status !== 'sent') throw new StoreError('envelope has not been sent');
    const signer = env.signers.find((s) => s.email === email);
    if (!signer) throw new StoreError('no such signer');
    signer.status = 'signed';
    if (env.signers.every((s) => s.status === 'signed')) env.status = 'completed';
    return env;
  }
}
