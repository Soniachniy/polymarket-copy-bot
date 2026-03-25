import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, botApi } from './lib/api';
import { wsClient } from './lib/ws';
import AuthPage from './pages/AuthPage';
import WizardPage from './pages/WizardPage';
import DashboardPage from './pages/DashboardPage';

function AuthGate({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

export default function App() {
  const navigate = useNavigate();
  const [token] = useState(() => localStorage.getItem('token'));

  const { data: authStatus } = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => authApi.status().then((r) => r.data),
    retry: false,
  });

  const { data: botStatus } = useQuery({
    queryKey: ['bot-status'],
    queryFn: () => botApi.status().then((r) => r.data),
    enabled: !!token,
    retry: false,
  });

  // Connect WS when logged in
  useEffect(() => {
    if (token) {
      wsClient.connect();
      return () => wsClient.disconnect();
    }
  }, [token]);

  // On load: redirect based on auth + setup state
  useEffect(() => {
    if (!authStatus) return;
    const path = window.location.pathname;
    // Unauthenticated pages redirect to /auth
    if (path === '/' || path === '/login' || path === '/setup') {
      navigate('/auth', { replace: true });
    }
  }, [authStatus, navigate]);

  // If token exists and bot is already set up, skip wizard → dashboard
  useEffect(() => {
    if (!botStatus) return;
    if (!token) return;
    const path = window.location.pathname;
    if (botStatus.setupComplete && (path === '/wizard' || path === '/auth' || path === '/')) {
      navigate('/dashboard', { replace: true });
    }
  }, [botStatus, token, navigate]);

  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/wizard" element={<AuthGate><WizardPage /></AuthGate>} />
      <Route path="/dashboard" element={<AuthGate><DashboardPage /></AuthGate>} />
      <Route path="*" element={<Navigate to={token ? '/dashboard' : '/auth'} replace />} />
    </Routes>
  );
}
