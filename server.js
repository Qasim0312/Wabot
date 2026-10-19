import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import baileys from '@whiskeysockets/baileys';
import { useMultiSupabaseAuth } from './authState.js';

const makeWASocket = baileys.default || baileys.makeWASocket;
const { DisconnectReason, Browsers } = baileys;

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY })) {
  if (!value) throw new Error(`${name} environment variable is missing.`);
}

// Initialize cloud connection configurations
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const SESSION_COOKIE = 'dashboard_access_token';

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage container keeping track of active connected instance details
const instances = {};

function readSessionToken(cookieHeader = '') {
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=3600${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`);
}

async function requireDashboardAuth(req, res, next) {
  const token = readSessionToken(req.headers.cookie);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    req.user = data.user;
    next();
  } catch (error) {
    log.error({ err: error }, 'Dashboard authentication failed');
    res.status(401).json({ error: 'Authentication failed' });
  }
}

io.use(async (socket, next) => {
  const token = readSessionToken(socket.request.headers.cookie);
  if (!token) return next(new Error('Authentication required'));

  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) return next(new Error('Authentication required'));
    socket.data.user = data.user;
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Parses View Once messages out of active parallel numbers and hooks into Supabase
 */
async function handleIncomingMessage(phone, msg) {
  if (msg.key.fromMe) return;
  let messageContent = msg.message;
  let isViewOnce = false;

  if (messageContent?.viewOnceMessageV2?.message) {
    messageContent = messageContent.viewOnceMessageV2.message;
    isViewOnce = true;
  } else if (messageContent?.viewOnceMessage?.message) {
    messageContent = messageContent.viewOnceMessage.message;
    isViewOnce = true;
  }

  if (!isViewOnce) return;

  const mediaMsg = messageContent.imageMessage || messageContent.videoMessage || messageContent.audioMessage;
  if (!mediaMsg) return;

  let mediaType = messageContent.imageMessage ? 'image' : messageContent.videoMessage ? 'video' : 'audio';

  const row = {
    instance_phone: phone,
    wa_id: msg.key.id,
    jid: msg.key.remoteJid,
    push_name: msg.pushName || 'Unknown',
    media_type: mediaType,
    media_url: mediaMsg.url || '',
    direct_path: mediaMsg.directPath || '',
    media_key: mediaMsg.mediaKey ? Buffer.from(mediaMsg.mediaKey).toString('base64') : '',
    enc_sha256: mediaMsg.fileEncSha256 ? Buffer.from(mediaMsg.fileEncSha256).toString('base64') : '',
    file_sha256: mediaMsg.fileSha256 ? Buffer.from(mediaMsg.fileSha256).toString('base64') : '',
    mime: mediaMsg.mimetype || ''
  };

  await supabase.from('pending_views').upsert(row, { onConflict: 'wa_id' });
  log.info({ phone, wa_id: msg.key.id }, 'View-Once elements buffered safely.');
}

/**
 * Initializes an isolated, independent WhatsApp session context loop
 */
async function startInstance(phone) {
  if (['CONNECTING', 'CONNECTED', 'PAIRING_READY'].includes(instances[phone]?.status)) return;

  const previousSocket = instances[phone]?.sock;
  log.info(`Launching isolated listener instance for line: ${phone}`);
  instances[phone] = { status: 'CONNECTING', pairingCode: null, sock: null };
  if (previousSocket) previousSocket.end(new Error('Instance reconnect requested'));
  io.emit('status_update', { phone, status: 'CONNECTING', pairingCode: null });

  try {
    const auth = await useMultiSupabaseAuth(supabase, phone);
    
    const sock = makeWASocket({
      auth: auth.state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    instances[phone].sock = sock;

    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          if (instances[phone]?.sock !== sock) return;
          instances[phone].pairingCode = code;
          instances[phone].status = 'PAIRING_READY';
          io.emit('status_update', { phone, status: 'PAIRING_READY', pairingCode: code });
        } catch (err) {
          log.error({ err }, 'Pairing engine generation challenge failed');
          if (instances[phone]?.sock === sock) {
            instances[phone].status = 'CRASHED';
            io.emit('status_update', { phone, status: 'CRASHED', pairingCode: null });
          }
        }
      }, 3000);
    }

    sock.ev.on('creds.update', auth.saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (instances[phone]?.sock !== sock) return;
      if (connection === 'open') {
        instances[phone].status = 'CONNECTED';
        instances[phone].pairingCode = null;
        io.emit('status_update', { phone, status: 'CONNECTED', pairingCode: null });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          delete instances[phone];
          io.emit('instance_deleted', { phone });
          await auth.clearAll();
        } else {
          instances[phone] = { status: 'DISCONNECTED', pairingCode: null, sock: null };
          io.emit('status_update', { phone, status: 'DISCONNECTED', pairingCode: null });
          setTimeout(() => startInstance(phone), 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (instances[phone]?.sock !== sock) return;
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleIncomingMessage(phone, msg); } catch (e) { log.error(e); }
      }
    });

  } catch (err) {
    log.error(err, 'Instance crash fallback triggered');
    instances[phone] = { status: 'CRASHED', pairingCode: null, sock: null };
    io.emit('status_update', { phone, status: 'CRASHED', pairingCode: null });
  }
}

/**
 * Automatically wakes up previously configured sessions from the database
 */
async function autoBootSavedSessions() {
  const { data, error } = await supabase.from('whatsapp_sessions').select('phone');
  if (error || !data) return;
  const uniquePhones = [...new Set(data.map(row => row.phone))];
  for (const phone of uniquePhones) {
    await startInstance(phone);
  }
}

// --- FRONTEND UI HTML MARKUP ---
const HTML_DASHBOARD = `
<!DOCTYPE html>
<html>
<head>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>WhatsApp Manager</title>
  <script src='/socket.io/socket.io.js'></script>
  <style>
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; padding: 32px 18px; color: #17221e; background: #f2f6f3; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .container { max-width: 760px; margin: 0 auto; padding: 30px; background: #fff; border: 1px solid #e2eae5; border-radius: 18px; box-shadow: 0 18px 55px rgba(24, 54, 39, .08); }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    h1 { margin: 0; font-size: clamp(23px, 4vw, 30px); letter-spacing: -.6px; }
    .subtitle { margin: 7px 0 0; color: #6a7770; font-size: 14px; }
    .input-group { display: flex; gap: 10px; margin-bottom: 24px; }
    input { min-width: 0; flex: 1; padding: 13px 14px; border: 1px solid #d5dfd9; border-radius: 9px; outline: none; font-size: 15px; }
    input:focus { border-color: #168553; box-shadow: 0 0 0 3px rgba(22, 133, 83, .12); }
    button { padding: 12px 17px; color: white; background: #168553; border: 0; border-radius: 9px; font-size: 14px; font-weight: 650; cursor: pointer; }
    button:hover { background: #106c42; }
    button.secondary { color: #34443b; background: #edf2ef; }
    button.secondary:hover { background: #dfe8e2; }
    button.reconnect { padding: 7px 11px; }
    .instance { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; padding: 15px 16px; background: #fbfcfb; border: 1px solid #e5ebe7; border-radius: 11px; }
    .phone { font-weight: 700; }
    .instance-meta { display: flex; align-items: center; justify-content: flex-end; gap: 9px; flex-wrap: wrap; }
    .status { padding: 5px 9px; color: #4d5a53; background: #edf1ee; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .CONNECTED { color: #116b3e; background: #e2f5e9; }
    .PAIRING_READY { color: #825909; background: #fff2d0; }
    .CONNECTING { color: #52626c; background: #e8eef1; }
    .pairing-box { padding: 6px 10px; color: #fff; background: #26352d; border-radius: 7px; font-family: ui-monospace, monospace; font-size: 16px; font-weight: 700; letter-spacing: 1.2px; }
    .empty { padding: 30px 16px; color: #77827b; text-align: center; border: 1px dashed #d5dfd9; border-radius: 11px; }
    @media (max-width: 520px) { body { padding: 16px 12px; } .container { padding: 21px 16px; } .input-group { flex-direction: column; } .input-group button { width: 100%; } .topbar { align-items: flex-start; } }
  </style>
</head>
<body>
  <div class='container'>
    <div class='topbar'>
      <div><h1>WhatsApp Manager</h1><p class='subtitle'>Manage your linked WhatsApp numbers.</p></div>
      <button class='secondary' id='logoutButton' type='button'>Log out</button>
    </div>
    <div class='input-group'>
      <input type='tel' id='phoneInput' inputmode='numeric' placeholder='Country code + number (e.g. 923001234567)'>
      <button id='addButton' type='button'>Link instance</button>
    </div>
    <div id='list'><div class='empty'>No WhatsApp instances are linked yet.</div></div>
  </div>

  <script>
    const socket = io();
    const activeInstances = {};

    function render() {
      const container = document.getElementById('list');
      const phones = Object.keys(activeInstances);
      container.innerHTML = '';
      if (!phones.length) {
        container.innerHTML = '<div class="empty">No WhatsApp instances are linked yet.</div>';
        return;
      }
      phones.forEach(phone => {
        const inst = activeInstances[phone];
        const div = document.createElement('div');
        div.className = 'instance';
        div.innerHTML = '<div class="phone">+' + phone + '</div>' +
          '<div class="instance-meta">' +
            (inst.pairingCode ? '<span>Pairing code: <span class="pairing-box">' + inst.pairingCode + '</span></span> ' : '') +
            '<span class="status ' + inst.status + '">' + inst.status + '</span>' +
          '</div>';
        if (['DISCONNECTED', 'CRASHED'].includes(inst.status)) {
          const reconnectButton = document.createElement('button');
          reconnectButton.className = 'reconnect';
          reconnectButton.type = 'button';
          reconnectButton.textContent = 'Reconnect';
          reconnectButton.addEventListener('click', () => reconnect(phone));
          div.querySelector('.instance-meta').appendChild(reconnectButton);
        }
        container.appendChild(div);
      });
    }

    async function addNumber() {
      const phone = document.getElementById('phoneInput').value.replace(/\\D/g, '');
      if (!phone) return alert('Enter a phone number including country code.');
      await connect(phone);
      document.getElementById('phoneInput').value = '';
    }

    async function reconnect(phone) {
      await connect(phone);
    }

    async function connect(phone) {
      const response = await fetch('/api/instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      if (!response.ok) alert('Could not connect this number. Please sign in again and retry.');
    }

    document.getElementById('addButton').addEventListener('click', addNumber);
    document.getElementById('logoutButton').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.assign('/');
    });

    socket.on('status_update', (data) => {
      activeInstances[data.phone] = data;
      render();
    });

    socket.on('instance_deleted', (data) => {
      delete activeInstances[data.phone];
      render();
    });

    fetch('/api/status')
      .then(res => res.json())
      .then(data => {
        if (!data || data.error) return;
        Object.assign(activeInstances, data);
        render();
      });
  </script>
</body>
</html>
`;

const HTML_LOGIN = `
<!DOCTYPE html>
<html>
<head>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <meta name='theme-color' content='#f2f6f3'>
  <title>WhatsApp Manager · Sign in</title>
  <style>
    * { box-sizing: border-box; }
    body { min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 24px; color: #17221e; background: radial-gradient(circle at 15% 10%, #e2f1e8, transparent 35%), #f2f6f3; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .auth-card { width: min(100%, 420px); padding: 36px; background: #fff; border: 1px solid #e2eae5; border-radius: 18px; box-shadow: 0 22px 65px rgba(24, 54, 39, .11); }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
    .brand-mark { display: grid; width: 42px; height: 42px; place-items: center; color: #fff; background: #168553; border-radius: 13px; font-size: 21px; }
    .brand-name { font-size: 14px; font-weight: 750; letter-spacing: .2px; }
    h1 { margin: 0; font-size: 27px; letter-spacing: -.6px; }
    .description { margin: 9px 0 24px; color: #69776f; font-size: 14px; line-height: 1.5; }
    label { display: block; margin: 15px 0 7px; color: #34443b; font-size: 13px; font-weight: 650; }
    input { width: 100%; padding: 12px 13px; color: #17221e; background: #fff; border: 1px solid #d5dfd9; border-radius: 9px; outline: none; font-size: 15px; }
    input:focus { border-color: #168553; box-shadow: 0 0 0 3px rgba(22, 133, 83, .12); }
    button { width: 100%; margin-top: 22px; padding: 13px; color: #fff; background: #168553; border: 0; border-radius: 9px; font-size: 15px; font-weight: 700; cursor: pointer; }
    button:hover { background: #106c42; }
    button:disabled { opacity: .65; cursor: wait; }
    .switch { margin: 20px 0 0; color: #69776f; text-align: center; font-size: 14px; }
    .switch button { width: auto; margin: 0; padding: 0; color: #137447; background: none; font: inherit; font-weight: 700; }
    .message { min-height: 20px; margin: 14px 0 0; color: #b42318; font-size: 13px; line-height: 1.45; }
    @media (max-width: 480px) { body { padding: 16px; } .auth-card { padding: 27px 22px; } }
  </style>
</head>
<body>
  <main class='auth-card'>
    <div class='brand'><div class='brand-mark'>W</div><div class='brand-name'>WhatsApp Manager</div></div>
    <h1 id='title'>Welcome back</h1>
    <p class='description' id='description'>Sign in to manage your linked WhatsApp instances.</p>
    <form id='authForm'>
      <label for='email'>Email address</label>
      <input id='email' name='email' type='email' autocomplete='email' placeholder='you@example.com' required>
      <label for='password'>Password</label>
      <input id='password' name='password' type='password' autocomplete='current-password' minlength='8' placeholder='At least 8 characters' required>
      <button id='submitButton' type='submit'>Sign in</button>
      <p class='message' id='message' role='status' aria-live='polite'></p>
    </form>
    <p class='switch'><span id='switchText'>New here?</span> <button id='switchButton' type='button'>Create account</button></p>
  </main>
  <script>
    let isSignup = false;
    const form = document.getElementById('authForm');
    const submitButton = document.getElementById('submitButton');
    const message = document.getElementById('message');
    document.getElementById('switchButton').addEventListener('click', () => {
      isSignup = !isSignup;
      document.getElementById('title').textContent = isSignup ? 'Create your account' : 'Welcome back';
      document.getElementById('description').textContent = isSignup ? 'Create an account to access WhatsApp Manager.' : 'Sign in to manage your linked WhatsApp instances.';
      document.getElementById('switchText').textContent = isSignup ? 'Already have an account?' : 'New here?';
      document.getElementById('switchButton').textContent = isSignup ? 'Sign in' : 'Create account';
      submitButton.textContent = isSignup ? 'Create account' : 'Sign in';
      document.getElementById('password').autocomplete = isSignup ? 'new-password' : 'current-password';
      message.textContent = '';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      message.textContent = '';
      submitButton.disabled = true;
      const originalText = isSignup ? 'Create account' : 'Sign in';
      submitButton.textContent = isSignup ? 'Creating account…' : 'Signing in…';
      try {
        const response = await fetch(isSignup ? '/api/auth/signup' : '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Authentication failed.');
        window.location.assign('/');
      } catch (error) {
        message.textContent = error.message;
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    });
  </script>
</body>
</html>
`;
// --- EXPRESS APP ROUTING ---
app.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = readSessionToken(req.headers.cookie);
  if (token) {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (!error && data.user) return res.send(HTML_DASHBOARD);
  }
  res.send(HTML_LOGIN);
});
app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || password.length < 8) return res.status(400).json({ error: 'Enter a valid email and a password with at least 8 characters.' });

  const { error: createError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (createError) return res.status(400).json({ error: createError.message });

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data.session) return res.status(400).json({ error: error?.message || 'Account created. Please sign in.' });
  setSessionCookie(res, data.session.access_token);
  res.json({ success: true });
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data.session) return res.status(401).json({ error: 'Email or password is incorrect.' });
  setSessionCookie(res, data.session.access_token);
  res.json({ success: true });
});
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});
app.get('/api/status', requireDashboardAuth, (req, res) => {
const simplifiedMap = {};
Object.keys(instances).forEach(phone => {
simplifiedMap[phone] = { phone, status: instances[phone].status, pairingCode: instances[phone].pairingCode };
});
res.json(simplifiedMap);
});
app.post('/api/instance', requireDashboardAuth, async (req, res) => {
const { phone } = req.body;
if (!phone) return res.status(400).json({ error: 'Phone missing' });
await startInstance(phone.replace(/\D/g, ''));
res.json({ success: true });
});
server.listen(PORT, () => {
log.info(`Multi-instance execution engine deployed live on interface port: ${PORT}`);
autoBootSavedSessions();
});
