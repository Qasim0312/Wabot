import baileys from '@whiskeysockets/baileys';

const { proto, initAuthCreds, BufferJSON } = baileys;

const deserialize = (value) => {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
};

const serialize = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));

/**
 * Dynamically resolves or provisions isolated authentication states 
 * out of a single Supabase data table using the phone number as a partition scope.
 */
export async function useMultiSupabaseAuth(supabase, phone) {
  const pendingData = new Map();

  const readData = async (id) => {
    if (pendingData.has(id)) return pendingData.get(id);
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('phone', phone)
      .eq('id', id)
      .maybeSingle();
    return deserialize(data?.data);
  };

  const writeData = async (id, value) => {
    if (!creds?.registered) {
      pendingData.set(id, value);
      return;
    }
    const { error } = await supabase
      .from('whatsapp_sessions')
      .upsert({ phone, id, data: serialize(value), updated_at: new Date().toISOString() });
    if (error) throw error;
  };

  const removeData = async (id) => {
    pendingData.delete(id);
    if (creds?.registered) {
      const { error } = await supabase.from('whatsapp_sessions').delete().eq('phone', phone).eq('id', id);
      if (error) throw error;
    }
  };

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
  } else if (!creds.registered && creds.me) {
    // A previous pairing request may have closed before WhatsApp accepted it.
    delete creds.me;
    delete creds.pairingCode;
    await writeData('creds', creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (value) {
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                await writeData(`${category}-${id}`, value);
              } else {
                await removeData(`${category}-${id}`);
              }
            }
          }
        }
      }
    },
    saveCreds: async (updatedCreds) => {
      if (updatedCreds) Object.assign(creds, updatedCreds);
      if (!creds.registered) {
        pendingData.set('creds', creds);
        return;
      }
      pendingData.set('creds', creds);
      for (const [id, value] of pendingData) {
        const { error } = await supabase.from('whatsapp_sessions').upsert({
          phone,
          id,
          data: serialize(value),
          updated_at: new Date().toISOString()
        });
        if (error) throw error;
      }
      pendingData.clear();
    },
    clearAll: async () => {
      pendingData.clear();
      const { error } = await supabase.from('whatsapp_sessions').delete().eq('phone', phone);
      if (error) throw error;
    }
  };
}
