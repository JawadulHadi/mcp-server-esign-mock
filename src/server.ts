#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { EsignStore, StoreError } from './store';

export interface ServerOptions {
  store?: EsignStore;
  /** What to do when the client cannot ask the human directly (no elicitation support). */
  fallback?: 'code' | 'deny';
  devTools?: boolean;
}

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

type Approval =
  | { status: 'approved' }
  | { status: 'declined' }
  | { status: 'needs_code'; code: string }
  | { status: 'invalid_code' }
  | { status: 'unavailable' };

export function createServer(opts: ServerOptions = {}) {
  const store = opts.store ?? new EsignStore();
  const fallback = opts.fallback ?? 'code';
  const server = new McpServer({ name: 'esign-mock', version: '0.1.0' });

  /**
   * The human gate. With elicitation the client shows the question to the person directly, so the
   * model cannot answer for them. The code fallback is only a speed bump: a model can still call
   * the tool twice. Use 'deny' if your client lacks elicitation and the action must be human-only.
   */
  async function requireApproval(action: string, envelopeId: string, summary: string, code?: string): Promise<Approval> {
    if (server.server.getClientCapabilities()?.elicitation) {
      try {
        const res = await server.server.elicitInput({
          message: summary,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: 'Approve this action?' } },
            required: ['confirm'],
          },
        });
        return res.action === 'accept' && res.content?.confirm === true ? { status: 'approved' } : { status: 'declined' };
      } catch {
        return { status: 'declined' }; // fail closed
      }
    }
    if (fallback === 'deny') return { status: 'unavailable' };
    if (!code) return { status: 'needs_code', code: store.issueCode(action, envelopeId) };
    return store.checkCode(action, envelopeId, code) ? { status: 'approved' } : { status: 'invalid_code' };
  }

  const handle = async (fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StoreError) return fail(e.message);
      throw e;
    }
  };

  const approvalReply = (a: Approval, action: string, summary: string) => {
    switch (a.status) {
      case 'needs_code':
        return text({
          sent: false, awaiting: 'human approval',
          instruction: `Show this to the user: "${summary}". Only if they explicitly approve, call ${action} again with confirmationCode "${a.code}".`,
        });
      case 'declined': return fail('The human declined. Nothing was changed.');
      case 'invalid_code': return fail('Invalid or expired confirmation code. Nothing was changed.');
      case 'unavailable': return fail('This client cannot ask the human for approval, so the action is blocked.');
      default: return null;
    }
  };

  server.registerTool('list_templates', {
    title: 'List templates', description: 'List available document templates.',
    annotations: { readOnlyHint: true },
  }, async () => text(store.listTemplates()));

  server.registerTool('create_envelope', {
    title: 'Create draft envelope',
    description: 'Create a DRAFT envelope from a template. Nothing is sent to signers until send_envelope is approved by a human.',
    inputSchema: {
      templateId: z.string().min(1),
      title: z.string().min(1).max(120),
      signers: z.array(z.object({ name: z.string().min(1).max(80), email: z.string().email().max(120) })).min(1).max(5),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => handle(() => text(store.createDraft(args))));

  server.registerTool('get_status', {
    title: 'Get envelope status', description: 'Get status and per-signer progress of an envelope.',
    inputSchema: { envelopeId: z.string() }, annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ envelopeId }) => handle(() => text(store.get(envelopeId))));

  server.registerTool('send_envelope', {
    title: 'Send envelope for signature',
    description: 'Send a draft to its signers. Requires explicit human approval. Never invent or guess a confirmation code.',
    inputSchema: { envelopeId: z.string(), confirmationCode: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ envelopeId, confirmationCode }) => handle(async () => {
    const env = store.get(envelopeId);
    if (env.status !== 'draft') return fail(`envelope is ${env.status}, only drafts can be sent`);
    const summary = `Send "${env.title}" to ${env.signers.map((s) => s.email).join(', ')}?`;
    const approval = await requireApproval('send_envelope', envelopeId, summary, confirmationCode);
    return approvalReply(approval, 'send_envelope', summary) ?? text(store.send(envelopeId));
  }));

  server.registerTool('cancel_envelope', {
    title: 'Cancel envelope', description: 'Cancel a draft or sent envelope. Requires explicit human approval.',
    inputSchema: { envelopeId: z.string(), confirmationCode: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ envelopeId, confirmationCode }) => handle(async () => {
    const env = store.get(envelopeId);
    const summary = `Cancel "${env.title}" (${env.status})? Signers will no longer be able to sign.`;
    const approval = await requireApproval('cancel_envelope', envelopeId, summary, confirmationCode);
    return approvalReply(approval, 'cancel_envelope', summary) ?? text(store.cancel(envelopeId));
  }));

  if (opts.devTools) {
    server.registerTool('simulate_signing', {
      title: 'Dev: simulate a signature', description: 'Development only. Marks a signer as signed.',
      inputSchema: { envelopeId: z.string(), email: z.string().email() },
    }, async ({ envelopeId, email }) => handle(() => text(store.simulateSigned(envelopeId, email))));
  }

  return { server, store };
}

async function main() {
  const { server } = createServer({
    fallback: process.env.ESIGN_FALLBACK === 'deny' ? 'deny' : 'code',
    devTools: process.env.ESIGN_DEV_TOOLS === '1',
  });
  await server.connect(new StdioServerTransport());
  console.error('esign-mcp running on stdio'); // stdout is reserved for the protocol
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
