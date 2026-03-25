import { useState, useCallback } from 'react';
import { authApi } from '../lib/api';

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));

  const login = useCallback(async (password: string) => {
    const res = await authApi.login(password);
    localStorage.setItem('token', res.data.token);
    setToken(res.data.token);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
  }, []);

  return { token, isLoggedIn: !!token, login, logout };
}
