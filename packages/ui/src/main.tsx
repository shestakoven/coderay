import '@xyflow/react/dist/style.css';
import './styles.css';
import './plan-flow/plan-flow.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './layout/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="The IDE">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
