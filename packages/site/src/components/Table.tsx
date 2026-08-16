import type { ReactNode } from 'react';
import styled from 'styled-components';

/*
 * A table that scrolls horizontally inside its own box on narrow screens,
 * so a long address never widens the page itself.
 */
const Scroller = styled.div`
  width: 100%;
  overflow-x: auto;
`;

export const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${({ theme }) => theme.fontSizes.small};
`;

export const Th = styled.th<{ align?: 'left' | 'right' | undefined }>`
  text-align: ${({ align }) => align ?? 'left'};
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${({ theme }) => theme.colors.text?.muted};
  padding: 0 1.2rem 0.8rem;
  white-space: nowrap;
`;

export const Td = styled.td<{
  align?: 'left' | 'right' | undefined;
  mono?: boolean | undefined;
}>`
  text-align: ${({ align }) => align ?? 'left'};
  padding: 1.2rem;
  border-top: 1px solid ${({ theme }) => theme.colors.border?.default};
  vertical-align: middle;
  font-family: ${({ theme, mono }) =>
    mono ? theme.fonts.code : theme.fonts.default};
  white-space: nowrap;
`;

export const Tr = styled.tr`
  &:hover td {
    background-color: ${({ theme }) => theme.colors.background?.alternative};
  }
`;

const Empty = styled.p`
  margin: 0;
  padding: 2.4rem 0;
  text-align: center;
  color: ${({ theme }) => theme.colors.text?.muted};
  font-size: ${({ theme }) => theme.fontSizes.small};
`;

export type DataTableProps = {
  /** Column headers, in order. */
  columns: {
    key: string;
    label: string;
    align?: 'left' | 'right' | undefined;
  }[];
  /** Shown instead of the table when there are no rows. */
  empty: ReactNode;
  /** True when the table has at least one row. */
  hasRows: boolean;
  children: ReactNode;
};

/**
 * A table with its header row, or an empty-state line when there is nothing
 * to show. The empty state is a sentence rather than a blank area: "no rows"
 * and "not loaded yet" are different facts and each caller says which.
 *
 * @param props - Table props.
 * @param props.columns - Column definitions.
 * @param props.empty - Empty-state content.
 * @param props.hasRows - Whether any rows were passed.
 * @param props.children - The `<tr>` rows.
 * @returns The table or the empty state.
 */
export const DataTable = ({
  columns,
  empty,
  hasRows,
  children,
}: DataTableProps) => {
  if (!hasRows) {
    return <Empty>{empty}</Empty>;
  }
  return (
    <Scroller>
      <Table>
        <thead>
          <tr>
            {columns.map((column) => (
              <Th key={column.key} align={column.align}>
                {column.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </Table>
    </Scroller>
  );
};
