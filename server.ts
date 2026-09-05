/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import PocketBase from 'pocketbase';
import { waClient } from './src/lib/whatsappBaileys';
import DigestFetch from 'digest-fetch';

// Interface representation on the server
interface ServerResident {
  id: string;
  name: string;
  apartment: string;
  block: string;
  password?: string;
  phone?: string;
  whatsapp?: string;
  photoDataUrl?: string;
  registeredAt: string;
  syncStatus: 'pending' | 'synced' | 'failed';
  syncError?: string;
  driveFileId?: string;
  deviceRegistered?: boolean;
  hikvisionSyncStatus?: Record<string, HikvisionFaceSyncStatus>;
  firstLogin: boolean;
}

interface ServerReservation {
  id: string;
  apartment: string;
  block: string;
  residentId: string;
  residentName: string;
  amenity: 'quadra' | 'churrasqueira' | 'salao';
  date: string; // YYYY-MM-DD
  timeSlot: string;
  notes?: string;
  createdAt: string;
}

interface ServerWhatsAppConfig {
  enabled: boolean;
  templateText: string;
}

interface ServerHikvisionDevice {
  id: string;
  name: string;
  deviceIp: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
  lastSync?: string;
  syncStatus: 'idle' | 'syncing' | 'error';
}

interface HikvisionFaceSyncStatus {
  status: 'synced' | 'pending' | 'failed';
  syncedAt?: string;
  error?: string;
}

interface ServerEmployee {
  id: string;
  name: string;
  username: string;
  role?: string;
  active: boolean;
  firstLogin: boolean;
}

interface ServerPackage {
  id: string;
  apartment: string;
  block: string;
  recipientName: string;
  description: string;
  receivedAt: string;
  status: 'pending' | 'delivered';
  deliveredAt?: string;
  deliveredTo?: string;
  receivedBy?: string;
  carrier?: string;
  employeeId?: string;
}

// ---- PocketBase init ----

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090';
const POCKETBASE_ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL || '';
const POCKETBASE_ADMIN_PASSWORD = process.env.POCKETBASE_ADMIN_PASSWORD || '';

const pbAdmin = new PocketBase(POCKETBASE_URL);
// Instância sem autenticação para operações de auth de usuários (login de moradores/funcionários)
const pbPublic = new PocketBase(POCKETBASE_URL);

async function initPocketBase() {
  console.log('Tentando logar com a função certa (_superusers)...');
  try {
    await pbAdmin.collection('_superusers').authWithPassword(POCKETBASE_ADMIN_EMAIL, POCKETBASE_ADMIN_PASSWORD, {
      autoRefreshThreshold: 30 * 60
    });
    console.log('PocketBase admin authenticated successfully.');

    // Renovar token a cada 10 minutos para nunca expirar
    setInterval(async () => {
      try {
        await pbAdmin.collection('_superusers').authWithPassword(POCKETBASE_ADMIN_EMAIL, POCKETBASE_ADMIN_PASSWORD);
      } catch (e) {
        console.error('[PocketBase] Falha ao renovar token:', e);
      }
    }, 10 * 60 * 1000);

  } catch (err: any) {
    console.error('⚠️ PocketBase admin auth failed:', err?.message || err);
    console.log('Dica: Certifique-se de ter acessado http://<seu-ip>:8090/_/ no navegador para criar a conta de superusuário inicial.');
    // Removido o process.exit(1) para evitar o loop infinito no PM2 se o banco estiver vazio
  }
}

// ---- PocketBase helpers ----

function residentPhotoDataUrl(rec: any): string | undefined {
  // Sempre devolve a URL do proxy Express (/api/residents/photo/:id) para que o browser
  // nunca precise acessar diretamente o PocketBase (127.0.0.1 — inacessível externamente).
  if (rec.photo) {
    return `/api/residents/photo/${rec.id}`;
  }
  if (rec.photoDataUrl) return rec.photoDataUrl;
  return undefined;
}

async function pbResidents() {
  const records = await pbAdmin.collection('residents').getFullList({ sort: 'apartment' });
  return records.map(r => {
    const rec = r as any;
    rec.photoDataUrl = residentPhotoDataUrl(rec);
    return rec;
  }) as unknown as ServerResident[];
}

async function pbEmployees() {
  const records = await pbAdmin.collection('employees').getFullList({ sort: 'name' });
  return records as unknown as ServerEmployee[];
}

async function pbReservations() {
  const records = await pbAdmin.collection('reservations').getFullList({ sort: '-createdAt' });
  return records as unknown as ServerReservation[];
}

async function pbPackages() {
  const records = await pbAdmin.collection('packages').getFullList({ sort: '-receivedAt' });
  return records as unknown as ServerPackage[];
}

async function pbSetting(key: string): Promise<any | null> {
  try {
    const record = await pbAdmin.collection('settings').getFirstListItem(`key="${key}"`);
    return record.value;
  } catch {
    return null;
  }
}

async function pbSetSetting(key: string, value: any): Promise<void> {
  try {
    const existing = await pbAdmin.collection('settings').getFirstListItem(`key="${key}"`);
    await pbAdmin.collection('settings').update(existing.id, { value });
  } catch {
    await pbAdmin.collection('settings').create({ key, value });
  }
}

// ================= WHATSAPP VIA BAILEYS =================

const AMENITY_NAMES_SERVER: Record<string, string> = {
  quadra: 'Quadra de Esportes',
  churrasqueira: 'Churrasqueira Coberta',
  salao: 'Salão de Festas',
};

function fillWhatsAppTemplate(template: string, resident: ServerResident, reservation: ServerReservation): string {
  const dateFormatted = new Date(reservation.date + 'T00:00:00').toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const amenityName = AMENITY_NAMES_SERVER[reservation.amenity] || reservation.amenity;
  const blockStr = reservation.block && reservation.block !== 'Único' ? ` / Bloco ${reservation.block}` : '';

  return template
    .replace(/\{morador\}/g, resident.name)
    .replace(/\{local\}/g, amenityName)
    .replace(/\{data\}/g, dateFormatted)
    .replace(/\{hora\}/g, reservation.timeSlot)
    .replace(/\{apartamento\}/g, reservation.apartment)
    .replace(/\{bloco\}/g, reservation.block || 'Único')
    .replace(/\{unidade\}/g, `Apto ${reservation.apartment}${blockStr}`);
}

async function sendWhatsAppNotification(resident: ServerResident, reservation: ServerReservation, config: ServerWhatsAppConfig): Promise<void> {
  if (!config.enabled || !resident.phone) return;

  const phone = resident.phone.replace(/\D/g, '');
  // Garante prefixo 55 (Brasil) sem duplicar — números com DDD têm 10-11 dígitos
  const normalizedPhone = phone.startsWith('55') ? phone : '55' + phone;
  const message = fillWhatsAppTemplate(config.templateText, resident, reservation);

  try {
    await waClient.sendText(normalizedPhone, message);
    console.log(`WhatsApp notification sent to ${normalizedPhone} for reservation ${reservation.id}`);
  } catch (err: any) {
    console.error('WhatsApp notification error:', err.message);
  }
}

// ================= HIKVISION FACE SYNC =================

function basicAuthHik(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function hikFetch(username: string, password: string) {
  return new DigestFetch(username, password, { algorithm: 'MD5' });
}

// Garante que exista uma FaceLib (FDID) do tipo blackFD no terminal e devolve o FDID.
// O DS-K1T342MWX exige um FDID válido antes de gravar faces — não aceita "blackFD" como lib.
async function ensureFaceLib(base: string, client: any): Promise<string> {
  // 1. Tenta listar libraries já existentes
  const listRes = await client.fetch(`${base}/ISAPI/Intelligent/FDLib?format=json`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (listRes.ok) {
    try {
      const data = await listRes.json();
      const libs = data?.FPLibListInfo?.FPLibInfo || data?.FDLibInfoList || [];
      const arr = Array.isArray(libs) ? libs : [libs];
      const existing = arr.find((l: any) => (l.faceLibType || l.FPLibType) === 'blackFD');
      if (existing && (existing.FDID || existing.id)) {
        return String(existing.FDID || existing.id);
      }
    } catch { /* segue para criação */ }
  }

  // 2. Cria a face library
  const createRes = await client.fetch(`${base}/ISAPI/Intelligent/FDLib?format=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      FPLibInfo: { faceLibType: 'blackFD', name: 'CondominioFaces', customInfo: 'AppMHVL' },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (createRes.ok) {
    try {
      const data = await createRes.json();
      if (data?.FDID) return String(data.FDID);
    } catch { /* fallback abaixo */ }
  }
  // Fallback: muitos firmwares aceitam FDID "1" como a library padrão.
  return '1';
}

async function syncFaceToHikvisionServer(resident: ServerResident & { photo?: string; collectionId?: string }, device: ServerHikvisionDevice): Promise<HikvisionFaceSyncStatus> {
  let photoBuffer: Buffer | null = null;

  // Prioridade: campo binário "photo" no PocketBase → URL interna (acessível no servidor)
  if ((resident as any).photo) {
    const internalUrl = `${POCKETBASE_URL}/api/files/${(resident as any).collectionId}/${resident.id}/${(resident as any).photo}`;
    try {
      const photoRes = await fetch(internalUrl, { signal: AbortSignal.timeout(10000) });
      if (photoRes.ok) photoBuffer = Buffer.from(await photoRes.arrayBuffer());
    } catch { /* fallback para photoDataUrl */ }
  }

  if (!photoBuffer && resident.photoDataUrl) {
    if (resident.photoDataUrl.startsWith('http')) {
      // URL absoluta (legado ou outro caso)
      try {
        const photoRes = await fetch(resident.photoDataUrl, { signal: AbortSignal.timeout(10000) });
        if (photoRes.ok) photoBuffer = Buffer.from(await photoRes.arrayBuffer());
      } catch { /* fallback */ }
    } else if (resident.photoDataUrl.startsWith('data:')) {
      // Base64 legado
      const match = resident.photoDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) photoBuffer = Buffer.from(match[2], 'base64');
    }
    // URLs relativas (/api/residents/photo/:id) são ignoradas aqui — já foram tratadas acima via campo photo
  }

  if (!photoBuffer) {
    return { status: 'failed', error: 'Morador sem foto cadastrada' };
  }

  const base = `http://${device.deviceIp}:${device.port}`;
  const client = hikFetch(device.username, device.password);
  // employeeNo precisa ser numérico/curto no DS-K1T342MWX; derivamos um número estável do id.
  const personId = (parseInt(resident.id.replace(/\D/g, '').slice(0, 9), 10) || Math.abs(hashCode(resident.id))).toString();

  try {
    // 1. Criar/atualizar pessoa no terminal com permissão de acesso à porta
    const userInfo = {
      employeeNo: personId,
      name: resident.name.substring(0, 32),
      userType: 'normal',
      Valid: { enable: true, beginTime: '2000-01-01T00:00:00', endTime: '2037-12-31T23:59:59', timeType: 'local' },
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    };

    const personRes = await client.fetch(`${base}/ISAPI/AccessControl/UserInfo/Record?format=json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ UserInfo: userInfo }),
      signal: AbortSignal.timeout(15000),
    });

    if (!personRes.ok) {
      const errText = await personRes.text();
      const alreadyExists = /statusCode["\s:]*6\b/.test(errText) || /already exist/i.test(errText);
      if (alreadyExists) {
        // Pessoa já existe — atualiza UserInfo para garantir que RightPlan e doorRight estejam corretos.
        const modRes = await client.fetch(`${base}/ISAPI/AccessControl/UserInfo/Modify?format=json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ UserInfo: userInfo }),
          signal: AbortSignal.timeout(15000),
        });
        if (!modRes.ok) {
          const modErr = await modRes.text();
          // Alguns firmwares não têm /Modify — ignora o erro e segue para a face
          console.warn(`[Hikvision] Modify falhou (${modRes.status}): ${modErr.substring(0, 120)} — prosseguindo para face`);
        }
      } else {
        return { status: 'failed', error: `Erro ao criar pessoa HTTP ${personRes.status}: ${errText.substring(0, 120)}` };
      }
    }

    // 2. Garantir face library e enviar a foto via multipart/form-data
    const fdid = await ensureFaceLib(base, client);

    const faceDataRecord = {
      faceLibType: 'blackFD',
      FDID: fdid,
      FPID: personId, // vincula a face ao employeeNo
    };

    const form = new FormData();
    form.append('FaceDataRecord', JSON.stringify(faceDataRecord));
    form.append('img', new Blob([photoBuffer], { type: 'image/jpeg' }), `${personId}.jpg`);

    const faceRes = await client.fetch(`${base}/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json`, {
      method: 'POST',
      body: form, // o Blob/FormData define o Content-Type com boundary automaticamente
      signal: AbortSignal.timeout(20000),
    });

    if (!faceRes.ok) {
      const errText = await faceRes.text();
      return { status: 'failed', error: `Erro foto HTTP ${faceRes.status}: ${errText.substring(0, 120)}` };
    }

    return { status: 'synced', syncedAt: new Date().toISOString() };
  } catch (err: any) {
    const errMsg = err.name === 'TimeoutError' ? 'Timeout na sincronização' : (err.message || 'Erro desconhecido');
    return { status: 'failed', error: errMsg };
  }
}

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

async function syncResidentToAllHikvisionDevices(residentId: string): Promise<void> {
  const devices = ((await pbSetting('hikvision_devices')) || []).filter((d: ServerHikvisionDevice) => d.enabled);
  if (devices.length === 0) return;

  const resident = await pbAdmin.collection('residents').getOne(residentId) as unknown as ServerResident & { photo?: string; collectionId?: string };
  if (!resident || (!(resident as any).photo && !resident.photoDataUrl)) return;

  const rawStatus = (resident as any).hikvisionSyncStatus;
  const hikvisionSyncStatus: Record<string, HikvisionFaceSyncStatus> =
    typeof rawStatus === 'string' ? (JSON.parse(rawStatus) || {}) : (rawStatus || {});
  for (const device of devices) {
    const result = await syncFaceToHikvisionServer(resident, device);
    hikvisionSyncStatus[device.id] = result;
    console.log(`Hikvision sync [${device.name}] resident ${resident.name}: ${result.status}`);
  }
  await pbAdmin.collection('residents').update(residentId, { hikvisionSyncStatus: JSON.stringify(hikvisionSyncStatus) });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Authenticate with PocketBase before serving any routes
  await initPocketBase();

  // Support up to 5MB payloads to handle base64 face captures comfortably
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  // ================= API ENDPOINTS =================

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Get all residents (excluding passwords)
  app.get('/api/residents', async (req, res) => {
    try {
      const residents = await pbResidents();
      const publicResidents = residents.map(({ password, ...rest }) => rest);
      res.json(publicResidents);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resident Login — username digitado → email = username@mhvl.local para authWithPassword
  app.post('/api/residents/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }
    const cleanUsername = username.trim().toLowerCase().replace(/\s+/g, '');
    const loginEmail = `${cleanUsername}@mhvl.local`;
    try {
      let authRecord: any;
      try {
        const authResult = await pbPublic.collection('residents').authWithPassword(loginEmail, password);
        authRecord = authResult.record;
      } catch {
        return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
      }
      const resident = await pbAdmin.collection('residents').getOne(authRecord.id) as unknown as ServerResident;
      const rec = resident as any;
      rec.photoDataUrl = residentPhotoDataUrl(rec);
      const { password: _, ...safeResident } = rec;
      res.json(safeResident);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resident Signup — username escolhido pelo morador (salvo no campo texto + usado como base do email)
  app.post('/api/residents/signup', async (req, res) => {
    const { name, username, apartment, password, phone } = req.body;
    const block = req.body.block || 'Único';
    if (!name || !username || !apartment || !password) {
      return res.status(400).json({ error: 'Nome, usuário, apartamento e senha são obrigatórios.' });
    }
    const cleanUsername = username.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleanUsername) return res.status(400).json({ error: 'Usuário inválido.' });
    const loginEmail = `${cleanUsername}@mhvl.local`;
    try {
      // Verificar se email (username) já existe
      const existingUser = await pbAdmin.collection('residents').getFirstListItem(
        `email="${loginEmail}"`
      ).catch(() => null);
      if (existingUser) {
        return res.status(400).json({ error: 'Este nome de usuário já está em uso. Escolha outro.' });
      }
      const created = await pbAdmin.collection('residents').create({
        username: cleanUsername,
        email: loginEmail,
        password,
        passwordConfirm: password,
        name: name.trim(),
        apartment: apartment.trim(),
        block: block.trim() || 'Único',
        phone: phone ? phone.trim() : '',
        registeredAt: new Date().toISOString(),
        syncStatus: 'pending',
        firstLogin: false,
      });
      res.status(201).json(created);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get all family members of an apartment
  app.get('/api/residents/apartment-members', async (req, res) => {
    const { apartment } = req.query;
    const block = (req.query.block as string) || 'Único';
    if (!apartment) return res.status(400).json({ error: 'Apartamento é obrigatório.' });
    try {
      const members = await pbAdmin.collection('residents').getFullList({
        filter: `apartment="${(apartment as string).trim()}" && block="${block.trim()}"`,
      });
      res.json(members);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add a family member to an apartment
  app.post('/api/residents/add-member', async (req, res) => {
    const { name, apartment, phone } = req.body;
    const block = req.body.block || 'Único';
    if (!name || !apartment) return res.status(400).json({ error: 'Nome e apartamento são obrigatórios.' });
    try {
      const exists = await pbAdmin.collection('residents').getFirstListItem(
        `apartment="${apartment.trim()}" && block="${block.trim()}" && name="${name.trim()}"`
      ).catch(() => null);
      if (exists) return res.status(400).json({ error: 'Este familiar já está cadastrado neste apartamento.' });
      const memberPassword = Math.random().toString(36).slice(2) + 'Aa1!';
      const memberUsername = `apt${apartment.trim()}_bloco${block.trim().replace(/\s+/g, '')}_${Date.now()}`;
      const newMember = await pbAdmin.collection('residents').create({
        username: memberUsername,
        email: `${memberUsername}@mhvl.local`,
        password: memberPassword,
        passwordConfirm: memberPassword,
        name: name.trim(),
        apartment: apartment.trim(),
        block: block.trim(),
        phone: phone ? phone.trim() : '',
        registeredAt: new Date().toISOString(),
        syncStatus: 'pending',
        firstLogin: false,
      });
      res.status(201).json(newMember);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload or update facial photo
  app.post('/api/residents/upload-face', async (req, res) => {
    const { id, photoDataUrl } = req.body;
    if (!id || !photoDataUrl) return res.status(400).json({ error: 'ID do morador e dados da foto são obrigatórios.' });
    const match = photoDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de foto inválido.' });
    const photoBuffer = Buffer.from(match[2], 'base64');
    if (photoBuffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'A imagem excede o tamanho limite de 5MB.' });
    try {
      const residents = await pbResidents();
      const resident = residents.find(r => r.id === id);
      if (!resident) return res.status(404).json({ error: 'Morador não encontrado.' });
      const enabledDevices = ((await pbSetting('hikvision_devices')) || []).filter((d: any) => d.enabled);
      const rawHikStatus = (resident as any).hikvisionSyncStatus;
      const hikvisionSyncStatus: Record<string, any> =
        typeof rawHikStatus === 'string' ? (JSON.parse(rawHikStatus) || {}) : (rawHikStatus || {});
      for (const device of enabledDevices) {
        hikvisionSyncStatus[device.id] = { status: 'pending' };
      }
      // Salva como arquivo binário no PocketBase (campo "photo") em vez de base64 em texto.
      // Isso evita o limite de 5000 chars do campo text.
      const form = new FormData();
      form.append('photo', new Blob([photoBuffer], { type: match[1] }), `${id}.jpg`);
      form.append('syncStatus', 'pending');
      form.append('deviceRegistered', 'false');
      form.append('hikvisionSyncStatus', JSON.stringify(hikvisionSyncStatus));
      const updated = await pbAdmin.collection('residents').update(id, form);
      // Devolve URL do proxy Express — o browser nunca acessa o PocketBase diretamente
      const updatedRec = updated as any;
      const publicPhotoUrl = updatedRec.photo
        ? `/api/residents/photo/${updatedRec.id}`
        : photoDataUrl;
      res.json({ ...updatedRec, photoDataUrl: publicPhotoUrl });
      if (enabledDevices.length > 0) {
        syncResidentToAllHikvisionDevices(id).catch(err => console.error('Hikvision background sync error:', err));
      }
    } catch (err: any) {
      const msg = err?.response?.message || err?.message || JSON.stringify(err);
      console.error('[upload-face] PocketBase error:', JSON.stringify(err?.response?.data || err));
      res.status(500).json({ error: msg });
    }
  });

  // Get photo of a resident — serves as proxy so the browser never needs to reach
  // PocketBase directly (which is on 127.0.0.1 and inaccessible from outside the LXC).
  app.get('/api/residents/photo/:id', async (req, res) => {
    try {
      const resident = await pbAdmin.collection('residents').getOne(req.params.id) as unknown as ServerResident & { photo?: string; collectionId?: string };
      if (!resident) return res.status(404).send('Photo not found');
      if ((resident as any).photo) {
        // Proxy: baixa internamente e devolve ao browser sem expor a URL interna
        const internalUrl = `${POCKETBASE_URL}/api/files/${(resident as any).collectionId}/${resident.id}/${(resident as any).photo}`;
        const photoRes = await fetch(internalUrl, { signal: AbortSignal.timeout(10000) });
        if (!photoRes.ok) return res.status(404).send('Photo not found');
        res.setHeader('Content-Type', photoRes.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(Buffer.from(await photoRes.arrayBuffer()));
      }
      if (resident.photoDataUrl) {
        const matches = resident.photoDataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return res.status(400).send('Invalid photo format');
        res.contentType(matches[1]);
        return res.send(Buffer.from(matches[2], 'base64'));
      }
      res.status(404).send('Photo not found');
    } catch {
      res.status(404).send('Photo not found');
    }
  });

  // Update sync status on the server
  app.post('/api/residents/update-sync', async (req, res) => {
    const { id, syncStatus, driveFileId, syncError } = req.body;
    if (!id || !syncStatus) return res.status(400).json({ error: 'ID e status são obrigatórios.' });
    try {
      const updateData: any = { syncStatus };
      if (driveFileId) updateData.driveFileId = driveFileId;
      if (syncError) updateData.syncError = syncError; else updateData.syncError = '';
      await pbAdmin.collection('residents').update(id, updateData);
      res.json({ message: 'Status atualizado com sucesso.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update physical device registration status
  app.post('/api/residents/update-device-registered', async (req, res) => {
    const { id, deviceRegistered } = req.body;
    if (!id) return res.status(400).json({ error: 'ID do morador é obrigatório.' });
    try {
      await pbAdmin.collection('residents').update(id, { deviceRegistered: !!deviceRegistered });
      res.json({ message: 'Status atualizado com sucesso.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reset resident password + optionally set username (called by Admin)
  app.post('/api/residents/reset-password', async (req, res) => {
    const { id, newPassword, newUsername } = req.body;
    if (!id || !newPassword || newPassword.length < 4) return res.status(400).json({ error: 'ID e nova senha (mínimo 4 caracteres) são obrigatórios.' });
    try {
      const updateData: any = { password: newPassword, passwordConfirm: newPassword };
      if (newUsername) {
        const cleanUsername = newUsername.trim().toLowerCase().replace(/\s+/g, '');
        updateData.username = cleanUsername;
        updateData.email = `${cleanUsername}@mhvl.local`; // email é a identidade de auth
      }
      await pbAdmin.collection('residents').update(id, updateData);
      res.json({ success: true, message: 'Credenciais do morador redefinidas com sucesso.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Migrate old residents: fill empty username from apt+block pattern
  app.post('/api/residents/migrate-usernames', async (req, res) => {
    try {
      const records = await pbAdmin.collection('residents').getFullList();
      const results: string[] = [];
      for (const rec of records) {
        const r = rec as any;
        if (!r.username) {
          const newUsername = `apt${r.apartment}_bloco${(r.block || 'Único').replace(/\s+/g, '')}`;
          const cleanUsername = newUsername.toLowerCase();
          await pbAdmin.collection('residents').update(r.id, {
            username: cleanUsername,
            email: `${cleanUsername}@mhvl.local`,
          });
          results.push(`${r.name} → username: ${cleanUsername}`);
        }
      }
      res.json({ migrated: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete resident
  app.post('/api/residents/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID do morador é obrigatório.' });
    try {
      await pbAdmin.collection('residents').delete(id);
      res.json({ success: true, message: 'Morador removido com sucesso.' });
    } catch (err: any) {
      res.status(404).json({ error: 'Morador não encontrado.' });
    }
  });

  // ================= RESERVATION ENDPOINTS =================

  // Get all reservations
  app.get('/api/reservations', async (req, res) => {
    try {
      res.json(await pbReservations());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new reservation with collision validation
  app.post('/api/reservations', async (req, res) => {
    const { apartment, residentId, residentName, amenity, date, timeSlot, notes } = req.body;
    const block = req.body.block || 'Único';
    if (!apartment || !residentId || !residentName || !amenity || !date || !timeSlot) {
      return res.status(400).json({ error: 'Todos os campos de reserva são obrigatórios.' });
    }
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      if (date < todayStr) return res.status(400).json({ error: 'Não é possível reservar datas passadas.' });
      const maxLimitDate = new Date();
      maxLimitDate.setMonth(maxLimitDate.getMonth() + 3);
      if (date > maxLimitDate.toISOString().split('T')[0]) {
        return res.status(400).json({ error: 'As reservas só podem ser feitas com no máximo 3 meses de antecedência.' });
      }
      const reservations = await pbReservations();
      if (amenity === 'quadra' && residentId !== 'admin') {
        const count = reservations.filter(r =>
          r.amenity === 'quadra' && r.date === date &&
          r.apartment.toLowerCase() === apartment.trim().toLowerCase() &&
          (r.block || 'Único').toLowerCase() === block.trim().toLowerCase()
        ).length;
        if (count >= 4) return res.status(400).json({ error: 'Reserva da quadra limitada a 4 períodos por dia por apartamento.' });
      }
      const isBooked = reservations.some(r => r.amenity === amenity && r.date === date && r.timeSlot === timeSlot);
      if (isBooked) return res.status(400).json({ error: 'Este horário já está reservado por outro morador.' });
      const newReservation = await pbAdmin.collection('reservations').create({
        apartment: apartment.trim(), block: block.trim(), residentId, residentName: residentName.trim(),
        amenity, date, timeSlot, notes: notes ? notes.trim() : '', createdAt: new Date().toISOString(),
      });
      // WhatsApp notification
      const whatsappConfig = await pbSetting('whatsapp_config') as ServerWhatsAppConfig | null;
      if (whatsappConfig?.enabled && residentId !== 'admin') {
        const residents = await pbResidents();
        const resident = residents.find(r => r.id === residentId);
        if (resident?.phone) {
          sendWhatsAppNotification(resident, newReservation as unknown as ServerReservation, whatsappConfig).catch(err =>
            console.error('WhatsApp notification error:', err)
          );
        }
      }
      res.status(201).json(newReservation);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel/Delete reservation with authorization check
  app.post('/api/reservations/delete', async (req, res) => {
    const { id, requesterApartment, requesterBlock, isAdmin } = req.body;
    if (!id) return res.status(400).json({ error: 'ID da reserva é obrigatório.' });
    try {
      const resv = await pbAdmin.collection('reservations').getOne(id) as unknown as ServerReservation;
      const isAuthorized = isAdmin || (requesterApartment &&
        resv.apartment.toLowerCase() === requesterApartment.trim().toLowerCase() &&
        (resv.block || 'Único').toLowerCase() === (requesterBlock || 'Único').trim().toLowerCase());
      if (!isAuthorized) return res.status(403).json({ error: 'Acesso negado.' });
      await pbAdmin.collection('reservations').delete(id);
      res.json({ success: true, message: 'Reserva cancelada com sucesso.' });
    } catch (err: any) {
      res.status(404).json({ error: 'Reserva não encontrada.' });
    }
  });

  // Edit/Update reservation with authorization check
  app.post('/api/reservations/update', async (req, res) => {
    const { id, notes, requesterApartment, requesterBlock, isAdmin } = req.body;
    if (!id) return res.status(400).json({ error: 'ID da reserva é obrigatório.' });
    try {
      const resv = await pbAdmin.collection('reservations').getOne(id) as unknown as ServerReservation;
      const isAuthorized = isAdmin || (requesterApartment &&
        resv.apartment.toLowerCase() === requesterApartment.trim().toLowerCase() &&
        (resv.block || 'Único').toLowerCase() === (requesterBlock || 'Único').trim().toLowerCase());
      if (!isAuthorized) return res.status(403).json({ error: 'Acesso negado.' });
      const updated = await pbAdmin.collection('reservations').update(id, { notes: notes ? notes.trim() : '' });
      res.json({ success: true, reservation: updated });
    } catch (err: any) {
      res.status(404).json({ error: 'Reserva não encontrada.' });
    }
  });

  // ================= ADMIN & DRIVE SETTINGS =================

  // Get dynamic admin email list
  app.get('/api/admins', async (req, res) => {
    try {
      const admins = await pbSetting('authorized_admins') || ['gabriel.nunez.costa@gmail.com'];
      res.json(admins);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add dynamic admin email
  app.post('/api/admins/add', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido.' });
    const cleanEmail = email.toLowerCase().trim();
    try {
      const admins: string[] = await pbSetting('authorized_admins') || ['gabriel.nunez.costa@gmail.com'];
      if (admins.includes(cleanEmail)) return res.status(400).json({ error: 'E-mail já possui acesso.' });
      admins.push(cleanEmail);
      await pbSetSetting('authorized_admins', admins);
      res.json({ success: true, authorizedAdmins: admins });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete dynamic admin email
  app.post('/api/admins/delete', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail é obrigatório.' });
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'gabriel.nunez.costa@gmail.com') {
      return res.status(400).json({ error: 'Não é possível remover o administrador principal.' });
    }
    try {
      const admins: string[] = await pbSetting('authorized_admins') || [];
      const index = admins.indexOf(cleanEmail);
      if (index === -1) return res.status(404).json({ error: 'Administrador não encontrado.' });
      admins.splice(index, 1);
      await pbSetSetting('authorized_admins', admins);
      res.json({ success: true, authorizedAdmins: admins });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get default shared Drive configurations
  app.get('/api/drive-config', async (req, res) => {
    try {
      res.json(await pbSetting('drive_config') || {});
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Store default shared Drive configurations
  app.post('/api/drive-config', async (req, res) => {
    const { accessToken, folderId, email, expiresAt } = req.body;
    try {
      await pbSetSetting('drive_config', {
        sharedAccessToken: accessToken || '',
        sharedFolderId: folderId || '',
        sharedAdminEmail: email || '',
        tokenExpiresAt: expiresAt || '',
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ================= ADMIN CREDENTIALS & EMPLOYEES =================

  // Check admin email status
  app.post('/api/admins/check-status', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido.' });
    const cleanEmail = email.toLowerCase().trim();
    try {
      const admins: string[] = await pbSetting('authorized_admins') || [];
      if (!admins.includes(cleanEmail)) return res.json({ authorized: false, error: 'E-mail não possui privilégios de administrador.' });
      const passwords: Record<string, string> = await pbSetting('admin_passwords') || {};
      res.json({ authorized: true, needsSetup: !passwords[cleanEmail] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Setup admin first-access password
  app.post('/api/admins/setup-password', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password || password.length < 4) return res.status(400).json({ error: 'E-mail e senha (mínimo 4 caracteres) são obrigatórios.' });
    const cleanEmail = email.toLowerCase().trim();
    try {
      const admins: string[] = await pbSetting('authorized_admins') || [];
      if (!admins.includes(cleanEmail)) return res.status(403).json({ error: 'E-mail não autorizado.' });
      const passwords: Record<string, string> = await pbSetting('admin_passwords') || {};
      passwords[cleanEmail] = password;
      await pbSetSetting('admin_passwords', passwords);
      res.json({ success: true, message: 'Senha cadastrada com sucesso!' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Local Admin Login
  app.post('/api/admins/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    const cleanEmail = email.toLowerCase().trim();
    try {
      const admins: string[] = await pbSetting('authorized_admins') || [];
      if (!admins.includes(cleanEmail)) return res.status(403).json({ error: 'E-mail não cadastrado como administrador.' });
      const passwords: Record<string, string> = await pbSetting('admin_passwords') || {};
      if (!passwords[cleanEmail] || passwords[cleanEmail] !== password) return res.status(401).json({ error: 'Senha incorreta.' });
      res.json({ success: true, user: { email: cleanEmail, displayName: cleanEmail.split('@')[0], isLocalAdmin: true } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee Login
  app.post('/api/employees/login', async (req, res) => {
    const { employeeId, password } = req.body;
    if (!employeeId || !password) return res.status(400).json({ error: 'Funcionário e senha são obrigatórios.' });
    try {
      const employee = await pbAdmin.collection('employees').getOne(employeeId) as unknown as ServerEmployee;
      if (!employee) return res.status(404).json({ error: 'Funcionário não encontrado.' });
      if (employee.firstLogin) {
        return res.status(403).json({ error: 'Este é seu primeiro acesso. Sua senha será definida agora.', needsSetup: true });
      }
      try {
        // Usa email como identidade (username pode estar vazio em registros antigos)
        const empEmail = (employee as any).email || `${employee.username}@mhvl.local`;
        await pbPublic.collection('employees').authWithPassword(empEmail, password);
      } catch {
        return res.status(401).json({ error: 'Senha incorreta.' });
      }
      res.json({ success: true, employee: { id: employee.id, name: employee.name } });
    } catch (err: any) {
      res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
  });

  // Update Shared Concierge Password (Admin)
  app.post('/api/concierge/password', async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Senha é obrigatória.' });
    try {
      await pbSetSetting('concierge_password', password);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check employee status
  app.post('/api/employees/check-status', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID é obrigatório.' });
    try {
      const employee = await pbAdmin.collection('employees').getOne(id) as unknown as ServerEmployee;
      res.json({ authorized: true, needsSetup: employee.firstLogin });
    } catch {
      res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
  });

  // Setup employee password
  app.post('/api/employees/setup-password', async (req, res) => {
    const { employeeId, password } = req.body;
    if (!employeeId || !password) return res.status(400).json({ error: 'ID e Senha são obrigatórios.' });
    try {
      await pbAdmin.collection('employees').update(employeeId, { password, passwordConfirm: password, firstLogin: false });
      res.json({ success: true, message: 'Senha definida com sucesso!' });
    } catch (err: any) {
      res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
  });

  // Get all employees
  app.get('/api/employees', async (req, res) => {
    try {
      res.json(await pbEmployees());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create standard employee (called by Admins)
  app.post('/api/employees', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório.' });
    try {
      const tempPassword = Math.random().toString(36).slice(2, 10) + 'Aa1!';
      const ts = Date.now();
      const username = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') + '_' + ts;
      const newEmployee = await pbAdmin.collection('employees').create({
        username,
        email: `${username}@mhvl.local`,
        password: tempPassword,
        passwordConfirm: tempPassword,
        name: name.trim(),
        role: 'porteiro',
        active: true,
        firstLogin: true,
      });
      res.status(201).json(newEmployee);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reset employee password (called by Admin)
  app.post('/api/employees/reset-password', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID é obrigatório.' });
    try {
      const tempPassword = Math.random().toString(36).slice(2, 10) + 'Aa1!';
      await pbAdmin.collection('employees').update(id, { password: tempPassword, passwordConfirm: tempPassword, firstLogin: true });
      res.json({ success: true });
    } catch (err: any) {
      res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
  });

  // Get photo of an employee — proxy para não expor URL interna do PocketBase
  app.get('/api/employees/photo/:id', async (req, res) => {
    try {
      const employee = await pbAdmin.collection('employees').getOne(req.params.id) as any;
      if (employee?.photo) {
        const internalUrl = `${POCKETBASE_URL}/api/files/${employee.collectionId}/${employee.id}/${employee.photo}`;
        const photoRes = await fetch(internalUrl, { signal: AbortSignal.timeout(10000) });
        if (!photoRes.ok) return res.status(404).send('Photo not found');
        res.setHeader('Content-Type', photoRes.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(Buffer.from(await photoRes.arrayBuffer()));
      }
      if (employee?.photoDataUrl) {
        const matches = employee.photoDataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches) return res.status(400).send('Invalid photo format');
        res.contentType(matches[1]);
        return res.send(Buffer.from(matches[2], 'base64'));
      }
      res.status(404).send('Photo not found');
    } catch {
      res.status(404).send('Photo not found');
    }
  });

  // Delete employee (called by Admins)
  app.post('/api/employees/delete', async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID do funcionário é obrigatório.' });
    try {
      const all = await pbEmployees();
      if (all.length <= 1) return res.status(400).json({ error: 'Não é possível remover o único funcionário.' });
      const removed = all.find(e => e.id === id);
      if (!removed) return res.status(404).json({ error: 'Funcionário não encontrado.' });
      await pbAdmin.collection('employees').delete(id);
      res.json({ success: true, removed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload employee photo — salva como arquivo binário (campo photo) igual aos moradores
  app.post('/api/employees/upload-photo', async (req, res) => {
    const { id, photoDataUrl } = req.body;
    if (!id || !photoDataUrl) return res.status(400).json({ error: 'ID e foto são obrigatórios.' });
    const match = photoDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Formato de foto inválido.' });
    const photoBuffer = Buffer.from(match[2], 'base64');
    try {
      const form = new FormData();
      form.append('photo', new Blob([photoBuffer], { type: match[1] }), `emp_${id}.jpg`);
      const updated = await pbAdmin.collection('employees').update(id, form);
      const updatedRec = updated as any;
      const publicPhotoUrl = updatedRec.photo
        ? `/api/employees/photo/${updatedRec.id}`
        : photoDataUrl;
      res.json({ success: true, employee: { ...updatedRec, photoDataUrl: publicPhotoUrl } });
    } catch (err: any) {
      console.error('[upload-employee-photo]', err?.response?.data || err?.message);
      res.status(500).json({ error: err?.response?.message || err?.message });
    }
  });

  // ================= PACKAGE ENDPOINTS =================

  // Get packages
  app.get('/api/packages', async (req, res) => {
    try {
      res.json(await pbPackages());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add package (by Employee)
  app.post('/api/packages/add', async (req, res) => {
    const { apartment, block, residentId, recipientName, description, receivedBy, employeeId } = req.body;
    if (!apartment || !description) return res.status(400).json({ error: 'Apartamento e descrição são obrigatórios.' });
    try {
      const newPackage = await pbAdmin.collection('packages').create({
        apartment: apartment.trim(),
        block: block ? block.trim() : 'Único',
        recipientName: recipientName ? recipientName.trim() : 'Qualquer Morador',
        description: description.trim(),
        receivedAt: new Date().toISOString(),
        status: 'pending',
        receivedBy: receivedBy ? receivedBy.trim() : 'Porteiro Principal',
        employeeId: employeeId || '',
      });

      // WhatsApp notification to resident
      const whatsappConfig = await pbSetting('whatsapp_config') as ServerWhatsAppConfig | null;
      if (whatsappConfig?.enabled) {
        const residents = await pbResidents();
        // Usa residentId direto se vier do frontend, senão busca por apartamento
        let resident: typeof residents[0] | undefined;
        if (residentId) {
          resident = residents.find(r => r.id === residentId);
        } else {
          const blockIsUnique = !block || block.trim() === '' || block.trim().toLowerCase().startsWith('ú') || block.trim().toLowerCase() === 'unico';
          resident = residents.find(r => {
            const aptMatch = r.apartment.trim().toLowerCase() === apartment.trim().toLowerCase();
            const blockMatch = blockIsUnique || r.block?.trim().toLowerCase() === block.trim().toLowerCase();
            return aptMatch && blockMatch;
          });
        }
        if (!resident) {
          console.warn(`[WhatsApp] Morador não encontrado (residentId=${residentId}, apto=${apartment})`);
        } else {
          const residentPhone = (resident as any).whatsapp || resident.phone;
          if (residentPhone) {
            const phone = residentPhone.replace(/\D/g, '');
            const normalizedPhone = phone.startsWith('55') ? phone : '55' + phone;
            const blockStr = block && block.trim() !== 'Único' ? ` / Bloco ${block.trim()}` : '';
            const message =
              `📦 *Encomenda Chegou!*\n\n` +
              `Olá, ${resident.name}! Uma encomenda chegou para você.\n\n` +
              `🏢 *Unidade:* Apto ${apartment.trim()}${blockStr}\n` +
              `📝 *Descrição:* ${description.trim()}\n\n` +
              `Retire na portaria assim que possível.`;
            console.log(`[WhatsApp] Enviando notificação de encomenda para ${resident.name} (${normalizedPhone})`);
            waClient.sendText(normalizedPhone, message).catch(err =>
              console.error('[WhatsApp] Erro ao enviar notificação de encomenda:', err)
            );
          } else {
            console.warn(`[WhatsApp] Morador ${resident.name} sem phone/whatsapp cadastrado`);
          }
        }
      }

      res.status(201).json(newPackage);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deliver package (Mark as delivered)
  app.post('/api/packages/deliver', async (req, res) => {
    const { id, deliveredTo } = req.body;
    if (!id) return res.status(400).json({ error: 'ID da encomenda é obrigatório.' });
    try {
      const updated = await pbAdmin.collection('packages').update(id, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
        deliveredTo: deliveredTo ? deliveredTo.trim() : 'Morador do apartamento',
      });
      res.json({ success: true, package: updated });
    } catch (err: any) {
      res.status(404).json({ error: 'Encomenda não encontrada.' });
    }
  });

  // ================= WHATSAPP CONFIG ENDPOINTS (Baileys) =================

  app.get('/api/whatsapp/config', async (req, res) => {
    try {
      const cfg = await pbSetting('whatsapp_config') as ServerWhatsAppConfig | null;
      res.json(cfg || { enabled: false, templateText: '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/config', async (req, res) => {
    const { enabled, templateText } = req.body;
    try {
      await pbSetSetting('whatsapp_config', {
        enabled: !!enabled,
        templateText: templateText || '🏠 *Reserva Confirmada!*\n\nOlá, {morador}! Sua reserva no *{local}* foi confirmada.\n\n📅 *Data:* {data}\n⏰ *Horário:* {hora}\n🏢 *Unidade:* {unidade}',
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/whatsapp/status', (_req, res) => {
    res.json({ status: waClient.getStatus() });
  });

  app.get('/api/whatsapp/qr', (_req, res) => {
    const qr = waClient.getQR();
    if (!qr) return res.json({ qr: null, status: waClient.getStatus() });
    res.json({ qr, status: 'qr' });
  });

  app.post('/api/whatsapp/connect', async (_req, res) => {
    try {
      await waClient.connect();
      res.json({ success: true, status: waClient.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/pairing-code', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Número é obrigatório.' });
    try {
      if (waClient.getStatus() === 'disconnected') {
        await waClient.connect();
        await new Promise(r => setTimeout(r, 4000));
      }
      const code = await waClient.requestPairingCode(phone.replace(/\D/g, ''));
      res.json({ code });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/disconnect', async (_req, res) => {
    try {
      await waClient.disconnect();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/test', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Número de telefone é obrigatório.' });
    if (waClient.getStatus() !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado. Escaneie o QR Code primeiro.' });
    }
    const normalizedPhone = phone.replace(/\D/g, '');
    const phoneWithCountry = normalizedPhone.startsWith('55') ? normalizedPhone : '55' + normalizedPhone;
    try {
      await waClient.sendText(phoneWithCountry, '✅ *Teste de Notificação*\n\nSeu WhatsApp está configurado corretamente no sistema do condomínio!');
      res.json({ success: true, message: 'Mensagem de teste enviada!' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Falha ao enviar mensagem de teste.' });
    }
  });

  // ================= HIKVISION ENDPOINTS =================

  app.get('/api/hikvision/devices', async (req, res) => {
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      res.json(devices.map(d => { const { password, ...safe } = d; return { ...safe, password: password ? '***configured***' : '' }; }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hikvision/devices', async (req, res) => {
    const { name, deviceIp, port, username, password, enabled } = req.body;
    if (!name || !deviceIp || !username || !password) return res.status(400).json({ error: 'Nome, IP, usuário e senha são obrigatórios.' });
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const newDevice: ServerHikvisionDevice = {
        id: 'hik_' + Math.random().toString(36).substring(2, 11),
        name: name.trim(), deviceIp: deviceIp.trim(), port: Number(port) || 80,
        username: username.trim(), password: password.trim(),
        enabled: enabled !== false, syncStatus: 'idle',
      };
      devices.push(newDevice);
      await pbSetSetting('hikvision_devices', devices);
      const { password: _, ...safe } = newDevice;
      res.status(201).json({ ...safe, password: '***configured***' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hikvision/devices/:id', async (req, res) => {
    const { name, deviceIp, port, username, password, enabled } = req.body;
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const idx = devices.findIndex(d => d.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Dispositivo não encontrado.' });
      const existing = devices[idx];
      devices[idx] = {
        ...existing,
        name: name ? name.trim() : existing.name,
        deviceIp: deviceIp ? deviceIp.trim() : existing.deviceIp,
        port: port !== undefined ? Number(port) : existing.port,
        username: username ? username.trim() : existing.username,
        password: password && password !== '***configured***' ? password.trim() : existing.password,
        enabled: enabled !== undefined ? !!enabled : existing.enabled,
      };
      await pbSetSetting('hikvision_devices', devices);
      const { password: _, ...safe } = devices[idx];
      res.json({ ...safe, password: '***configured***' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hikvision/devices/:id/delete', async (req, res) => {
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const idx = devices.findIndex(d => d.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Dispositivo não encontrado.' });
      devices.splice(idx, 1);
      await pbSetSetting('hikvision_devices', devices);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hikvision/test-connection', async (req, res) => {
    const { deviceId, deviceIp, port, username, password } = req.body;

    let ip: string, p: number, user: string, pass: string;

    if (deviceId) {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const device = devices.find(d => d.id === deviceId);
      if (!device) return res.status(404).json({ error: 'Dispositivo não encontrado.' });
      ip = device.deviceIp; p = device.port; user = device.username; pass = device.password;
    } else {
      if (!deviceIp || !username || !password) {
        return res.status(400).json({ error: 'IP, usuário e senha são obrigatórios.' });
      }
      ip = deviceIp.trim(); p = Number(port) || 80; user = username; pass = password;
    }

    const url = `http://${ip}:${p}/ISAPI/System/deviceInfo`;
    try {
      const client = hikFetch(user, pass);
      const response = await client.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/xml' },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 401) return res.status(401).json({ error: 'Credenciais inválidas (401)' });
      if (!response.ok) return res.status(400).json({ error: `Erro HTTP ${response.status}` });

      const text = await response.text();
      const modelMatch = text.match(/<deviceName>([^<]+)<\/deviceName>/);
      const serialMatch = text.match(/<serialNumber>([^<]+)<\/serialNumber>/);
      res.json({
        success: true,
        deviceName: modelMatch?.[1] || 'Dispositivo Hikvision',
        serialNumber: serialMatch?.[1] || 'N/A',
      });
    } catch (err: any) {
      const msg = err.name === 'TimeoutError' ? 'Timeout: dispositivo não respondeu em 8s' : (err.message || 'Falha de conexão');
      res.status(500).json({ error: msg });
    }
  });

  // Consulta direta ao dispositivo Hikvision — retorna lista de employeeNo cadastrados
  app.post('/api/hikvision/device-users', async (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId é obrigatório.' });
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const device = devices.find(d => d.id === deviceId);
      if (!device) return res.status(404).json({ error: 'Dispositivo não encontrado.' });
      const base = `http://${device.deviceIp}:${device.port}`;
      const client = hikFetch(device.username, device.password);
      const searchRes = await client.fetch(`${base}/ISAPI/AccessControl/UserInfo/Search?format=json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ UserInfoSearchCond: { searchID: '0', searchResultPosition: 0, maxResults: 100 } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!searchRes.ok) return res.status(400).json({ error: `Dispositivo retornou ${searchRes.status}` });
      const data = await searchRes.json();
      const users = data?.UserInfoSearch?.UserInfo || [];
      const arr = Array.isArray(users) ? users : [users];
      // Mapeia employeeNo → nome para cruzar com moradores
      const residents = await pbResidents();
      const personIdMap: Record<string, string> = {};
      for (const r of residents) {
        const personId = (parseInt(r.id.replace(/\D/g, '').slice(0, 9), 10) || Math.abs(hashCode(r.id))).toString();
        personIdMap[personId] = r.id;
      }
      const registeredResidentIds = arr
        .map((u: any) => personIdMap[String(u.employeeNo)])
        .filter(Boolean);
      res.json({ totalUsers: arr.length, registeredResidentIds, rawUsers: arr.map((u: any) => ({ employeeNo: u.employeeNo, name: u.name })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/hikvision/sync', async (req, res) => {
    const { residentId, deviceId } = req.body;
    if (!residentId) return res.status(400).json({ error: 'ID do morador é obrigatório.' });
    try {
      const resident = await pbAdmin.collection('residents').getOne(residentId) as unknown as ServerResident & { photo?: string; collectionId?: string };
      if (!resident) return res.status(404).json({ error: 'Morador não encontrado.' });
      if (!(resident as any).photo && !resident.photoDataUrl) return res.status(400).json({ error: 'Morador não possui foto.' });
      const allDevices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const devices = deviceId ? allDevices.filter(d => d.id === deviceId) : allDevices.filter(d => d.enabled);
      if (devices.length === 0) return res.status(400).json({ error: 'Nenhum dispositivo habilitado.' });
      const results: Record<string, HikvisionFaceSyncStatus> = {};
      for (const device of devices) {
        results[device.id] = await syncFaceToHikvisionServer(resident, device);
      }
      const rawExisting = (resident as any).hikvisionSyncStatus;
      const existing: Record<string, HikvisionFaceSyncStatus> =
        typeof rawExisting === 'string' ? (JSON.parse(rawExisting) || {}) : (rawExisting || {});
      await pbAdmin.collection('residents').update(residentId, { hikvisionSyncStatus: JSON.stringify({ ...existing, ...results }) });
      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/hikvision/sync-status', async (req, res) => {
    try {
      const devices = (await pbSetting('hikvision_devices') || []) as ServerHikvisionDevice[];
      const residents = await pbResidents();
      res.json({
        devices: devices.map(d => ({ id: d.id, name: d.name, enabled: d.enabled })),
        residents: residents.map(r => ({
          id: r.id, name: r.name, apartment: r.apartment, block: r.block,
          hasPhoto: !!r.photoDataUrl, hikvisionSyncStatus: (() => { const raw = (r as any).hikvisionSyncStatus; return typeof raw === 'string' ? (JSON.parse(raw) || {}) : (raw || {}); })(),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ================= VITE OR STATIC SERVING =================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve built static assets from `dist`
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Iniciar WhatsApp Baileys em background.
  // Conecta automaticamente: se já houver sessão salva, reconecta; caso contrário,
  // gera o QR/pairing code que o admin escaneia pelo painel. Sem isso, o disparo
  // automático ao criar reserva nunca acontece porque o cliente fica desconectado.
  const fs = await import('fs');
  if (fs.existsSync('./baileys_auth/creds.json')) {
    console.log('[WhatsApp] Sessão encontrada — reconectando...');
  } else {
    console.log('[WhatsApp] Sem sessão salva — gerando QR/pairing code. Abra o painel WhatsApp do admin para vincular.');
  }
  waClient.connect().catch(err => console.error('[WhatsApp] Erro ao iniciar:', err));
}

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
