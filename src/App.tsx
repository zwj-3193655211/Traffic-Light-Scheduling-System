import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import IntersectionList from './pages/IntersectionList';
import IntersectionDetail from './pages/IntersectionDetail';
import TrafficControl from './pages/TrafficControl';
import EmergencyManagement from './pages/EmergencyManagement';
import Settings from './pages/Settings';
import Demo from './pages/Demo';
import Login from './pages/Login';
import { useDemoEngine } from './stores/demoEngine';

function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('auth_token'));
  const startDemo = useDemoEngine((s) => s.start);
  useEffect(() => {
    const check = () => setAuthed(!!localStorage.getItem('auth_token'));
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);
  useEffect(() => { if (authed) startDemo() }, [authed, startDemo]);
  return (
    <Router>
      {authed ? (
        <div className="App flex h-screen bg-gray-100">
          <Toaster position="top-right" richColors />
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header />
            <main className="flex-1 overflow-y-auto p-4">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/intersections" element={<IntersectionList />} />
                <Route path="/intersections/:id" element={<IntersectionDetail />} />
                <Route path="/traffic-control" element={<TrafficControl />} />
                <Route path="/emergency" element={<EmergencyManagement />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/demo" element={<Demo />} />
              </Routes>
            </main>
          </div>
        </div>
      ) : (
        <div className="min-h-screen bg-gray-100">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Login />} />
          </Routes>
        </div>
      )}
    </Router>
  );
}

export default App;
