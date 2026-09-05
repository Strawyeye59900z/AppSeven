/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Building, Lock, Package, User } from 'lucide-react';
import { Resident } from './types';
import ResidentAuth from './components/ResidentAuth';
import CameraCapture from './components/CameraCapture';
import ResidentStatus from './components/ResidentStatus';
import AdminDashboard from './components/AdminDashboard';
import ReservationSection from './components/ReservationSection';
import ResidentReservationsSidePanel from './components/ResidentReservationsSidePanel';
import EmployeePanel from './components/EmployeePanel';
import BottomNav from './components/BottomNav';

export default function App() {
  const [activeTab, setActiveTabRaw] = useState<'resident' | 'admin' | 'employee'>(() => {
    const saved = localStorage.getItem('activeTab');
    if (saved === 'admin' && localStorage.getItem('adminSession')) return 'admin';
    return 'resident';
  });
  const setActiveTab = (tab: 'resident' | 'admin' | 'employee') => {
    if (tab === 'resident') localStorage.removeItem('activeTab');
    else localStorage.setItem('activeTab', tab);
    setActiveTabRaw(tab);
  };
  const [residentView, setResidentView] = useState<'inicio' | 'reservar' | 'encomendas' | 'family'>('inicio');
  const [loggedInResident, setLoggedInResident] = useState<Resident | null>(null);
  const [captureTarget, setCaptureTarget] = useState<Resident | null>(null);
  // Admin session lives here (lifted from AdminDashboard) so that re-renders or
  // sub-panel actions can never accidentally drop the admin back to the login screen.
  const [adminUser, setAdminUser] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem('adminSession') || 'null'); } catch { return null; }
  });

  const handleAdminLogin = useCallback((user: any) => {
    localStorage.setItem('adminSession', JSON.stringify(user));
    setAdminUser(user);
  }, []);

  const handleAdminLogout = useCallback(() => {
    localStorage.removeItem('adminSession');
    setAdminUser(null);
    localStorage.removeItem('activeTab');
    setActiveTabRaw('resident');
  }, []);

  const handleAdminBack = useCallback(() => {
    localStorage.removeItem('activeTab');
    setActiveTabRaw('resident');
  }, []);
  
  // Employee Login State
  const [employeeSession, setEmployeeSession] = useState<{ id: string; name: string; photoDataUrl?: string } | null>(null);
  const [employeePassword, setEmployeePassword] = useState('');
  const [employeeError, setEmployeeError] = useState('');
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [allEmployees, setAllEmployees] = useState<{ id: string; name: string; photoDataUrl?: string }[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [employeeNeedsSetup, setEmployeeNeedsSetup] = useState(false);
  const [employeeConfirmPassword, setEmployeeConfirmPassword] = useState('');

  const fetchAllEmployees = async () => {
    try {
      const res = await fetch('/api/employees');
      if (res.ok) {
        const data = await res.json();
        setAllEmployees(data);
        if (data.length > 0 && !selectedEmployeeId) {
          setSelectedEmployeeId(data[0].id);
        }
      }
    } catch (err) {
      console.error('Error loading employees list:', err);
    }
  };

  React.useEffect(() => {
    if (activeTab === 'employee') {
      fetchAllEmployees();
    }
  }, [activeTab]);

  const handleEmployeeLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmployeeError('');
    setEmployeeLoading(true);

    if (!selectedEmployeeId) {
      setEmployeeError('Selecione um funcionário.');
      setEmployeeLoading(false);
      return;
    }

    if (!employeePassword) {
      setEmployeeError('Digite sua senha.');
      setEmployeeLoading(false);
      return;
    }

    try {
      if (employeeNeedsSetup) {
        if (employeePassword !== employeeConfirmPassword) {
          setEmployeeError('As senhas não coincidem.');
          setEmployeeLoading(false);
          return;
        }
        if (employeePassword.length < 4) {
          setEmployeeError('A senha deve ter no mínimo 4 caracteres.');
          setEmployeeLoading(false);
          return;
        }

        const setupRes = await fetch('/api/employees/setup-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            employeeId: selectedEmployeeId, 
            password: employeePassword 
          })
        });
        if (setupRes.ok) {
          const emp = allEmployees.find(e => e.id === selectedEmployeeId);
          setEmployeeSession(emp ? { ...emp } : { id: selectedEmployeeId, name: 'Funcionário' });
          setEmployeePassword('');
          setEmployeeConfirmPassword('');
          setEmployeeNeedsSetup(false);
        } else {
          const setupError = await setupRes.json();
          setEmployeeError(setupError.error || 'Erro ao configurar senha inicial.');
        }
        return;
      }

      const res = await fetch('/api/employees/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          employeeId: selectedEmployeeId, 
          password: employeePassword 
        })
      });
      const data = await res.json();
      if (res.ok) {
        const empInfo = allEmployees.find(e => e.id === data.employee.id);                
        setEmployeeSession({ ...data.employee, photoDataUrl: empInfo?.photoDataUrl });
        setEmployeePassword('');
      } else {
        setEmployeeError(data.error || 'Senha inválida.');
      }
    } catch (err) {
      console.error('Login error:', err);
      setEmployeeError('Erro de conexão ao validar senha.');
    } finally {
      setEmployeeLoading(false);
    }
  };

  const handleResidentLogin = (resident: Resident) => {
    localStorage.setItem('loggedInResident', JSON.stringify(resident));
    setLoggedInResident(resident);
  };

  const handleResidentCaptureCompleted = (updatedResident: Resident) => {
    if (updatedResident.id === loggedInResident?.id) {
      localStorage.setItem('loggedInResident', JSON.stringify(updatedResident));
      setLoggedInResident(updatedResident);
    }
    setCaptureTarget(null);
  };

  const handleResidentLogout = () => {
    localStorage.removeItem('loggedInResident');
    setLoggedInResident(null);
    setCaptureTarget(null);
  };

  React.useEffect(() => {
    const savedResident = localStorage.getItem('loggedInResident');
    if (savedResident) {
      try {
        setLoggedInResident(JSON.parse(savedResident));
      } catch (err) {
        console.error('Failed to parse saved resident session', err);
        localStorage.removeItem('loggedInResident');
      }
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#020617] text-[#E4E4E7] flex flex-col font-sans">
      
      {/* GLOBAL NAVIGATION HEADER */}
      {!(activeTab === 'resident' && !loggedInResident) && (
        <header className="border-b border-white/5 bg-[#0f172a]/20 backdrop-blur-md sticky top-0 z-40 select-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-sm tracking-widest font-display shadow-lg shadow-blue-900/40">
                <Building size={18} />
              </div>
              <div>
                <h1 className="font-display font-bold text-sm tracking-tight text-white">Seven Residence</h1>
                <p className="text-[10px] text-blue-300/60 font-mono tracking-widest">SISTEMA CONDOMINIAL</p>
              </div>
            </div>

          </div>
        </header>
      )}

      {/* CORE CONTENT SHELF */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-10 flex flex-col items-center justify-center">
        {activeTab === 'resident' ? (
          /* RESIDENT FLOW COORDINATOR */
          <div className="w-full flex justify-center">
            {!loggedInResident ? (
              <ResidentAuth 
                onLoginSuccess={handleResidentLogin} 
                onAdminInitiate={() => { localStorage.setItem('activeTab', 'admin'); setActiveTab('admin'); }}
                onEmployeeInitiate={() => setActiveTab('employee')}
              />
            ) : !loggedInResident.photoDataUrl ? (
              /* Make photo mandatory only for the first person (who created the account/login) */
              <CameraCapture 
                resident={loggedInResident} 
                onCaptureCompleted={handleResidentCaptureCompleted} 
                onCancel={() => setLoggedInResident(null)}
              />
            ) : captureTarget ? (
              /* Allow other members to optionally take or update their photos with a Back option */
              <CameraCapture
                resident={captureTarget}
                onCaptureCompleted={handleResidentCaptureCompleted}
                onCancel={() => setCaptureTarget(null)}
              />
            ) : (
              <div className="w-full space-y-6">
                <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-6 items-start text-left">
                  
                  {/* LEFT PRIMARY PANEL CONTAINER */}
                  <div className="lg:col-span-8 space-y-6 w-full flex flex-col items-center">
                    {residentView === 'inicio' || residentView === 'family' || residentView === 'encomendas' ? (
                      /* RESIDENT STATUS (covers INICIO, FAMILY and ENCOMENDAS) */
                      <ResidentStatus 
                        resident={loggedInResident} 
                        onLogout={handleResidentLogout} 
                        onCaptureRequest={(member) => setCaptureTarget(member)}
                        // Pass down the current view so ResidentStatus knows whether to show family, packages or me
                        initialTab={residentView === 'family' ? 'family' : residentView === 'encomendas' ? 'packages' : 'me'}
                      />
                    ) : residentView === 'reservar' ? (
                      <div className="w-full bg-[#121214]/60 rounded-2xl border border-dark-border shadow-xl p-4 sm:p-6 space-y-6">
                        <div className="flex justify-between items-center border-b border-dark-border pb-4 mb-4 select-none">
                          <div>
                            <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest font-semibold text-gold">Apto {loggedInResident.apartment} {loggedInResident.block !== 'Único' ? `/ Bloco ${loggedInResident.block}` : ''}</span>
                            <h3 className="text-sm font-semibold text-white">Reservas</h3>
                          </div>
                          <button 
                            onClick={handleResidentLogout}
                            className="px-3 py-1.5 hover:bg-red-950/20 text-red-400 hover:text-red-300 border border-transparent hover:border-red-900/15 text-xs font-semibold rounded-xl cursor-pointer transition-all font-sans"
                          >
                            Sair do Portal
                          </button>
                        </div>
                        
                        <ReservationSection resident={loggedInResident} isAdmin={false} />
                      </div>
                    ) : (
                      <div className="w-full p-10 text-center text-zinc-500">
                        Visualização não encontrada.
                      </div>
                    )}
                  </div>

                  {/* RIGHT UPCOMING RESERVATIONS SIDE PANEL */}
                  <div className="lg:col-span-4 w-full">
                    <ResidentReservationsSidePanel resident={loggedInResident} />
                  </div>

                </div>
              </div>
            )}
          </div>
        ) : activeTab === 'employee' ? (
          /* EMPLOYEE FLOW COORDINATOR */
          <div className="w-full flex justify-center">
            {!employeeSession ? (
              /* PORTARIA STAFF PIN AUTHENTICATION CARD */
              <div className="w-full max-w-sm bg-dark-card border border-dark-border rounded-2xl shadow-xl shadow-black/40 p-8 space-y-6 text-left">
                <div className="flex justify-center select-none">
                  <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-400 border border-blue-500/15">
                    <Package size={32} />
                  </div>
                </div>
                
                <div className="text-center">
                  <h2 className="font-display text-lg font-bold text-white tracking-tight">Portaria & Encomendas</h2>
                  <p className="text-xs text-zinc-400 leading-relaxed mt-1 font-sans">
                    Selecione seu nome e insira sua senha pessoal. Se for seu primeiro acesso, a senha digitada agora será gravada como sua nova senha.
                  </p>
                </div>

                {employeeError && (
                  <div className="p-3 bg-red-950/40 text-red-400 text-xs border border-red-900/35 rounded-xl font-medium leading-relaxed font-sans">
                    {employeeError}
                  </div>
                )}

                <form onSubmit={handleEmployeeLogin} className="space-y-6">
                  <div className="space-y-3">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest font-display block text-center">Selecione seu perfil</label>
                    
                    <div className="grid grid-cols-3 gap-3">
                      {allEmployees.map((emp) => (
                        <button
                          key={emp.id}
                          type="button"
                          onClick={async () => {
                            setSelectedEmployeeId(emp.id);
                            setEmployeeError('');
                            setEmployeeNeedsSetup(false);
                            try {
                              const statusRes = await fetch('/api/employees/check-status', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ id: emp.id })
                              });
                              if (statusRes.ok) {
                                const statusData = await statusRes.ok ? await statusRes.json() : {};
                                if (statusData.needsSetup) {
                                  setEmployeeNeedsSetup(true);
                                }
                              }
                            } catch (error) {
                              console.error('Status check fail', error);
                            }
                          }}
                          className={`flex flex-col items-center gap-2 p-3 rounded-2xl border transition-all duration-300 group ${
                            selectedEmployeeId === emp.id 
                              ? 'bg-blue-500/10 border-blue-500 shadow-lg shadow-blue-500/10' 
                              : 'bg-dark-input/50 border-dark-border hover:border-zinc-700'
                          }`}
                        >
                          <div className={`w-14 h-14 rounded-xl overflow-hidden border-2 transition-transform duration-300 ${
                            selectedEmployeeId === emp.id ? 'border-blue-500 scale-105' : 'border-dark-border group-hover:border-zinc-600'
                          }`}>
                            {emp.photoDataUrl ? (
                              <img src={emp.photoDataUrl} alt={emp.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-zinc-600">
                                <User size={24} />
                              </div>
                            )}
                          </div>
                          <span className={`text-[10px] font-bold uppercase tracking-tight text-center truncate w-full ${
                            selectedEmployeeId === emp.id ? 'text-blue-400' : 'text-zinc-500'
                          }`}>
                            {emp.name.split(' ')[0]}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedEmployeeId && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="space-y-4"
                    >
                      {employeeNeedsSetup && (
                        <div className="text-center py-2">
                           <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 rounded-full text-[9px] font-bold tracking-wider uppercase font-mono">
                             Primeiro Acesso
                           </span>
                           <p className="text-[10px] text-zinc-500 mt-1 font-sans">Sua senha será gravada para novos acessos.</p>
                        </div>
                      )}

                      <div className="space-y-1.5 text-center">
                        <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest font-display block">Senha Pessoal</label>
                        <input
                          type="password"
                          required
                          autoFocus
                          value={employeePassword}
                          onChange={(e) => setEmployeePassword(e.target.value)}
                          placeholder="Digite sua senha"
                          className="w-full px-4 py-3 bg-dark-input border border-dark-border rounded-xl text-center text-sm font-semibold tracking-[0.3em] focus:outline-none focus:border-blue-500 text-white placeholder-zinc-700 font-mono shadow-inner"
                        />
                      </div>

                      {employeeNeedsSetup && (
                        <div className="space-y-1.5 text-center">
                          <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest font-display block">Confirme a Senha</label>
                          <input
                            type="password"
                            required
                            value={employeeConfirmPassword}
                            onChange={(e) => setEmployeeConfirmPassword(e.target.value)}
                            placeholder="Repita a senha"
                            className="w-full px-4 py-3 bg-dark-input border border-dark-border rounded-xl text-center text-sm font-semibold tracking-[0.3em] focus:outline-none focus:border-blue-500 text-white placeholder-zinc-700 font-mono shadow-inner"
                          />
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={employeeLoading}
                        className="w-full py-3 font-bold rounded-xl text-xs text-white bg-blue-500 hover:bg-blue-600 active:scale-[0.98] transition-all shadow-lg shadow-blue-500/20 cursor-pointer disabled:opacity-50"
                      >
                        {employeeLoading ? 'Validando...' : employeeNeedsSetup ? 'Gravar Senha e Entrar' : 'Entrar na Portaria'}
                      </button>
                    </motion.div>
                  )}
                </form>

                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab('resident');
                      setEmployeeError('');
                    }}
                    className="text-xs text-zinc-500 hover:text-zinc-300 font-medium cursor-pointer"
                  >
                    Voltar para o Portal de Moradores
                  </button>
                </div>
              </div>
            ) : !employeeSession.photoDataUrl ? (
              <div className="w-full">
                <CameraCapture 
                  entityId={employeeSession.id}
                  personName={employeeSession.name}
                  personSubtitle="Porteiro(a)"
                  uploadUrl="/api/employees/upload-photo"
                  onCaptureCompleted={(data: any) => {
                    const empData = data.employee || data;
                    setEmployeeSession(empData);
                    fetchAllEmployees();
                  }}
                  onCancel={() => setEmployeeSession(null)}
                />
              </div>
            ) : (
              <EmployeePanel 
                employee={employeeSession} 
                onLogout={() => {
                  setEmployeeSession(null);
                  setActiveTab('resident');
                }}
              />
            )}
          </div>
        ) : (
          /* ADMIN DASHBOARD */
          <div className="w-full">
            <AdminDashboard
              user={adminUser}
              onLogin={handleAdminLogin}
              onLogout={handleAdminLogout}
              onBack={handleAdminBack}
            />
          </div>
        )}
      </main>

      {/* MINIMAL FOOTER DECORATION */}
      <footer className="border-t border-dark-border bg-dark-card text-center py-5 select-none pb-24">
        <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
          © {new Date().getFullYear()} Condomínio Portaria Segura • Powered by Google Drive API
        </p>
      </footer>

      {/* PERSISTENT BOTTOM NAVIGATION - ONLY FOR LOGGED IN RESIDENTS */}
      {activeTab === 'resident' && loggedInResident && (
        <BottomNav activeTab={residentView} onTabChange={setResidentView} />
      )}
    </div>
  );
}
