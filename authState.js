import baileys from '@whiskeysockets/baileys';

const { proto, initAuthCreds } = baileys;

/**
 * Dynamically resolves or provisions isolated authentication states 
 * out of a single Supabase data table using the phone number as a partition scope.
 */
export async function useMultiSupabaseAuth(supabase, phone) {
  const readData = async (id) => {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('phone', phone)
      .eq('id', id)
      .maybeSingle();
    return data?.data || null;
  };

  const writeData = async (id, value) => {
    await supabase
      .from('whatsapp_sessions')
      .upsert({ phone, id, data: value, updated_at: new Date().toISOString() });
  };

  const removeData = async (id) => {
    await supabase.from('whatsapp_sessions').delete().eq('phone', phone).eq('id', id);
  };

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
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
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    clearAll: async () => {
      await supabase.from('whatsapp_sessions').delete().eq('phone', phone);
    }
  };
}
