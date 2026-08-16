import type { ReactNode } from 'react';
import styled from 'styled-components';

// The page's content column.
export const Page = styled.main`
  width: 100%;
  max-width: 108rem;
  margin: 0 auto;
  padding: 4rem 2.4rem 6rem;
  box-sizing: border-box;
  flex: 1;
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 2rem 1.6rem 4rem;
  }
`;

// Vertical rhythm between panels.
export const Stack = styled.div<{ gap?: string | undefined }>`
  display: flex;
  flex-direction: column;
  gap: ${({ gap }) => gap ?? '2rem'};
`;

// A horizontal group that wraps on narrow screens.
export const Cluster = styled.div<{
  gap?: string | undefined;
  align?: string | undefined;
}>`
  display: flex;
  flex-wrap: wrap;
  align-items: ${({ align }) => align ?? 'center'};
  gap: ${({ gap }) => gap ?? '1.2rem'};
`;

// Two columns on wide screens, one on narrow.
export const Columns = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(34rem, 1fr));
  gap: 2rem;
  align-items: start;
`;

const PanelBox = styled.section<{ muted?: boolean | undefined }>`
  background-color: ${({ theme, muted }) =>
    muted ? theme.colors.background?.alternative : theme.colors.card?.default};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.default};
  box-shadow: ${({ theme }) => theme.shadows.panel};
  padding: 2.4rem;
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 1.6rem;
  }
`;

const PanelHead = styled.header`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.2rem;
  margin-bottom: 1.6rem;
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.fontSizes.large};
  font-weight: 600;
`;

const PanelDescription = styled.p`
  margin: 0.4rem 0 0;
  font-size: ${({ theme }) => theme.fontSizes.small};
  color: ${({ theme }) => theme.colors.text?.muted};
  max-width: 62ch;
`;

const PanelActions = styled.div`
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
`;

export type PanelProps = {
  title: string;
  description?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  muted?: boolean | undefined;
  id?: string | undefined;
};

/**
 * A titled content panel: the page's one structural container.
 *
 * @param props - Panel props.
 * @param props.title - The panel heading.
 * @param props.description - Optional supporting line under the heading.
 * @param props.actions - Optional controls aligned to the heading.
 * @param props.children - The panel body.
 * @param props.muted - Render on the alternative surface.
 * @param props.id - Anchor id, for in-page navigation.
 * @returns The panel.
 */
export const Panel = ({
  title,
  description,
  actions,
  children,
  muted,
  id,
}: PanelProps) => (
  <PanelBox muted={muted} id={id}>
    <PanelHead>
      <div>
        <PanelTitle>{title}</PanelTitle>
        {description ? (
          <PanelDescription>{description}</PanelDescription>
        ) : null}
      </div>
      {actions ? <PanelActions>{actions}</PanelActions> : null}
    </PanelHead>
    {children}
  </PanelBox>
);
