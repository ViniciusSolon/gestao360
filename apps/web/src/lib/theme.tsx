import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'g360-theme';

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Tema escolhido por esta pessoa neste navegador. Padrão: Mirage (escuro). */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY, theme); } catch { /* sem armazenamento: vale só nesta visita */ }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

/** Botão do menu: alterna entre Mirage (escuro) e Classic (claro). */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'Classic (claro)' : 'Mirage (escuro)';
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={`Mudar para o tema ${next}`} title={`Mudar para o tema ${next}`}>
      <span aria-hidden>{theme === 'dark' ? '☀' : '☾'}</span> {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
    </button>
  );
}
