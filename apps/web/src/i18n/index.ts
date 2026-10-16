import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar';
import en from './en';

export type Lang = 'ar' | 'en';

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('ah.lang');
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'ar';
}

void i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, en: { translation: en } },
  lng: initialLang(),
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Switches language and document direction (true RTL/LTR, not just text alignment). */
export function setLanguage(lang: Lang): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  try {
    localStorage.setItem('ah.lang', lang);
  } catch {
    /* ignore */
  }
}

export function currentLang(): Lang {
  return i18n.language === 'en' ? 'en' : 'ar';
}

setLanguage(initialLang());

export default i18n;
