// Rehber yedeği: kişilerin tamamı tek bir JSON öğesi (fotoğraflar hariç). Kaynak kimliği içeriğin özetidir: rehber
// değişmedikçe aynı nesne, yeniden yüklenmez. Geri yükleme yalnız eksikleri ekler: ad + telefon / e-posta eşleşen kişi
// atlanır (yinelenen kayıt olmasın). Telefondaki kişilere dokunulmaz.
import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync } from 'expo-contacts';
import type { CreateContactRecord } from 'expo-contacts';
import { fromUtf8, toHex, utf8 } from '../core/crypto.ts';
import type { Source } from '../core/snapshot.ts';
import { sha256 } from './cipher.ts';

const FIELDS = [
  ContactField.IS_FAVOURITE, ContactField.GIVEN_NAME, ContactField.MIDDLE_NAME, ContactField.FAMILY_NAME, ContactField.NICKNAME,
  ContactField.PREFIX, ContactField.SUFFIX, ContactField.COMPANY, ContactField.DEPARTMENT, ContactField.JOB_TITLE, ContactField.NOTE,
  ContactField.BIRTHDAY, ContactField.EMAILS, ContactField.PHONES, ContactField.ADDRESSES, ContactField.DATES,
  ContactField.URL_ADDRESSES, ContactField.RELATIONS, ContactField.EXTRA_NAMES,
] as const;
type Saved = CreateContactRecord;

export async function contactsAccess(ask: boolean): Promise<boolean> {
  const p = ask ? await requestPermissionsAsync() : await getPermissionsAsync();
  return p.granted;
}

// Telefondaki kayıt → yedek kaydı: alt öğelerin telefon kimlikleri ve boş alanlar atılır
const noId = <T extends { id?: string }>(list: T[] | undefined): Omit<T, 'id'>[] | undefined =>
  list?.length ? list.map(({ id: _id, ...rest }) => rest) : undefined;
function toSaved(d: Record<string, any>): Saved {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'id' || v === null || v === undefined || v === '' || v === false) continue;
    out[k] = Array.isArray(v) ? noId(v) : v;
  }
  return out as Saved;
}

// Eşleştirme anahtarları: ad + her telefonun son 9 hanesi, ad + her e-posta (biri tutarsa aynı kişi sayılır)
const norm = (s: string | null | undefined) => (s || '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
function keys(c: Saved): string[] {
  const name = norm([c.givenName, c.middleName, c.familyName].filter(Boolean).join(' ') || c.nickname || c.company);
  const out = [
    ...(c.phones || []).map(p => (p.number || '').replace(/\D/g, '').slice(-9)).filter(n => n.length >= 6).map(n => `${name}|t:${n}`),
    ...(c.emails || []).map(e => norm(e.address)).filter(Boolean).map(e => `${name}|e:${e}`),
  ];
  return out.length ? out : [`${name}|`];
}

export function contactsSource(): Source {
  let bytes: Uint8Array | null = null;
  return {
    async *pages() {
      if (!(await contactsAccess(false))) throw new Error('Kişilere erişim izni yok — Ayarlar\'dan izin verin ya da kişileri kapatın');
      const list = (await Contact.getAllDetails(FIELDS)).map(d => toSaved(d as Record<string, any>));
      bytes = utf8(JSON.stringify({ v: 1, contacts: list }));
      const hash = toHex(await sha256(bytes)).slice(0, 32);
      yield [{ kind: 'contacts', src: `contacts:${hash}`, name: 'Kişiler.json', created: null, modified: null, count: list.length }];
    },
    async open() {
      const b = bytes;
      return b ? { size: b.length, read: async (o, l) => b.subarray(o, o + l) } : null;
    },
  };
}

export interface ContactsPlan { contacts: Saved[]; missing: Saved[] }
export async function planContacts(data: Uint8Array): Promise<ContactsPlan> {
  const j = JSON.parse(fromUtf8(data)) as { v: number; contacts: Saved[] };
  if (j?.v !== 1 || !Array.isArray(j.contacts)) throw new Error('Kişi yedeği tanınmadı');
  const have = new Set<string>();
  for (const d of await Contact.getAllDetails(FIELDS)) for (const k of keys(toSaved(d as Record<string, any>))) have.add(k);
  return { contacts: j.contacts, missing: j.contacts.filter(c => !keys(c).some(k => have.has(k))) };
}
export async function addContacts(list: Saved[], onProgress?: (done: number) => void): Promise<{ added: number; failed: number }> {
  let added = 0;
  let failed = 0;
  for (const c of list) {
    try { await Contact.create(c); added++; } catch { failed++; }
    onProgress?.(added + failed);
  }
  return { added, failed };
}
