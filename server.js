import 'dotenv/config';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './authState.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const PHONE_NUMBER = process.env.PHONE_NUMBER;

const requiredEnvs = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const name of requiredEnvs) {
  if (!process.env[name]) throw new Error(`${name} environment variable is missing.`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let sock = null;
let connecting = false;

async function onIncoming(msg) {
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

  const mediaMsg = messageContent.imageMessage || 
                   messageContent.videoMessage || 
                   messageContent.audioMessage;

  if (!mediaMsg) return;

  let mediaType = 'unknown';
  if (messageContent.imageMessage) mediaType = 'image';
  if (messageContent.videoMessage) mediaType = 'video';
  if (messageContent.audioMessage) mediaType = 'audio';

  log.info({ wa_id: msg.key.id, type: mediaType }, 'Intercepted View Once message. Transmuting crypto parameters...');

  const row = {
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

  const { data, error } = await supabase
    .from('pending_views')
    .upsert(row, { onConflict: 'wa_id' })
    .select()
    .single();

  if (error) {
    log.error({ error, wa_id: msg.key.id }, 'Supabase queue entry insertion error');
    return;
  }

  log.info({ wa_id: data.wa_id }, 'View Once cryptographic elements successfully committed to database queue.');
}

async function startSocket() {
  if (connecting) return;
  connecting = true;

  try {
    const auth = await useSupabaseAuthState(supabase);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: auth.state,
      logger: pino({ level: 'warn' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    if (!sock.authState.creds.registered) {
      if (!PHONE_NUMBER) {
        log.error('CRITICAL: PHONE_NUMBER environment variable is required to prompt initial registration pairing codes.');
      } else {
        setTimeout(async () => {
          try {
            const formattedPhone = PHONE_NUMBER.replace(/\D/g, '');
            const code = await sock.requestPairingCode(formattedPhone);
            console.log(`\n\n========================================\nYOUR WHATSAPP PAIRING CODE IS:\n\n      ${code}\n\n========================================\n`);
          } catch (err) {
            log.error({ err }, 'Failed requesting alphanumeric sequence validation token');
          }
        }, 4000);
      }
    }

    sock.ev.on('creds.update', auth.saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        log.info('WhatsApp pipeline successfully opened. Session parameters safely mirrored to Supabase.');
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        log.warn({ code }, 'Connection stream terminated');
        sock = null;
        connecting = false;

        if (code === DisconnectReason.loggedOut) {
          log.error('Session explicitly purged by parent engine. Dropping storage mappings...');
          await auth.clearAll();
          setTimeout(startSocket, 2000);
        } else {
          setTimeout(startSocket, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await onIncoming(msg);
        } catch (err) {
          log.error({ err }, 'Fatal incoming processor crash event managed');
        }
      }
    });

  } catch (err) {
    log.error({ err }, 'Fatal system loop failures detected, restarting service layer instance...');
    connecting = false;
    setTimeout(startSocket, 5000);
  }
}

startSocket();
