import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ApiError } from './api/client.ts';
import { decor } from './assets/index.ts';
import { initializeWebApp } from './telegram/webapp.ts';
import { applyTelegramTheme, watchTelegramTheme } from './telegram/theme.ts';
import './styles.css';

/**
 * Points the decoration mount at its bundled file.
 *
 * Done from JavaScript so the URL comes from a Vite import and carries the content
 * hash. Writing `url(./assets/decorations/tentacle-arc.svg)` in the stylesheet would
 * work until someone renames the file, at which point it becomes a 404 that nothing
 * catches — the decoration would simply stop appearing.
 */
function applyDecor(): void {
  document.documentElement.style.setProperty(
    '--zone-decor-tentacle',
    `url(${decor.tentacleArc})`,
  );
}

// Apply the theme and signal readiness before the first paint so the app never
// flashes the wrong colours.
applyTelegramTheme();
watchTelegramTheme();
applyDecor();
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
