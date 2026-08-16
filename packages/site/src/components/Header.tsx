import styled, { useTheme } from 'styled-components';

import { HeaderButtons } from './Buttons';
import { SnapLogo } from './SnapLogo';
import { Toggle } from './Toggle';
import { dark } from '../config/theme';

const HeaderWrapper = styled.header`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1.6rem;
  padding: 1.6rem 2.4rem;
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 1.2rem 1.6rem;
  }
  border-bottom: 1px solid ${(props) => props.theme.colors.border?.default};
  background-color: ${({ theme }) => theme.colors.card?.default};
  position: sticky;
  top: 0;
  z-index: 10;
`;

const Title = styled.p`
  font-size: ${(props) => props.theme.fontSizes.text};
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0 1.2rem;
  ${({ theme }) => theme.mediaQueries.small} {
    display: none;
  }
`;

const LogoWrapper = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
`;

const RightContainer = styled.div`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 1.2rem;
  min-width: 0;
`;

export const Header = ({
  handleToggleClick,
}: {
  handleToggleClick: () => void;
}) => {
  // The active theme object identifies the state Root already owns: re-reading
  // the stored preference here (as this used to do) touches storage on every
  // render and can disagree with the theme actually applied once the user has
  // toggled. The provider hands out the exact `dark`/`light` object, so an
  // identity check is reliable.
  const theme = useTheme();

  return (
    <HeaderWrapper>
      <LogoWrapper>
        <SnapLogo size={32} />
        <Title>Stellar Soroban Snap</Title>
      </LogoWrapper>
      <RightContainer>
        <Toggle onToggle={handleToggleClick} checked={theme === dark} />
        <HeaderButtons />
      </RightContainer>
    </HeaderWrapper>
  );
};
