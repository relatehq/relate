import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  createDevClient,
  inspectorBaseUrl,
  takeFragmentToken,
} from './connection/client.js';
import { DevClientProvider } from './inspector-context.js';
import { createInspectorRouter } from './router.js';

// Strip the terminal token from the address bar before anything else observes it.
const token = takeFragmentToken(window.location, window.history);
const baseUrl = inspectorBaseUrl(window.location);
const client = createDevClient({ baseUrl, token });
const queryClient = new QueryClient();
const router = createInspectorRouter(baseUrl.pathname.replace(/\/$/, ''));

void client.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DevClientProvider client={client}>
        <RouterProvider router={router} />
      </DevClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
