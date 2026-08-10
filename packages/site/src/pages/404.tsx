import { Link } from 'gatsby';
import styled from 'styled-components';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  margin-top: 7.6rem;
  margin-bottom: 7.6rem;
`;

const NotFoundPage = () => (
  <Container>
    <h1>Page not found</h1>
    <p>
      <Link to="/">Back to the Stellar Soroban Snap test bench</Link>
    </p>
  </Container>
);

export default NotFoundPage;
