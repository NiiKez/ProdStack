import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import App from './App';
import { queryClient } from '@/lib/queryClient';
import { setUnauthorizedHandler } from '@/lib/api';
import { ToastProvider } from '@/components/ui';
import './index.css';

setUnauthorizedHandler(() => {
  queryClient.removeQueries({ queryKey: ['me'] });
  const path = window.location.pathname;
  if (path !== '/' && !path.startsWith('/auth/')) {
    window.location.replace('/?session=expired');
  }
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  </StrictMode>,
);
