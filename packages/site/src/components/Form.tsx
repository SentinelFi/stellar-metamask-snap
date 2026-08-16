import type { ReactNode } from 'react';
import styled, { css } from 'styled-components';

/**
 * Button appearance. `primary` is reserved for the action that opens a
 * MetaMask dialog, so exactly one control per panel carries the accent.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const variants = {
  primary: css`
    background-color: ${({ theme }) => theme.colors.primary?.default};
    border-color: ${({ theme }) => theme.colors.primary?.default};
    color: ${({ theme }) => theme.colors.primary?.inverse};

    &:hover:not(:disabled) {
      background-color: ${({ theme }) => theme.colors.primary?.hover};
      border-color: ${({ theme }) => theme.colors.primary?.hover};
    }
  `,
  secondary: css`
    background-color: transparent;
    border-color: ${({ theme }) => theme.colors.border?.strong};
    color: ${({ theme }) => theme.colors.text?.default};

    &:hover:not(:disabled) {
      border-color: ${({ theme }) => theme.colors.primary?.default};
      color: ${({ theme }) => theme.colors.primary?.default};
    }
  `,
  ghost: css`
    background-color: transparent;
    border-color: transparent;
    color: ${({ theme }) => theme.colors.text?.muted};

    &:hover:not(:disabled) {
      color: ${({ theme }) => theme.colors.text?.default};
      background-color: ${({ theme }) => theme.colors.background?.alternative};
    }
  `,
  danger: css`
    background-color: transparent;
    border-color: ${({ theme }) => theme.colors.error?.default};
    color: ${({ theme }) => theme.colors.error?.default};

    &:hover:not(:disabled) {
      background-color: ${({ theme }) => theme.colors.error?.muted};
    }
  `,
};

const buttonBase = css<{ variant?: ButtonVariant; small?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.8rem;
  border: 1px solid transparent;
  border-radius: ${({ theme }) => theme.radii.button};
  font-weight: 600;
  font-size: ${({ theme, small }) =>
    small ? theme.fontSizes.tiny : theme.fontSizes.small};
  padding: ${({ small }) => (small ? '0.6rem 1rem' : '1rem 1.6rem')};
  min-height: ${({ small }) => (small ? '3.2rem' : '4rem')};
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
  ${({ variant }) => variants[variant ?? 'secondary']}

  &:disabled {
    opacity: 0.45;
  }
`;

export const Button = styled.button<{
  variant?: ButtonVariant;
  small?: boolean;
}>`
  ${buttonBase}
`;

/*
 * An anchor that looks like a button.
 *
 * A link is not a button with a different `as` prop: it navigates, it is
 * keyboard-activated differently, and assistive technology announces it
 * differently. Sharing only the styling keeps the element honest.
 */
export const LinkButton = styled.a<{
  variant?: ButtonVariant;
  small?: boolean;
}>`
  ${buttonBase}
  text-decoration: none;
`;

const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  font-size: ${({ theme }) => theme.fontSizes.small};
  font-weight: 600;
  color: ${({ theme }) => theme.colors.text?.alternative};
  flex: 1 1 22rem;
  min-width: 0;
`;

const Hint = styled.span`
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  font-weight: 400;
  color: ${({ theme }) => theme.colors.text?.muted};
`;

const controlStyles = css`
  width: 100%;
  box-sizing: border-box;
  padding: 1rem 1.2rem;
  font-size: ${({ theme }) => theme.fontSizes.small};
  font-weight: 400;
  color: ${({ theme }) => theme.colors.text?.default};
  background-color: ${({ theme }) => theme.colors.background?.default};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.button};

  &::placeholder {
    color: ${({ theme }) => theme.colors.text?.muted};
  }

  &:disabled {
    opacity: 0.6;
  }
`;

export const Input = styled.input<{ mono?: boolean | undefined }>`
  ${controlStyles}
  font-family: ${({ theme, mono }) =>
    mono ? theme.fonts.code : theme.fonts.default};
`;

export const Select = styled.select`
  ${controlStyles}
`;

export const FormRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 1.2rem;
  margin-bottom: 1.6rem;
`;

export type FieldProps = {
  label: string;
  hint?: ReactNode | undefined;
  children: ReactNode;
};

/**
 * A labelled form control.
 *
 * @param props - Field props.
 * @param props.label - The visible label, which also labels the control.
 * @param props.hint - Optional supporting text under the label.
 * @param props.children - The control itself.
 * @returns The labelled field.
 */
export const Field = ({ label, hint, children }: FieldProps) => (
  <Label>
    <span>
      {label}
      {hint ? <Hint> {hint}</Hint> : null}
    </span>
    {children}
  </Label>
);
