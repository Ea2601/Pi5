import { Users, Tv, Gamepad2, MessageCircle, EyeOff, Dices, Globe } from 'lucide-react';

// İçerik türleri: Ebeveyn Kontrol kategorileri (arka uç parental.ts CATEGORIES) + Genel (contentActivity.ts: hiçbir kategoriye
// uymayan). Aynı ikonlar ebeveyn kural düzenleyicisinde ve ağ haritasındaki cihaz rozetlerinde kullanılır.
export type ContentCat = 'social' | 'video' | 'gaming' | 'messaging' | 'adult' | 'gambling' | 'general';
export const CONTENT_ORDER: ContentCat[] = ['social', 'video', 'gaming', 'messaging', 'adult', 'gambling', 'general'];
export const CAT_ICON: Record<ContentCat, typeof Globe> = {
  social: Users, video: Tv, gaming: Gamepad2, messaging: MessageCircle, adult: EyeOff, gambling: Dices, general: Globe,
};
export const CAT_LABEL: Record<ContentCat, string> = {
  social: 'Sosyal medya', video: 'Video ve yayın', gaming: 'Oyun', messaging: 'Mesajlaşma',
  adult: 'Yetişkin içerik', gambling: 'Kumar ve bahis', general: 'Genel',
};
