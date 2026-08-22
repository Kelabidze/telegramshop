import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ApiError } from './api/client.ts';
import { initializeWebApp } from './telegram/webapp.ts';
import { applyTelegramTheme, watchTelegramTheme } from './telegram/theme.ts';
import './styles.css';

// Apply the theme and signal readiness before the first paint so the app never
// flashes the wrong colours.
applyTelegramTheme();
watchTelegramTheme();
initializeWebApp();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A WebView is often resumed from the background; refetching on focus
      // keeps stock counts honest.
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Never retry client errors: a 401 or 409 will not fix itself.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
