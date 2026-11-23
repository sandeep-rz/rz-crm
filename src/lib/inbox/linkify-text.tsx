import type { ReactNode } from 'react';

interface LinkifyTextProps {
  text: string;
  isAgent: boolean;
  className?: string;
}

/** Text stays React-escaped. Only explicit HTTP(S) and www URLs become links. */
export function LinkifyText({ text, isAgent, className }: LinkifyTextProps) {
  const parts: ReactNode[] = [];
  let previous = 0;
  for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)) {
    let label = match[0].replace(/[.,!?;:]+$/, '');
    while (
      label.endsWith(')') &&
      (label.match(/\)/g)?.length ?? 0) > (label.match(/\(/g)?.length ?? 0)
    )
      label = label.slice(0, -1);
    const href = /^www\./i.test(label) ? `https://${label}` : label;
    try {
      const url = new URL(href);
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname)
        continue;
    } catch {
      continue;
    }
    parts.push(text.slice(previous, match.index));
    parts.push(
      <a
        key={match.index}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className={
          isAgent
            ? 'text-primary-foreground underline underline-offset-2 hover:opacity-80'
            : 'text-primary underline underline-offset-2 hover:opacity-80'
        }
      >
        {label}
      </a>
    );
    previous = match.index! + label.length;
  }
  parts.push(text.slice(previous));
  return <span className={className}>{parts}</span>;
}
