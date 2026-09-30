import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const sidebar = read('src/components/layout/sidebar.tsx');
const broadcasts = read('src/app/(dashboard)/broadcasts/page.tsx');
const broadcastNew = read('src/app/(dashboard)/broadcasts/new/page.tsx');
const broadcastDetail = read('src/app/(dashboard)/broadcasts/[id]/page.tsx');
const flows = read('src/app/(dashboard)/flows/page.tsx');
const flowEditor = read('src/app/(dashboard)/flows/[id]/page.tsx');
const flowRuns = read('src/app/(dashboard)/flows/[id]/runs/page.tsx');
const composer = read('src/components/inbox/message-composer.tsx');
const thread = read('src/components/inbox/message-thread.tsx');
const templates = read('src/components/settings/template-manager.tsx');
const builder = read('src/components/automations/automation-builder.tsx');
const shell = read('src/app/(dashboard)/dashboard-shell.tsx');
const provider = read('src/hooks/use-whatsapp-capability.tsx');
const endpoint = read('src/app/api/whatsapp/capability/route.ts');

describe('WhatsApp capability UI contract', () => {
  it('locks Broadcasts and Flows in the sidebar while leaving them visible', () => {
    expect(sidebar).toContain("item.href === '/broadcasts'");
    expect(sidebar).toContain("item.href === '/flows'");
    expect(sidebar).toContain('LockKeyhole');
  });

  it('sends locked sidebar clicks to the canonical WhatsApp settings route', () => {
    expect(sidebar).toContain('href="/settings?tab=whatsapp"');
  });

  it('provides a keyboard-capable tooltip trigger for locked navigation', () => {
    expect(sidebar).toContain('<TooltipProvider delay={150}>');
    expect(sidebar).toContain('<TooltipTrigger');
    expect(sidebar).toContain('focus-visible:outline-2');
    expect(sidebar).toContain('WhatsApp is not configured.');
  });

  it('protects the direct Broadcasts page and skips its data load while locked', () => {
    expect(broadcasts).toContain(
      '<WhatsAppCapabilityGate feature="Broadcasts">'
    );
    expect(broadcasts).toContain('if (!whatsapp.available) return;');
    expect(broadcastNew).toContain(
      '<WhatsAppCapabilityGate feature="Broadcasts">'
    );
    expect(broadcastDetail).toContain(
      '<WhatsAppCapabilityGate feature="Broadcasts">'
    );
  });

  it('protects the direct Flows page and skips its data load while locked', () => {
    expect(flows).toContain('<WhatsAppCapabilityGate feature="Flows">');
    expect(flows).toContain('if (!whatsapp.available) return;');
    expect(flowEditor).toContain('<WhatsAppCapabilityGate feature="Flows">');
    expect(flowRuns).toContain('<WhatsAppCapabilityGate feature="Flows">');
  });

  it('keeps the Inbox thread readable and gates only the composer', () => {
    expect(thread).toContain('<MessageComposer');
    expect(thread).not.toContain('WhatsAppCapabilityGate');
    expect(composer).toContain(
      'const composerReadOnly = readOnly || whatsappDisabled'
    );
  });

  it('prevents text and staged-media sends while WhatsApp is unavailable', () => {
    expect(composer).toContain('sessionExpired || whatsappDisabled');
    expect(composer).toContain(
      'if (!draft || busy || whatsappDisabled) return;'
    );
  });

  it('keeps Automations globally accessible', () => {
    expect(sidebar).toContain("href: '/automations'");
    expect(sidebar).not.toMatch(/requiresWhatsApp[\s\S]{0,120}automations/);
  });

  it('keeps CRM-only automation actions available', () => {
    expect(builder).toContain("'add_tag'");
    expect(builder).toContain("'create_deal'");
    expect(builder).toContain("'send_webhook'");
    expect(builder).toContain("'wait'");
  });

  it('uses the existing automation action-level WhatsApp availability gate', () => {
    expect(builder).toContain('automationActionAvailability(tp');
    expect(builder).toContain(
      'usableConnectionCount: whatsappConnections.length'
    );
    expect(builder).toContain("availability.reason === 'checking'");
  });

  it('leaves generic CRM and AI Agent navigation outside the gate', () => {
    for (const href of [
      '/contacts',
      '/reservations',
      '/pipelines',
      '/agents',
    ]) {
      expect(sidebar).toContain(`href: '${href}'`);
    }
    expect(sidebar).toContain(
      "item.href === '/broadcasts' || item.href === '/flows'"
    );
  });

  it('gates Meta-backed template mutations while preserving the template view', () => {
    expect(templates).toContain('disabled={syncing || !whatsapp.available}');
    expect(templates).toContain('if (!whatsapp.available) return;');
    expect(templates).toContain('templates.map((template)');
  });

  it('loads one shared capability provider for the dashboard', () => {
    expect(shell).toContain('<WhatsAppCapabilityProvider>');
    expect(sidebar).toContain('useWhatsAppCapability()');
    expect(composer).toContain('useWhatsAppCapability()');
  });

  it('treats data from a different active workspace as loading, never available', () => {
    expect(provider).toContain('stored.accountId === accountId');
    expect(provider).toContain("status: current ? stored.status : 'loading'");
    expect(provider).toContain('available: current ? stored.available : false');
  });

  it('keeps loading, unavailable, and request errors distinct', () => {
    expect(provider).toContain("'loading'");
    expect(provider).toContain("'unavailable'");
    expect(provider).toContain("'error'");
  });

  it('does not select or return WhatsApp credentials', () => {
    expect(endpoint).toContain(".select('id', { count: 'exact', head: true })");
    expect(endpoint).not.toContain('access_token');
    expect(endpoint).not.toContain('waba_id');
  });
});
