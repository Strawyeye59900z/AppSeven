/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { User, Home, Lock, Phone, Building2 } from 'lucide-react';
import { Resident } from '../types';

interface ResidentAuthProps {
  onLoginSuccess: (resident: Resident) => void;
  onAdminInitiate: () => void;
  onEmployeeInitiate: () => void;
}

export default function ResidentAuth({ onLoginSuccess, onAdminInitiate, onEmployeeInitiate }: ResidentAuthProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [apartment, setApartment] = useState('');
  const [block, setBlock] = useState('Único');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (isSignUp) {
      if (!name.trim() || !username.trim() || !apartment.trim() || !password.trim()) {
        setError('Nome, usuário, apartamento e senha são obrigatórios.');
        setLoading(false);
        return;
      }
      if (username.trim().includes(' ')) {
        setError('O nome de usuário não pode conter espaços.');
        setLoading(false);
        return;
      }
    } else {
      if (!username.trim() || !password.trim()) {
        setError('Usuário e senha são obrigatórios.');
        setLoading(false);
        return;
      }
    }

    try {
      const endpoint = isSignUp ? '/api/residents/signup' : '/api/residents/login';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          username: username.trim().toLowerCase(),
          apartment: apartment.trim(),
          block: block.trim() || 'Único',
          password,
          phone: phone.trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ocorreu um erro no servidor.');
      onLoginSuccess(data);
    } catch (err: any) {
      setError(err.message || 'Erro de conexão.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6 bg-[#020617]">
      <div className="w-full max-w-5xl flex flex-col lg:flex-row items-center justify-center lg:justify-between gap-8 lg:gap-12">
        {/* Left Side: Text and Building Logo */}
        <div className="hidden lg:flex flex-col gap-4 text-white">
          <div className="w-20 h-20 rounded-3xl bg-blue-600/20 backdrop-blur-md border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-2xl">
            <Building2 size={40} />
          </div>
          <h1 className="font-display text-5xl font-bold tracking-tight">
            Seven<br />Residence
          </h1>
        </div>

        {/* Right Side: Login Card */}
        <div id="resident-auth-card" className="w-full max-w-md bg-[#0f172a]/90 backdrop-blur-3xl border border-white/10 rounded-[32px] shadow-2xl p-8 lg:p-10 overflow-hidden text-zinc-100">
          <div className="text-center mb-10 flex flex-col items-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-white">
              {isSignUp ? 'Criar Conta' : 'Bem-vindo(a)!'}
            </h2>
            <p className="text-sm text-zinc-400 mt-2 font-sans max-w-xs">
              {isSignUp 
                ? 'Preencha os dados abaixo para se cadastrar no sistema.' 
                : 'Acesse sua conta para utilizar os serviços do condomínio.'}
            </p>
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 mb-6 bg-red-950/40 border border-red-900/50 text-red-400 rounded-2xl text-sm"
            >
              {error}
            </motion.div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-4">
              {isSignUp && (
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Nome Completo</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-blue-400/50"><User size={18} /></span>
                    <input type="text" value={name} onChange={e => setName(e.target.value)}
                      placeholder="Seu nome completo"
                      className="w-full pl-12 pr-4 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" required />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Usuário</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-blue-400/50"><User size={18} /></span>
                  <input id="resident-auth-username" type="text" value={username} onChange={e => setUsername(e.target.value)}
                    placeholder={isSignUp ? "Crie seu usuário (sem espaços)" : "Seu usuário"}
                    className="w-full pl-12 pr-4 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" required />
                </div>
              </div>

              {isSignUp && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Apartamento</label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-blue-400/50"><Home size={16} /></span>
                        <input type="text" value={apartment} onChange={e => setApartment(e.target.value)}
                          placeholder="Ex: 1301"
                          className="w-full pl-10 pr-3 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" required />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Bloco</label>
                      <input type="text" value={block} onChange={e => setBlock(e.target.value)}
                        placeholder="Único"
                        className="w-full px-4 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Telefone / WhatsApp</label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-blue-400/50"><Phone size={18} /></span>
                      <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                        placeholder="(00) 00000-0000"
                        className="w-full pl-12 pr-4 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" />
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-blue-300 uppercase tracking-widest block font-display">Senha</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-blue-400/50"><Lock size={18} /></span>
                  <input id="resident-auth-password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="Digite sua senha"
                    className="w-full pl-12 pr-4 py-3.5 bg-[#020617]/50 border border-white/5 rounded-2xl text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder-zinc-500" required />
                </div>
              </div>
            </div>

            {!isSignUp && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-400 hover:text-white transition-colors">
                  <input type="checkbox" className="rounded border-zinc-700 bg-zinc-800 text-blue-600 focus:ring-blue-500" />
                  Lembrar meu acesso
                </label>
              </div>
            )}

            <button
              id="resident-auth-submit-btn"
              type="submit"
              disabled={loading}
              className="w-full py-4 px-4 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-semibold rounded-2xl text-sm transition-all cursor-pointer shadow-lg shadow-blue-500/20 active:scale-[0.98] disabled:opacity-50 font-display"
            >
              {loading ? 'Processando...' : (isSignUp ? 'Criar minha conta' : 'Entrar na Conta')}
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError('');
              }}
              className="w-full text-xs font-semibold text-zinc-400 hover:text-white transition-colors py-2"
            >
              {isSignUp ? 'Já tem uma conta? Acesse aqui' : 'Não tem conta? Cadastre-se aqui'}
            </button>
          </form>

          <div className="mt-8 pt-8 border-t border-white/5 flex flex-col items-center gap-6">
            <p className="text-xs text-zinc-500 font-medium">OU</p>
            
            <div className="grid grid-cols-2 gap-4 w-full">
              <button
                id="resident-goto-employee-btn"
                type="button"
                onClick={onEmployeeInitiate}
                className="text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer font-display flex items-center justify-center gap-2 bg-white/5 py-4 rounded-xl border border-white/10 hover:border-blue-500/30 hover:bg-white/10"
              >
                <Building2 size={16} /> Sou Funcionário
              </button>

              <button
                id="resident-goto-admin-btn"
                type="button"
                onClick={onAdminInitiate}
                className="text-xs font-semibold text-zinc-300 hover:text-white transition-all cursor-pointer font-display flex items-center justify-center gap-2 bg-white/5 py-4 rounded-xl border border-white/10 hover:border-blue-500/30 hover:bg-white/10"
              >
                <Lock size={16} /> Administração
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
