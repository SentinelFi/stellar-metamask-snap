import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import { truncateMiddle } from '../utils';

export type Tone = 'neutral' | 'accent' | 'success' | 'error' | 'warning';

const toneColor = (tone: Tone) =>
  ({
    neutral: 'text' as const,
    accent: 'accent' as const,
    success: 'success' as const,
    error: 'error' as const,
    warning: 'warning' as const,
  })[tone];

export const Badge = styled.span<{ tone?: Tone | undefined }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: ${({ theme }) => theme.radii.pill};
  padding: 0.2rem 0.9rem;
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: ${({ theme, tone }) =>
    theme.colors[toneColor(tone ?? 'neutral')]?.default};
  background-color: ${({ theme, tone }) =>
    tone && tone !== 'neutral'
      ? theme.colors[toneColor(tone)]?.muted
      : theme.colors.background?.alternative};
  border: 1px solid
    ${({ theme, tone }) =>
      tone && tone !== 'neutral'
        ? 'transparent'
        : theme.colors.border?.default};
`;

const AlertBox = styled.div<{ tone: Tone }>`
  border-radius: ${({ theme }) => theme.radii.button};
  border: 1px solid
    ${({ theme, tone }) => theme.colors[toneColor(tone)]?.default};
  background-color: ${({ theme, tone }) =>
    theme.colors[toneColor(tone)]?.muted ??
    theme.colors.background?.alternative};
  color: ${({ theme }) => theme.colors.text?.default};
  padding: 1.2rem 1.6rem;
  font-size: ${({ theme }) => theme.fontSizes.small};
  display: flex;
  gap: 1.2rem;
  align-items: flex-start;
  justify-content: space-between;
  word-break: break-word;

  & > div > strong {
    color: ${({ theme, tone }) => theme.colors[toneColor(tone)]?.default};
  }
`;

const DismissButton = styled.button`
  background: none;
  border: none;
  color: inherit;
  opacity: 0.6;
  font-size: ${({ theme }) => theme.fontSizes.text};
  line-height: 1;
  padding: 0.2rem 0.4rem;

  &:hover {
    opacity: 1;
  }
`;

export type AlertProps = {
  tone: Tone;
  title?: string | undefined;
  children: ReactNode;
  onDismiss?: (() => void) | undefined;
};

/**
 * An inline notice. Used for connector errors, submission results, and the
 * advisory warnings the snap returns alongside a signature.
 *
 * @param props - Alert props.
 * @param props.tone - Which palette the notice draws on.
 * @param props.title - Optional bold lead-in.
 * @param props.children - The message.
 * @param props.onDismiss - When given, renders a dismiss control.
 * @returns The alert.
 */
export const Alert = ({ tone, title, children, onDismiss }: AlertProps) => (
  <AlertBox tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <div>
      {title ? <strong>{title} </strong> : null}
      {children}
    </div>
    {onDismiss ? (
      <DismissButton type="button" onClick={onDismiss} aria-label="Dismiss">
        ×
      </DismissButton>
    ) : null}
  </AlertBox>
);

export const Mono = styled.span`
  font-family: ${({ theme }) => theme.fonts.code};
  font-size: ${({ theme }) => theme.fontSizes.small};
  word-break: break-all;
`;

const CopyRow = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.8rem;
`;

const CopyButton = styled.button`
  background: none;
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: 6px;
  color: ${({ theme }) => theme.colors.text?.muted};
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  padding: 0.2rem 0.6rem;

  &:hover {
    color: ${({ theme }) => theme.colors.text?.default};
    border-color: ${({ theme }) => theme.colors.border?.strong};
  }
`;

export type AddressChipProps = {
  value: string;
  /** Characters kept on each side of the ellipsis. */
  keep?: number | undefined;
  /** Render the value in full instead of truncating. */
  full?: boolean | undefined;
};

/**
 * A truncated identifier with a copy control.
 *
 * The full value goes to the clipboard and to the `title` attribute; only the
 * rendering is shortened. An address a user cannot copy exactly is an address
 * they will retype by hand, which is how funds reach the wrong account.
 *
 * @param props - Chip props.
 * @param props.value - The full address, hash, or contract id.
 * @param props.keep - Characters kept on each side.
 * @param props.full - Render the value untruncated.
 * @returns The chip.
 */
export const AddressChip = ({ value, keep = 6, full }: AddressChipProps) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [value]);

  if (!value) {
    return <Mono>—</Mono>;
  }

  return (
    <CopyRow>
      <Mono title={value}>{full ? value : truncateMiddle(value, keep)}</Mono>
      <CopyButton type="button" onClick={copy} aria-label="Copy to clipboard">
        {copied ? 'Copied' : 'Copy'}
      </CopyButton>
    </CopyRow>
  );
};

const Anchor = styled.a`
  color: ${({ theme }) => theme.colors.accent?.default};
  text-decoration: none;
  font-weight: 600;

  &:hover {
    text-decoration: underline;
  }
`;

export type ExternalLinkProps = {
  href: string;
  children: ReactNode;
};

/**
 * An outbound link, always opened with `noopener noreferrer`.
 *
 * @param props - Link props.
 * @param props.href - The destination.
 * @param props.children - The link text.
 * @returns The link.
 */
export const ExternalLink = ({ href, children }: ExternalLinkProps) => (
  <Anchor href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </Anchor>
);

export const CodeBlock = styled.pre`
  margin: 0;
  padding: 1.2rem 1.6rem;
  background-color: ${({ theme }) => theme.colors.background?.alternative};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.button};
  font-family: ${({ theme }) => theme.fonts.code};
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 32rem;
  overflow: auto;
`;
