'use client';

import type { Dispatch, SetStateAction } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  MessageCircle,
  Plus,
  Star,
} from 'lucide-react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WhatsAppConnectionSummary } from '@/lib/whatsapp/config-state';

type ConnectionSummary = WhatsAppConnectionSummary;

export function WhatsAppEmptyState({
  canConnect,
  onConnect,
}: {
  canConnect: boolean;
  onConnect: () => void;
}) {
  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center px-6 py-12 text-center sm:px-12">
        <div className="bg-primary/10 text-primary mb-5 flex size-12 items-center justify-center rounded-full">
          <MessageCircle className="size-6" />
        </div>
        <h2 className="text-foreground text-xl font-semibold">
          Connect WhatsApp
        </h2>
        <p className="text-muted-foreground mt-2 max-w-lg text-sm leading-6">
          Connect your WhatsApp Business number to manage customer conversations
          from the CRM.
        </p>
        <p className="text-muted-foreground mt-1 max-w-lg text-sm leading-6">
          Receive messages, reply from your shared inbox, send templates, and
          use automations.
        </p>
        {canConnect && (
          <Button className="mt-6" onClick={onConnect}>
            Connect WhatsApp
          </Button>
        )}
        <p className="text-muted-foreground mt-4 text-xs">
          Already have your Meta API details? Setup takes only a few minutes.
        </p>
      </CardContent>
    </Card>
  );
}

export function WhatsAppConnectionCard({
  connection,
  showPrimary,
  canManage,
  onManage,
  onSetPrimary,
}: {
  connection: ConnectionSummary;
  showPrimary: boolean;
  canManage: boolean;
  onManage: () => void;
  onSetPrimary: () => void;
}) {
  const connected = connection.status === 'connected';
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-foreground truncate font-medium">
              {connection.display_name || 'WhatsApp connection'}
            </p>
            <div className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
              <span
                className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
              {connected ? 'Configured' : 'Needs attention'}
            </div>
          </div>
          {showPrimary && connection.is_primary && (
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] tracking-wide uppercase"
            >
              Primary
            </Badge>
          )}
        </div>
        <div className="mt-auto flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onManage}>
            Manage
          </Button>
          {canManage && showPrimary && !connection.is_primary && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSetPrimary}
            >
              <Star className="size-3.5" /> Make primary
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function WhatsAppSetupGuide({
  open,
  onOpenChange,
  webhookUrl,
  copied,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhookUrl: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>WhatsApp setup guide</DialogTitle>
          <DialogDescription>
            Keep Meta&apos;s WhatsApp API Setup page open while you complete
            these steps.
          </DialogDescription>
        </DialogHeader>
        <Accordion>
          {[
            [
              '1',
              'Create a Meta App',
              'Open Meta for Developers, create or select your app, and choose the Business app type.',
            ],
            [
              '2',
              'Add WhatsApp',
              'Add the WhatsApp product to the app, then open WhatsApp → API Setup.',
            ],
            [
              '3',
              'Find your API credentials',
              'Copy the Phone Number ID, WhatsApp Business Account ID, and permanent access token from Meta.',
            ],
          ].map(([number, title, body]) => (
            <AccordionItem key={number}>
              <AccordionTrigger>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">{number}.</span>
                  {title}
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm leading-6">
                {body}
              </AccordionContent>
            </AccordionItem>
          ))}
          <AccordionItem>
            <AccordionTrigger>
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">4.</span>Configure your
                webhook
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground space-y-3 text-sm leading-6">
              <p>
                In Meta, open WhatsApp → Configuration. Paste this callback URL
                and enter the same private verify token you use in the CRM.
              </p>
              <div className="flex min-w-0 gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="min-w-0 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onCopy}
                  aria-label="Copy webhook callback URL"
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
              {copied && <p className="text-xs text-emerald-600">Copied</p>}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <a
          href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 text-sm"
        >
          <ExternalLink className="size-3.5" /> Meta documentation
        </a>
      </DialogContent>
    </Dialog>
  );
}

export interface WhatsAppSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: 1 | 2 | 3;
  setStep: Dispatch<SetStateAction<1 | 2 | 3>>;
  displayName: string;
  setDisplayName: (value: string) => void;
  phoneNumberId: string;
  setPhoneNumberId: (value: string) => void;
  wabaId: string;
  setWabaId: (value: string) => void;
  accessToken: string;
  setAccessToken: (value: string) => void;
  showToken: boolean;
  setShowToken: (value: boolean) => void;
  verifyToken: string;
  setVerifyToken: (value: string) => void;
  pin: string;
  setPin: (value: string) => void;
  webhookUrl: string;
  copied: boolean;
  connecting: boolean;
  errorMessage?: string | null;
  onTokenEdited: () => void;
  onCopyWebhook: () => void;
  onOpenGuide: () => void;
  onContinue: () => void;
  onConnect: () => void;
}

export function WhatsAppSetupWizard(props: WhatsAppSetupWizardProps) {
  const title =
    props.step === 1
      ? 'Connect WhatsApp'
      : props.step === 2
        ? 'Enter your WhatsApp API details'
        : 'Complete setup';

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !props.connecting && props.onOpenChange(open)}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="pr-8">
            <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              Step {props.step} of 3
            </p>
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>
            {props.step === 1 &&
              "Before connecting your number, you'll need your WhatsApp Business API details from Meta."}
            {props.step === 2 &&
              'These details are available on the WhatsApp API Setup page in Meta.'}
            {props.step === 3 &&
              'Add the webhook details Meta needs, then connect your number.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2" aria-hidden="true">
          {[1, 2, 3].map((item) => (
            <span
              key={item}
              className={`h-1 rounded-full ${item <= props.step ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>

        {props.errorMessage && (
          <Alert className="border-red-700/40 bg-red-950/20">
            <AlertDescription>{props.errorMessage}</AlertDescription>
          </Alert>
        )}

        {props.step === 1 && (
          <div className="space-y-5 py-2">
            <ol className="space-y-3">
              {[
                'Create or open your Meta App',
                'Add the WhatsApp product',
                'Open WhatsApp → API Setup',
                'Keep that page open for the next step',
              ].map((item, index) => (
                <li key={item} className="flex items-center gap-3 text-sm">
                  <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  {item}
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={props.onOpenGuide}
            >
              View setup instructions
            </Button>
          </div>
        )}

        {props.step === 2 && (
          <div className="space-y-5 py-2">
            <WizardField
              label="Connection name"
              help="A name only your team will see. For example: Reservations, Support, Main WhatsApp, or Varkala Property."
              collapsible={false}
            >
              <Input
                value={props.displayName}
                onChange={(event) => props.setDisplayName(event.target.value)}
                placeholder="Reservations"
                disabled={props.connecting}
              />
            </WizardField>
            <WizardField
              label="Phone Number ID"
              help="This is the Phone Number ID shown in Meta's WhatsApp API Setup page, not your WhatsApp phone number."
            >
              <Input
                value={props.phoneNumberId}
                onChange={(event) => props.setPhoneNumberId(event.target.value)}
                placeholder="Enter the numeric Phone Number ID"
                inputMode="numeric"
                disabled={props.connecting}
              />
            </WizardField>
            <WizardField
              label="WhatsApp Business Account ID"
              help="Find this beside the Phone Number ID on Meta's WhatsApp API Setup page. It may also be called the WABA ID."
            >
              <Input
                value={props.wabaId}
                onChange={(event) => props.setWabaId(event.target.value)}
                placeholder="Enter the numeric Business Account ID"
                inputMode="numeric"
                disabled={props.connecting}
              />
            </WizardField>
            <WizardField
              label="Permanent Access Token"
              help="Use the permanent access token configured for your WhatsApp Business API. The CRM encrypts it before storage."
            >
              <div className="relative">
                <Input
                  type={props.showToken ? 'text' : 'password'}
                  value={props.accessToken}
                  onChange={(event) => {
                    props.setAccessToken(event.target.value);
                    props.onTokenEdited();
                  }}
                  placeholder="Paste your permanent access token"
                  className="pr-10"
                  disabled={props.connecting}
                />
                <button
                  type="button"
                  onClick={() => props.setShowToken(!props.showToken)}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  aria-label={
                    props.showToken ? 'Hide access token' : 'Show access token'
                  }
                >
                  {props.showToken ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </WizardField>
          </div>
        )}

        {props.step === 3 && (
          <div className="space-y-5 py-2">
            <WizardField
              label="Webhook Verify Token"
              help="Create any private verification string. Enter this exact same value in Meta's webhook configuration."
              helpLabel="Where do I use this?"
            >
              <Input
                value={props.verifyToken}
                onChange={(event) => props.setVerifyToken(event.target.value)}
                placeholder="my-whatsapp-webhook-token"
                disabled={props.connecting}
              />
            </WizardField>
            <WizardField
              label="Two-step verification PIN (optional)"
              help="Meta may require the six-digit PIN already configured for this phone number. Leave it blank when your number does not use one."
              helpLabel="Learn more"
            >
              <Input
                value={props.pin}
                onChange={(event) =>
                  props.setPin(
                    event.target.value.replace(/\D/g, '').slice(0, 6)
                  )
                }
                placeholder="6-digit PIN"
                inputMode="numeric"
                maxLength={6}
                disabled={props.connecting}
              />
            </WizardField>
            <div className="space-y-2">
              <Label>Webhook callback URL</Label>
              <p className="text-muted-foreground text-xs">
                Copy this value into Meta&apos;s webhook configuration.
              </p>
              <div className="flex min-w-0 gap-2">
                <Input
                  readOnly
                  value={props.webhookUrl}
                  className="min-w-0 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={props.onCopyWebhook}
                  aria-label="Copy webhook callback URL"
                >
                  {props.copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
              {props.copied && (
                <p className="text-xs text-emerald-600">Copied</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {props.step > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => props.setStep((props.step - 1) as 1 | 2)}
              disabled={props.connecting}
            >
              Back
            </Button>
          )}
          {props.step < 3 ? (
            <Button type="button" onClick={props.onContinue}>
              Continue
            </Button>
          ) : (
            <Button
              type="button"
              onClick={props.onConnect}
              disabled={props.connecting}
            >
              {props.connecting ? 'Connecting WhatsApp…' : 'Connect WhatsApp'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WizardField({
  label,
  help,
  helpLabel = 'Where do I find this?',
  collapsible = true,
  children,
}: {
  label: string;
  help: string;
  helpLabel?: string;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {collapsible ? (
        <Accordion>
          <AccordionItem className="border-0">
            <AccordionTrigger className="text-primary py-0 text-xs font-normal hover:no-underline">
              {helpLabel}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground pt-2 text-xs leading-5">
              {help}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : (
        <p className="text-muted-foreground text-xs leading-5">{help}</p>
      )}
    </div>
  );
}

export function AddWhatsAppConnectionButton({
  onClick,
}: {
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="outline" onClick={onClick}>
      <Plus className="size-4" /> Add WhatsApp connection
    </Button>
  );
}
