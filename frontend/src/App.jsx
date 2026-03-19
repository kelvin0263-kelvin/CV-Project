import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import PeopleCounting from './components/PeopleCounting';
import DressCode from './components/DressCode';
import Reporting from './components/Reporting';
import SystemConfiguration from './components/SystemConfiguration';
import Login from './components/Login';
import FallDetection from './components/FallDetection';
import AccountSettings from './components/AccountSettings';
import { clearAuthSession, getStoredToken, storeAuthSession, subscribeAuthChanges } from './apiConfig';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return Boolean(getStoredToken());
  });

  useEffect(() => {
    return subscribeAuthChanges(() => {
      setIsAuthenticated(Boolean(getStoredToken()));
    });
  }, []);

  const handleLogin = (accessToken, user) => {
    storeAuthSession(accessToken, user);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    clearAuthSession();
    setIsAuthenticated(false);
  };

  return (
    <Router>
      <Routes>
        <Route path="/login" element={
          isAuthenticated ? <Navigate to="/" replace /> : <Login onLogin={handleLogin} />
        } />

        <Route path="/" element={
          isAuthenticated ? <Layout onLogout={handleLogout} /> : <Navigate to="/login" replace />
        }>
          <Route index element={<Dashboard />} />
          <Route path="people-counting" element={<PeopleCounting />} />
          <Route path="dress-code" element={<DressCode />} />
          <Route path="fall-detection" element={<FallDetection />} />
          <Route path="reports" element={<Reporting />} />
          <Route path="settings" element={<SystemConfiguration />} />
          <Route path="account" element={<AccountSettings />} />
          <Route path="upload" element={<Navigate to="/settings?tab=uploads" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
