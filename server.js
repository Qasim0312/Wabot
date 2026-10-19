import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, { DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import { useMultiSupabaseAuth } from './authState.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PASSWORD = process.env.DASHBOARD_PASSWORD || "admin123";
const PORT = process.env.PORT || 3000;

// Initialize cloud connection configurations
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage container keeping track of active connected instance details
const instances = {};

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
  if (instances[phone]?.status === 'CONNECTING' || instances[phone]?.status === 'CONNECTED') return;

  log.info(`Launching isolated listener instance for line: ${phone}`);
  instances[phone] = { status: 'CONNECTING', pairingCode: null, sock: null };
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
          instances[phone].pairingCode = code;
          instances[phone].status = 'PAIRING_READY';
          io.emit('status_update', { phone, status: 'PAIRING_READY', pairingCode: code });
        } catch (err) {
          log.error({ err }, 'Pairing engine generation challenge failed');
        }
      }, 3000);
    }

    sock.ev.on('creds.update', auth.saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        instances[phone].status = 'CONNECTED';
        instances[phone].pairingCode = null;
        io.emit('status_update', { phone, status: 'CONNECTED', pairingCode: null });
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        delete instances[phone];
        
        if (code === DisconnectReason.loggedOut) {
          io.emit('instance_deleted', { phone });
          await auth.clearAll();
        } else {
          io.emit('status_update', { phone, status: 'DISCONNECTED', pairingCode: null });
          setTimeout(() => startInstance(phone), 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleIncomingMessage(phone, msg); } catch (e) { log.error(e); }
      }
    });

  } catch (err) {
    log.error(err, 'Instance crash fallback triggered');
    delete instances[phone];
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
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 600px; margin: 0 auto; background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    h2 { margin-top: 0; color: #111; border-bottom: 2px solid #eaeaea; padding-bottom: 10px; }
    .input-group { display: flex; gap: 10px; margin-bottom: 25px; }
    input { flex: 1; padding: 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 16px; }
    button { padding: 12px 20px; background: #007aff; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 15px; }
    button:hover { background: #0062cc; }
    .card { background: #fafafa; border: 1px solid #e5e5e5; padding: 15px; border-radius: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    .status { font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 13px; }
    .CONNECTED { background: #e3fbe3; color: #1e7e34; }
    .PAIRING_READY { background: #fff3cd; color: #856404; }
    .CONNECTING { background: #e2e3e5; color: #383d41; }
    .pairing-box { font-family: monospace; font-size: 18px; font-weight: bold; background: #333; color: #fff; padding: 4px 10px; border-radius: 4px; letter-spacing: 1px; }
  </style>
</head>
<body>
  <div class='container'>
    <h2>Linked WhatsApp Instances</h2>
    <div class='input-group'>
      <input type='number' id='phoneInput' placeholder='Country code + number (e.g. 923001234567)'>
      <button onclick='addNumber()'>Link Instance</button>
    </div>
    <div id='list'></div>
  </div>

  <script>
    const socket = io();
    const activeInstances = {};

    function render() {
      const container = document.getElementById('list');
      container.innerHTML = '';
      Object.keys(activeInstances).forEach(phone => {
        const inst = activeInstances[phone];
        const div = document.createElement('div');
        div.className = 'card';
        div.innerHTML = '<div><strong>+' + phone + '</strong></div>' +
          '<div>' + 
            (inst.pairingCode ? '<span class="pairing-box">' + inst.pairingCode + '</span> ' : '') +
            '<span class="status ' + inst.status + '">' + inst.status + '</span>' +
          '</div>';
        container.appendChild(div);
      });
    }

    function addNumber() {
      const phone = document.getElementById('phoneInput').value.replace(/\\D/g, '');
      if(!phone) return alert('Enter valid sequence numbers');
      fetch('/api/instance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password: localStorage.getItem('dash_pwd') })
      });
      document.getElementById('phoneInput').value = '';
    }

    socket.on('status_update', (data) => {
      activeInstances[data.phone] = data;
      render();
    });

    socket.on('instance_deleted', (data) => {
      delete activeInstances[data.phone];
      render();
    });

    fetch('/api/status?password=' + localStorage.getItem('dash_pwd'))
      .then(res => res.json())
      .then(data => {
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
  <title>Login</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f4f6f8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); width: 100%; max-width: 320px; text-align: center; }
    input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 6px; margin: 15px 0; box-sizing: border-box; font-size: 16px; }
    button { width: 100%; padding: 12px; background: #007aff; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; }
  </style>
</head>
<body>
  <div class='card'>
    <h2>System Access</h2>
    <input type='password' id='pwd' placeholder='Enter access token key'>
    <button onclick='login()'>Verify Authorization</button>
  </div>
  <script>
function login() {
const val = document.getElementById('pwd').value;
localStorage.setItem('dash_pwd', val);
window.location.reload();
}
</script>
</body>
</html>
`;
// --- EXPRESS APP ROUTING ---
app.get('/', (req, res) => {
  res.send(`<script>
    if (localStorage.getItem('dash_pwd') === ${JSON.stringify(PASSWORD)}) {
      document.write(${JSON.stringify(HTML_DASHBOARD)});
    } else {
      document.write(${JSON.stringify(HTML_LOGIN)});
    }
  </script>`);
});
app.get('/api/status', (req, res) => {
if (req.query.password !== PASSWORD) return res.status(401).json({ error: 'Deny' });
const simplifiedMap = {};
Object.keys(instances).forEach(phone => {
simplifiedMap[phone] = { phone, status: instances[phone].status, pairingCode: instances[phone].pairingCode };
});
res.json(simplifiedMap);
});
app.post('/api/instance', async (req, res) => {
const { phone, password } = req.body;
if (password !== PASSWORD) return res.status(401).json({ error: 'Deny' });
if (!phone) return res.status(400).json({ error: 'Phone missing' });
res.json({ success: true });
await startInstance(phone.replace(/\D/g, ''));
});
server.listen(PORT, () => {
log.info(`Multi-instance execution engine deployed live on interface port: ${PORT}`);
autoBootSavedSessions();
});
