import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { RunProvider } from './api/hooks';
import { Layout } from './components/Layout';
import { LangProvider } from './i18n';
import { DeadLetters } from './pages/DeadLetters';
import { EventDetailPage } from './pages/EventDetail';
import { Events } from './pages/Events';
import { HowItWorks } from './pages/HowItWorks';
import { Overview } from './pages/Overview';
import { ReceiverInspector } from './pages/ReceiverInspector';
import { ScenarioRunner } from './pages/ScenarioRunner';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LangProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <RunProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Overview />} />
                <Route path="runner" element={<ScenarioRunner />} />
                <Route path="events" element={<Events />} />
                <Route path="events/:id" element={<EventDetailPage />} />
                <Route path="dead-letters" element={<DeadLetters />} />
                <Route path="receiver" element={<ReceiverInspector />} />
                <Route path="how-it-works" element={<HowItWorks />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </RunProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </LangProvider>
  </StrictMode>,
);
