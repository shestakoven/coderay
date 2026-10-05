import '@xyflow/react/dist/style.css';
import './styles.css';
import './plan-flow/plan-flow.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './layout/ErrorBoundary';
import './settings/appearance.css';
import { applyAppearance, loadAppearance } from './settings/appearance';
import { localStorageOrUndefined } from './settings/storage';

applyAppearance(document.documentElement, loadAppearance(localStorageOrUndefined()));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="The IDE">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
